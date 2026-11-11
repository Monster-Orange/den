/**
 * MCP agent_helpers (D32): a read tool, on for every agent, scoped to its
 * own workspace or a granted one. It asks the server's helpers routes,
 * which the MCP client must let through (GET only): the first cut's tool
 * called a path the client's allowlist refused ("not exposed to agents").
 * The API here is a fake that records what was asked of it, and checks
 * each request as the real client does (assertAllowedRequest).
 */
import { describe, expect, it } from "@jest/globals";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import { Refusal } from "../../../src/ui/mcp/guards.js";
import type { McpScope } from "../../../src/ui/mcp/scope.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";

function fakeApi(): { api: DenApi; paths: string[] } {
  const paths: string[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7777",
    async get(path, query = {}, method = "GET") {
      const [p] = path.split("?");
      assertAllowedRequest(method, p, query);
      // Only the helpers routes (callTool reads the workspaces and logs
      // refusals to /api/activity itself).
      if (path.includes("/helpers")) paths.push(path);
      if (path === "/api/workspaces")
        return { active: ["north"], focus: "north", workspaces: { north: {} } };
      return { ok: true, helpers: [] };
    },
    async stream() {
      throw new Error("no stream here");
    },
  };
  return { api, paths };
}

const cfg = {
  actions: [],
  runTestsEnvs: ["local" as const],
  logsRemote: false,
  approvals: true,
};
const SCOPE: McpScope = { workspace: "north", actor: "agent:lead", grants: [] };
const call = (a: Record<string, unknown>, api: DenApi, scope?: McpScope) =>
  callTool("agent_helpers", a, { api, cfg, cli: "acme", scope });

describe("the agent_helpers tool", () => {
  it("is a read tool, there with no mcp.actions", () => {
    expect(toolsFor(cfg).map((t) => t.name)).toContain("agent_helpers");
  });

  it("lists an agent's helpers in the caller's workspace", async () => {
    const { api, paths } = fakeApi();
    const r = await call({ agent: "scout" }, api, SCOPE);
    expect(r.isError).toBe(false);
    expect(paths).toEqual(["/api/workspaces/north/agents/scout/helpers"]);
  });

  it("one helper's transcript, its last `limit` lines", async () => {
    const { api, paths } = fakeApi();
    const r = await call(
      { agent: "scout", helper: "a3f0c0ffee0000003", limit: 20 },
      api,
      SCOPE,
    );
    expect(r.isError).toBe(false);
    expect(paths).toEqual([
      "/api/workspaces/north/agents/scout/helpers/a3f0c0ffee0000003?limit=20",
    ]);
  });

  it("no scope (a person's MCP): the focused workspace", async () => {
    const { api, paths } = fakeApi();
    await call({ agent: "scout" }, api);
    expect(paths.at(-1)).toBe("/api/workspaces/north/agents/scout/helpers");
  });

  it("refuses a workspace outside the agent's scope, and ids that aren't ids", async () => {
    const { api, paths } = fakeApi();
    for (const a of [
      { agent: "scout", workspace: "south" },
      { agent: "../x" },
      { agent: "scout", helper: "../../etc" },
    ]) {
      const r = await call(a, api, SCOPE);
      expect([a, r.isError]).toEqual([a, true]);
    }
    expect(paths).toEqual([]);
  });
});

describe("the MCP client's allowlist: the helpers routes", () => {
  it("lets GET through, for the list and one helper", () => {
    for (const p of [
      "/api/workspaces/north/agents/scout/helpers",
      "/api/workspaces/north/agents/scout/helpers/a3f0c0ffee0000003",
    ])
      expect(() => assertAllowedRequest("GET", p, {})).not.toThrow();
  });

  it("nothing but GET, and no deeper path", () => {
    for (const [m, p] of [
      ["POST", "/api/workspaces/north/agents/scout/helpers"],
      [
        "DELETE",
        "/api/workspaces/north/agents/scout/helpers/a3f0c0ffee0000003",
      ],
      ["GET", "/api/workspaces/north/agents/scout/helpers/a3/stop"],
      ["GET", "/api/workspaces/north/agents/scout/helpers/.."],
    ])
      expect(() => assertAllowedRequest(m, p, {})).toThrow(Refusal);
  });
});
