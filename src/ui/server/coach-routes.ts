/**
 * Issue 52: the Coach's routes, for the platform agent's Coach tab.
 *
 *   GET  /api/coach          { ok, settings, report (null: none yet),
 *                            running, findings (the open ones), dismissed }
 *   POST /api/coach/run      Run now: { ok, report }, or a refusal with a
 *                            code: person_only (403), coach_off (409),
 *                            already_running (409), run_failed (500)
 *   POST /api/coach/dismiss  { id, reason? }: Dismiss a finding, a
 *                            person's (mock v4 asks no reason; one given is
 *                            kept); bad_body, bad_id, reason_too_long
 *                            (400), person_only (403)
 *   POST /api/coach/undismiss { id }: Undo a dismissal, a person's;
 *                            bad_body, bad_id (400), person_only (403),
 *                            not_dismissed (404)
 *
 * The request guard (route-classes.ts) has checked the sign-in, Origin and
 * CSRF already. Run now is a person's: an agent's token, a claimed agent
 * or the fixture person is refused. Each run, or refusal, is audited. One
 * run at a time. The run itself is read-only: it reads transcripts on this
 * machine, keeps counts and calls no model.
 */
import type * as http from "http";
import type { CoachReport } from "../../shared/coach/breakdown.js";
import type {
  CoachFinding,
  DismissResult,
  Dismissal,
  UndismissResult,
} from "../../shared/coach/findings.js";
import type { CoachSettings } from "../../shared/coach/settings.js";

export const COACH_ROUTES = [
  "/api/coach",
  "/api/coach/run",
  "/api/coach/dismiss",
  "/api/coach/undismiss",
] as const;

export interface CoachAuditEntry {
  verb: "coach-run" | "coach-dismiss" | "coach-undismiss";
  detail: string;
  outcome?: "refused";
  reason?: string;
}

export interface CoachRouteDeps {
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
  /** An agent's token, a claimed agent, the fixture person (notAPersonOf). */
  notAPerson: (req: http.IncomingMessage) => boolean;
  settings: () => CoachSettings;
  latest: () => CoachReport | null;
  /** Run the Coach and save its report (coach run), telling its progress. */
  run: (
    progress?: (done: number, total: number) => void,
  ) => Promise<CoachReport>;
  /** ms since the epoch (default: Date.now). */
  now?: () => number;
  audit: (req: http.IncomingMessage, e: CoachAuditEntry) => void;
  /** The report's open findings, and the dismissals (findings.ts). */
  findings: (report: CoachReport | null) => {
    open: CoachFinding[];
    dismissed: Dismissal[];
  };
  dismiss: (id: string, reason: string) => DismissResult;
  /** Undo a dismissal (findings.ts undismissFinding). */
  undismiss: (id: string) => UndismissResult;
  readBody: (req: http.IncomingMessage) => Promise<string>;
}

let running: Promise<unknown> | null = null;
/** The run going now: agents read of all (the Running state). */
let progress: { done: number; total: number } | null = null;
/**
 * The last run, when it failed (the Failed state, with the report before
 * it): kept until a run succeeds. In memory: a restart starts clean.
 */
let failed: { at: string; error: string } | null = null;

/** Handle `pathname` if it is a Coach route; false when it isn't one. */
export async function handleCoachRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: CoachRouteDeps,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  if (pathname === "/api/coach") {
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader?.("Allow", "GET, HEAD");
      d.sendJson(res, { ok: false, error: "use GET" }, 405);
      return true;
    }
    const report = d.latest();
    const f = d.findings(report);
    d.sendJson(res, {
      ok: true,
      settings: d.settings(),
      report,
      running: running !== null,
      progress: running ? progress : null,
      failed,
      findings: f.open,
      dismissed: f.dismissed,
    });
    return true;
  }
  if (pathname === "/api/coach/dismiss") return dismiss(req, res, method, d);
  if (pathname === "/api/coach/undismiss")
    return undismiss(req, res, method, d);
  if (pathname !== "/api/coach/run") return false;
  if (method !== "POST") {
    res.setHeader?.("Allow", "POST");
    d.sendJson(res, { ok: false, error: "use POST" }, 405);
    return true;
  }
  const refuse = (status: number, code: string, error: string) => {
    d.audit(req, {
      verb: "coach-run",
      detail: "Coach run refused",
      outcome: "refused",
      reason: code,
    });
    d.sendJson(res, { ok: false, code, error }, status);
    return true;
  };
  if (d.notAPerson(req))
    return refuse(
      403,
      "person_only",
      "Only a person runs the Coach, from the Coach tab: an agent can't.",
    );
  if (!d.settings().enabled)
    return refuse(
      409,
      "coach_off",
      "The Coach is off. Turn it on in Settings (agents.coach.enabled).",
    );
  if (running)
    return refuse(
      409,
      "already_running",
      "The Coach is running now. Its report shows here when it ends.",
    );
  progress = null;
  const run = d.run((done, total) => {
    progress = { done, total };
  });
  running = run;
  try {
    const report = await run;
    failed = null;
    d.audit(req, { verb: "coach-run", detail: "Coach run (read-only)" });
    d.sendJson(res, { ok: true, report });
  } catch (e) {
    failed = {
      at: new Date((d.now ?? Date.now)()).toISOString(),
      error: String((e as Error)?.message ?? e).slice(0, 300),
    };
    d.sendJson(
      res,
      {
        ok: false,
        code: "run_failed",
        error: `The Coach run failed: ${(e as Error).message}`,
      },
      500,
    );
  } finally {
    running = null;
    progress = null;
  }
  return true;
}

