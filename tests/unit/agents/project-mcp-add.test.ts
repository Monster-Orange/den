/**
 * Issue 335: adding a project's extra MCP server is a held write with
 * Allow (project_mcp_add, always the person's own); Settings and doctor
 * list the servers by name and url only. Invented names and values only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import type { ProjectMcpServer } from "../../../src/shared/agents/project-mcp.js";
import { isCriticalWrite } from "../../../src/shared/approval-policy.js";
import {
  checkProjectMcpAdd,
  resolveAgentsDeps,
  runProjectMcpAdd,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  mcpBearerProblem,
  projectMcpLines,
} from "../../../src/ui/cli/doctor-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

const VALUE = "trk_TESTONLY_never_shown_51a2";
const URL_A = "https://mcp.tracker.example.test";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

/** A rig whose projects' mcp_servers live in memory; one ref is set. */
async function withStore(): Promise<{
  r: Rig;
  saved: Record<string, ProjectMcpServer[]>;
}> {
  const saved: Record<string, ProjectMcpServer[]> = {};
  const r = await rig({
    workspaceMcpServers: (ws) => saved[ws],
    saveWorkspaceMcpServers: (ws, list) => {
      saved[ws] = list;
    },
    secretRefSet: (n) => n === "tracker_token",
  });
  return { r, saved };
}

