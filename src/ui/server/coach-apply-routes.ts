/**
 * Issue 110, Coach Apply: POST /api/coach/apply { id }.
 *
 * A person's Apply on a Coach finding asks for the finding's proposal as a
 * held write, through the same path as POST /api/approvals (askHeld): the
 * held action's own check, the queue, its audit and the approval policy.
 * Nothing changes until a person allows it in the bell. The held write
 * comes from the stored finding, never from the request. Den keeps which
 * held write the Apply asked for (coach/applies.ts), so the finding's row
 * follows it, and refuses a second Apply while one is waiting.
 *
 *   202 { ok, approval, state: "waiting" }
 *   400 bad_body; or the held write's own refusal (invalid_args, …)
 *   403 person_only (audited)
 *   404 not_found (no open finding of that id), no_apply (no proposal)
 *   405 a method other than POST
 *   409 apply_waiting
 *
 * The request guard (route-classes.ts, request-guard.ts) has checked the
 * sign-in, Origin and CSRF, and lists it as a person's write.
 */
import type * as http from "http";
import type { ApplyLink, ApplyState } from "../../shared/coach/applies.js";
import {
  coachApplyFor,
  type CoachFinding,
} from "../../shared/coach/findings.js";

export const COACH_APPLY_ROUTES = ["/api/coach/apply"] as const;

/** Issue 110: the bell card's Coach block (approvals.ts CoachAsk). */
export interface CoachAskBlock {
  finding: string;
  kind: string;
  persona: string;
  vars: Record<string, string | number>;
}

/** The finding's numbers the bell words it with, as the Coach tab does. */
function coachAskFor(
  f: CoachFinding,
  persona: string,
  line: number | undefined,
): CoachAskBlock {
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const vars: Record<string, string | number> = { agent: f.agent };
  const n = num(f.evidence?.subagent_opus_pct);
  const calls = num(f.evidence?.subagent_calls);
  if (n !== undefined) vars.n = n;
  if (calls !== undefined) vars.calls = calls;
  if (num(line) !== undefined) vars.line = line as number;
  return { finding: f.id, kind: f.kind, persona, vars };
}

/**
 * Finding ids whose Apply is asking now: a second Apply at the same
 * moment is refused, as one waiting is (Builder 2, issue 110).
 */
const asking = new Set<string>();

export interface CoachApplyDeps {
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
  /** An agent's token, a claimed agent, the fixture person (notAPersonOf). */
  notAPerson: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  audit: (
    req: http.IncomingMessage,
    e: {
      verb: "coach-apply";
      detail: string;
      outcome?: "refused";
      reason?: string;
    },
  ) => void;
  /** The latest report's open findings (findings.ts openFindings). */
  openFindings: () => CoachFinding[];
  linkOf: (id: string) => ApplyLink | null;
  /** A held write's state as the row shows it (applies.ts applyStateOf). */
  stateOf: (approval: string) => ApplyState;
  /** Ask for a held write as POST /api/approvals does (askHeld). */
  ask: (
    req: http.IncomingMessage,
    body: { action: string; args: Record<string, string>; note: string },
    opts: { coach: CoachAskBlock },
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** The line a finding of `kind` passed (the Coach's settings). */
  lineOf?: (kind: string) => number | undefined;
  link: (id: string, approval: string, at: string) => void;
  /** Whether Den has project `ws` (the held write names it only then). */
  projectExists?: (ws: string) => boolean;
  now?: () => number;
}

/** Handle `pathname` if it is Apply's route; false when it isn't. */
export async function handleCoachApplyRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: CoachApplyDeps,
): Promise<boolean> {
  if (pathname !== "/api/coach/apply") return false;
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    res.setHeader?.("Allow", "POST");
    d.sendJson(res, { ok: false, error: "use POST" }, 405);
    return true;
  }
  const answer = (status: number, code: string, error: string) =>
    d.sendJson(res, { ok: false, code, error }, status);
  if (d.notAPerson(req)) {
    d.audit(req, {
      verb: "coach-apply",
      detail: "Coach Apply refused",
      outcome: "refused",
      reason: "person_only",
    });
    answer(
      403,
      "person_only",
      "Only a person applies a Coach finding: an agent can't.",
    );
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(await d.readBody(req));
  } catch {
    body = null;
  }
  const b = body as Record<string, unknown> | null;
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    Object.keys(b).some((k) => k !== "id") ||
    typeof b.id !== "string" ||
    b.id.length === 0 ||
    b.id.length > 200
  ) {
    answer(400, "bad_body", 'Send { "id": "<finding id>" } and nothing else.');
    return true;
  }
  const id = b.id;
  const f = d.openFindings().find((x) => x.id === id);
  if (!f) {
    answer(404, "not_found", "No open Coach finding has that id.");
    return true;
  }
  // Rebuilt in code from the finding's kind and names: a stored `apply`
  // (the report file) is never trusted (Reviewer B, issue 110).
  const apply = coachApplyFor(f, d.projectExists);
  if (!apply) {
    answer(404, "no_apply", "This finding has no change to apply.");
    return true;
  }
  const was = d.linkOf(id);
  if (asking.has(id) || (was && d.stateOf(was.approval) === "waiting")) {
    answer(
      409,
      "apply_waiting",
      "This finding's change is already waiting for a person's Allow.",
    );
    return true;
  }
  asking.add(id);
  try {
    return await askAndLink(req, res, f, apply, d);
  } finally {
    asking.delete(id);
  }
}

async function askAndLink(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  f: CoachFinding,
  apply: NonNullable<ReturnType<typeof coachApplyFor>>,
  d: CoachApplyDeps,
): Promise<boolean> {
  const id = f.id;
  const r = await d.ask(
    req,
    {
      action: apply.action,
      args: { ...apply.args },
      note: `Coach: ${apply.change}`,
    },
    { coach: coachAskFor(f, apply.args.id, d.lineOf?.(f.kind)) },
  );
  const approval = typeof r.body.id === "string" ? r.body.id : null;
  if (r.status !== 202 || r.body.ok !== true || !approval) {
    d.sendJson(res, r.body, r.status === 202 ? 500 : r.status);
    return true;
  }
  const at = new Date((d.now ?? Date.now)()).toISOString();
  d.link(id, approval, at);
  d.audit(req, {
    verb: "coach-apply",
    detail: `Coach finding ${id}: Apply asked for a held write [${approval}]`,
  });
  d.sendJson(res, { ok: true, approval, state: d.stateOf(approval), at }, 202);
  return true;
}
