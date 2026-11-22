/**
 * issue_write, the MCP side: always registered (a direct, audited action,
 * not a held write and not an mcp.actions one), it checks its input and
 * its project, then asks the web server once (POST
 * /api/agents/self/issue-write), which runs it as the agent. Refused
 * input, a closing action or another project's name: nothing is sent.
 */
import { describe, expect, it } from "@jest/globals";
import {
  callTool,
  toolsFor,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import {
  DenHttpError,
  assertAllowedRequest,
  type DenApi,
} from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

const PATH = "/api/agents/self/issue-write";

function fakeApi(answer: () => unknown = () => ({ ok: true, issue: 42 })) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, _query, method, body) {
      calls.push({ path, method, body });
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      if (path === "/api/activity") return { ok: true };
      if (path === PATH) return answer();
      throw new DenHttpError("GET", path, 404, "not found");
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}

const cfg = (): ResolvedMcpConfig => ({
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

const ctx = (api: DenApi, scoped = true): ToolContext => ({
  api,
  cfg: cfg(),
  cli: "acme",
  ...(scoped ? { scope: { workspace: "north", actor: "agent:a1" } } : {}),
});

const sent = (calls: { path: string }[]) =>
  calls.filter((c) => c.path === PATH);

describe("issue_write (MCP)", () => {
  it("is registered with no mcp.actions and held writes off, and its route is allowed", () => {
    expect(toolsFor(cfg()).map((t) => t.name)).toContain("issue_write");
    expect(
      toolsFor({ ...cfg(), approvals: false }).map((t) => t.name),
    ).toContain("issue_write");
    expect(() => assertAllowedRequest("POST", PATH, {})).not.toThrow();
  });

  it("sends one call with the action and its fields, the project its own", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "issue_write",
      {
        action: "create",
        repo: "acme/api",
        title: "Save fails",
        body: "Steps…",
        labels: ["bug"],
      },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(sent(calls)).toEqual([
      {
        path: PATH,
        method: "POST",
        body: {
          project: "north",
          action: "create",
          repo: "acme/api",
          title: "Save fails",
          body: "Steps…",
          labels: ["bug"],
        },
      },
    ]);
  });

  it("another project, close, or bad input: refused, nothing sent", async () => {
    const { api, calls } = fakeApi();
    for (const args of [
      { project: "south", action: "comment", repo: "a/b", issue: 1, body: "x" },
      { action: "close", repo: "a/b", issue: 1 },
      { action: "delete", repo: "a/b", issue: 1 },
      { action: "transfer", repo: "a/b", issue: 1 },
      { action: "create", repo: "a/b", title: "" },
      { action: "comment", repo: "a/b", issue: -3, body: "x" },
    ]) {
      const r = await callTool("issue_write", args, ctx(api));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Refused: issue_write: /);
    }
    expect(sent(calls)).toEqual([]);
  });

  it("Den's own agent (no scope) must name the project", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "issue_write",
      { action: "comment", repo: "a/b", issue: 1, body: "x" },
      ctx(api, false),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/project/);
    expect(sent(calls)).toEqual([]);
  });

  it("the server's refusal comes back plainly, with its reason", async () => {
    const { api } = fakeApi(() => {
      throw new DenHttpError(
        "POST",
        PATH,
        429,
        JSON.stringify({
          ok: false,
          code: "issue_write_limit",
          error:
            "this Den made 60 issue writes in the last hour; try again in 12 minutes",
        }),
      );
    });
    const r = await callTool(
      "issue_write",
      { action: "comment", repo: "a/b", issue: 1, body: "x" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Refused: issue_write: this Den made 60 issue writes in the last hour; try again in 12 minutes (429)",
    );
  });
});
