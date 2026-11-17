/**
 * Issue 352: removing a project's extra MCP server, or changing its url or
 * bearer reference, is a held write with Allow (project_mcp_remove,
 * project_mcp_update), always the person's own. Removing one takes it out
 * of the next agent start's --mcp-config; a new url reaches the next
 * start; neither runs before the Allow. The bearer stays a secrets.refs
 * name. Invented names and values only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import type { ProjectMcpServer } from "../../../src/shared/agents/project-mcp.js";
import { isCriticalWrite } from "../../../src/shared/approval-policy.js";
import {
  checkProjectMcpAdd,
  checkProjectMcpRemove,
  checkProjectMcpUpdate,
  resolveAgentsDeps,
  runProjectMcpAdd,
  runProjectMcpRemove,
  runProjectMcpUpdate,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { APPROVAL_TOOL_NAMES } from "../../../src/ui/mcp/tools.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

const VALUE = "trk_TESTONLY_never_shown_7c40";
const URL_A = "https://mcp.tracker.example.test";
const URL_B = "https://mcp2.tracker.example.test/mcp";

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
  await cleanupRigs();
});

/** A rig whose project north has tracker (with a bearer) and wiki. */
async function withStore(): Promise<{
  r: Rig;
  saved: Record<string, ProjectMcpServer[]>;
}> {
  const saved: Record<string, ProjectMcpServer[]> = {
    north: [
      { name: "tracker", url: URL_A, bearer: "tracker_token" },
      { name: "wiki", url: "https://wiki.example.test/mcp" },
    ],
  };
  const r = await rig({
    workspaceMcpServers: (ws) => saved[ws],
    saveWorkspaceMcpServers: (ws, list) => {
      saved[ws] = list;
    },
    secretRefSet: (n) => n === "tracker_token" || n === "tracker_token_2",
  });
  return { r, saved };
}

/** The MCP config project north's next agent starts with. */
async function nextStart(
  r: Rig,
): Promise<Record<string, { url?: string; headersHelper?: string }>> {
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  const file = path.join(r.stateDir, "agent-files", "planner", "mcp.json");
  return (
    JSON.parse(fs.readFileSync(file, "utf-8")) as {
      mcpServers: Record<string, { url?: string; headersHelper?: string }>;
    }
  ).mcpServers;
}

