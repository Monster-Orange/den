/**
 * Issue 459: GET /api/agents/self/app-feeds[/:name], what app_feed_read
 * reads: an agent's own token only, the caller taken from the token
 * (never a parameter), and its after/limit read strictly. Invented names.
 */
import type http from "node:http";
import { handleAppFeedRoutes } from "../../../src/ui/server/app-feed-routes";
import { setPrincipal } from "../../../src/ui/server/request-guard";
import { appFeedRead } from "../../../src/ui/server/app-feed-service";

function fakeRes() {
  const r = { status: 0, body: "" } as {
    status: number;
    body: string;
    writeHead: (s: number) => void;
    end: (b: string) => void;
  };
  r.writeHead = (s) => void (r.status = s);
  r.end = (b) => void (r.body = b);
  return r;
}

async function call(path: string, agent: string | null) {
  const req = { method: "GET", url: path, headers: {} } as http.IncomingMessage;
  if (agent)
    setPrincipal(req, {
      kind: "agent",
      actor: `agent:${agent}`,
      workspace: "north",
      grants: [],
      session: { name: "north:x" },
    });
  const res = fakeRes();
  const calls: unknown[][] = [];
  const read = ((...a: unknown[]) => {
    calls.push(a);
    return { ok: true, feeds: [] };
  }) as unknown as typeof appFeedRead;
  const u = new URL(path, "http://localhost");
  const handled = await handleAppFeedRoutes(
    req,
    res as unknown as http.ServerResponse,
    u.pathname,
    u,
    read,
  );
  return { handled, res, calls };
}

describe("issue 459: the app feed read route", () => {
  it("a person or no token: refused, nothing read", async () => {
    const r = await call("/api/agents/self/app-feeds/chat", null);
    expect(r.handled).toBe(true);
    expect(r.res.status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  it("the caller is the token's agent; after and limit read strictly", async () => {
    const r = await call(
      "/api/agents/self/app-feeds/chat?after=7&limit=5",
      "north-helper",
    );
    expect(r.res.status).toBe(200);
    expect(r.calls).toEqual([["north-helper", "chat", 7, 5]]);
    const bad = await call(
      "/api/agents/self/app-feeds/chat?after=-1&limit=x",
      "north-helper",
    );
    expect(bad.calls).toEqual([["north-helper", "chat", null, 100]]);
    const list = await call("/api/agents/self/app-feeds", "north-helper");
    expect(list.calls).toEqual([["north-helper", null, null, 100]]);
  });

  it("before the server started the feeds: not ready", async () => {
    const req = {
      method: "GET",
      url: "/",
      headers: {},
    } as http.IncomingMessage;
    setPrincipal(req, {
      kind: "agent",
      actor: "agent:north-helper",
      workspace: "north",
      grants: [],
      session: { name: "north:x" },
    });
    const res = fakeRes();
    const u = new URL("http://localhost/api/agents/self/app-feeds");
    await handleAppFeedRoutes(
      req,
      res as unknown as http.ServerResponse,
      u.pathname,
      u,
    );
    expect(res.status).toBe(503);
  });
});
