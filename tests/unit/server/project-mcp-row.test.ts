/**
 * Issue 352: Settings › Project › Agents' extra MCP servers, the row's
 * actions. Each server has Change and Remove; the person's own click is
 * the decision, so the routes are a person's only (an agent asks with
 * project_mcp_update or project_mcp_remove, which wait for the Allow):
 *
 *   POST   /api/workspaces/:ws/mcp-servers/:name  { url?, bearer?, no_bearer? }
 *   DELETE /api/workspaces/:ws/mcp-servers/:name
 *
 * A bearer is a secrets.refs name, never a value, and no answer holds
 * one. Invented names and values only.
 */
import { afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import type { ProjectMcpServer } from "../../../src/shared/agents/project-mcp.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  AGENT_PERSON_WRITES,
  setPrincipal,
} from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import { cleanupRigs, rig } from "../agents/helpers/rig.js";
import { installEnShell } from "./helpers/en-catalog.js";

type Row = Record<string, unknown>;
const URL_A = "https://mcp.tracker.example.test";
const URL_B = "https://mcp2.tracker.example.test/mcp";
const VALUE = "trk_TESTONLY_never_shown_e3b9";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

/** Project north's servers in memory, behind the agent routes. */
async function serve(): Promise<{
  base: string;
  saved: Record<string, ProjectMcpServer[]>;
}> {
  const saved: Record<string, ProjectMcpServer[]> = {
    north: [
      { name: "tracker", url: URL_A, bearer: "tracker_token" },
      { name: "wiki", url: "https://wiki.example.test/mcp" },
    ],
  };
  const r = await rig({
    workspaceMcpServers: (ws) => saved[ws],
    saveWorkspaceMcpServers: (ws, list) => {
      saved[ws] = list;
    },
    secretRefSet: (n) => n === "tracker_token" || n === "tracker_token_2",
  });
  const s = http.createServer((req, res) => {
    if (req.headers["x-test-agent"])
      setPrincipal(req, {
        kind: "agent",
        actor: "agent:lead",
        workspace: "north",
        grants: [],
        session: { name: "acme-north:lead" },
      });
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, { agents: r.deps });
  });
  servers.push(s);
  await new Promise<void>((res) => s.listen(0, "localhost", () => res()));
  return {
    base: `http://localhost:${(s.address() as AddressInfo).port}`,
    saved,
  };
}

const call = async (
  url: string,
  method: string,
  body?: unknown,
  agent = false,
): Promise<{ status: number; text: string; json: Row }> => {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(agent ? { "x-test-agent": "lead" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Row };
};

describe("issue 352: a person changes or removes one from Settings", () => {
  it("POST changes its url; the answer is names and urls only", async () => {
    const { base, saved } = await serve();
    const r = await call(
      `${base}/api/workspaces/north/mcp-servers/tracker`,
      "POST",
      { url: URL_B },
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      project: "north",
      servers: [
        { name: "tracker", url: URL_B },
        { name: "wiki", url: "https://wiki.example.test/mcp" },
      ],
    });
    expect(r.text).not.toContain("tracker_token");
    expect(saved.north[0]).toEqual({
      name: "tracker",
      url: URL_B,
      bearer: "tracker_token",
    });
  });

  it("POST changes the bearer reference or drops it; refuses a value, an unset ref, an unknown field", async () => {
    const { base, saved } = await serve();
    const u = `${base}/api/workspaces/north/mcp-servers/tracker`;
    expect((await call(u, "POST", { bearer: "tracker_token_2" })).status).toBe(
      200,
    );
    expect(saved.north[0].bearer).toBe("tracker_token_2");
    expect((await call(u, "POST", { no_bearer: true })).status).toBe(200);
    expect(saved.north[0]).toEqual({ name: "tracker", url: URL_A });
    const leak = await call(u, "POST", { bearer: `Bearer ${VALUE}` });
    expect(leak.status).toBe(400);
    expect(leak.text).not.toContain(VALUE);
    expect((await call(u, "POST", { bearer: "other_ref" })).json.error).toBe(
      "secrets.refs.other_ref is not set: a person adds it to the install's config first",
    );
    expect((await call(u, "POST", { token: "x" })).status).toBe(400);
  });

  it("DELETE removes it; an unknown one is 404", async () => {
    const { base, saved } = await serve();
    const r = await call(
      `${base}/api/workspaces/north/mcp-servers/tracker`,
      "DELETE",
    );
    expect(r.status).toBe(200);
    expect(r.json.servers).toEqual([
      { name: "wiki", url: "https://wiki.example.test/mcp" },
    ]);
    expect(saved.north.map((s) => s.name)).toEqual(["wiki"]);
    expect(
      (await call(`${base}/api/workspaces/north/mcp-servers/nope`, "DELETE"))
        .status,
    ).toBe(404);
  });

  it("an agent's token is refused, and nothing changes: it asks with the held write", async () => {
    const { base, saved } = await serve();
    const before = JSON.stringify(saved.north);
    const u = `${base}/api/workspaces/north/mcp-servers/tracker`;
    const rm = await call(u, "DELETE", undefined, true);
    expect(rm.status).toBe(403);
    expect(String(rm.json.error)).toContain("project_mcp_remove");
    const up = await call(u, "POST", { url: URL_B }, true);
    expect(up.status).toBe(403);
    expect(String(up.json.error)).toContain("project_mcp_update");
    expect(JSON.stringify(saved.north)).toBe(before);
  });

  it("route classes: a person's writes", () => {
    const p = "/api/workspaces/north/mcp-servers/tracker";
    expect(routeClass("POST", p)).toBe("mutating");
    expect(routeClass("DELETE", p)).toBe("mutating");
    expect(AGENT_PERSON_WRITES).toContain(
      "/api/workspaces/:ws/mcp-servers/:name",
    );
  });
});

describe("issue 352: each row has Change and Remove", () => {
  let projectMcpHtml: (v: unknown, t: (k: string, v?: Row) => string) => string;
  let t: (k: string, v?: Row) => string;
  beforeAll(async () => {
    installEnShell();
    t = (
      globalThis as unknown as {
        window: { denShell: { t: (k: string, v?: Row) => string } };
      }
    ).window.denShell.t;
    ({ projectMcpHtml } =
      await import("../../../src/ui/server/public/settings-registry.js"));
  });

  it("a Change and a Remove button per server, labelled with its name", () => {
    const html = projectMcpHtml(
      { servers: [{ name: "tracker", url: URL_A }] },
      t,
    );
    expect(html).toContain('data-pmcp-edit="tracker"');
    expect(html).toContain('data-pmcp-remove="tracker"');
    expect(html).toMatch(/aria-label="Change tracker"/);
    expect(html).toMatch(/aria-label="Remove tracker"/);
  });
});
