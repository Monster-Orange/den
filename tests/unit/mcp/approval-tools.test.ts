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

  it("issue 160: ask: true asks the person anyway, with the note's why", async () => {
    const { api, calls } = fakeApi([{ state: "pending" }]);
    await callTool(
      "repo_clone",
      { source: "acme/big", ask: true, note: "it is 4 GB" },
      ctx(api),
    );
    expect(calls[0].body).toEqual({
      action: "repo_clone",
      args: { source: "acme/big" },
      note: "it is 4 GB",
      ask: true,
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

  it("issue 277: repo_add and manifest_draft take no_run for a repo that runs nothing", async () => {
    const { api, calls } = fakeApi([{ state: "done", result: { ok: true } }]);
    await callTool(
      "repo_add",
      { path: "~/code/rules", workspace: "web", no_run: true },
      ctx(api),
    );
    expect(calls[0].body).toEqual({
      action: "repo_add",
      args: { path: "~/code/rules", workspace: "web", no_run: true },
    });
    const tool = toolsFor(cfg()).find((t) => t.name === "repo_add");
    expect(tool?.description).toMatch(/no_run: true/);
    const draft = toolsFor(cfg()).find((t) => t.name === "manifest_draft");
    expect(draft?.description).toMatch(/no_run: true/);
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

describe("SRV-1b: den_update", () => {
  it("asks for den_update with the version (latest by default) and reason; says to end the turn", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, from: "1.0.0", to: "1.1.0", restarting: true },
    }));
    const r = await callTool("den_update", { reason: "new release" }, ctx(api));
    expect(r.isError).toBe(false);
    expect(calls[0].body).toEqual({
      action: "den_update",
      args: { version: "latest", reason: "new release" },
    });
    expect(JSON.parse(r.text)).toMatchObject({
      approved: true,
      result: { to: "1.1.0", restarting: true },
      next: expect.stringMatching(
        /End your turn now.*Server is back on.*commit/,
      ),
    });
  });

  it("a project's agent can't update Den: refused before anything is asked", async () => {
    const { api, calls } = fakeApi([]);
    const r = await callTool("den_update", { reason: "x" }, ctx(api, true));
    expect(r.isError).toBe(true);
    expect(calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });
});

describe("SRV-P1: agent_create", () => {
  it("asks for agent_create with the project, persona and what else was given", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, id: "ana", project: "north", repo: "shop" },
    }));
    const r = await callTool(
      "agent_create",
      {
        project: "north",
        persona: "reviewer",
        name: "Ana",
        repo: "shop",
        mode: "edits",
        note: "a second pair of eyes",
      },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls[0].body).toEqual({
      action: "agent_create",
      args: {
        project: "north",
        persona: "reviewer",
        name: "Ana",
        repo: "shop",
        mode: "edits",
      },
      note: "a second pair of eyes",
    });
    expect(JSON.parse(r.text)).toMatchObject({
      approved: true,
      result: { id: "ana", repo: "shop" },
    });
  });

  it("needs a project and a persona", async () => {
    const { api, calls } = fakeApi([]);
    const r = await callTool("agent_create", { persona: "x" }, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/project/);
    expect(calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });

  it("a project's agent asks for its own project (the default); another project is refused before anything is asked", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, id: "planner" },
    }));
    const own = await callTool(
      "agent_create",
      { persona: "planner" },
      ctx(api, true),
    );
    expect(own.isError).toBe(false);
    const asked = calls.find((c) => c.path === "/api/approvals");
    expect(asked?.body).toMatchObject({
      action: "agent_create",
      args: { project: "north", persona: "planner" },
    });
    const n = calls.length;
    const other = await callTool(
      "agent_create",
      { project: "elsewhere", persona: "planner" },
      ctx(api, true),
    );
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(
      /project "north".*only.*not to project "elsewhere"/,
    );
    expect(calls.slice(n).some((c) => c.path === "/api/approvals")).toBe(false);
  });
});

describe("SRV-P2: persona_create and persona_update", () => {
  it("persona_create asks with the persona's fields; any agent may ask", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, persona: { id: "copy-checker" } },
    }));
    const r = await callTool(
      "persona_create",
      {
        displayName: "Copy checker",
        role: "reviewer",
        category: "marketing",
        description: "Checks copy.",
        instructions: "Read the copy.",
        runtime: "den-claude",
        allowedCommands: ["git diff"],
      },
      ctx(api, true),
    );
    expect(r.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toEqual({
      action: "persona_create",
      args: {
        displayName: "Copy checker",
        role: "reviewer",
        category: "marketing",
        description: "Checks copy.",
        instructions: "Read the copy.",
        runtime: "den-claude",
        allowedCommands: ["git diff"],
      },
    });
  });

  it("persona_update asks with the id and only the fields given", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true },
    }));
    const r = await callTool(
      "persona_update",
      { id: "copy-checker", description: "Checks copy." },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls[0].body).toEqual({
      action: "persona_update",
      args: { id: "copy-checker", description: "Checks copy." },
    });
  });
});

