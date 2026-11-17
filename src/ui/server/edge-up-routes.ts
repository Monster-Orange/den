/**
 * Issue 395: Settings › Access › Start the edge (Apply, when it runs).
 *
 *   POST /api/edge/up   a person's only (shell-grade in route-classes.ts:
 *        Origin and CSRF, never an agent's token; an agent's actor header
 *        is refused here too). Runs what `edge up` runs (runEdgeUp in
 *        shared/edge/up.ts), one at a time, and says what it did (#385).
 *
 * Answers:
 *   { ok: true, outcome: { kind, changes, downSeconds }, line }
 *        kind: started | current | recreated; `line` is the CLI's words
 *   { ok: false, error }   403 an agent, 409 one already running, 500 failed
 */
import type * as http from "http";
import { edgeUpLine, type EdgeUpOutcome } from "../../shared/edge/spec.js";

export interface EdgeUpDeps {
  /** An agent's request (its token or actor header): never runs it. */
  isAgent: (req: http.IncomingMessage) => boolean;
  /** `edge up` itself (the real one runs docker; tests pass a fake). */
  run: () => Promise<EdgeUpOutcome>;
  /** A line for the server's log. */
  log?: (line: string) => void;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
}

let inFlight = false;

export function handleEdgeUpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: EdgeUpDeps,
): boolean {
  if (pathname !== "/api/edge/up" || req.method !== "POST") return false;
  if (d.isAgent(req)) {
    d.sendJson(res, { ok: false, error: "only a person starts the edge" }, 403);
    return true;
  }
  if (inFlight) {
    d.sendJson(
      res,
      { ok: false, error: "The edge is already starting. Wait for it." },
      409,
    );
    return true;
  }
  inFlight = true;
  void (async () => {
    try {
      const outcome = await d.run();
      const line = edgeUpLine(outcome);
      d.log?.(`edge up (Settings, by a person): ${line}`);
      d.sendJson(res, { ok: true, outcome, line });
    } catch (e) {
      const error = String((e as Error)?.message ?? e).trim() || "failed";
      d.log?.(`edge up (Settings) failed: ${error}`);
      if (!res.headersSent) d.sendJson(res, { ok: false, error }, 500);
    } finally {
      inFlight = false;
    }
  })();
  return true;
}
