/**
 * Issue 210: verify_result, the agent's read of one Verify run. A run on
 * a shared environment starts when the person allows it and answers its
 * run id (approval_check's result); the agent reads the run's progress
 * and verdict here. Reads only, in the agent's own project.
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

function fakeApi() {
  const calls: { path: string; query?: Query; method?: string }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, query, method) {
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      calls.push({ path, query, method });
      if (path === "/api/verify/runs/20261115-abc123")
        return { ok: true, runId: "20261115-abc123", verdict: "running" };
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

describe("issue 210: verify_result", () => {
  it("is a read, and GET /api/verify/runs/:id is open to agents (reads only)", () => {
    expect(READ_TOOL_NAMES).toContain("verify_result");
    expect(() =>
      assertAllowedRequest("GET", "/api/verify/runs/20261115-abc123", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", "/api/verify/runs/20261115-abc123", {}),
    ).toThrow(Refusal);
  });

  it("reads the run in the agent's own project", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "verify_result",
      { run: "20261115-abc123" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("running");
    expect(calls[0]).toMatchObject({
      path: "/api/verify/runs/20261115-abc123",
      query: { project: "north" },
    });
  });

  it("refuses a run id that isn't one", async () => {
    const { api } = fakeApi();
    const r = await callTool("verify_result", { run: "../x" }, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/run id/);
  });
});