describe("issue 352: project_mcp_remove", () => {
  it("checks the ask: the person's own Allow, critical, details with no bearer", async () => {
    const { r } = await withStore();
    const c = checkProjectMcpRemove(resolveAgentsDeps(r.deps), {
      project: "north",
      name: "tracker",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBe(true);
    expect(c.args).toEqual({ project: "north", name: "tracker" });
    expect(c.params).toEqual({ project: "north", name: "tracker", url: URL_A });
    expect(c.detailKeys?.map((k) => k?.key)).toEqual([
      "ap.mcp.removeWarn",
      "ap.pm.project",
      "ap.mcp.server",
    ]);
    expect(JSON.stringify(c)).not.toContain("tracker_token");
    expect(isCriticalWrite("project_mcp_remove", false)).toBe(true);
  });

  it("refuses a server it hasn't, another project's, and Den's own place", async () => {
    const { r } = await withStore();
    const d = resolveAgentsDeps(r.deps);
    expect(
      checkProjectMcpRemove(d, { project: "north", name: "nope" }),
    ).toEqual({ ok: false, error: 'project north has no MCP server "nope"' });
    expect(
      checkProjectMcpRemove(
        d,
        { project: "north", name: "tracker" },
        { agent: "scout", project: "south" },
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("south") });
    expect(checkProjectMcpRemove(d, { project: "server", name: "x" }).ok).toBe(
      false,
    );
  });

  it("run: takes it out of the file and of the next start's --mcp-config", async () => {
    const { r, saved } = await withStore();
    const d = resolveAgentsDeps(r.deps);
    expect(
      await runProjectMcpRemove(d, { project: "north", name: "tracker" }),
    ).toEqual({
      ok: true,
      project: "north",
      servers: [{ name: "wiki", url: "https://wiki.example.test/mcp" }],
    });
    expect(saved.north.map((s) => s.name)).toEqual(["wiki"]);
    const cfg = await nextStart(r);
    expect(cfg.tracker).toBeUndefined();
    expect(cfg.wiki?.url).toBe("https://wiki.example.test/mcp");
  });
});

describe("issue 352: project_mcp_update", () => {
  it("checks a new url: critical, the old and new address, the bearer as a name", async () => {
    const { r } = await withStore();
    const c = checkProjectMcpUpdate(resolveAgentsDeps(r.deps), {
      project: "north",
      name: "tracker",
      url: URL_B,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBe(true);
    expect(c.args).toEqual({
      project: "north",
      server: { name: "tracker", url: URL_B, bearer: "tracker_token" },
    });
    expect(c.params).toEqual({ project: "north", name: "tracker", url: URL_B });
    expect(c.detailKeys?.map((k) => k?.key)).toEqual([
      "ap.mcp.warn",
      "ap.pm.project",
      "ap.mcp.urlChange",
      "ap.mcp.next",
    ]);
    expect(c.details.join("\n")).toContain(`${URL_A} → ${URL_B}`);
    expect(isCriticalWrite("project_mcp_update", false)).toBe(true);
  });

  it("changes the bearer reference, or drops it; never takes a value", async () => {
    const { r } = await withStore();
    const d = resolveAgentsDeps(r.deps);
    const ask = (a: Record<string, unknown>, who = {}) =>
      checkProjectMcpUpdate(
        d,
        { project: "north", name: "tracker", ...a },
        who,
      );
    const ref = ask({ bearer: "tracker_token_2" });
    expect(ref).toMatchObject({
      ok: true,
      args: {
        server: { name: "tracker", url: URL_A, bearer: "tracker_token_2" },
      },
    });
    expect(
      ref.ok && ref.detailKeys?.map((k) => k?.key).includes("ap.mcp.bearer"),
    ).toBe(true);
    expect(ask({ bearer: null })).toMatchObject({
      ok: true,
      args: { server: { name: "tracker", url: URL_A } },
    });
    expect(ask({ bearer: "other_ref" })).toEqual({
      ok: false,
      error:
        "secrets.refs.other_ref is not set: a person adds it to the install's config first",
    });
    const leak = ask({ bearer: `Bearer ${VALUE} x` });
    expect(leak.ok).toBe(false);
    expect(JSON.stringify(leak)).not.toContain(VALUE);
    expect(ask({ bearer: 42 }).ok).toBe(false);
    expect(ask({})).toEqual({
      ok: false,
      error: "nothing to change: give url, or bearer (null for none)",
    });
    expect(ask({ url: URL_A })).toEqual({
      ok: false,
      error: 'project north\'s MCP server "tracker" is already so',
    });
    expect(ask({ url: "http://far.example.test" }).ok).toBe(false);
    expect(
      ask({ url: URL_B }, { agent: "scout", project: "south" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("south") });
    expect(
      checkProjectMcpUpdate(d, { project: "north", name: "nope", url: URL_B }),
    ).toEqual({ ok: false, error: 'project north has no MCP server "nope"' });
  });

  it("run: the new url reaches the next start, in the same place in the list", async () => {
    const { r, saved } = await withStore();
    const d = resolveAgentsDeps(r.deps);
    const c = checkProjectMcpUpdate(d, {
      project: "north",
      name: "tracker",
      url: URL_B,
    });
    if (!c.ok) throw new Error(c.error);
    expect(await runProjectMcpUpdate(d, c.args)).toEqual({
      ok: true,
      project: "north",
      servers: [
        { name: "tracker", url: URL_B },
        { name: "wiki", url: "https://wiki.example.test/mcp" },
      ],
    });
    expect(saved.north[0]).toEqual({
      name: "tracker",
      url: URL_B,
      bearer: "tracker_token",
    });
    const cfg = await nextStart(r);
    expect(cfg.tracker?.url).toBe(URL_B);
    expect(cfg.tracker?.headersHelper).toContain("tracker");
    expect(JSON.stringify(cfg)).not.toContain("tracker_token");
  });
});

describe("issue 352: neither runs before the person's Allow", () => {
  it("an agent's ask waits, even with a setting that allows every ask; the Allow runs it", async () => {
    const { r, saved } = await withStore();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-pmcp-"));
    dirs.push(stateDir);
    const d = () => resolveAgentsDeps(r.deps);
    const actions = heldActions({
      projectMcp: {
        check: (a, who) => checkProjectMcpAdd(d(), a, who),
        run: (a) => runProjectMcpAdd(d(), a),
      },
      projectMcpRemove: {
        check: (a, who) => checkProjectMcpRemove(d(), a, who),
        run: (a) => runProjectMcpRemove(d(), a),
      },
      projectMcpUpdate: {
        check: (a, who) => checkProjectMcpUpdate(d(), a, who),
        run: (a) => runProjectMcpUpdate(d(), a),
      },
    } as Parameters<typeof heldActions>[0]);
    const queue = createApprovalQueue(actions, () => stateDir);
    const s = http.createServer((req, res) => {
      const p: Principal = {
        kind: "agent",
        actor: "agent:lead",
        workspace: "north",
        grants: [],
        session: { name: "acme-north:lead" },
      };
      setPrincipal(req, p);
      void handleApprovalRoutes(
        req,
        res,
        new URL(req.url!, "http://x").pathname,
        {
          ok: true,
          principal: p,
          via: "loopback",
          beyond: false,
          session: null,
        } as unknown as Extract<GuardResult, { ok: true }>,
        {
          queue,
          actions,
          enabled: () => true,
          autoAllow: () => "a setting that allows every ask",
          policy: () => ({ kind: "auto", from: "test" }),
        },
      );
    });
    servers.push(s);
    await new Promise<void>((res) => s.listen(0, "localhost", () => res()));
    const base = `http://localhost:${(s.address() as AddressInfo).port}`;
    mintActorToken(stateDir, {
      agentId: "lead",
      workspace: "north",
      sessionName: "acme-north:lead",
    });
    const ask = async (action: string, args: Record<string, unknown>) =>
      (await (
        await fetch(`${base}/api/approvals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, args }),
        })
      ).json()) as { id: string; state: string };
    const before = JSON.stringify(saved.north);
    const upd = await ask("project_mcp_update", {
      project: "north",
      name: "tracker",
      url: URL_B,
    });
    const rem = await ask("project_mcp_remove", {
      project: "north",
      name: "wiki",
    });
    // Issue 335's add, through the same queue: the Allow re-checks the
    // args as they were stored.
    const add = await ask("project_mcp_add", {
      project: "north",
      name: "docs",
      url: "https://docs.example.test/mcp",
      bearer: "tracker_token_2",
    });
    expect([upd.state, rem.state, add.state]).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(JSON.stringify(saved.north)).toBe(before);
    for (const id of [upd.id, rem.id, add.id])
      expect(await queue.decide(id, "allow", "s1")).toMatchObject({
        ok: true,
        approval: { state: "done", result: { ok: true } },
      });
    expect(saved.north).toEqual([
      { name: "tracker", url: URL_B, bearer: "tracker_token" },
      {
        name: "docs",
        url: "https://docs.example.test/mcp",
        bearer: "tracker_token_2",
      },
    ]);
    const cfg = await nextStart(r);
    expect(cfg.tracker?.url).toBe(URL_B);
    expect(cfg.wiki).toBeUndefined();
    expect(cfg.docs?.url).toBe("https://docs.example.test/mcp");
  });

  it("both are registered held writes", () => {
    expect(APPROVAL_TOOL_NAMES).toEqual(
      expect.arrayContaining(["project_mcp_remove", "project_mcp_update"]),
    );
  });
});
