/**
 * A scoped MCP server (AG-2a-core): `<cli> mcp --workspace <ws> --actor
 * agent:<id>` pins one workspace, refuses a call naming another, filters
 * lists to it and stamps the actor on every web API call. Unscoped, every
 * tool behaves as before. The web API is a fake that records each call.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ACTION_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import {
  parseScopeFlags,
  printablePath,
  type McpScope,
} from "../../../src/ui/mcp/scope.js";
import type { DenApi, Query } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";
import {
  AUDIT_HEADERS,
  actorFromHeaders,
  actorLabel,
  agentAuditHeaders,
} from "../../../src/shared/agent-actor.js";
import { recordAction, setAuditSink } from "../../../src/ui/server/audit.js";

interface Call {
  path: string;
  query?: Query;
  body?: unknown;
}

const WORKSPACES = {
  active: ["north", "south"],
  focus: "south",
  workspaces: {
    north: { services: { shop: { mode: "managed" } } },
    south: { services: { billing: { mode: "managed" } } },
  },
  resolvedDirs: { north: "/w/north", south: "/w/south" },
  codeWorkspacePaths: {},
};

const SERVICES: Record<string, unknown[]> = {
  north: [
    {
      repo: "shop",
      service: "api",
      commands: ["up", "down", "restart"],
      mode: "managed",
      repoPath: "/repos/shop",
      isEntrypoint: true,
    },
  ],
  south: [
    {
      repo: "billing",
      service: "api",
      commands: ["up", "down", "restart"],
      mode: "managed",
      repoPath: "/repos/billing",
      isEntrypoint: true,
    },
  ],
};

function fakeApi(workspaces: unknown = WORKSPACES): {
  api: DenApi;
  calls: Call[];
} {
  const calls: Call[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7777",
    async get(path, query, _method, body) {
      calls.push({ path, query, ...(body !== undefined ? { body } : {}) });
      if (path === "/api/workspaces") return workspaces;
      if (path === "/api/services")
        return SERVICES[String(query?.workspace ?? "south")] ?? [];
      return [{ path, workspace: query?.workspace ?? null }];
    },
    async stream(path, query) {
      calls.push({ path, query });
      return {
        events: [{ type: "done", exitCode: 0 }],
        lines: ["ok"],
        ended: "done",
        exitCode: 0,
      };
    },
  };
  return { api, calls };
}

const cfg: ResolvedMcpConfig = {
  actions: [...ACTION_TOOL_NAMES],
  runTestsEnvs: ["local"],
  logsRemote: false,
};

const SCOPE: McpScope = { workspace: "north", actor: "agent:planner" };

function ctx(api: DenApi, scope?: McpScope): ToolContext {
  return { api, cfg, cli: "acme", ...(scope ? { scope: { ...scope } } : {}) };
}

/** Calls beyond the scope's one existence check and any refusal report. */
const work = (calls: Call[]) =>
  calls.filter(
    (c) => c.path !== "/api/workspaces" && c.path !== "/api/activity",
  );

describe("--workspace / --actor", () => {
  it("both, in either form, make a scope; the rest of argv is kept", () => {
    expect(
      parseScopeFlags([
        "--workspace",
        "north",
        "--actor=agent:planner-1",
        "--port",
        "7001",
      ]),
    ).toEqual({
      scope: { workspace: "north", actor: "agent:planner-1" },
      rest: ["--port", "7001"],
    });
    expect(
      parseScopeFlags(["-w=north", "--actor", "agent:a.b_c", "--list"]).scope,
    ).toEqual({ workspace: "north", actor: "agent:a.b_c" });
  });

  it("neither: no scope, argv untouched (the unscoped server)", () => {
    const argv = ["--call", "status", "{}"];
    expect(parseScopeFlags(argv)).toEqual({ scope: null, rest: argv });
  });

  it("one without the other is a usage error", () => {
    expect(() => parseScopeFlags(["--workspace", "north"])).toThrow(
      /--workspace needs --actor agent:<id>/,
    );
    expect(() => parseScopeFlags(["--actor", "agent:x"])).toThrow(
      /--actor needs --workspace/,
    );
  });

  it("refuses a bad actor or workspace, saying the expected shape", () => {
    for (const bad of [
      "planner",
      "user:ward",
      "agent:",
      "agent:-x",
      "agent:a b",
      "agent:a/b",
      `agent:${"x".repeat(65)}`,
      "agent:\u001b[31mx",
    ])
      expect(() =>
        parseScopeFlags(["--workspace", "north", "--actor", bad]),
      ).toThrow(/is not agent:<id>/);
    for (const bad of ["../north", "-north", "a b", "north;rm"])
      expect(() =>
        parseScopeFlags([`--workspace=${bad}`, "--actor", "agent:x"]),
      ).toThrow(/is not a workspace name/);
    expect(() =>
      parseScopeFlags(["--workspace", "--actor", "agent:x"]),
    ).toThrow(/--workspace needs a value/);
  });
});