describe("issue 335: project_mcp_add, a held write with Allow", () => {
  it("checks the ask: the person's own Allow, a summary and details with no value", async () => {
    const { r } = await withStore();
    const d = resolveAgentsDeps(r.deps);
    const c = checkProjectMcpAdd(d, {
      project: "north",
      name: "tracker",
      url: URL_A,
      bearer: "tracker_token",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBe(true);
    expect(c.params).toEqual({ project: "north", name: "tracker", url: URL_A });
    expect(c.details.join("\n")).toContain("secrets.refs.tracker_token");
    expect(c.detailKeys?.map((k) => k?.key)).toEqual([
      "ap.mcp.warn",
      "ap.pm.project",
      "ap.mcp.server",
      "ap.mcp.bearer",
      "ap.mcp.next",
    ]);
    expect(isCriticalWrite("project_mcp_add", false)).toBe(true);
  });

  it("refuses an unset ref, a value as bearer, another project, a taken name and a duplicate", async () => {
    const { r, saved } = await withStore();
    const d = resolveAgentsDeps(r.deps);
    const ask = (a: Record<string, unknown>, who = {}) =>
      checkProjectMcpAdd(d, { project: "north", url: URL_A, ...a }, who);
    expect(ask({ name: "tracker", bearer: "other_ref" })).toEqual({
      ok: false,
      error:
        "secrets.refs.other_ref is not set: a person adds it to the install's config first",
    });
    const leak = ask({ name: "tracker", bearer: `Bearer ${VALUE} x` });
    expect(leak.ok).toBe(false);
    expect(JSON.stringify(leak)).not.toContain(VALUE);
    expect(
      ask({ name: "tracker" }, { agent: "scout", project: "south" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("south") });
    expect(ask({ name: "acme" }).ok).toBe(false);
    saved.north = [{ name: "tracker", url: URL_A }];
    expect(ask({ name: "tracker" })).toEqual({
      ok: false,
      error: 'project north already has an MCP server "tracker"',
    });
  });

  it("on Allow, the held action saves it and project north's next agent gets it", async () => {
    const { r, saved } = await withStore();
    const held = heldActions({
      projectMcp: {
        check: (a, who) =>
          checkProjectMcpAdd(resolveAgentsDeps(r.deps), a, who),
        run: (a) => runProjectMcpAdd(resolveAgentsDeps(r.deps), a),
      },
    } as Parameters<typeof heldActions>[0]);
    const c = held.project_mcp_add.check({
      project: "north",
      name: "tracker",
      url: URL_A,
      bearer: "tracker_token",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(await held.project_mcp_add.run(c.args)).toEqual({
      ok: true,
      project: "north",
      servers: [{ name: "tracker", url: URL_A }],
    });
    expect(saved.north).toEqual([
      { name: "tracker", url: URL_A, bearer: "tracker_token" },
    ]);
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(r.stateDir, "agent-files", "planner", "mcp.json"),
        "utf-8",
      ),
    ) as { mcpServers: Record<string, { url?: string }> };
    expect(cfg.mcpServers.tracker?.url).toBe(URL_A);
  });
});

describe("issue 335: Settings and doctor show names and urls only", () => {
  it("GET /api/workspaces/:ws/mcp-servers answers names and urls; other methods are refused", async () => {
    const { r, saved } = await withStore();
    saved.north = [{ name: "tracker", url: URL_A, bearer: "tracker_token" }];
    const s = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, { agents: r.deps });
    });
    servers.push(s);
    await new Promise<void>((res) => s.listen(0, "localhost", () => res()));
    const base = `http://localhost:${(s.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/workspaces/north/mcp-servers`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      ok: true,
      project: "north",
      servers: [{ name: "tracker", url: URL_A }],
    });
    expect(body).not.toContain("tracker_token");
    expect(
      (
        await fetch(`${base}/api/workspaces/north/mcp-servers`, {
          method: "POST",
        })
      ).status,
    ).toBe(405);
    expect(routeClass("GET", "/api/workspaces/north/mcp-servers")).toBe(
      "readonly",
    );
  });

  it("doctor: a line per server, name and url; a bearer that can't be served is ✗ with why, a bad entry warns, with no value", () => {
    // Issue 473: why each bearer can't be served (null: it can).
    const why: Record<string, string | null> = {
      tracker: null,
      wiki: "secrets.refs.w is not set",
      notes:
        "secrets.provider is env and NOTES_TOKEN isn't in the server's env",
    };
    const out = projectMcpLines(
      [
        {
          ws: "north",
          raw: [
            { name: "tracker", url: URL_A, bearer: "tracker_token" },
            { name: "wiki", url: "https://wiki.example.test/mcp", bearer: "w" },
            { name: "notes", url: "https://notes.example.test", bearer: "n" },
            { name: "open", url: "https://open.example.test" },
            { name: "bad", url: "http://far.example.test", bearer: VALUE },
          ],
        },
      ],
      (_ws, sv) => why[sv.name] ?? null,
    );
    expect(out.lines).toEqual([
      `  mcp server  ✓  north: tracker ${URL_A}`,
      "  mcp server  ✗  north: wiki https://wiki.example.test/mcp: its bearer can't be served, so it won't connect: secrets.refs.w is not set",
      "  mcp server  ✗  north: notes https://notes.example.test: its bearer can't be served, so it won't connect: secrets.provider is env and NOTES_TOKEN isn't in the server's env",
      "  mcp server  ✓  north: open https://open.example.test",
      "  mcp server  ⚠  north: agents.mcp_servers[4]: url must be https (http only to this machine): http://far.example.test",
    ]);
    expect(out.checks.map((c) => c.status)).toEqual([
      "ok",
      "fail",
      "fail",
      "ok",
      "warn",
    ]);
    expect(JSON.stringify(out)).not.toContain(VALUE);
    expect(JSON.stringify(out)).not.toContain("tracker_token");
  });

  it("issue 473, doctor: an unset ref, Den not running, or the server's own why: can't be served", () => {
    const set = (n: string) => n === "tracker_token";
    const d = { refSet: set, cli: "acme" };
    expect(mcpBearerProblem("w", { ...d, served: { why: null } })).toBe(
      "secrets.refs.w is not set",
    );
    expect(mcpBearerProblem("tracker_token", { ...d, served: null })).toBe(
      "Den isn't running, and only Den serves the bearer: start it with `acme web up`",
    );
    const why =
      "secrets.refs.tracker_token can't be read: Secret TRACKER_TOKEN is not set in the environment";
    expect(mcpBearerProblem("tracker_token", { ...d, served: { why } })).toBe(
      why,
    );
    expect(
      mcpBearerProblem("tracker_token", { ...d, served: { why: null } }),
    ).toBeNull();
  });
});
