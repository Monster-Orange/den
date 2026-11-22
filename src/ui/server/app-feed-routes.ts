/**
 * Issue 459: what the app_feed_read tool reads, an agent's own token only.
 *
 *   GET /api/agents/self/app-feeds         the caller's feeds, with unread counts
 *   GET /api/agents/self/app-feeds/:name   ?after=<seq>&limit=<n>: its events
 *
 * Only feeds of the caller's own project (as its record says now) that
 * name the caller: another project's feed, or another agent's, is "no such
 * feed". What one call returns is capped (embed.feed_read_max_kb).
 */
import type http from "node:http";
import { agentPrincipalOf } from "./request-guard.js";
import { appFeedRead } from "./app-feed-service.js";

const LIST = /^\/api\/agents\/self\/app-feeds$/;
const ONE = /^\/api\/agents\/self\/app-feeds\/([^/]+)$/;

export function isAppFeedPath(pathname: string): boolean {
  return LIST.test(pathname) || ONE.test(pathname);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export async function handleAppFeedRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL,
  read: typeof appFeedRead = appFeedRead,
): Promise<boolean> {
  if (!isAppFeedPath(pathname)) return false;
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    send(res, 405, { ok: false, code: "method", error: "GET only." });
    return true;
  }
  const agent = agentPrincipalOf(req);
  if (!agent) {
    send(res, 403, {
      ok: false,
      code: "agent_only",
      error: "Only an agent's own token reads its app feeds.",
    });
    return true;
  }
  const id = agent.actor.slice("agent:".length);
  let feed: string | null = null;
  const m = ONE.exec(pathname);
  if (m) {
    try {
      feed = decodeURIComponent(m[1]);
    } catch {
      feed = m[1];
    }
  }
  const a = url.searchParams.get("after");
  const after = a !== null && /^\d{1,15}$/.test(a) ? Number(a) : null;
  const l = url.searchParams.get("limit");
  const limit = l !== null && /^\d{1,4}$/.test(l) ? Number(l) : 100;
  const r = read(id, feed, after, limit);
  if (!r) {
    send(res, 503, {
      ok: false,
      code: "not_ready",
      error: "Den is still starting. Ask again in a moment.",
    });
    return true;
  }
  if (!r.ok) {
    send(res, 404, r);
    return true;
  }
  send(res, 200, r);
  return true;
}