describe("a scoped server refuses another workspace", () => {
  it("a tool naming another workspace is refused before it reaches the API", async () => {
    const { api, calls } = fakeApi();
    for (const tool of [
      "status",
      "services",
      "applications",
      "graph",
      "stacks",
    ]) {
      const r = await callTool(tool, { workspace: "south" }, ctx(api, SCOPE));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(
        new RegExp(
          `^Refused: ${tool}: this MCP server is scoped to workspace "north" \\(agent:planner\\); "south" is another workspace`,
        ),
      );
    }
    expect(work(calls)).toEqual([]);
  });

  it("an action naming another workspace runs nothing and is recorded", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "service_up",
      { repo: "billing", workspace: "south" },
      ctx(api, SCOPE),
    );
    expect(r.isError).toBe(true);
    expect(work(calls)).toEqual([]);
    const report = calls.find((c) => c.path === "/api/activity");
    expect(report?.body).toMatchObject({
      tool: "service_up",
      repo: "billing",
      reason: expect.stringMatching(/scoped to workspace "north".*"south"/),
    });
  });

  it("a read refused for its workspace is recorded too", async () => {
    const { api, calls } = fakeApi();
    await callTool("services", { workspace: "south" }, ctx(api, SCOPE));
    expect(calls.some((c) => c.path === "/api/activity")).toBe(true);
  });

  it("a refused logs_search reports its targets, so each service's activity shows it", async () => {
    const { api, calls } = fakeApi();
    await callTool(
      "logs_search",
      { q: "error", targets: ["shop/api", "billing/api"] },
      ctx(api, SCOPE),
    );
    const report = calls.find((c) => c.path === "/api/activity");
    expect(report?.body).toMatchObject({
      tool: "logs_search",
      targets: ["shop/api", "billing/api"],
      reason: expect.stringMatching(/billing\/api is not a service/),
    });
  });

  it("a refused manifest_validate reports its path, so the server can name the repo", async () => {
    const { api, calls } = fakeApi();
    await callTool(
      "manifest_validate",
      { path: "/repos/billing/.den.yml" },
      ctx(api, SCOPE),
    );
    const report = calls.find((c) => c.path === "/api/activity");
    expect(report?.body).toMatchObject({
      tool: "manifest_validate",
      path: "/repos/billing/.den.yml",
      reason: expect.stringMatching(
        /is not inside a repo of workspace "north"/,
      ),
    });
  });

  it("a refused manifest_validate names a long path whole, never cut mid-filename (0.3.0-dev.40)", async () => {
    const long = `/Users/someone/Projects/${"deeply-nested-folder/".repeat(4)}billing/.den.yml`;
    const { api } = fakeApi();
    const r = await callTool(
      "manifest_validate",
      { path: long },
      ctx(api, SCOPE),
    );
    expect(long.length).toBeGreaterThan(80);
    expect(r.text).toContain(`manifest_validate: ${long} is not inside`);
  });

  it("printablePath elides the middle of a very long path and keeps its filename", () => {
    const name = "a-rather-long-manifest-name.den.yml";
    const p = `/start/${"x/".repeat(200)}${name}`;
    const out = printablePath(p);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.startsWith("/start/")).toBe(true);
    expect(out.endsWith(`/${name}`)).toBe(true);
    expect(out).toContain("…");
    expect(printablePath("/short/.den.yml")).toBe("/short/.den.yml");
  });

  it("a repo of another workspace is not served: logs, lifecycle, manifests", async () => {
    const { api, calls } = fakeApi();
    const tail = await callTool(
      "logs_tail",
      { repo: "billing", service: "api" },
      ctx(api, SCOPE),
    );
    expect(tail.text).toMatch(
      /^Refused: logs_tail: billing\/api is not a service of workspace "north"/,
    );
    const search = await callTool(
      "logs_search",
      { q: "error", targets: ["shop/api", "billing/api"] },
      ctx(api, SCOPE),
    );
    expect(search.text).toMatch(/billing\/api is not a service/);
    // Pinned to north, a repo only south has is not found there.
    const up = await callTool(
      "service_up",
      { repo: "billing" },
      ctx(api, SCOPE),
    );
    expect(up.text).toMatch(/no service in repo "billing"/);
    const man = await callTool(
      "manifest_validate",
      { path: "/repos/billing/.den.yml" },
      ctx(api, SCOPE),
    );
    expect(man.text).toMatch(/is not inside a repo of workspace "north"/);
    const rel = await callTool(
      "manifest_validate",
      { path: "../billing" },
      ctx(api, SCOPE),
    );
    expect(rel.text).toMatch(/takes an absolute path/);
    expect(
      work(calls).filter(
        (c) =>
          c.path !== "/api/services" ||
          (c.query as Query | undefined)?.workspace !== "north",
      ),
    ).toEqual([]);
  });

  it("tests run on the focused workspace: refused when that is another", async () => {
    const { api, calls } = fakeApi();
    for (const [tool, args] of [
      ["tests_available", { pillar: "smoke" }],
      ["run_tests", { pillar: "smoke" }],
    ] as const) {
      const r = await callTool(tool, { ...args }, ctx(api, SCOPE));
      expect(r.text).toMatch(
        new RegExp(
          `^Refused: ${tool}: tests run against the focused workspace \\("south"\\)`,
        ),
      );
    }
    expect(work(calls)).toEqual([]);
  });

  it("a scope naming a workspace that does not exist serves nothing", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "services",
      {},
      ctx(api, { workspace: "nope", actor: "agent:x" }),
    );
    expect(r.text).toMatch(/scoped to workspace "nope", which does not exist/);
    expect(work(calls)).toEqual([]);
  });
});

