/**
 * Issue 52: the Coach's routes, for the platform agent's Coach tab.
 *
 *   GET  /api/coach      { ok, settings, report (null: none yet), running }
 *   POST /api/coach/run  Run now: { ok, report }, or a refusal with a code:
 *                        person_only (403), coach_off (409),
 *                        already_running (409), run_failed (500)
 *
 * The request guard (route-classes.ts) has checked the sign-in, Origin and
 * CSRF already. Run now is a person's: an agent's token, a claimed agent
 * or the fixture person is refused. Each run, or refusal, is audited. One
 * run at a time. The run itself is read-only: it reads transcripts on this
 * machine, keeps counts and calls no model.
 */
import type * as http from "http";
import type { CoachReport } from "../../shared/coach/breakdown.js";
import type { CoachSettings } from "../../shared/coach/settings.js";

export const COACH_ROUTES = ["/api/coach", "/api/coach/run"] as const;

export interface CoachAuditEntry {
  verb: "coach-run";
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
  /** Run the Coach and save its report (coach run). */
  run: () => Promise<CoachReport>;
  audit: (req: http.IncomingMessage, e: CoachAuditEntry) => void;
}

let running: Promise<unknown> | null = null;

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
    d.sendJson(res, {
      ok: true,
      settings: d.settings(),
      report: d.latest(),
      running: running !== null,
    });
    return true;
  }
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
  const run = d.run();
  running = run;
  try {
    const report = await run;
    d.audit(req, { verb: "coach-run", detail: "Coach run (read-only)" });
    d.sendJson(res, { ok: true, report });
  } catch (e) {
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
  }
  return true;
}
