/**
 * MCP-2: a scoped agent gets a whole, honest picture through Den's MCP.
 *
 *   - MCP-2.1: `org_summary`, for every agent: every workspace and repo
 *     with status counts, the graph, the edge and the environments, and
 *     nothing from outside the agent's workspace but names and counts.
 *   - MCP-2.2: a scoped answer states its scope and how much it hides; a
 *     pinned server's tools say "this workspace only" and take no
 *     `workspace`; `graph` is the workspace's, or labelled org-wide.
 *   - MCP-2.3: a refusal names the grant and how a person gives it.
 *   - MCP-2.4: every health row has a state, and one with no verdict says
 *     why; a redirect is "redirect", not down; an empty `stacks` explains
 *     itself.
 *
 * The web API is a fake: three workspaces, one inactive.
 */
import { describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ACTION_TOOL_NAMES,
  callTool,
  toolsFor,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import { createDenMcpServer } from "../../../src/ui/mcp/server.js";
import type { McpScope } from "../../../src/ui/mcp/scope.js";
import type { DenApi, Query } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

/** Strings only south's (or east's) details carry: none may reach north. */
const SECRETS = [
  "SOUTH-URL-SENTINEL",
  "SOUTH-CHECK-SENTINEL",
  "SOUTH-ERROR-SENTINEL",
  "/private/south-path-sentinel",
  "SOUTH-OPEN-SENTINEL",
  "SOUTH-LINK-SENTINEL",
  "SOUTH-LABEL-SENTINEL",
  "EVIDENCE-SENTINEL",
  "EAST-DIR-SENTINEL",
  "south-branch-sentinel",
];

const WORKSPACES = {
  active: ["north", "south"],
  focus: "south",
  workspaces: {
    north: {
      services: { shop: { mode: "managed" }, "cart/api": { mode: "managed" } },
    },
    south: {
      services: { billing: { mode: "managed" }, ledger: { mode: "managed" } },
      directory: "/private/south-path-sentinel",
      repos: { billing: "south-branch-sentinel" },
    },
    east: {
      services: { search: { mode: "dev-managed" } },
      directory: "EAST-DIR-SENTINEL",
    },
  },
  resolvedDirs: {},
  codeWorkspacePaths: {},
};

const NORTH_HEALTH = [
  {
    repo: "shop",
    service: "web",
    ok: true,
    url: "http://shop/healthz",
    runs: "local",
    target: null,
    isEntrypoint: true,
    workspaces: ["north"],
  },
  // A login redirect: answering, not down.
  {
    repo: "shop",
    service: "admin",
    ok: null,
    status: 302,
    redirect: "/login",
    url: "http://shop/admin",
    runs: "local",
    target: null,
    workspaces: ["north"],
  },
  // An older web server's unchecked rows: no `why`, so the MCP says it.
  {
    repo: "cart",
    service: "api",
    ok: null,
    url: null,
    runs: "remote",
    target: { env: "dev" },
    workspaces: ["north"],
  },
  {
    repo: "cart",
    service: "worker",
    ok: null,
    url: null,
    runs: "none",
    target: null,
    workspaces: ["north"],
  },
];

const SOUTH_HEALTH = [
  {
    repo: "billing",
    service: "api",
    label: "SOUTH-LABEL-SENTINEL",
    ok: false,
    url: "http://SOUTH-URL-SENTINEL/healthz",
    error: "SOUTH-ERROR-SENTINEL token=abc",
    repoPath: "/private/south-path-sentinel",
    openUrl: "https://SOUTH-OPEN-SENTINEL",
    links: [{ label: "x", url: "https://SOUTH-LINK-SENTINEL" }],
    runs: "local",
    isEntrypoint: true,
    workspaces: ["south"],
  },
  {
    repo: "ledger",
    service: "ledger",
    ok: true,
    check: "SOUTH-CHECK-SENTINEL --deep",
    repoPath: "/private/south-path-sentinel",
    runs: "local",
    workspaces: ["south"],
  },
];

const GRAPH = {
  nodes: ["shop", "cart", "billing", "ledger", "search"],
  edges: [
    {
      from: "shop",
      to: "cart",
      kind: "http",
      blocking: "hard",
      signal: "http:env-url",
      evidence: "shop/.env.example: CART_URL",
      confidence: "high",
    },
    {
      from: "cart",
      to: "billing",
      kind: "http",
      blocking: "soft",
      signal: "http:env-url",
      evidence: "cart/src/pay.ts: BILLING_URL",
      confidence: "high",
    },
    {
      from: "billing",
      to: "ledger",
      kind: "event",
      blocking: "soft",
      signal: "event:eventbridge-rule",
      evidence: "billing/infra.ts EVIDENCE-SENTINEL API_KEY=xyz",
      confidence: "medium",
    },
  ],
  order: ["ledger", "billing", "cart", "shop", "search"],
};

const EDGE = {
  configured: true,
  org: "acme",
  up: true,
  state: "running",
  domains: ["acme.localhost"],
  routes: [{ name: "web", url: "https://web.acme.localhost", upstream: "x" }],
  certIssuedByDen: false,
  certIssued: false,
  tls: { strategy: "files", implicit: false, from: "explicit", ca: null },
  https: {
    strategy: "files",
    certs: "distribution",
    serving: true,
    detail: "TLS handshake answered on 127.0.0.1:443 (web.acme.localhost)",
  },
};

interface Call {
  path: string;
  query?: Query;
  body?: unknown;
}

function fakeApi(
  over: { stacks?: unknown; edge?: unknown; health?: unknown } = {},
): { api: DenApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:1",
    async get(path, query, _method, body) {
      calls.push({ path, query, ...(body !== undefined ? { body } : {}) });
      const ws = query?.workspace as string | undefined;
      switch (path) {
        case "/api/workspaces":
          return WORKSPACES;
        case "/api/health":
          if (over.health !== undefined) return over.health;
          return ws === "north"
            ? NORTH_HEALTH
            : ws === "south"
              ? SOUTH_HEALTH
              : [...NORTH_HEALTH, ...SOUTH_HEALTH];
        case "/api/graph":
          return GRAPH;
        case "/api/edge":
          return over.edge ?? EDGE;
        case "/api/environments":
          return ["local", "beta", "prod"];
        case "/api/services":
          return ws === "north"
            ? [
                { repo: "shop", service: "web", commands: ["up"] },
                { repo: "cart", service: "api", commands: [] },
              ]
            : [];
        case "/api/stacks":
          return (
            over.stacks ?? {
              workspace: ws ?? "south",
              stackWorkspace: ws ?? "south",
              stacks: [
                { name: "billing", repo: "billing", routes: [], uses: [] },
              ],
            }
          );
        default:
          return {};
      }
    },
    async stream(path, query) {
      calls.push({ path, query });
      return { events: [], lines: [], ended: "done", exitCode: 0 };
    },
  };
  return { api, calls };
}

