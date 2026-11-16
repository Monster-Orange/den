/**
 * Issue 212: verify_history, the agent's read of one module's history on
 * one environment ("since when?", "is it flaky?"): the route's MCP twin.
 * Reads only, in the agent's own project.
 */
import { describe, expect, it } from "@jest/globals";
import {
  READ_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import {
  DenHttpError,
  assertAllowedRequest,
  type DenApi,
  type Query,
} from "../../../src/ui/mcp/api.js";
import { Refusal } from "../../../src/ui/mcp/guards.js";

const PATH = "/api/verify/modules/shop%3Aapi%2Forders/history";

function fakeApi() {
  const calls: { path: string; query?: Query }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, query) {
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      calls.push({ path, query });
      if (path === PATH)
        return { ok: true, flaky: { mark: true, count: 2 }, runs: [] };
      throw new DenHttpError("GET", path, 404, "not found");
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}

const ctx = (api: DenApi): ToolContext => ({
  api,
  cfg: {
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  },
  cli: "acme",
  scope: { workspace: "north", actor: "agent:release-helper" },
});

describe("issue 212: verify_history", () => {
  it("is a read, and the history route is open to agents for GET only", () => {
    expect(READ_TOOL_NAMES).toContain("verify_history");
    expect(() => assertAllowedRequest("GET", PATH, {})).not.toThrow();
    expect(() => assertAllowedRequest("POST", PATH, {})).toThrow(Refusal);
  });

  it("reads the module on the environment, in the agent's own project", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "verify_history",
      { module: "shop:api/orders", env: "staging" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain('"mark": true');
    expect(calls[0]).toMatchObject({
      path: PATH,
      query: { project: "north", env: "staging" },
    });
  });

  it("refuses a module id that isn't one", async () => {
    const { api } = fakeApi();
    const r = await callTool(
      "verify_history",
      { module: "../../etc", env: "local" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
  });
});
