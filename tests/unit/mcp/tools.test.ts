/**
 * The MCP tools: which are registered (read tools always, actions only when
 * the org opts in) and every guard, enforced before any action reaches the
 * web API. The API is a fake that records what was asked of it.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ACTION_TOOL_NAMES,
  READ_TOOL_NAMES,
  callTool,
  toolsFor,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import {
  Refusal,
  assertLifecycleCmd,
  runsLocally,
} from "../../../src/ui/mcp/guards.js";
import {
  DenHttpError,
  DenWebDown,
  type DenApi,
  type Query,
  type StreamOpts,
} from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

interface Call {
  kind: "get" | "stream";
  method?: string;
  path: string;
  query?: Query;
}

const SERVICES = [
  {
    repo: "shop",
    service: "api",
    address: "shop/api",
    commands: ["up", "down", "restart"],
    mode: "managed",
    isEntrypoint: true,
  },
  {
    repo: "shop",
    service: "worker",
    address: "shop/worker",
    commands: ["down"],
    mode: "managed",
    isEntrypoint: false,
  },
  {
    repo: "web",
    service: "web",
    address: "web",
    commands: ["up", "down", "restart"],
    mode: "dev-managed",
    isEntrypoint: true,
  },
];

function fakeApi(
  over: {
    get?: (path: string, query?: Query) => unknown;
    lines?: string[];
  } = {},
): { api: DenApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7777",
    async get(path, query, method) {
      calls.push({ kind: "get", path, query, method });
      if (over.get) return over.get(path, query);
      if (path === "/api/services") return SERVICES;
      if (path === "/api/security/plan")
        return { ok: true, exitCode: 0, log: [], errors: [] };
      return {};
    },
    async stream(path, query, opts: StreamOpts) {
      calls.push({ kind: "stream", path, query, method: opts.method });
      return {
        events: [{ type: "done", exitCode: 0 }],
        lines: over.lines ?? ["ok"],
        ended: "done",
        exitCode: 0,
      };
    },
  };
  return { api, calls };
}

const cfg = (over: Partial<ResolvedMcpConfig> = {}): ResolvedMcpConfig => ({
  actions: [...ACTION_TOOL_NAMES],
  runTestsEnvs: ["local"],
  logsRemote: false,
  ...over,
});

function ctx(api: DenApi, c: ResolvedMcpConfig = cfg()): ToolContext {
  return { api, cfg: c, cli: "acme" };
}

const streams = (calls: Call[]) => calls.filter((c) => c.kind === "stream");

describe("tool registration", () => {
  it("with no mcp: block, only the read tools", () => {
    const names = toolsFor(cfg({ actions: [] })).map((t) => t.name);
    expect(names).toEqual([...READ_TOOL_NAMES]);
    expect(names).toEqual(
      expect.arrayContaining(["stacks", "edge_status", "logs_tail", "status"]),
    );
    for (const a of ACTION_TOOL_NAMES) expect(names).not.toContain(a);
  });

  it("mcp.actions adds exactly the named actions", () => {
    const names = toolsFor(cfg({ actions: ["service_up", "run_tests"] })).map(
      (t) => t.name,
    );
    expect(names).toEqual([...READ_TOOL_NAMES, "service_up", "run_tests"]);
  });

  it("there is no deploy tool and nothing for the never-exposed routes", () => {
    const names = toolsFor(cfg()).map((t) => t.name);
    for (const n of names)
      expect(n).not.toMatch(/deploy|sudo|terminal|editor|settings|aws|exec/);
  });
});

describe("lifecycle guards", () => {
  it("only up, down and restart are lifecycle commands", () => {
    for (const c of ["up", "down", "restart"])
      expect(() => assertLifecycleCmd(c)).not.toThrow();
    for (const c of ["setup", "build", "migrate", "logs"])
      expect(() => assertLifecycleCmd(c)).toThrow(Refusal);
  });

  it("refuses a non-local env before touching the API", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "service_up",
      { repo: "shop", env: "dev" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/local only/i);
    expect(calls).toEqual([]);
  });

  it("refuses a service with no local up command", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "service_restart",
      { repo: "shop", service: "worker" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not run locally/);
    expect(streams(calls)).toEqual([]);
  });

  it("runsLocally: an up command today; an explicit runs.local:false wins (R13 hook)", () => {
    expect(runsLocally({ commands: ["up", "down"] })).toBe(true);
    expect(runsLocally({ commands: ["down"] })).toBe(false);
    expect(runsLocally({ commands: ["up"], runs: { local: false } })).toBe(
      false,
    );
  });

  it("runs up through /api/service/exec, cmd=up, env=local", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool("service_up", { repo: "shop" }, ctx(api));
    expect(r.isError).toBe(false);
    expect(streams(calls)).toEqual([
      {
        kind: "stream",
        path: "/api/service/exec",
        method: "GET",
        query: { repo: "shop", service: "api", cmd: "up", env: "local" },
      },
    ]);
  });
});

describe("run_tests guards", () => {
  it("refuses production, even when listed in run_tests.envs", async () => {
    const { api, calls } = fakeApi();
    const c = cfg({ runTestsEnvs: ["local", "production"] });
    for (const env of ["production", "prod"]) {
      const r = await callTool(
        "run_tests",
        { pillar: "smoke", env },
        ctx(api, c),
      );
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/production/i);
    }
    expect(calls).toEqual([]);
  });

  it("refuses an env not in mcp.run_tests.envs", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "run_tests",
      { pillar: "smoke", env: "dev" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/run_tests\.envs/);
    expect(calls).toEqual([]);
  });

  it("refuses security mode full off local", async () => {
    const { api, calls } = fakeApi();
    const c = cfg({ runTestsEnvs: ["local", "dev"] });
    const r = await callTool(
      "run_tests",
      { pillar: "security", env: "dev", mode: "full" },
      ctx(api, c),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/full.*local only/i);
    expect(calls).toEqual([]);
  });

  it("refuses a security run whose target is not in security.owned_hosts", async () => {
    const { api, calls } = fakeApi({
      get: (path) =>
        path === "/api/security/plan"
          ? {
              ok: false,
              exitCode: 1,
              log: [],
              errors: [
                'Security plan refused: Refusing to scan "evil.example.com": not an owned host',
              ],
            }
          : SERVICES,
    });
    const r = await callTool(
      "run_tests",
      { pillar: "security", modules: ["shop/api"] },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not an owned host/);
    expect(calls.map((c) => c.path)).toEqual(["/api/security/plan"]);
    expect(calls[0].query).toEqual({
      env: "local",
      mode: "baseline",
      service: "shop/api",
    });
  });

  it("an allowed run streams /api/run with its pillar, modules, env and mode", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "run_tests",
      { pillar: "security", modules: ["shop/api"], mode: "full" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(streams(calls)).toEqual([
      {
        kind: "stream",
        path: "/api/run",
        method: "GET",
        query: {
          pillar: "security",
          module: ["shop/api"],
          env: "local",
          mode: "full",
        },
      },
    ]);
  });
});

describe("workspace_sync guards", () => {
  it("refuses a dev-managed repo", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool("workspace_sync", { repo: "web" }, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/dev-managed/);
    expect(streams(calls)).toEqual([]);
  });

  it("syncs a managed repo with POST /api/workspace/sync", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool("workspace_sync", { repo: "shop" }, ctx(api));
    expect(r.isError).toBe(false);
    expect(streams(calls)).toEqual([
      {
        kind: "stream",
        path: "/api/workspace/sync",
        method: "POST",
        query: { repo: "shop" },
      },
    ]);
  });
});

describe("logs", () => {
  it("remote sources are off unless mcp.logs.remote is true", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "logs_tail",
      { repo: "shop", service: "api", env: "dev" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/mcp\.logs\.remote/);
    expect(calls).toEqual([]);
    const s = await callTool(
      "logs_search",
      { q: "error", targets: ["shop/api"], env: "dev" },
      ctx(api),
    );
    expect(s.isError).toBe(true);
  });

  it("log text comes back redacted", async () => {
    const { api } = fakeApi({
      lines: [
        "connecting postgres://app:hunter2@db:5432/x",
        "Bearer abcdefghijklmnop",
      ],
    });
    const r = await callTool(
      "logs_tail",
      { repo: "shop", service: "api", lines: 10 },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(r.text).not.toMatch(/hunter2|abcdefghijklmnop/);
    expect(r.text).toMatch(/\[REDACTED\]/);
  });
});

describe("web server down", () => {
  it("every tool says how to start it", async () => {
    const api: DenApi = {
      baseUrl: "http://localhost:7777",
      get: async () => {
        throw new DenWebDown("http://localhost:7777", "acme");
      },
      stream: async () => {
        throw new DenWebDown("http://localhost:7777", "acme");
      },
    };
    const r = await callTool("status", {}, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not running at http:\/\/localhost:7777/);
    expect(r.text).toMatch(/`acme web up`/);
  });
});

describe("a web server older than the MCP server", () => {
  /** A web server that has no /api/stacks or /api/edge yet. */
  function olderServer(info: unknown): { api: DenApi; calls: Call[] } {
    return fakeApi({
      get: (path) => {
        if (path === "/api/server-info") {
          if (info === 404)
            throw new DenHttpError("GET", path, 404, "Not found");
          return info;
        }
        throw new DenHttpError("GET", path, 404, "Not found");
      },
    });
  }

  it("names its version, the version the tool needs and the restart", async () => {
    const { api, calls } = olderServer({ pid: 1, version: "0.1.0" });
    const r = await callTool("stacks", {}, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "web server is Den 0.1.0; stacks needs >= 0.2.0: run acme web restart",
    );
    // server-info is read lazily: only once a call has 404'd.
    expect(calls.map((c) => c.path)).toEqual([
      "/api/stacks",
      "/api/server-info",
    ]);
    const e = await callTool("edge_status", {}, ctx(api));
    expect(e.text).toBe(
      "web server is Den 0.1.0; edge_status needs >= 0.2.0: run acme web restart",
    );
  });

  it("a server-info with no version is from before 0.2.0", async () => {
    for (const info of [{ pid: 1, stale: false }, 404]) {
      const { api } = olderServer(info);
      const r = await callTool("stacks", {}, ctx(api));
      expect(r.text).toBe(
        "web server is Den < 0.2.0; stacks needs >= 0.2.0: run acme web restart",
      );
    }
  });

  it("a 404 from a server new enough stays a plain, clear error", async () => {
    const { api } = olderServer({ pid: 1, version: "0.2.0-dev.0" });
    const r = await callTool("stacks", {}, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Error: stacks: the web server answered 404 for GET /api/stacks: Not found",
    );
  });

  it("other 404s never read server-info", async () => {
    const { api, calls } = fakeApi({
      get: (path) => {
        throw new DenHttpError("GET", path, 404, "no such repo");
      },
    });
    const r = await callTool("graph", { seed: "shop" }, ctx(api));
    expect(r.text).toBe(
      "Error: graph: the web server answered 404 for GET /api/graph: no such repo",
    );
    expect(calls.map((c) => c.path)).toEqual(["/api/graph"]);
  });
});