const cfg: ResolvedMcpConfig = {
  actions: [...ACTION_TOOL_NAMES],
  runTestsEnvs: ["local"],
  logsRemote: false,
};
const NORTH: McpScope = { workspace: "north", actor: "agent:planner" };

const ctx = (api: DenApi, scope?: McpScope): ToolContext => ({
  api,
  cfg,
  cli: "acme",
  ...(scope ? { scope: { ...scope } } : {}),
});

async function call(
  tool: string,
  args: Record<string, unknown>,
  c: ToolContext,
): Promise<Record<string, unknown>> {
  const r = await callTool(tool, args, c);
  expect(r.isError).toBe(false);
  return JSON.parse(r.text) as Record<string, unknown>;
}

describe("the gate: a scoped agent asks “what are our servers?”", () => {
  it("org_summary answers it without docker: every workspace and repo, and its own services in full", async () => {
    const { api } = fakeApi();
    const s = await call("org_summary", {}, ctx(api, NORTH));

    expect(s.workspaces).toEqual([
      {
        name: "north",
        active: true,
        yours: true,
        state: "running",
        counts: {
          services: 4,
          up: 1,
          down: 0,
          redirect: 1,
          pending: 0,
          unknown: 0,
          notChecked: 2,
        },
        repos: [
          {
            repo: "cart",
            state: "unknown",
            services: 2,
            up: 0,
            down: 0,
            notChecked: 2,
          },
          {
            repo: "shop",
            state: "ok",
            services: 2,
            up: 1,
            down: 0,
            redirect: 1,
          },
        ],
      },
      {
        name: "south",
        active: true,
        focused: true,
        state: "partial",
        counts: {
          services: 2,
          up: 1,
          down: 1,
          redirect: 0,
          pending: 0,
          unknown: 0,
          notChecked: 0,
        },
        repos: [
          { repo: "billing", state: "down", services: 1, up: 0, down: 1 },
          { repo: "ledger", state: "ok", services: 1, up: 1, down: 0 },
        ],
      },
      {
        name: "east",
        active: false,
        state: "inactive",
        repos: [{ repo: "search", state: "inactive" }],
      },
    ]);
    expect(s.summary).toMatch(/^3 workspaces \(2 active\), 5 repos\./);
    expect(s.graph).toEqual({
      map: "org-wide",
      nodes: GRAPH.nodes,
      edges: [
        { from: "shop", to: "cart", kind: "http", blocking: "hard" },
        { from: "cart", to: "billing", kind: "http", blocking: "soft" },
        { from: "billing", to: "ledger", kind: "event", blocking: "soft" },
      ],
      order: GRAPH.order,
    });
    expect(s.edge).toEqual({
      configured: true,
      up: true,
      state: "running",
      domains: ["acme.localhost"],
      routes: 1,
      https: {
        strategy: "files",
        certs: "distribution",
        serving: true,
        detail: EDGE.https.detail,
      },
    });
    expect(s.environments).toEqual(["local", "beta", "prod"]);
    expect(s.scope).toEqual({ workspace: "north", actor: "agent:planner" });

    // Its own workspace in full: every service has a state, and any
    // without a plain up/down says why.
    const yours = s.yours as {
      workspace: string;
      services: Record<string, unknown>[];
    };
    expect(yours.workspace).toBe("north");
    expect(yours.services.map((x) => [x.service, x.state])).toEqual([
      ["web", "up"],
      ["admin", "redirect"],
      ["api", "not-checked"],
      ["worker", "not-checked"],
    ]);
    for (const x of yours.services)
      if (x.state !== "up") expect(typeof x.why).toBe("string");
    expect(yours.services[1].why).toMatch(/302 → \/login/);
    expect(yours.services[2].why).toMatch(/remote \(runs in dev\)/);
    expect(yours.services[3].why).toMatch(/not deployed in local/);
  });

  it("a scoped agent's org_summary carries no logs, env values, commands, URLs, paths or check output of other workspaces", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool("org_summary", {}, ctx(api, NORTH));
    expect(r.isError).toBe(false);
    for (const secret of SECRETS) expect(r.text).not.toContain(secret);
    expect(r.text).not.toContain("token=abc");
    expect(r.text).not.toContain("API_KEY");
    // Nothing that holds logs, env values or another workspace's services
    // was asked for: one org-wide health read, and north's own.
    expect(calls.map((c) => c.path).sort()).toEqual(
      [
        "/api/edge",
        "/api/environments",
        "/api/graph",
        "/api/health",
        "/api/health",
        "/api/workspaces",
        "/api/workspaces",
      ].sort(),
    );
    const health = calls.filter((c) => c.path === "/api/health");
    expect(health.map((c) => c.query?.workspace)).toEqual([undefined, "north"]);
  });

  it("is registered for every agent, unscoped too (no `yours`)", async () => {
    expect(toolsFor(cfg).map((t) => t.name)).toContain("org_summary");
    const { api } = fakeApi();
    const s = await call("org_summary", {}, ctx(api));
    expect(s).not.toHaveProperty("yours");
    expect((s.workspaces as unknown[]).length).toBe(3);
  });
});

