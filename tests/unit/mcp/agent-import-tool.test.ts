/**
 * MCP agent_import (AG-17.1): scoped like agent_resume (its own
 * workspace, or a granted one). With no session it lists the conversations
 * to bring in (opted in through mcp.actions); with one it asks the person
 * to bring it in: a held write (issue 160). The web
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
      // Issue 160: the bring-in is a held write; this one was allowed.
      if (path === "/api/approvals" && method === "POST")
        return { id: "r1", state: "done", result: { ok: true, id: "planner" } };
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
  approvals: true,
};
const off = { ...on, actions: [] };
const SCOPE: McpScope = {
  workspace: "north",
  actor: "agent:orchestrator",
  grants: ["south"],
};

describe("the agent_import tool", () => {
  it("issue 160: a held write, registered with the held writes (once), not only when mcp.actions names it", () => {
    expect(MCP_ACTIONS).toContain("agent_import");
    const names = (c: typeof on) => toolsFor(c).map((t) => t.name);
    expect(names(off)).toContain("agent_import");
    expect(names(on).filter((n) => n === "agent_import")).toHaveLength(1);
    // Held writes off: only the opt-in registers it (its list).
    expect(names({ ...off, approvals: false })).not.toContain("agent_import");
  });

  it("with no session, lists; with one, asks the person to bring it in (a held write)", async () => {
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
    // Never the import route itself: POST /api/approvals, held for the person.
    expect(bring.calls.some((c) => /\/import$/.test(c.path))).toBe(false);
    const post = bring.calls.find((c) => c.path === "/api/approvals");
    expect(post).toMatchObject({
      method: "POST",
      body: {
        action: "agent_import",
        args: { project: "north", session: "abc-123", persona: "planner" },
      },
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
    // Issue 160: the import route is never an agent's, opted in or not:
    // it asks with the held write.
    expect(
      agentRefusal(
        p,
        "POST",
        "/api/workspaces/north/conversations/abc/import",
        "shell-grade",
      ),
    ).toMatch(/held write: ask with agent_import/);
  });
});
