/**
 * Issue 395: the server agent's held `edge_up`. It recreates the edge on
 * the configured image and args after the person's Allow (POST
 * /api/approvals, action edge_up), and its answer carries edge_status:
 * the image, its version, whether the edge was recreated, and why. A
 * project's agent can't ask: the edge is every project's. The API is a
 * fake that records what was asked; nothing reaches Docker.
 */
import { describe, expect, it } from "@jest/globals";
import {
  APPROVAL_TOOL_NAMES,
  callTool,
  toolsFor,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import { DenHttpError, type DenApi } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

const ID = "EdGeUpEdGeUpEdGe";

const EDGE_STATUS = {
  image: "traefik:v3.8.0",
  version: "3.8.0",
  recreated: true,
  kind: "recreated",
  why: "image: traefik:v3.7.17 → traefik:v3.8.0",
};

function fakeApi(post: () => unknown) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, _q, method, body) {
      calls.push({ path, method, body });
      if (path === "/api/approvals" && method === "POST") return post();
      throw new DenHttpError("GET", path, 404, "not found");
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}

const cfg = (approvals = true): ResolvedMcpConfig => ({
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals,
});

const ctx = (api: DenApi, scoped = false): ToolContext => ({
  api,
  cfg: cfg(),
  cli: "acme",
  approvalWait: { intervalMs: 1, waitMs: 20, sleep: async () => undefined },
  ...(scoped ? { scope: { workspace: "north", actor: "agent:planner" } } : {}),
});

describe("issue 395: edge_up is a held write", () => {
  it("is listed with the held writes, and only while they are on", () => {
    expect(APPROVAL_TOOL_NAMES).toContain("edge_up");
    expect(toolsFor(cfg(true)).map((t) => t.name)).toContain("edge_up");
    expect(toolsFor(cfg(false)).map((t) => t.name)).not.toContain("edge_up");
    const t = toolsFor(cfg(true)).find((x) => x.name === "edge_up")!;
    expect(t.action).toBe(true);
    expect(t.description).toMatch(/Allow/);
  });

  it("asks for edge_up; on the Allow its answer carries edge_status", async () => {
    const { api, calls } = fakeApi(() => ({
      id: ID,
      state: "done",
      result: {
        ok: true,
        outcome: { kind: "recreated", changes: [], downSeconds: 3 },
        line: "Edge recreated because image: traefik:v3.7.17 → traefik:v3.8.0; it was unreachable for about 3 s",
        edge_status: EDGE_STATUS,
      },
    }));
    const r = await callTool(
      "edge_up",
      { note: "the config's image changed" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls[0].body).toEqual({
      action: "edge_up",
      args: {},
      note: "the config's image changed",
    });
    const out = JSON.parse(r.text);
    expect(out).toMatchObject({ approved: true, edge_status: EDGE_STATUS });
  });

  it("a project's agent can't ask: nothing is asked", async () => {
    const { api, calls } = fakeApi(() => ({ id: ID, state: "pending" }));
    const r = await callTool("edge_up", {}, ctx(api, true));
    expect(r.isError).toBe(true);
    expect(calls.filter((c) => c.path === "/api/approvals")).toEqual([]);
  });
});
