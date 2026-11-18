/**
 * Issue 395: Settings › Access › Start the edge (Apply, when it runs).
 *
 *   POST /api/edge/up   a person's only (shell-grade in route-classes.ts:
 *        Origin and CSRF, never an agent's token; an agent's actor header
 *        is refused here too). Runs applyEdgeConfig (shared/edge/apply.ts),
 *        the one path the held edge_up runs too: what `edge up` runs, one
 *        at a time, and what it did (#385).
 *
 * Answers:
 *   { ok: true, outcome: { kind, changes, downSeconds }, line, edge_status }
 *        kind: started | current | recreated; `line` is the CLI's words;
 *        edge_status: image, version, recreated, why
 *   { ok: false, error }   403 an agent, 409 one already running, 500 failed
 */
import type * as http from "http";
import { EdgeUpBusy, type EdgeApplied } from "../../shared/edge/apply.js";

export interface EdgeUpDeps {
  /** An agent's request (its token or actor header): never runs it. */
  isAgent: (req: http.IncomingMessage) => boolean;
  /** applyEdgeConfig (the real one runs docker; tests pass a fake up). */
  run: () => Promise<EdgeApplied>;
  /** A line for the server's log. */
  log?: (line: string) => void;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
}

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
  void (async () => {
    try {
      const r = await d.run();
      d.log?.(`edge up (Settings, by a person): ${r.line}`);
      d.sendJson(res, { ok: true, ...r });
    } catch (e) {
      const error = String((e as Error)?.message ?? e).trim() || "failed";
      if (e instanceof EdgeUpBusy) {
        if (!res.headersSent) d.sendJson(res, { ok: false, error }, 409);
        return;
      }
      d.log?.(`edge up (Settings) failed: ${error}`);
      if (!res.headersSent) d.sendJson(res, { ok: false, error }, 500);
    }
  })();
  return true;
}
