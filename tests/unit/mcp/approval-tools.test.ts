/**
 * ON-3's MCP write tools (0.4.15): workspace_create, repo_add and
 * service_try. None writes by itself: each asks the web server to hold
 * the change for the person (POST /api/approvals), then waits a while for
 * the answer (GET /api/approvals/<id>). Allowed: the server ran it and
 * this is what it said. Denied, expired, or the agent stopped since: a
 * plain refusal. Still waiting: a plain answer saying to call
 * approval_check later. Always registered (the person's approval is the
 * gate, not mcp.actions). The API is a fake that records what was asked.
 */
import { describe, expect, it } from "@jest/globals";
import {
  READ_TOOL_NAMES,
  callTool,
  toolsFor,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import {
  DenHttpError,
  assertAllowedRequest,
  type DenApi,
  type Query,
} from "../../../src/ui/mcp/api.js";
import { Refusal } from "../../../src/ui/mcp/guards.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

interface Call {
  path: string;
  query?: Query;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const ID = "AbCdEfGhIjKlMnOp";

/** A fake web server: POST /api/approvals answers pending; each GET walks `states`. */
function fakeApi(
  states: Record<string, unknown>[],
  post: () => unknown = () => ({
    id: ID,
    state: "pending",
    expiresAt: "2026-11-07T12:10:00.000Z",
  }),
) {
  const calls: Call[] = [];
  let i = 0;
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, query, method, body, headers) {
      calls.push({ path, query, method, body, headers });
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      if (path === "/api/approvals" && method === "POST") return post();
      if (path === `/api/approvals/${ID}`)
        return { id: ID, ...states[Math.min(i++, states.length - 1)] };
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

const ctx = (api: DenApi, scoped = false): ToolContext => ({
  api,
  cfg: cfg(),
  cli: "acme",
  approvalWait: { intervalMs: 1, waitMs: 50, sleep: async () => undefined },
  ...(scoped ? { scope: { workspace: "north", actor: "agent:planner" } } : {}),
});

const WRITES = ["workspace_create", "repo_add", "service_try"];

describe("registration", () => {
  it("the three writes are registered with no mcp.actions; approval_check is a read", () => {
    const names = toolsFor(cfg()).map((t) => t.name);
    for (const n of WRITES) expect(names).toContain(n);
    expect(READ_TOOL_NAMES).toContain("approval_check");
    for (const n of WRITES)
      expect(toolsFor(cfg()).find((t) => t.name === n)?.action).toBe(true);
  });

  it("the API client may POST /api/approvals and GET one request, nothing else there", () => {
    expect(() =>
      assertAllowedRequest("POST", "/api/approvals", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("GET", `/api/approvals/${ID}`, {}),
    ).not.toThrow();
    // Deciding is a person's: never reachable from MCP.
    expect(() =>
      assertAllowedRequest("POST", `/api/approvals/${ID}/decide`, {}),
    ).toThrow(Refusal);
    expect(() => assertAllowedRequest("DELETE", "/api/approvals", {})).toThrow(
      Refusal,
    );
  });
});

describe("a write asks, then waits for the person", () => {
  it("workspace_create sends the action, the exact args and the note; Allowed: the server's result", async () => {
    const { api, calls } = fakeApi([
      { state: "pending" },
      { state: "done", result: { ok: true, name: "web" } },
    ]);
    const r = await callTool(
      "workspace_create",
      { name: "web", note: "for the storefront repos" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls[0]).toEqual({
      path: "/api/approvals",
      query: {},
      method: "POST",
      body: {
        action: "workspace_create",
        args: { name: "web" },
        note: "for the storefront repos",
      },
    });
    expect(JSON.parse(r.text)).toMatchObject({
      approved: true,
      id: ID,
      result: { ok: true, name: "web" },
    });
  });

  it("repo_add sends only the args it knows", async () => {
    const { api, calls } = fakeApi([{ state: "done", result: { ok: true } }]);
    await callTool(
      "repo_add",
      {
        path: "~/code/shop",
        workspace: "web",
        run: "npm run dev",
        extra: "dropped",
      },
      ctx(api),
    );
    expect(calls[0].body).toEqual({
      action: "repo_add",
      args: { path: "~/code/shop", workspace: "web", run: "npm run dev" },
    });
  });

  it("an allowed run that failed comes back as an error with what it said", async () => {
    const { api } = fakeApi([
      { state: "done", result: { ok: false, error: "port 3000 is taken" } },
    ]);
    const r = await callTool("service_try", { service: "shop" }, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/port 3000 is taken/);
  });

  it("Denied: a plain refusal, nothing ran", async () => {
    const { api } = fakeApi([{ state: "denied" }]);
    const r = await callTool("workspace_create", { name: "web" }, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      `Refused: workspace_create: the person denied it (request ${ID}); nothing ran.`,
    );
  });

  it("expired, or the agent was stopped since: plain refusals", async () => {
    const a = fakeApi([{ state: "expired" }]);
    expect(
      (await callTool("workspace_create", { name: "web" }, ctx(a.api))).text,
    ).toMatch(/^Refused: workspace_create: nobody answered in time/);
    const b = fakeApi([{ state: "denied", endedBecause: "actor_gone" }]);
    expect(
      (await callTool("workspace_create", { name: "web" }, ctx(b.api))).text,
    ).toMatch(/^Refused: workspace_create: the agent that asked was stopped/);
  });

  it("still waiting after the wait: a plain answer naming approval_check, not an error", async () => {
    const { api } = fakeApi([{ state: "pending" }]);
    const r = await callTool("workspace_create", { name: "web" }, ctx(api));
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      `Waiting for the person to approve in Den (request ${ID}); call approval_check with this id later.`,
    );
  });

  it("the server's refusal of the ask (bad args, too many waiting) reads as a refusal", async () => {
    const { api } = fakeApi([], () => {
      throw new DenHttpError(
        "POST",
        "/api/approvals",
        429,
        "This agent already has 5 requests waiting for a person. Wait for those first.",
      );
    });
    const r = await callTool("workspace_create", { name: "web" }, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Refused: workspace_create: This agent already has 5 requests waiting for a person. Wait for those first.",
    );
  });

  it("a required arg missing: refused before anything is asked", async () => {
    const { api, calls } = fakeApi([]);
    const r = await callTool("service_try", {}, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Refused: service_try: .*service/);
    expect(calls.filter((c) => c.path === "/api/approvals")).toEqual([]);
  });
});

describe("the ticket (an ask with no agent token)", () => {
  const TICKET = "T".repeat(32);
  it("is sent on every read of that request, and never shown to the agent", async () => {
    const { api, calls } = fakeApi(
      [{ state: "pending" }, { state: "done", result: { ok: true } }],
      () => ({ id: ID, state: "pending", ticket: TICKET }),
    );
    const r = await callTool("workspace_create", { name: "web" }, ctx(api));
    expect(r.text).not.toContain(TICKET);
    const reads = calls.filter((c) => c.path === `/api/approvals/${ID}`);
    expect(reads.length).toBeGreaterThan(0);
    for (const c of reads)
      expect(c.headers).toEqual({ "X-Den-Approval-Ticket": TICKET });
    const later = await callTool("approval_check", { id: ID }, ctx(api));
    expect(later.text).not.toContain(TICKET);
    expect(calls[calls.length - 1].headers).toEqual({
      "X-Den-Approval-Ticket": TICKET,
    });
  });
});

describe("approval_check", () => {
  it("reads one request and says where it stands", async () => {
    const { api, calls } = fakeApi([{ state: "pending", summary: "x" }]);
    const r = await callTool("approval_check", { id: ID }, ctx(api));
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ id: ID, state: "pending" });
    expect(calls.map((c) => c.path)).toEqual([`/api/approvals/${ID}`]);
  });
});

describe("a scoped server", () => {
  it("workspace_create and repo_add are the server agent's (unscoped): refused and reported", async () => {
    for (const [tool, args] of [
      ["workspace_create", { name: "web" }],
      ["repo_add", { path: "~/code/shop" }],
    ] as const) {
      const { api, calls } = fakeApi([]);
      const r = await callTool(tool, args, ctx(api, true));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/scoped to project "north"/);
      expect(calls.some((c) => c.path === "/api/approvals")).toBe(false);
      expect(calls.some((c) => c.path === "/api/activity")).toBe(true);
    }
  });

  it("service_try asks within its own workspace", async () => {
    const { api, calls } = fakeApi([{ state: "done", result: { ok: true } }]);
    const r = await callTool(
      "service_try",
      { service: "shop" },
      ctx(api, true),
    );
    expect(r.isError).toBe(false);
    const ask = calls.find((c) => c.path === "/api/approvals");
    expect(ask?.body).toEqual({
      action: "service_try",
      args: { service: "shop", workspace: "north" },
    });
  });
});

describe("SRV-1a: den_restart_server", () => {
  it("asks for den_restart with its reason; allowed at once (auto): no wait, and it says to end the turn", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, restarting: true },
    }));
    const r = await callTool(
      "den_restart_server",
      { reason: "new pin" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls[0].body).toEqual({
      action: "den_restart",
      args: { reason: "new pin" },
    });
    // The ask's own answer was the outcome: no read of the request.
    expect(calls.some((c) => c.path === `/api/approvals/${ID}`)).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({
      approved: true,
      result: { restarting: true },
      next: expect.stringMatching(/End your turn now.*Server is back on/),
    });
  });

  it("Den stops answering after the ask (it restarted): not an error, the same next step", async () => {
    const { api } = fakeApi([]);
    const get = api.get.bind(api);
    api.get = async (p, q, m, b, h) => {
      if (p === `/api/approvals/${ID}`) throw new TypeError("fetch failed");
      return get(p, q, m, b, h);
    };
    const r = await callTool(
      "den_restart_server",
      { reason: "new pin" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Den is restarting\. End your turn now/);
    expect(r.text).toContain(ID);
  });

  it('Den down before the ask: an error, never "restarting"', async () => {
    const api: DenApi = {
      baseUrl: "http://localhost:47003",
      async get() {
        throw new TypeError("fetch failed");
      },
      async stream() {
        throw new Error("no streams here");
      },
    };
    const r = await callTool(
      "den_restart_server",
      { reason: "new pin" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/restarting/);
  });

  it("a project's agent can't restart Den: refused before anything is asked", async () => {
    const { api, calls } = fakeApi([]);
    const r = await callTool(
      "den_restart_server",
      { reason: "x" },
      ctx(api, true),
    );
    expect(r.isError).toBe(true);
    expect(calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });
});