describe("scoped answers say so (MCP-2.2)", () => {
  it("status states its scope and how many repos it hides", async () => {
    const { api } = fakeApi();
    const s = await call("status", {}, ctx(api, NORTH));
    expect(s.scope).toEqual({
      workspace: "north",
      actor: "agent:planner",
      otherWorkspaces: 2,
      hidden: { repos: 3 },
      note: "4 services in north (your scope); 2 other workspaces with 3 more repos: summary only, see org_summary",
    });
    expect((s.counts as { services: number }).services).toBe(4);
  });

  it("services and applications carry the same scope block", async () => {
    const { api } = fakeApi();
    const svc = await call("services", {}, ctx(api, NORTH));
    expect(svc.scope).toMatchObject({
      workspace: "north",
      hidden: { repos: 3 },
    });
    expect(svc.services).toHaveLength(2);
    const apps = await call("applications", {}, ctx(api, NORTH));
    expect(apps.scope).toMatchObject({ workspace: "north" });
  });

  it("graph is the workspace's own repos, naming what they depend on outside; unscoped it is labelled org-wide", async () => {
    const { api } = fakeApi();
    const g = await call("graph", {}, ctx(api, NORTH));
    expect(g.map).toBe("workspace");
    expect(g.nodes).toEqual(["shop", "cart"]);
    expect((g.edges as { from: string }[]).map((e) => e.from)).toEqual([
      "shop",
      "cart",
    ]);
    expect(g.outside).toEqual(["billing"]);
    expect(g.order).toEqual(["cart", "shop"]);
    expect(g.scope).toMatchObject({
      workspace: "north",
      hidden: { repos: 3, graphNodes: 3 },
    });
    const all = await call("graph", {}, ctx(api));
    expect(all.map).toBe("org-wide");
    expect(all.nodes).toEqual(GRAPH.nodes);
  });

  it("a pinned server's workspace tools say “this workspace only” and take no workspace", () => {
    const tools = toolsFor(cfg, NORTH);
    for (const name of [
      "status",
      "services",
      "applications",
      "graph",
      "stacks",
    ]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.description).toContain('This workspace only ("north")');
      expect(t.shape).not.toHaveProperty("workspace");
    }
    // The org's own tools are not workspace data.
    for (const name of ["environments", "edge_status", "org_summary"])
      expect(tools.find((x) => x.name === name)!.description).not.toContain(
        "This workspace only",
      );
    // Unscoped, nothing changes.
    expect(
      toolsFor(cfg).find((x) => x.name === "status")!.shape,
    ).toHaveProperty("workspace");
  });

  it("with grants the workspace parameter stays, as the scope's own or a granted one", () => {
    const t = toolsFor(cfg, { ...NORTH, grants: ["south"] }).find(
      (x) => x.name === "status",
    )!;
    expect(t.description).toContain(
      'This workspace only ("north", or a granted one: south)',
    );
    const ws = t.shape.workspace as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(ws.safeParse("south").success).toBe(true);
    expect(ws.safeParse("east").success).toBe(false);
  });

  it("over MCP, tools/list shows the pinned schemas", async () => {
    const { api } = fakeApi();
    const server = createDenMcpServer({
      cfg,
      baseUrl: api.baseUrl,
      cli: "acme",
      api,
      scope: NORTH,
      log: () => {},
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "acme-test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const { tools } = await client.listTools();
      const status = tools.find((t) => t.name === "status")!;
      expect(Object.keys(status.inputSchema.properties ?? {})).toEqual(["env"]);
      expect(status.description).toContain("This workspace only");
      expect(tools.map((t) => t.name)).toContain("org_summary");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("how to get more (MCP-2.3)", () => {
  it("a refusal names the grant and how a person gives it", async () => {
    const { api } = fakeApi();
    const r = await callTool("status", { workspace: "south" }, ctx(api, NORTH));
    expect(r.isError).toBe(true);
    expect(r.text).toContain(
      'To reach it, a person adds "south" to agents.planner.grants in the org config and restarts the agent',
    );
    expect(r.text).toMatch(/an agent can't grant itself one/);
    expect(r.text).toContain("org_summary");
  });

  it("logs of another workspace say a grant does not widen them", async () => {
    const { api } = fakeApi();
    const r = await callTool(
      "logs_tail",
      { repo: "billing", service: "api" },
      ctx(api, NORTH),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/a grant does not widen them/);
  });
});

describe("honest health (MCP-2.4)", () => {
  it("status gives every row a state; a redirect is counted as a redirect, not down", async () => {
    const { api } = fakeApi({
      health: [
        {
          repo: "site",
          service: "web",
          ok: null,
          status: 302,
          redirect: "https://sso.acme.example/login",
          url: "https://site.acme.example/",
          runs: "remote",
          target: { env: "prod" },
        },
        { repo: "jobs", service: "jobs", ok: null, url: null, runs: "none" },
        {
          repo: "api",
          service: "api",
          ok: null,
          url: null,
          runs: "local",
          why: "not checked: no health check in the manifest for local",
        },
        {
          repo: "db",
          service: "db",
          ok: null,
          pending: true,
          check: "container db",
          error: "timeout",
          runs: "local",
        },
      ],
    });
    const s = await call("status", { env: "prod" }, ctx(api));
    expect(s.counts).toEqual({
      services: 4,
      up: 0,
      down: 0,
      redirect: 1,
      pending: 1,
      unknown: 0,
      notChecked: 2,
    });
    const rows = s.services as Record<string, unknown>[];
    expect(rows.map((r) => r.state)).toEqual([
      "redirect",
      "not-checked",
      "not-checked",
      "pending",
    ]);
    expect(rows[0].why).toBe(
      "redirect: 302 → https://sso.acme.example/login (answering; not counted as down)",
    );
    expect(rows[1].why).toBe(
      "not checked: not deployed in prod (the manifest has no commands and no health check for prod)",
    );
    // The web server's own reason wins.
    expect(rows[2].why).toBe(
      "not checked: no health check in the manifest for local",
    );
    expect(rows[3].why).toBe("checked, no answer yet (timeout)");
  });

  it("an empty stacks says why: the web server's reason, or the scope's", async () => {
    const { api } = fakeApi({
      stacks: {
        workspace: "north",
        stackWorkspace: "north",
        stacks: [],
        why: 'no stacks: the org config (den.yml) declares no stacks:, and no repo of workspace "north" has a compose: block in its .den.yml',
      },
    });
    const own = await call("stacks", {}, ctx(api, NORTH));
    expect(own.stacks).toEqual([]);
    expect(own.why).toMatch(/^no stacks: the org config/);

    // The stacks listed are another workspace's repos': hidden, and said.
    const { api: api2 } = fakeApi();
    const hidden = await call("stacks", {}, ctx(api2, NORTH));
    expect(hidden.stacks).toEqual([]);
    expect(hidden.why).toBe(
      'no stacks in workspace "north": the 1 stack listed belong to repos outside it',
    );
    expect(hidden.scope).toMatchObject({ hidden: { repos: 3, stacks: 1 } });

    // An older web server's bare empty list.
    const { api: api3 } = fakeApi({
      stacks: { workspace: "x", stackWorkspace: "x", stacks: [] },
    });
    const old = await call("stacks", {}, ctx(api3));
    expect(old.why).toMatch(/no stacks \(the web server gave no reason/);
  });
});

describe("edge_status (MCP-2.5)", () => {
  it("from an older web server, says what certIssued means", async () => {
    const { api } = fakeApi({
      edge: { configured: true, up: true, certIssued: false },
    });
    const e = await call("edge_status", {}, ctx(api));
    expect(e.certIssuedMeans).toMatch(
      /whether Den minted the cert itself.*tls strategy files/,
    );
  });

  it("passes the https block through", async () => {
    const { api } = fakeApi();
    const e = await call("edge_status", {}, ctx(api));
    expect(e.https).toEqual(EDGE.https);
    expect(e).not.toHaveProperty("certIssuedMeans");
  });
});
