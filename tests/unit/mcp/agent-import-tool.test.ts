/**
 * MCP agent_import (AG-17.1): opt-in through mcp.actions, scoped like
 * agent_resume (its own workspace, or a granted one). With no session it
 * lists the conversations to bring in; with one it brings it in. The web
 * server checks the same rule again (agent-resume-grant.ts). The API is a
 * fake that records what was asked of it.
 */
import { describe, expect, it } from "@jest/globals";
import { MCP_ACTIONS } from "../../../src/shared/den-config.js";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import { Refusal } from "../../../src/ui/mcp/guards.js";
import type { McpScope } from "../../../src/ui/mcp/scope.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";
import { agentRefusal } from "../../../src/ui/server/request-guard.js";

interface Call {
  path: string;
  method?: string;
  query?: unknown;
  body?: unknown;
}

function fakeApi(): { api: DenApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7777",
    async get(path, query, method, body) {
      calls.push({
        path,
        method,
        query,
        ...(body !== undefined ? { body } : {}),
      });
      if (path === "/api/workspaces")
        return {
          active: ["north", "south"],
          focus: "north",
          workspaces: { north: {}, south: {}, east: {} },
        };
      return { ok: true, conversations: [] };
    },
    async stream() {
      throw new Error("no stream here");
    },
  };
  return { api, calls };
}

const on = {
  actions: ["agent_import" as const],
  runTestsEnvs: ["local" as const],
  logsRemote: false,
};
const off = { ...on, actions: [] };
const SCOPE: McpScope = {
  workspace: "north",
  actor: "agent:orchestrator",
  grants: ["south"],
};

describe("the agent_import tool", () => {
  it("is an MCP action, off unless mcp.actions names it", () => {
    expect(MCP_ACTIONS).toContain("agent_import");
    expect(toolsFor(off).map((t) => t.name)).not.toContain("agent_import");
    expect(toolsFor(on).map((t) => t.name)).toContain("agent_import");
  });

  it("with no session, lists; with one, brings it in with the persona", async () => {
    const list = fakeApi();
    expect(
      (
        await callTool(
          "agent_import",
          {},
          { api: list.api, cfg: on, cli: "acme", scope: { ...SCOPE } },
        )
      ).isError,
    ).toBe(false);
    expect(list.calls.map((c) => c.path)).toContain(
      "/api/workspaces/north/conversations",
    );

    const bring = fakeApi();
    const r = await callTool(
      "agent_import",
      { session: "abc-123", persona: "planner" },
      { api: bring.api, cfg: on, cli: "acme", scope: { ...SCOPE } },
    );
    expect(r.isError).toBe(false);
    const post = bring.calls.find((c) => /\/import$/.test(c.path));
    expect(post).toMatchObject({
      path: "/api/workspaces/north/conversations/abc-123/import",
      body: { persona: "planner" },
    });
  });

  it("a session needs a persona; another workspace is refused before anything is asked", async () => {
    const a = fakeApi();
    const noPersona = await callTool(
      "agent_import",
      { session: "abc-123" },
      { api: a.api, cfg: on, cli: "acme", scope: { ...SCOPE } },
    );
    expect(noPersona.isError).toBe(true);
    const b = fakeApi();
    const other = await callTool(
      "agent_import",
      { session: "abc-123", persona: "planner", workspace: "east" },
      { api: b.api, cfg: on, cli: "acme", scope: { ...SCOPE } },
    );
    expect(other.isError).toBe(true);
    expect(b.calls.some((c) => /\/import$/.test(c.path))).toBe(false);
  });

  it("the MCP client may call the list and the import routes only", () => {
    expect(() =>
      assertAllowedRequest("GET", "/api/workspaces/north/conversations", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest(
        "POST",
        "/api/workspaces/north/conversations/abc-123/import",
        {},
      ),
    ).not.toThrow();
    for (const [m, p] of [
      ["POST", "/api/workspaces/north/conversations"],
      ["GET", "/api/workspaces/north/conversations/abc-123/import"],
      ["POST", "/api/workspaces/north/conversations/../x/import"],
    ])
      expect(() => assertAllowedRequest(m, p, {})).toThrow(Refusal);
  });

  it("the request checks refuse an agent's list and import without the opt-in", () => {
    const p = {
      kind: "agent" as const,
      actor: "agent:orchestrator" as const,
      workspace: "north",
      grants: ["south"],
      session: { name: "acme-north:orchestrator", id: "s1" },
    };
    expect(
      agentRefusal(p, "GET", "/api/workspaces/north/conversations", "read"),
    ).toMatch(/agent_import/);
    expect(
      agentRefusal(
        p,
        "POST",
        "/api/workspaces/north/conversations/abc/import",
        "shell-grade",
      ),
    ).toMatch(/agent_import/);
  });
});
