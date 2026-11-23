/**
 * Issue 772, the MCP side: agent_prompt (a held write, through POST
 * /api/approvals) and agent_wait (read-only, polls GET
 * /api/agents/prompt-state).
 *
 *   5. agent_wait returns as soon as the target reaches the state; past the
 *      timeout it returns a timeout result, with no resend and no write
 *   9. both are in the tool list (agent_prompt a held write)
 */
import { describe, expect, it } from "@jest/globals";
import {
  APPROVAL_TOOL_NAMES,
  READ_TOOL_NAMES,
  callTool,
  toolsFor,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import {
  DenHttpError,
  assertAllowedRequest,
  type DenApi,
  type Query,
} from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

interface Call {
  path: string;
  query?: Query;
  method?: string;
  body?: unknown;
}

/** A fake web server: each prompt-state GET walks `states`. */
function fakeApi(
  states: (string | null)[],
  post: () => unknown = () => ({
    id: "AbCdEfGhIjKlMnOp",
    state: "done",
    result: { ok: true, agent: "builder", state: "working" },
  }),
) {
  const calls: Call[] = [];
  let i = 0;
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, query, method, body) {
      calls.push({ path, query, method, body });
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      if (path === "/api/approvals" && method === "POST") return post();
      if (path === "/api/agents/prompt-state")
        return {
          ok: true,
          agent: query?.agent,
          state: states[Math.min(i++, states.length - 1)],
        };
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

const ctx = (api: DenApi): ToolContext => ({
  api,
  cfg: cfg(),
  cli: "acme",
  approvalWait: { intervalMs: 1, waitMs: 50, sleep: async () => undefined },
  scope: { workspace: "north", actor: "agent:planner" },
});

describe("772: registration", () => {
  it("9: agent_prompt is a held write, agent_wait a read; both listed", () => {
    const names = toolsFor(cfg()).map((t) => t.name);
    expect(names).toContain("agent_prompt");
    expect(names).toContain("agent_wait");
    expect(APPROVAL_TOOL_NAMES).toContain("agent_prompt");
    expect(READ_TOOL_NAMES).toContain("agent_wait");
    const prompt = toolsFor(cfg()).find((t) => t.name === "agent_prompt");
    expect(prompt?.action).toBe(true);
  });

  it("the API client may GET the prompt state", () => {
    expect(() =>
      assertAllowedRequest("GET", "/api/agents/prompt-state", {}),
    ).not.toThrow();
  });
});

describe("772: agent_wait", () => {
  it("5: returns as soon as the target reaches the state", async () => {
    const f = fakeApi(["idle", "working", "working"]);
    const r = await callTool(
      "agent_wait",
      { agent: "builder", until: "working", timeout: 30 },
      ctx(f.api),
    );
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({
      agent: "builder",
      state: "working",
      reached: true,
    });
    const polls = f.calls.filter((c) => c.path === "/api/agents/prompt-state");
    expect(polls).toHaveLength(2);
  });

  it("blocked means it needs its person", async () => {
    const f = fakeApi(["working", "needs"]);
    const r = await callTool(
      "agent_wait",
      { agent: "builder", until: "blocked", timeout: 30 },
      ctx(f.api),
    );
    expect(JSON.parse(r.text)).toMatchObject({ state: "needs", reached: true });
  });

  it("5: past the timeout: a timeout result, only reads, nothing sent", async () => {
    const f = fakeApi(["working"]);
    const r = await callTool(
      "agent_wait",
      { agent: "builder", until: "done", timeout: 1 },
      ctx(f.api),
    );
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({
      state: "working",
      reached: false,
      timedOut: true,
    });
    expect(f.calls.every((c) => (c.method ?? "GET") === "GET")).toBe(true);
    expect(f.calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });

  it("an agent that isn't running ends the wait: ended", async () => {
    const f = fakeApi([null]);
    const r = await callTool(
      "agent_wait",
      { agent: "builder", until: "done", timeout: 30 },
      ctx(f.api),
    );
    expect(JSON.parse(r.text)).toMatchObject({
      state: null,
      reached: false,
      ended: true,
    });
  });
});

describe("772: agent_prompt", () => {
  it("asks through the approvals route with the agent and the text", async () => {
    const f = fakeApi(["working"]);
    const r = await callTool(
      "agent_prompt",
      { agent: "builder", text: "run the tests" },
      ctx(f.api),
    );
    expect(r.isError).toBe(false);
    const post = f.calls.find(
      (c) => c.path === "/api/approvals" && c.method === "POST",
    );
    expect(post?.body).toMatchObject({
      action: "agent_prompt",
      args: { agent: "builder", text: "run the tests" },
    });
  });

  it("with wait: after it runs, waits for the state (one prompt, then reads)", async () => {
    const f = fakeApi(["working", "done"]);
    const r = await callTool(
      "agent_prompt",
      { agent: "builder", text: "go", wait: "done", timeout: 30 },
      ctx(f.api),
    );
    expect(JSON.parse(r.text)).toMatchObject({
      approved: true,
      wait: { state: "done", reached: true },
    });
    expect(
      f.calls.filter((c) => c.path === "/api/approvals" && c.method === "POST"),
    ).toHaveLength(1);
  });

  it("6: never itself (refused before anything is asked)", async () => {
    const f = fakeApi(["idle"]);
    const r = await callTool(
      "agent_prompt",
      { agent: "planner", text: "hi" },
      ctx(f.api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/itself/);
    expect(f.calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });
});