describe("SRV-P4: project_mode and agent_folder", () => {
  it("project_mode asks with the project and mode; none clears it", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, project: "north", mode: null },
    }));
    const r = await callTool(
      "project_mode",
      { project: "north", mode: "none" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toEqual({
      action: "project_mode",
      args: { project: "north", mode: null },
    });
  });

  it("a project's agent sets its own project's mode (the default); another project is refused before anything is asked", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true },
    }));
    const own = await callTool(
      "project_mode",
      { mode: "edits" },
      ctx(api, true),
    );
    expect(own.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toMatchObject({
      args: { project: "north", mode: "edits" },
    });
    const n = calls.length;
    const other = await callTool(
      "project_mode",
      { project: "elsewhere", mode: "ask" },
      ctx(api, true),
    );
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(
      /project "north".*only.*not project "elsewhere"/,
    );
    expect(calls.slice(n).some((c) => c.path === "/api/approvals")).toBe(false);
  });

  it("agent_folder asks with the agent and its repo or folder; a project's agent's ask names its project", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, id: "ana", restarted: true },
    }));
    const r = await callTool(
      "agent_folder",
      { agent: "ana", repo: "shop" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toEqual({
      action: "agent_folder",
      args: { agent: "ana", repo: "shop" },
    });
    const n = calls.length;
    await callTool(
      "agent_folder",
      { agent: "ana", folder: "docs" },
      ctx(api, true),
    );
    expect(
      calls.slice(n).find((c) => c.path === "/api/approvals")?.body,
    ).toMatchObject({
      args: { agent: "ana", folder: "docs", project: "north" },
    });
    const none = await callTool("agent_folder", { repo: "shop" }, ctx(api));
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/agent/);
  });
});

describe("SRV-P3: repo_clone", () => {
  it("asks with the source, and the name and branch when given", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, path: "/r/notes" },
    }));
    const r = await callTool(
      "repo_clone",
      { source: "acme/notes", branch: "dev" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls[0].body).toEqual({
      action: "repo_clone",
      args: { source: "acme/notes", branch: "dev" },
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

describe("issue 199: agent_mode", () => {
  it("asks to make an agent follow its project's mode; a project's agent's ask names its project", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, agent: "ana", mode: "all", restarts: true },
    }));
    const r = await callTool("agent_mode", { agent: "ana" }, ctx(api));
    expect(r.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toEqual({
      action: "agent_mode",
      args: { agent: "ana" },
    });
    const n = calls.length;
    await callTool("agent_mode", { agent: "ana" }, ctx(api, true));
    expect(
      calls.slice(n).find((c) => c.path === "/api/approvals")?.body,
    ).toMatchObject({ args: { agent: "ana", project: "north" } });
    const none = await callTool("agent_mode", {}, ctx(api));
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/agent/);
  });
});

describe("issue 271: hub_project_create", () => {
  it("asks with the project and the name; the name may be left to Den", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, project: "north" },
    }));
    const r = await callTool(
      "hub_project_create",
      { project: "north", name: "North Star" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toEqual({
      action: "hub_project_create",
      args: { project: "north", name: "North Star" },
    });
    const own = await callTool("hub_project_create", {}, ctx(api, true));
    expect(own.isError).toBe(false);
    expect(
      calls.filter((c) => c.path === "/api/approvals").pop()?.body,
    ).toEqual({ action: "hub_project_create", args: { project: "north" } });
  });

  it("a project's agent can't ask for another project; nothing is asked", async () => {
    const { api, calls } = fakeApi([]);
    const r = await callTool(
      "hub_project_create",
      { project: "elsewhere" },
      ctx(api, true),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/project "north".*not project "elsewhere"/);
    expect(calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });
});

describe("issue 160: pr_close", () => {
  it("asks with the repo, the pull request and a comment; a held write with no mcp.actions", async () => {
    expect(toolsFor(cfg()).map((t) => t.name)).toContain("pr_close");
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, repo: "acme/api", pr: 12 },
    }));
    const r = await callTool(
      "pr_close",
      {
        repo: "acme/api",
        pr: 12,
        comment: "Superseded by 15, per the Hub note",
        note: "stale since the Hub note",
      },
      ctx(api, true),
    );
    expect(r.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toEqual({
      action: "pr_close",
      args: {
        project: "north",
        repo: "acme/api",
        pr: 12,
        comment: "Superseded by 15, per the Hub note",
      },
      note: "stale since the Hub note",
    });
  });

  it("needs the repo, the pull request and a comment: refused before anything is asked", async () => {
    const { api, calls } = fakeApi([]);
    for (const args of [
      { pr: 1, comment: "x" },
      { repo: "acme/api", comment: "x" },
      { repo: "acme/api", pr: 1 },
    ]) {
      const r = await callTool("pr_close", args, ctx(api, true));
      expect(r.isError).toBe(true);
    }
    expect(calls.filter((c) => c.path === "/api/approvals")).toEqual([]);
  });
});

