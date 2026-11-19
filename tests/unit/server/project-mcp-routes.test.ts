/**
 * Issue 473: the server's routes for a project MCP server's bearer. The
 * project is the token's, never the body's; a store's error, even one
 * holding a secret-shaped value, reaches neither the answer nor a log.
 * The agent principal is set as the request guard sets it; a fake store.
 * Invented names and a test-only value.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { handleProjectMcpRoutes } from "../../../src/ui/server/project-mcp-routes.js";
import {
  setPrincipal,
  type AgentPrincipal,
} from "../../../src/ui/server/request-guard.js";
import type { ProjectMcpServer } from "../../../src/shared/agents/project-mcp.js";

const BEARER = "trk_TESTONLY_route_473_77aa66bb55";
const SERVERS: Record<string, ProjectMcpServer[]> = {
  north: [
    { name: "tracker", url: "https://mcp.tracker.example.test", bearer: "t" },
    { name: "broken", url: "https://broken.example.test", bearer: "b" },
  ],
  south: [],
};

const agentOf = (ws: string): AgentPrincipal => ({
  kind: "agent",
  actor: `agent:planner-${ws}`,
  workspace: ws,
  grants: [],
  session: { name: `acme-${ws}:planner` },
});

let srv: http.Server | null = null;
afterEach(async () => {
  jest.restoreAllMocks();
  await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
  srv = null;
});

async function serve(as: AgentPrincipal | null): Promise<string> {
  srv = http.createServer((req, res) => {
    setPrincipal(req, as);
    const p = new URL(req.url ?? "/", "http://x").pathname;
    void handleProjectMcpRoutes(req, res, p, {
      projects: () => Object.keys(SERVERS),
      servers: (ws) => SERVERS[ws] ?? [],
      secret: async (ref) => {
        if (ref === "t") return BEARER;
        throw new Error(`store said: Authorization: Bearer ${BEARER}`);
      },
    }).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(srv!.address() as AddressInfo).port}`;
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/agents/self/mcp-headers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("issue 473: /api/agents/self/mcp-headers", () => {
  it("the agent's own project's header; another project's server is no one's", async () => {
    const ok = await post(await serve(agentOf("north")), { name: "tracker" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    await new Promise<void>((r) => srv!.close(() => r()));
    const base = await serve(agentOf("south"));
    const no = await post(base, { name: "tracker" });
    expect(no.status).toBe(404);
    expect(await no.text()).not.toContain(BEARER);
    // The body never names the project.
    const named = await post(base, { name: "tracker", project: "north" });
    expect(named.status).toBe(400);
    // A name that is no MCP entry's shape: refused, not echoed.
    const odd = await post(base, { name: `x\n${"y".repeat(200)}` });
    expect(odd.status).toBe(400);
    expect(await odd.text()).not.toContain("yyyy");
    expect(await named.text()).not.toContain(BEARER);
  });

  it("a person's request, or a GET, gets nothing", async () => {
    const base = await serve(null);
    const p = await post(base, { name: "tracker" });
    expect(p.status).toBe(403);
    expect(await p.text()).not.toContain(BEARER);
    expect((await fetch(`${base}/api/agents/self/mcp-headers`)).status).toBe(
      405,
    );
  });

  it("a store's error holding the value: scrubbed in the answer, and nothing logged", async () => {
    const said: string[] = [];
    const keep = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    jest.spyOn(console, "log").mockImplementation(keep);
    jest.spyOn(console, "warn").mockImplementation(keep);
    jest.spyOn(console, "error").mockImplementation(keep);
    const base = await serve(agentOf("north"));
    const r = await post(base, { name: "broken" });
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(text).toContain("secrets.refs.b can't be read");
    expect(text).not.toContain(BEARER);
    // Doctor's check: the same scrubbed why, and never a value.
    const d = await fetch(`${base}/api/mcp-servers/bearers`);
    const dt = await d.text();
    expect(dt).not.toContain(BEARER);
    expect(JSON.parse(dt).servers).toEqual([
      { project: "north", name: "tracker", served: true },
      {
        project: "north",
        name: "broken",
        served: false,
        why: expect.stringContaining("secrets.refs.b can't be read"),
      },
    ]);
    expect(said.join("\n")).not.toContain(BEARER);
  });
});
