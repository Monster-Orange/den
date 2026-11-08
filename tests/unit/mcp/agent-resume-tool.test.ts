/**
 * MCP agent_resume (AG-14.4): opt-in through mcp.actions, for orchestrators,
 * scoped as agent_spawn is (its own workspace, or a granted one), never the
 * caller itself. The web server checks the same rule again
 * (agent-resume-grant.ts), and only that one route is open to an agent's
 * token. The API is a fake that records what was asked of it.
 */
import { describe, expect, it } from "@jest/globals";
import { MCP_ACTIONS } from "../../../src/shared/den-config.js";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import { Refusal } from "../../../src/ui/mcp/guards.js";
import type { McpScope } from "../../../src/ui/mcp/scope.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";
import {
  agentResumeRefusal,
  agentResumeTarget,
} from "../../../src/ui/server/agent-resume-grant.js";
import { agentRefusal } from "../../../src/ui/server/request-guard.js";

interface Call {
  path: string;
  method?: string;
  body?: unknown;
}

function fakeApi(): { api: DenApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7777",
    async get(path, _query, method, body) {
      calls.push({ path, method, ...(body !== undefined ? { body } : {}) });
      if (path === "/api/workspaces")
        return {
          active: ["north", "south"],
          focus: "north",
          workspaces: { north: {}, south: {}, east: {} },
        };
      return { ok: true, agent: { id: "sde-1" } };
    },
    async stream() {
      throw new Error("no stream here");
    },
  };
  return { api, calls };
}

const on = {
  actions: ["agent_resume" as const],
  runTestsEnvs: ["local" as const],
  logsRemote: false,
  approvals: true,
};
const off = { ...on, actions: [] };
const SCOPE: McpScope = {
  workspace: "north",
  actor: "agent:orchestrator",
  grants: ["south"],
};

describe("the agent_resume tool", () => {
  it("is an MCP action, off unless mcp.actions names it", () => {
    expect(MCP_ACTIONS).toContain("agent_resume");
    expect(toolsFor(off).map((t) => t.name)).not.toContain("agent_resume");
    expect(toolsFor(on).map((t) => t.name)).toContain("agent_resume");
  });

  it("resumes an agent of its own workspace through the resume route", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "agent_resume",
      { agent: "sde-1" },
      { api, cfg: on, cli: "acme", scope: { ...SCOPE } },
    );
    expect(r.isError).toBe(false);
    const post = calls.find(
      (c) => c.method === "POST" && /resume$/.test(c.path),
    );
    expect(post?.path).toBe("/api/workspaces/north/agents/sde-1/resume");
  });

  it("a granted workspace is served (and reported); another one is refused before anything is asked", async () => {
    const granted = fakeApi();
    const ok = await callTool(
      "agent_resume",
      { agent: "sde-2", workspace: "south" },
      { api: granted.api, cfg: on, cli: "acme", scope: { ...SCOPE } },
    );
    expect(ok.isError).toBe(false);
    expect(granted.calls.map((c) => c.path)).toContain(
      "/api/workspaces/south/agents/sde-2/resume",
    );
    expect(granted.calls.some((c) => c.path === "/api/activity")).toBe(true);

    const other = fakeApi();
    const no = await callTool(
      "agent_resume",
      { agent: "sde-3", workspace: "east" },
      { api: other.api, cfg: on, cli: "acme", scope: { ...SCOPE } },
    );
    expect(no.isError).toBe(true);
    expect(other.calls.some((c) => /\/resume$/.test(c.path))).toBe(false);
  });

  it("never resumes itself", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "agent_resume",
      { agent: "orchestrator" },
      { api, cfg: on, cli: "acme", scope: { ...SCOPE } },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/can't resume itself/);
    expect(calls.some((c) => /\/resume$/.test(c.path))).toBe(false);
  });

  it("the resume route is the one agent route the MCP client may call; start, stop and remove are not", () => {
    expect(() =>
      assertAllowedRequest(
        "POST",
        "/api/workspaces/north/agents/sde-1/resume",
        {},
      ),
    ).not.toThrow();
    for (const p of [
      "/api/workspaces/north/agents",
      "/api/workspaces/north/agents/sde-1/stop",
      "/api/workspaces/north/agents/sde-1/fresh",
      "/api/workspaces/north/agents/sde-1/remove",
      "/api/workspaces/north/agents/../x/resume",
    ])
      expect(() => assertAllowedRequest("POST", p, {})).toThrow(Refusal);
  });
});

describe("the web server's rule (agent-resume-grant.ts)", () => {
  const me = {
    actor: "agent:orchestrator",
    workspace: "north",
    grants: ["south"],
  };

  it("needs mcp.actions to list agent_resume", () => {
    expect(agentResumeRefusal(me, "north", "sde-1", [])).toMatch(
      /mcp\.actions doesn't list agent_resume/,
    );
    expect(
      agentResumeRefusal(me, "north", "sde-1", ["agent_resume"]),
    ).toBeNull();
  });

  it("its own workspace or a granted one; never another, never itself", () => {
    const a = ["agent_resume"];
    expect(agentResumeRefusal(me, "south", "sde-1", a)).toBeNull();
    expect(agentResumeRefusal(me, "east", "sde-1", a)).toMatch(/not east/);
    expect(agentResumeRefusal(me, "north", "orchestrator", a)).toMatch(
      /can't resume itself/,
    );
  });

  it("reads the route's workspace and agent", () => {
    expect(
      agentResumeTarget("/api/workspaces/north/agents/sde-1/resume"),
    ).toEqual({
      ws: "north",
      id: "sde-1",
    });
    expect(
      agentResumeTarget("/api/workspaces/north/agents/sde-1/stop"),
    ).toBeNull();
  });

  it("the request checks still refuse an agent's start, stop and remove, and its resume without the opt-in", () => {
    const p = {
      kind: "agent" as const,
      actor: "agent:orchestrator" as const,
      workspace: "north",
      grants: ["south"],
      session: { name: "acme-north:orchestrator", id: "s1" },
    };
    expect(
      agentRefusal(p, "POST", "/api/workspaces/north/agents", "shell-grade"),
    ).toMatch(/a person's/);
    expect(
      agentRefusal(
        p,
        "POST",
        "/api/workspaces/north/agents/sde-1/fresh",
        "shell-grade",
      ),
    ).toMatch(/a person's/);
    // This test's org config names no mcp.actions: the resume is refused too.
    expect(
      agentRefusal(
        p,
        "POST",
        "/api/workspaces/north/agents/sde-1/resume",
        "shell-grade",
      ),
    ).toMatch(/agent_resume/);
  });
});
