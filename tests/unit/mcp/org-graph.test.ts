/**
 * The org-wide map is org-wide, and an ungranted workspace gets Den's
 * refusal (0.4.4 review):
 *
 *   - org_summary.graph and an unscoped `graph` merge every active
 *     workspace's graph (the web server derives one per workspace), so a
 *     repo only in a non-focus workspace is on the map; org_summary keeps
 *     names and edge kinds only. `graph` naming a workspace says so.
 *   - MCP-2.3: on a scoped server with grants, naming a workspace that is
 *     not granted is refused by Den (naming agents.<id>.grants and how a
 *     person grants it), over the protocol and in a one-shot alike, never
 *     a schema error listing the allowed names.
 *
 * The web API is a fake: north (focus) and south active, each with its own
 * graph.
 */
import { describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import { createDenMcpServer, runOneShot } from "../../../src/ui/mcp/server.js";
import type { McpScope } from "../../../src/ui/mcp/scope.js";
import type { DenApi, Query } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

const WORKSPACES = {
  active: ["north", "south"],
  focus: "north",
  workspaces: {
    north: { services: { shop: { mode: "managed" }, cart: {} } },
    south: { services: { bank: { mode: "managed" } } },
    east: { services: { search: {} } },
  },
};

const GRAPHS: Record<string, unknown> = {
  north: {
    nodes: ["cart", "shop"],
    edges: [
      {
        from: "shop",
        to: "cart",
        kind: "http",
        blocking: "hard",
        evidence: "shop/.env.example NORTH-EVIDENCE-SENTINEL",
      },
    ],
    order: ["cart", "shop"],
  },
  south: {
    nodes: ["bank", "cart"],
    edges: [
      {
        from: "bank",
        to: "cart",
        kind: "event",
        blocking: "soft",
        evidence: "bank/infra.ts SOUTH-EVIDENCE-SENTINEL",
      },
    ],
    order: ["cart", "bank"],
  },
};

function fakeApi(): { api: DenApi; calls: { path: string; query?: Query }[] } {
  const calls: { path: string; query?: Query }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:1",
    async get(path, query) {
      calls.push({ path, query });
      const ws = query?.workspace as string | undefined;
      switch (path) {
        case "/api/workspaces":
          return WORKSPACES;
        case "/api/graph":
          // No workspace named: the web server's focused one.
          return GRAPHS[ws ?? "north"] ?? { nodes: [], edges: [] };
        case "/api/health":
          return [];
        case "/api/environments":
          return ["local"];
        case "/api/services":
          return ws === "north" ? [{ repo: "shop", service: "web" }] : [];
        default:
          return {};
      }
    },
    async stream() {
      return { events: [], lines: [], ended: "done", exitCode: 0 };
    },
  };
  return { api, calls };
}

const cfg: ResolvedMcpConfig = {
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
};
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

describe("the org-wide map is org-wide", () => {
  it("org_summary.graph has every active workspace's repos, with names and edge kinds only", async () => {
    const { api } = fakeApi();
    const r = await callTool(
      "org_summary",
      {},
      ctx(api, { workspace: "north", actor: "agent:planner" }),
    );
    expect(r.isError).toBe(false);
    const s = JSON.parse(r.text) as { graph: Record<string, unknown> };
    expect(s.graph).toEqual({
      map: "org-wide",
      workspaces: ["north", "south"],
      nodes: ["bank", "cart", "shop"],
      edges: [
        { from: "shop", to: "cart", kind: "http", blocking: "hard" },
        { from: "bank", to: "cart", kind: "event", blocking: "soft" },
      ],
    });
    expect(r.text).not.toMatch(/EVIDENCE-SENTINEL/);
  });

  it("an unscoped graph is the merged map; naming a workspace, that workspace's, labelled so", async () => {
    const { api } = fakeApi();
    const all = await call("graph", {}, ctx(api));
    expect(all.map).toBe("org-wide");
    expect(all.nodes).toEqual(["bank", "cart", "shop"]);
    expect(all.workspaces).toEqual(["north", "south"]);
    const south = await call("graph", { workspace: "south" }, ctx(api));
    expect(south).toMatchObject({
      map: "workspace",
      workspace: "south",
      nodes: ["bank", "cart"],
      order: ["cart", "bank"],
    });
  });
});

describe("an ungranted workspace gets Den's refusal (MCP-2.3)", () => {
  const SCOPE: McpScope = {
    workspace: "north",
    actor: "agent:planner",
    grants: ["east"],
  };
  const refusal =
    /Refused: services: .*"south" is another workspace.*adds "south" to agents\.planner\.grants/s;

  it("over the protocol, a scoped server with grants refuses it by name, not by schema", async () => {
    const { api, calls } = fakeApi();
    const server = createDenMcpServer({
      cfg,
      baseUrl: api.baseUrl,
      cli: "acme",
      api,
      scope: SCOPE,
      log: () => {},
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "acme-test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const r = (await client.callTool({
        name: "services",
        arguments: { workspace: "south" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(refusal);
      expect(r.content[0].text).not.toMatch(/-32602|expected one of/);
      const { tools } = await client.listTools();
      const svc = tools.find((t) => t.name === "services")!;
      const ws = (svc.inputSchema.properties ?? {}).workspace as {
        description?: string;
      };
      // The allowed names are still said, in the description.
      expect(ws.description).toMatch(/"north".*"east"/);
      // Nothing of south was read.
      expect(
        calls.filter((c) => c.path === "/api/services").map((c) => c.query),
      ).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("a one-shot gets the same refusal, with grants and without", async () => {
    for (const scope of [
      SCOPE,
      { workspace: "north", actor: "agent:planner" },
    ]) {
      const { api, calls } = fakeApi();
      const out: string[] = [];
      const err: string[] = [];
      const code = await runOneShot(
        { kind: "call", tool: "services", args: { workspace: "south" } },
        {
          cfg,
          cli: "acme",
          api,
          scope,
          out: (t) => out.push(t),
          err: (t) => err.push(t),
        },
      );
      expect([code, err.join("")]).toEqual([1, ""]);
      expect(out.join("")).toMatch(refusal);
      expect(calls.some((c) => c.path === "/api/services")).toBe(false);
    }
  });

  it("a scoped one-shot lists and validates against the pinned tools, as the stdio server registers them", async () => {
    const { api } = fakeApi();
    const err: string[] = [];
    // A key the pinned schema doesn't take is still an error (strict).
    const code = await runOneShot(
      { kind: "call", tool: "services", args: { wrkspace: "south" } },
      {
        cfg,
        cli: "acme",
        api,
        scope: { workspace: "north", actor: "agent:planner" },
        out: () => {},
        err: (t) => err.push(t),
      },
    );
    expect(code).toBe(2);
    // The pinned schema: no workspace without grants.
    expect(err.join("")).toMatch(/takes: env\n/);
  });
});
