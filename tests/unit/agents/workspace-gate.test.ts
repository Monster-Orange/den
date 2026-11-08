/**
 * The AG-2a gate (AG spec §5b, §6): an agent started in one workspace
 * cannot list another workspace's services through its MCP; with a grant
 * for it (config, agents.<id>.grants) it can, and the audit names both
 * workspaces. The MCP side is driven exactly as AG-2a-core's tests drive
 * it: the scope comes from the agent's own MCP config file, the web API is
 * a fake that records each call.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { callTool, ACTION_TOOL_NAMES } from "../../../src/ui/mcp/tools.js";
import {
  checkGrants,
  parseScopeFlags,
  type McpScope,
} from "../../../src/ui/mcp/scope.js";
import type { DenApi, Query } from "../../../src/ui/mcp/api.js";
import {
  actorFromHeaders,
  agentAuditHeaders,
} from "../../../src/shared/agent-actor.js";
import {
  recordCrossWorkspace,
  setAuditSink,
} from "../../../src/ui/server/audit.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  setAuditSink(null);
  await cleanupRigs();
});

interface Call {
  path: string;
  query?: Query;
  body?: unknown;
}

const WORKSPACES = {
  active: ["north", "south"],
  focus: "north",
  workspaces: {
    north: { services: { shop: { mode: "managed" } } },
    south: { services: { billing: { mode: "managed" } } },
  },
  resolvedDirs: { north: "/w/north", south: "/w/south" },
};

const SERVICES: Record<string, unknown[]> = {
  north: [{ repo: "shop", service: "api", repoPath: "/repos/shop" }],
  south: [{ repo: "billing", service: "api", repoPath: "/repos/billing" }],
};

function fakeApi(): { api: DenApi; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    api: {
      baseUrl: "http://localhost:7001",
      async get(path, query, _method, body) {
        calls.push({ path, query, ...(body !== undefined ? { body } : {}) });
        if (path === "/api/workspaces") return WORKSPACES;
        if (path === "/api/services")
          return SERVICES[String(query?.workspace)] ?? [];
        return {};
      },
      async stream() {
        return { events: [], lines: [], ended: "done", exitCode: 0 };
      },
    },
  };
}

/** The scope the agent's MCP server runs with: its own config file's argv. */
async function agentScope(r: Rig): Promise<McpScope> {
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  const p = r.made[0];
  const cfg = JSON.parse(
    fs.readFileSync(p.args[p.args.indexOf("--mcp-config") + 1], "utf-8"),
  );
  const [sub, ...argv] = cfg.mcpServers.acme.args as string[];
  expect(sub).toBe("mcp");
  const { scope, rest } = parseScopeFlags(argv);
  expect(rest).toEqual([]);
  return scope!;
}

const ctx = (api: DenApi, scope: McpScope) => ({
  api,
  cfg: {
    actions: [...ACTION_TOOL_NAMES],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  },
  cli: "acme",
  scope,
});

describe("an agent's MCP is pinned to its workspace", () => {
  it("an agent started in north cannot list south's services", async () => {
    const r = await rig();
    const scope = await agentScope(r);
    expect(scope).toEqual({ workspace: "north", actor: "agent:planner" });
    const { api, calls } = fakeApi();
    const res = await callTool(
      "services",
      { workspace: "south" },
      ctx(api, scope),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(
      /scoped to workspace "north".*"south" is another workspace/,
    );
    // The refusal says what the agent may reach: here, nothing more.
    expect(res.text).toMatch(/\(agent:planner; no grants\)/);
    expect(calls.filter((c) => c.path === "/api/services")).toEqual([]);
    const ws = await callTool("workspaces", {}, ctx(api, scope));
    expect(ws.text).not.toContain("south");
  });

  it("with agents.planner.grants: [south] it can, and the audit names both", async () => {
    const r = await rig();
    r.config.agents = { planner: { grants: ["south"] } };
    const scope = await agentScope(r);
    expect(scope).toEqual({
      workspace: "north",
      actor: "agent:planner",
      grants: ["south"],
    });
    expect(checkGrants(scope, r.config)).toBeNull();
    const { api, calls } = fakeApi();
    const res = await callTool(
      "services",
      { workspace: "south" },
      ctx(api, scope),
    );
    expect(res.isError).toBe(false);
    expect(res.text).toContain("billing");
    // Its own workspace is no cross-workspace call.
    await callTool("services", {}, ctx(api, scope));
    const reports = calls.filter((c) => c.path === "/api/activity");
    expect(reports).toHaveLength(1);
    expect(reports[0].body).toEqual({
      tool: "services",
      crossWorkspace: "south",
    });
    // The listing names the granted workspace, never one beyond the grant.
    const ws = JSON.parse(
      (await callTool("workspaces", {}, ctx(api, scope))).text,
    );
    expect(Object.keys(ws.workspaces).sort()).toEqual(["north", "south"]);

    // The web server records the report under both workspaces.
    const lines: string[] = [];
    setAuditSink((l) => lines.push(l));
    const actor = actorFromHeaders(
      agentAuditHeaders({
        client: "claude-code",
        clientVersion: "1",
        mcpPid: 1,
        session: "s",
        agent: scope.actor,
        workspace: scope.workspace,
      }),
    );
    const entry = recordCrossWorkspace(
      actor,
      reports[0].body as Record<string, unknown>,
    );
    expect(entry).toMatchObject({
      agent: "agent:planner",
      workspace: "north",
      targetWorkspace: "south",
      verb: "services",
    });
    expect(lines[0]).toMatch(
      /services in workspace south.*agent:planner.*workspace north/,
    );
  });

  it("a grant beyond the one config gives is refused", async () => {
    const r = await rig();
    r.config.agents = { planner: { grants: ["south"] } };
    const { api, calls } = fakeApi();
    const scope = await agentScope(r);
    const res = await callTool(
      "services",
      { workspace: "other" },
      ctx(api, scope),
    );
    expect(res.text).toMatch(/^Refused: .*"other" is another workspace/);
    expect(res.text).toMatch(/\(agent:planner; grants: south\)/);
    expect(calls.filter((c) => c.path === "/api/services")).toEqual([]);
  });

  it("an agent cannot grant itself: --grant must be in agents.<id>.grants", async () => {
    const r = await rig();
    const scope = await agentScope(r);
    const self = { ...scope, grants: ["south"] };
    expect(checkGrants(self, r.config)).toMatch(
      /--grant south: agent:planner has no such grant in agents\.planner\.grants/,
    );
    expect(() => parseScopeFlags(["--grant", "south"])).toThrow(
      /--grant needs --workspace and --actor/,
    );
    expect(() =>
      parseScopeFlags(["-w", "north", "--actor", "agent:a", "--grant", "../x"]),
    ).toThrow(/--grant "\.\.\/x" is not a workspace name/);
  });

  it("recordCrossWorkspace refuses a report without a scoped actor or a target", () => {
    expect(
      recordCrossWorkspace(null, { tool: "services", crossWorkspace: "b" }),
    ).toBeNull();
    const actor = actorFromHeaders(
      agentAuditHeaders({
        client: "c",
        clientVersion: "1",
        mcpPid: 1,
        session: "s",
        agent: "agent:a",
        workspace: "north",
      }),
    );
    expect(
      recordCrossWorkspace(actor, {
        tool: "services",
        crossWorkspace: "north",
      }),
    ).toBeNull();
    expect(
      recordCrossWorkspace(actor, { tool: "services", crossWorkspace: "a b" }),
    ).toBeNull();
  });
});