/** POST /api/coach/dismiss { id, reason? }: a person's, audited. */
async function dismiss(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  d: CoachRouteDeps,
): Promise<boolean> {
  if (method !== "POST") {
    res.setHeader?.("Allow", "POST");
    d.sendJson(res, { ok: false, error: "use POST" }, 405);
    return true;
  }
  if (d.notAPerson(req)) {
    d.audit(req, {
      verb: "coach-dismiss",
      detail: "Coach dismiss refused",
      outcome: "refused",
      reason: "person_only",
    });
    d.sendJson(
      res,
      {
        ok: false,
        code: "person_only",
        error: "Only a person dismisses a Coach finding: an agent can't.",
      },
      403,
    );
    return true;
  }
  let body: { id?: unknown; reason?: unknown };
  try {
    body = JSON.parse(await d.readBody(req)) as typeof body;
  } catch {
    body = {};
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.id !== "string" ||
    (body.reason !== undefined && typeof body.reason !== "string")
  ) {
    d.sendJson(
      res,
      {
        ok: false,
        code: "bad_body",
        error: 'Send { "id": "<finding id>" }, with "reason" if you like.',
      },
      400,
    );
    return true;
  }
  const why = typeof body.reason === "string" ? body.reason.trim() : "";
  const r = d.dismiss(body.id, why);
  if (!r.ok) {
    d.sendJson(res, { ok: false, code: r.code, error: r.error }, 400);
    return true;
  }
  d.audit(req, {
    verb: "coach-dismiss",
    detail: why
      ? `Coach finding ${body.id} dismissed: ${why}`
      : `Coach finding ${body.id} dismissed`,
  });
  d.sendJson(res, { ok: true });
  return true;
}

/** POST /api/coach/undismiss { id }: Undo a dismissal, a person's, audited. */
async function undismiss(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  d: CoachRouteDeps,
): Promise<boolean> {
  if (method !== "POST") {
    res.setHeader?.("Allow", "POST");
    d.sendJson(res, { ok: false, error: "use POST" }, 405);
    return true;
  }
  if (d.notAPerson(req)) {
    d.audit(req, {
      verb: "coach-undismiss",
      detail: "Coach undismiss refused",
      outcome: "refused",
      reason: "person_only",
    });
    d.sendJson(
      res,
      {
        ok: false,
        code: "person_only",
        error: "Only a person takes a dismissal back: an agent can't.",
      },
      403,
    );
    return true;
  }
  let body: { id?: unknown };
  try {
    body = JSON.parse(await d.readBody(req)) as typeof body;
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object" || typeof body.id !== "string") {
    d.sendJson(
      res,
      { ok: false, code: "bad_body", error: 'Send { "id": "<finding id>" }.' },
      400,
    );
    return true;
  }
  const r = d.undismiss(body.id);
  if (!r.ok) {
    d.sendJson(
      res,
      { ok: false, code: r.code, error: r.error },
      r.code === "not_dismissed" ? 404 : 400,
    );
    return true;
  }
  d.audit(req, {
    verb: "coach-undismiss",
    detail: `Coach finding ${body.id} dismissal taken back`,
  });
  d.sendJson(res, { ok: true });
  return true;
}
