/**
 * The server agent's MCP (ON-6): `<cli> mcp --workspace den-server --actor
 * agent:server`. Its scope is the whole Den, not a workspace: its tools are
 * unpinned, and the onboarding writes a workspace's agent is refused
 * (workspace_create, repo_add) are open to it. They are still held for the
 * person's Allow (POST /api/approvals): nothing writes by itself. The API
 * is a fake that records what was asked.
 */
import { describe, expect, it } from "@jest/globals";
import { runOneShot } from "../../../src/ui/mcp/server.js";
import { DenHttpError, type DenApi } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";

const ID = "AbCdEfGhIjKlMnOp";

function fakeApi() {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, _query, method, body) {
      calls.push({ path, method, body });
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      if (path === "/api/approvals" && method === "POST")
        return { id: ID, state: "pending" };
      // The person allowed it.
      if (path === `/api/approvals/${ID}`)
        return { id: ID, state: "done", result: { ok: true, name: "web" } };
      if (path === "/api/activity") return { ok: true };
      throw new DenHttpError("GET", path, 404, "not found");
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}

const cfg = (): ResolvedMcpConfig => ({
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

async function shot(
  scope: { workspace: string; actor: string },
  tool: string,
  args: Record<string, unknown>,
) {
  const { api, calls } = fakeApi();
  let out = "";
  let err = "";
  const code = await runOneShot(
    { kind: "call", tool, args },
    {
      cfg: cfg(),
      cli: "acme",
      api,
      scope,
      out: (t) => (out += t),
      err: (t) => (err += t),
    },
  );
  return { code, out, err, calls };
}

describe("the server agent's MCP scope", () => {
  it("workspace_create is held for the person, never refused as a workspace's agent's is", async () => {
    const s = await shot(
      { workspace: SERVER_SCOPE, actor: "agent:server" },
      "workspace_create",
      { name: "web" },
    );
    expect([s.code, s.err]).toEqual([0, ""]);
    expect(s.calls[0]).toEqual({
      path: "/api/approvals",
      method: "POST",
      body: { action: "workspace_create", args: { name: "web" } },
    });
    expect(JSON.parse(s.out)).toMatchObject({ approved: true, id: ID });
  });

  it("a workspace's agent is still refused it, and nothing is asked", async () => {
    const s = await shot(
      { workspace: "north", actor: "agent:planner" },
      "workspace_create",
      { name: "web" },
    );
    expect(s.code).not.toBe(0);
    expect(s.err + s.out).toMatch(/onboarding/);
    expect(s.calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });

  it("its tools are the whole Den's: a workspace parameter, not pinned to one", async () => {
    const { api } = fakeApi();
    let out = "";
    await runOneShot(
      { kind: "list" },
      {
        cfg: cfg(),
        cli: "acme",
        api,
        scope: { workspace: SERVER_SCOPE, actor: "agent:server" },
        out: (t) => (out += t),
        err: () => undefined,
      },
    );
    for (const n of ["repos_detect", "workspace_create", "repo_add"])
      expect(out.split("\n")).toContain(n);
  });
});