describe("a scoped server pins and filters", () => {
  it("a tool without a workspace argument gets the scoped one", async () => {
    const { api, calls } = fakeApi();
    for (const tool of [
      "status",
      "services",
      "applications",
      "graph",
      "stacks",
    ])
      expect((await callTool(tool, {}, ctx(api, SCOPE))).isError).toBe(false);
    // Naming its own workspace is fine too.
    await callTool("status", { workspace: "north" }, ctx(api, SCOPE));
    for (const c of work(calls))
      expect((c.query as Query).workspace).toBe("north");
  });

  it("workspaces lists the scoped workspace only", async () => {
    const { api } = fakeApi();
    const r = await callTool("workspaces", {}, ctx(api, SCOPE));
    expect(JSON.parse(r.text)).toEqual({
      active: ["north"],
      workspaces: { north: WORKSPACES.workspaces.north },
      resolvedDirs: { north: "/w/north" },
      codeWorkspacePaths: {},
      scope: { workspace: "north", actor: "agent:planner" },
    });
    expect(r.text).not.toContain("south");
  });

  it("lifecycle and sync name the scoped workspace", async () => {
    const { api, calls } = fakeApi();
    expect(
      (await callTool("service_up", { repo: "shop" }, ctx(api, SCOPE))).isError,
    ).toBe(false);
    expect(
      (await callTool("workspace_sync", { repo: "shop" }, ctx(api, SCOPE)))
        .isError,
    ).toBe(false);
    expect(
      calls.find((c) => c.path === "/api/service/exec")?.query,
    ).toMatchObject({ repo: "shop", workspace: "north" });
    expect(calls.find((c) => c.path === "/api/workspace/sync")?.query).toEqual({
      repo: "shop",
      workspace: "north",
    });
  });

  it("its own service's logs and manifest are served", async () => {
    const { api } = fakeApi();
    expect(
      (
        await callTool(
          "logs_tail",
          { repo: "shop", service: "api" },
          ctx(api, SCOPE),
        )
      ).isError,
    ).toBe(false);
    expect(
      (
        await callTool(
          "manifest_validate",
          { path: "/repos/shop/.den.yml" },
          ctx(api, SCOPE),
        )
      ).isError,
    ).toBe(false);
  });

  it("tests are served when the scoped workspace is the focused one", async () => {
    const { api } = fakeApi({ ...WORKSPACES, focus: "north" });
    const r = await callTool(
      "tests_available",
      { pillar: "smoke" },
      ctx(api, SCOPE),
    );
    expect(r.isError).toBe(false);
  });

  it("checks the workspace exists once per server", async () => {
    const { api, calls } = fakeApi();
    const c = ctx(api, SCOPE);
    await callTool("status", {}, c);
    await callTool("services", {}, c);
    expect(calls.filter((x) => x.path === "/api/workspaces")).toHaveLength(1);
  });
});

