/**
 * github_watch, github_watch_list and github_watch_cancel: an agent asks
 * Den's one shared watcher to watch a pull request's checks or a workflow
 * run, instead of running `gh … --watch` itself. Read tools (no held
 * write): they change only the agent's own watches. Which agent comes from
 * its token; the server checks the repo is its project's. The API is a
 * fake that records what was asked.
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
} from "../../../src/ui/mcp/api.js";

function fakeApi(answer: (path: string) => unknown = () => ({ ok: true })) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, _query, method, body) {
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      calls.push({ path, method, body });
      const a = answer(path);
      if (a instanceof Error) throw a;
      return a;
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}

const ctx = (api: DenApi, scoped = true): ToolContext => ({
  api,
  cfg: {
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  },
  cli: "acme",
  ...(scoped ? { scope: { workspace: "north", actor: "agent:planner" } } : {}),
});

describe("github_watch tools", () => {
  it("are read tools, always there", () => {
    for (const n of [
      "github_watch",
      "github_watch_list",
      "github_watch_cancel",
    ])
      expect(READ_TOOL_NAMES).toContain(n);
  });

  it("their routes are open to the MCP client", () => {
    expect(() =>
      assertAllowedRequest("POST", "/api/agents/self/github-watches", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("GET", "/api/agents/self/github-watches", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest(
        "POST",
        "/api/agents/self/github-watches/cancel",
        {},
      ),
    ).not.toThrow();
  });

  it("github_watch posts the repo and the pull request", async () => {
    const { api, calls } = fakeApi(() => ({
      ok: true,
      watch: { id: "gw-1", state: "running" },
    }));
    const r = await callTool(
      "github_watch",
      { repo: "acme/north", pr: 12 },
      ctx(api),
    );
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/agents/self/github-watches",
        method: "POST",
        body: { repo: "acme/north", pr: 12 },
      },
    ]);
    expect(r.text).toContain("gw-1");
  });

  it("github_watch takes a run instead, and refuses both or neither", async () => {
    const { api, calls } = fakeApi();
    await callTool("github_watch", { repo: "acme/north", run: 99 }, ctx(api));
    expect(calls[0].body).toEqual({ repo: "acme/north", run: 99 });
    for (const a of [
      { repo: "acme/north" },
      { repo: "acme/north", pr: 1, run: 2 },
    ]) {
      const r = await callTool("github_watch", a, ctx(api));
      expect(r.isError).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it("the server's refusal (another project's repo) reaches the agent as a refusal", async () => {
    const { api } = fakeApi(
      () =>
        new DenHttpError(
          "POST",
          "/api/agents/self/github-watches",
          403,
          JSON.stringify({
            ok: false,
            code: "scope",
            error: "other/elsewhere isn't a repo of your project",
          }),
        ),
    );
    const r = await callTool(
      "github_watch",
      { repo: "other/elsewhere", pr: 1 },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("isn't a repo of your project");
  });

  it("list and cancel ask for the agent's own", async () => {
    const { api, calls } = fakeApi(() => ({ ok: true, watches: [] }));
    await callTool("github_watch_list", {}, ctx(api));
    await callTool("github_watch_cancel", { id: "gw-1" }, ctx(api));
    expect(calls).toEqual([
      {
        path: "/api/agents/self/github-watches",
        method: "GET",
        body: undefined,
      },
      {
        path: "/api/agents/self/github-watches/cancel",
        method: "POST",
        body: { id: "gw-1" },
      },
    ]);
  });

  it("is an agent's: an unscoped server is refused", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "github_watch",
      { repo: "acme/north", pr: 1 },
      ctx(api, false),
    );
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
