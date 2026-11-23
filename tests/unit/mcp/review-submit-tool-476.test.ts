/**
 * Issue 476: review_submit, the MCP tool a review leg calls once with its
 * findings. An agent's tool only (the server takes the agent from its
 * token); it posts to the leg route, and a refusal reaches the agent as a
 * refusal with the reason.
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

function fakeApi(
  answer: () => unknown = () => ({ ok: true, outcome: "converged" }),
) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, _q, method, body) {
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      calls.push({ path, method, body });
      const a = answer();
      if (a instanceof Error) throw a;
      return a;
    },
    async stream() {
      throw new Error("no streams");
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
  ...(scoped ? { scope: { workspace: "north", actor: "agent:rev-1" } } : {}),
});
const args = {
  leg: "f".repeat(32),
  repo: "octo/app",
  pr: 3,
  sha: "a".repeat(40),
  verdict: "One finding.",
  findings: [
    {
      id: "f-1",
      path: "src/a.ts",
      line: 4,
      severity: "high",
      lens: "correctness",
      blocking: true,
      body: "Off by one.",
    },
  ],
  depth: "standard",
  model: "claude-opus-5-5",
};

describe("review_submit", () => {
  it("is a read tool (it changes nothing the agent owns), and its route is open", () => {
    expect(READ_TOOL_NAMES).toContain("review_submit");
    expect(() =>
      assertAllowedRequest("POST", "/api/agents/self/review-submit", {}),
    ).not.toThrow();
  });

  it("posts the findings to the leg route", async () => {
    const { api, calls } = fakeApi();
    const out = await callTool("review_submit", args, ctx(api));
    expect(JSON.stringify(out)).toContain("converged");
    expect(calls).toEqual([
      {
        path: "/api/agents/self/review-submit",
        method: "POST",
        body: { ...args, tokens: null, costUsd: null },
      },
    ]);
  });

  it("an MCP server that isn't an agent's can't call it", async () => {
    const { api, calls } = fakeApi();
    const out = (await callTool("review_submit", args, ctx(api, false))) as {
      isError?: boolean;
      text?: string;
    };
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/review leg/);
    expect(calls).toHaveLength(0);
  });

  it("a refusal reaches the agent with its reason", async () => {
    const { api } = fakeApi(
      () =>
        new DenHttpError(
          "POST",
          "/api/agents/self/review-submit",
          409,
          JSON.stringify({
            ok: false,
            code: "wrong_head",
            error: "review_submit refused: wrong head.",
          }),
        ),
    );
    const out = (await callTool("review_submit", args, ctx(api))) as {
      isError?: boolean;
      text?: string;
    };
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/wrong head/);
  });
});