describe("unscoped behaviour is unchanged", () => {
  it("another workspace is passed through, no workspace is sent as none", async () => {
    const { api, calls } = fakeApi();
    expect(
      (await callTool("services", { workspace: "south" }, ctx(api))).isError,
    ).toBe(false);
    await callTool("status", {}, ctx(api));
    expect(calls).toEqual([
      {
        path: "/api/services",
        query: { env: "local", workspace: "south" },
      },
      { path: "/api/health", query: { env: "local", workspace: undefined } },
    ]);
  });

  it("workspaces is the web server's answer as it is", async () => {
    const { api } = fakeApi();
    const r = await callTool("workspaces", {}, ctx(api));
    expect(JSON.parse(r.text)).toEqual(WORKSPACES);
  });

  it("logs, tests and sync make the same calls as before", async () => {
    const { api, calls } = fakeApi();
    await callTool("logs_tail", { repo: "billing", service: "api" }, ctx(api));
    await callTool("tests_available", { pillar: "smoke" }, ctx(api));
    await callTool("workspace_sync", {}, ctx(api));
    expect(calls.map((c) => [c.path, c.query])).toEqual([
      ["/api/service/taillog", { repo: "billing", service: "api" }],
      ["/api/modules", { pillar: "smoke" }],
      ["/api/test-sources", { pillar: "smoke" }],
      ["/api/workspace/sync", {}],
    ]);
  });

  it("the audit headers are the five they always were", () => {
    const h = agentAuditHeaders({
      client: "acme",
      clientVersion: "1",
      mcpPid: 1,
      session: "s",
    });
    expect(Object.keys(h).sort()).toEqual(
      [
        AUDIT_HEADERS.actor,
        AUDIT_HEADERS.client,
        AUDIT_HEADERS.clientVersion,
        AUDIT_HEADERS.pid,
        AUDIT_HEADERS.session,
      ].sort(),
    );
  });
});

describe("the actor is stamped", () => {
  const info = {
    client: "claude-code",
    clientVersion: "2.0.0",
    mcpPid: 4242,
    session: "0b9f6c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f",
    agent: "agent:planner",
    workspace: "north",
  };

  it("on every call's headers, and the web server reads it back", () => {
    const headers = agentAuditHeaders(info);
    expect(headers[AUDIT_HEADERS.agent]).toBe("agent:planner");
    expect(headers[AUDIT_HEADERS.workspace]).toBe("north");
    expect(actorFromHeaders(headers)).toEqual({ kind: "agent", ...info });
  });

  it("a malformed agent or workspace header is dropped, not cleaned into one", () => {
    const a = actorFromHeaders({
      [AUDIT_HEADERS.actor]: "agent",
      [AUDIT_HEADERS.agent]: "agent:pl anner",
      [AUDIT_HEADERS.workspace]: "../north",
    });
    expect(a).not.toBeNull();
    expect(a).not.toHaveProperty("agent");
    expect(a).not.toHaveProperty("workspace");
  });

  it("in the activity entry and the log line (exec, run, sync)", () => {
    const lines: string[] = [];
    setAuditSink((l) => lines.push(l));
    const e = recordAction(
      { kind: "agent", ...info },
      { verb: "run", detail: "smoke/local · modules=all [abc123]" },
    );
    setAuditSink(null);
    expect(e).toMatchObject({
      actor: "agent",
      agent: "agent:planner",
      workspace: "north",
    });
    expect(lines).toEqual([
      `▶ run smoke/local · modules=all [abc123] · by agent:planner claude-code 2.0.0 (workspace north, mcp pid 4242, session ${info.session})`,
    ]);
    expect(actorLabel({ kind: "agent", ...info })).toBe(
      `agent:planner claude-code 2.0.0 (workspace north, mcp pid 4242, session ${info.session})`,
    );
  });
});
