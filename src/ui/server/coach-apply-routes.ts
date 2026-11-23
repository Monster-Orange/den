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
import type { CoachFinding } from "../../shared/coach/findings.js";

export const COACH_APPLY_ROUTES = ["/api/coach/apply"] as const;

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
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  link: (id: string, approval: string, at: string) => void;
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
  if (!f.apply) {
    answer(404, "no_apply", "This finding has no change to apply.");
    return true;
  }
  const was = d.linkOf(id);
  if (was && d.stateOf(was.approval) === "waiting") {
    answer(
      409,
      "apply_waiting",
      "This finding's change is already waiting for a person's Allow.",
    );
    return true;
  }
  const r = await d.ask(req, {
    action: f.apply.action,
    args: { ...f.apply.args },
    note: `Coach: ${f.apply.change}`,
  });
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