describe("issue 647: hub_link", () => {
  it("asks with the project and the Hub project's id or slug", async () => {
    const { api, calls } = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, project: "north" },
    }));
    const r = await callTool(
      "hub_link",
      { project: "north", hub: "proj_n1" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toEqual({
      action: "hub_link",
      args: { project: "north", hub: "proj_n1" },
    });
    const own = await callTool("hub_link", { hub: "comet" }, ctx(api, true));
    expect(own.isError).toBe(false);
    expect(
      calls.filter((c) => c.path === "/api/approvals").pop()?.body,
    ).toEqual({ action: "hub_link", args: { project: "north", hub: "comet" } });
  });

  it("needs the Hub project; a project's agent can't ask for another project; nothing is asked", async () => {
    const { api, calls } = fakeApi([]);
    const none = await callTool("hub_link", { project: "north" }, ctx(api));
    expect(none.isError).toBe(true);
    const r = await callTool(
      "hub_link",
      { project: "elsewhere", hub: "proj_n1" },
      ctx(api, true),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/project "north".*not project "elsewhere"/);
    expect(calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });
});

describe("issue 565: report", () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  const DESTS = {
    ok: true,
    repos: [
      { repo: "acme-eng/engine", visibility: "public" },
      { repo: "acme-eng/inside", visibility: "private" },
    ],
  };
  /** The fake, plus Report's own routes: destinations and drafts. */
  function reportApi() {
    const f = fakeApi([], () => ({
      id: ID,
      state: "done",
      result: { ok: true, url: "https://github.com/acme-eng/inside/issues/9" },
    }));
    const inner = f.api.get.bind(f.api);
    f.api.get = async (p, query, method, body, headers) => {
      if (p === "/api/report" && (method ?? "GET") === "GET") {
        f.calls.push({ path: p, method: "GET" });
        return DESTS;
      }
      if (p === "/api/report/drafts" && method === "POST") {
        f.calls.push({ path: p, method, body });
        return { ok: true, draft: { id: "0123456789abcdef" } };
      }
      return inner(p, query, method, body, headers);
    };
    return f;
  }

  it("is a held write with no mcp.actions; the API client reaches only Report's list and drafts", () => {
    expect(toolsFor(cfg()).map((t) => t.name)).toContain("report");
    expect(toolsFor(cfg()).find((t) => t.name === "report")?.action).toBe(true);
    expect(() => assertAllowedRequest("GET", "/api/report", {})).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", "/api/report/drafts", {}),
    ).not.toThrow();
    // Never the person's own send.
    expect(() => assertAllowedRequest("POST", "/api/report/send", {})).toThrow(
      Refusal,
    );
  });

  it("with no title it lists the destinations with the page's labels, and asks nothing", async () => {
    const { api, calls } = reportApi();
    const r = await callTool("report", {}, ctx(api, true));
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/acme-eng\/engine.*Public repository/);
    expect(r.text).toMatch(/acme-eng\/inside.*Private repository/);
    expect(calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });

  it("asks the person with the page, the form and the destination", async () => {
    const { api, calls } = reportApi();
    const r = await callTool(
      "report",
      {
        kind: "bug",
        title: "Agents page blank",
        description: "Nothing renders",
        page: "/agents",
        repo: "acme-eng/inside",
      },
      ctx(api, true),
    );
    expect(r.isError).toBe(false);
    expect(calls.find((c) => c.path === "/api/approvals")?.body).toEqual({
      action: "report",
      args: {
        kind: "bug",
        title: "Agents page blank",
        description: "Nothing renders",
        page: "/agents",
        repo: "acme-eng/inside",
      },
    });
  });

  it("a screenshot path is read here and kept as the agent's own draft; its id goes with the ask", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const pth = await import("path");
    const dir = fs.mkdtempSync(pth.join(os.tmpdir(), "den-report-mcp-"));
    try {
      const shot = pth.join(dir, "shot.png");
      fs.writeFileSync(shot, PNG);
      const { api, calls } = reportApi();
      const r = await callTool(
        "report",
        { title: "Blank", repo: "acme-eng/inside", screenshot: shot },
        ctx(api, true),
      );
      expect(r.isError).toBe(false);
      const draft = calls.find((c) => c.path === "/api/report/drafts");
      expect((draft?.body as { shot?: string }).shot).toBe(
        `data:image/png;base64,${PNG.toString("base64")}`,
      );
      const asked = calls.find((c) => c.path === "/api/approvals")?.body as {
        args: Record<string, unknown>;
      };
      expect(asked.args.draftId).toBe("0123456789abcdef");
      // Not a PNG: refused before anything is kept or asked.
      const txt = pth.join(dir, "notes.txt");
      fs.writeFileSync(txt, "not an image");
      const b = reportApi();
      const n = await callTool(
        "report",
        { title: "Blank", screenshot: txt },
        ctx(b.api, true),
      );
      expect(n.isError).toBe(true);
      expect(b.calls.some((c) => c.path === "/api/report/drafts")).toBe(false);
      expect(b.calls.some((c) => c.path === "/api/approvals")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
