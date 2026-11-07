/**
 * Session rotation (den#4): once an agent's session rotated (3 compactions
 * by default, or its pull request merged) and its handoff.md passes the
 * check, Den declines a plain Resume and offers Relaunch from handoff: a
 * fresh conversation (a new conversation id), the same persona, workspace,
 * folder and grants, whose first prompt is the handoff.
 *
 *   - `agents resume <id>` on a rotated agent refuses (exit 1) and names
 *     `agents relaunch <id>`; the resume route answers 409 `rotated`;
 *   - handoff.md missing or failing: relaunch says so and names Start
 *     fresh; Resume stays available;
 *   - `agents list` and the rows say why: ready to relaunch or handoff due;
 *   - the handoff moves to handoffs/, the count starts again, the record
 *     keeps the rotation; standing personas rotate unless
 *     agents.rotate.standing is false.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs), and a
 * `claude` shim that must never run. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  readRecord,
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import {
  noteCompaction,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const rec = (r: Rig, id: string) => readRecord(r.stateDir, id)!;
const files = (r: Rig, id: string) => path.join(r.stateDir, "agent-files", id);

async function listRows(r: Rig, ws = "north") {
  r.out.length = 0;
  expect(await agents(r, "list", "-w", ws, "--json")).toBe(0);
  return JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
}

/** A started, prompted be-dev with a grant: there is a conversation. */
async function started(r: Rig, id = "be-dev"): Promise<string> {
  r.config.agents = { [id]: { grants: ["south"] } };
  expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(rec(r, id).session.id, Buffer.from("build the export\r"));
  await settle();
  c.close();
  return rec(r, id).resumeToken!;
}

/** Its conversation compacts `n` times (the SessionStart "compact" count). */
function compact(r: Rig, id: string, n: number): void {
  const token = rec(r, id).resumeToken!;
  const after = readRotation(files(r, id))!.after;
  for (let i = 0; i < n; i++)
    noteCompaction(files(r, id), { session_id: token, trigger: "auto" }, after);
}

async function stop(r: Rig, id = "be-dev"): Promise<void> {
  expect(await agents(r, "stop", id)).toBe(0);
  r.made[r.made.length - 1].exit(0);
  await settle();
}

const writeHandoff = (r: Rig, id: string, text = GOOD_HANDOFF) =>
  fs.writeFileSync(path.join(files(r, id), "handoff.md"), text);

describe("agents handoff-check <id>", () => {
  it("checks that agent's handoff.md; a missing one says where it would be", async () => {
    const r = await rig();
    await started(r);
    expect(await agents(r, "handoff-check", "be-dev")).toBe(1);
    expect(r.err.join("\n")).toContain(
      `no handoff.md yet for agent be-dev (${path.join(files(r, "be-dev"), "handoff.md")})`,
    );
    writeHandoff(r, "be-dev");
    expect(await agents(r, "handoff-check", "be-dev")).toBe(0);
    expect(r.out.join("\n")).toContain("✓ the handoff is complete and plain");
  });
});

describe("a session that rotated after 3 compactions", () => {
  it("counts from 0 at its start, under its own conversation", async () => {
    const r = await rig();
    const token = await started(r);
    expect(readRotation(files(r, "be-dev"))).toEqual({
      conversation: token,
      compactions: 0,
      after: 3,
    });
    compact(r, "be-dev", 2);
    const [row] = await listRows(r);
    expect(row.rotation).toEqual({
      compactions: 2,
      after: 3,
      handoff: "missing",
      ready: false,
    });
  });

  it("without a handoff: the row says handoff due; Resume stays; relaunch says so and names Start fresh", async () => {
    const r = await rig();
    await started(r);
    compact(r, "be-dev", 3);
    await stop(r);
    const [row] = await listRows(r);
    expect(row).toMatchObject({
      state: "stopped",
      resumable: true,
      rotation: { due: "compactions", handoff: "missing", ready: false },
    });
    r.out.length = 0;
    expect(await agents(r, "list", "-w", "north")).toBe(0);
    expect(r.out.join("\n")).toMatch(/stopped, handoff due \(3 compactions\)/);

    r.err.length = 0;
    expect(await agents(r, "relaunch", "be-dev")).toBe(1);
    expect(r.err.join("\n")).toMatch(/has no handoff\.md yet/);
    expect(r.err.join("\n")).toMatch(/Start fresh: acme agents start -w north/);
    // A failing handoff is named, problem by problem.
    writeHandoff(r, "be-dev", "## Objective\nShip.\n");
    r.err.length = 0;
    expect(await agents(r, "relaunch", "be-dev")).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /handoff\.md is not ready: .*Missing "## State"/,
    );
    const [bad] = await listRows(r);
    expect(bad.rotation).toMatchObject({ handoff: "invalid", ready: false });
    // Resume is still there: to write (or fix) the handoff.
    expect(await agents(r, "resume", "be-dev")).toBe(0);
    expect(r.made[1].args.slice(0, 1)).toEqual(["--resume"]);
    expect(r.made).toHaveLength(2);
  });

  it("with a handoff: Resume refuses (exit 1) naming relaunch; relaunch starts a new conversation from it", async () => {
    const r = await rig();
    const t1 = await started(r);
    compact(r, "be-dev", 3);
    writeHandoff(r, "be-dev");
    await stop(r);

    const [row] = await listRows(r);
    expect(row).toMatchObject({
      resumable: false,
      noResume: "be-dev rotated (3 compactions): relaunch it from its handoff",
      rotation: { due: "compactions", handoff: "ok", ready: true },
    });
    r.out.length = 0;
    await agents(r, "list", "-w", "north");
    expect(r.out.join("\n")).toMatch(/ready to relaunch \(3 compactions\)/);

    r.err.length = 0;
    expect(await agents(r, "resume", "be-dev")).toBe(1);
    expect(r.err[0]).toBe(
      "✗ agent be-dev rotated after 3 compactions: its conversation is not resumed",
    );
    expect(r.err).toContain(
      "  Relaunch from handoff: acme agents relaunch be-dev",
    );
    expect(r.made).toHaveLength(1);

    r.out.length = 0;
    expect(await agents(r, "relaunch", "be-dev")).toBe(0);
    expect(r.out[0]).toMatch(
      /^relaunched agent be-dev from its handoff \(the last session ended after 3 compactions\)/,
    );
    expect(r.made).toHaveLength(2);
    const p = r.made[1];
    // A fresh conversation: --session-id, a new id, never --resume.
    expect(p.args[0]).toBe("--session-id");
    const t2 = p.args[1];
    expect(t2).not.toBe(t1);
    expect(p.args).not.toContain("--resume");
    // Its first prompt is the handoff, the last argument.
    const first = p.args[p.args.length - 1];
    expect(first).toMatch(
      /^Den relaunched you from the handoff your last session wrote\. That session ended after 3 compactions/,
    );
    expect(first).toContain(GOOD_HANDOFF);
    // The same persona, workspace, folder and grants.
    const now = rec(r, "be-dev");
    expect(now).toMatchObject({
      persona: "be-dev",
      workspace: "north",
      cwd: r.wsDir("north"),
      grants: ["south"],
      resumeToken: t2,
    });
    expect(p.opts.cwd).toBe(r.wsDir("north"));
    expect(now.rotations).toEqual([
      {
        at: expect.any(String),
        reason: "compactions",
        compactions: 3,
        conversation: t1,
      },
    ]);
    // The handoff is kept aside; the new conversation counts from 0.
    expect(fs.existsSync(path.join(files(r, "be-dev"), "handoff.md"))).toBe(
      false,
    );
    const kept = fs.readdirSync(path.join(files(r, "be-dev"), "handoffs"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain(t1);
    expect(readRotation(files(r, "be-dev"))).toEqual({
      conversation: t2,
      compactions: 0,
      after: 3,
    });
    const [after] = await listRows(r);
    expect(after.state).toBe("running");
    expect(after.rotation).toEqual({
      compactions: 0,
      after: 3,
      handoff: "missing",
      ready: false,
    });
    expect(after.rotations).toBe(1);
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("relaunch of one that has not rotated is refused, naming resume", async () => {
    const r = await rig();
    await started(r);
    await stop(r);
    r.err.length = 0;
    expect(await agents(r, "relaunch", "be-dev")).toBe(1);
    expect(r.err.join("\n")).toMatch(/has not rotated: resume it instead/);
  });

  it("a running rotated agent is stopped, then relaunched", async () => {
    const r = await rig({ stopWaitMs: 5000 });
    await started(r);
    const p = r.made[0];
    const kill = p.kill.bind(p);
    p.kill = (signal: string) => {
      kill(signal);
      setTimeout(() => p.exit(143), 50);
    };
    compact(r, "be-dev", 3);
    writeHandoff(r, "be-dev");
    expect(await agents(r, "relaunch", "be-dev")).toBe(0);
    expect(p.signals).toContain("SIGTERM");
    expect(r.made).toHaveLength(2);
    expect(r.made[1].args[0]).toBe("--session-id");
  }, 20_000);
});

describe("the other trigger and the settings", () => {
  it("its pull request merged (the record's outcome): ready to relaunch (PR merged)", async () => {
    const r = await rig();
    await started(r);
    compact(r, "be-dev", 1);
    const x: AgentRecord = {
      ...rec(r, "be-dev"),
      outcome: {
        prOpened: "https://github.com/acme/notes/pull/7",
        prMerged: true,
      },
    };
    writeRecord(r.stateDir, x);
    writeHandoff(r, "be-dev");
    await stop(r);
    const [row] = await listRows(r);
    expect(row.rotation).toMatchObject({ due: "pr-merged", ready: true });
    expect(await agents(r, "relaunch", "be-dev")).toBe(0);
    const first = r.made[1].args[r.made[1].args.length - 1];
    expect(first).toMatch(/ended after PR merged/);
    expect(rec(r, "be-dev").rotations?.[0].reason).toBe("pr-merged");
  });

  it("agents.rotate.after_compactions sets the limit", async () => {
    const r = await rig();
    r.config.rotate = { afterCompactions: 5, standing: true };
    await started(r);
    expect(readRotation(files(r, "be-dev"))?.after).toBe(5);
    compact(r, "be-dev", 4);
    const [row] = await listRows(r);
    expect((row.rotation as { due?: string }).due).toBeUndefined();
  });

  it("a standing persona rotates by default; never with agents.rotate.standing false", async () => {
    const r = await rig();
    await started(r, "planner");
    expect(readRotation(files(r, "planner"))?.after).toBe(3);
    await stop(r, "planner");
    r.config.rotate = { afterCompactions: 3, standing: false };
    expect(
      // --id: the same agent again (a new start would take planner-2).
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--id",
        "planner",
      ),
    ).toBe(0);
    expect(readRotation(files(r, "planner"))?.after).toBe(0);
    compact(r, "planner", 6);
    const [row] = await listRows(r);
    expect((row.rotation as { due?: string }).due).toBeUndefined();
  });
});

describe("the routes", () => {
  async function route(r: Rig) {
    const server = http.createServer((req, res) => {
      jsonApiErrors(res, newRequestId());
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, { agents: r.deps });
    });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "localhost", res));
    const port = (server.address() as AddressInfo).port;
    return async (p: string) => {
      const res = await fetch(`http://localhost:${port}${p}`, {
        method: "POST",
      });
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    };
  }

  it("resume answers 409 rotated with the relaunch hint; relaunch starts it from the handoff", async () => {
    const r = await rig();
    await started(r);
    compact(r, "be-dev", 3);
    writeHandoff(r, "be-dev");
    await stop(r);
    const post = await route(r);
    const no = await post("/api/workspaces/north/agents/be-dev/resume");
    expect(no.status).toBe(409);
    expect(no.json).toMatchObject({ ok: false, code: "rotated" });
    expect(no.json.hints).toContain(
      "Relaunch from handoff: acme agents relaunch be-dev",
    );
    const ok = await post("/api/workspaces/north/agents/be-dev/relaunch");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      ok: true,
      agent: { id: "be-dev", workspace: "north" },
    });
    expect(r.made[1].args[r.made[1].args.length - 1]).toContain(GOOD_HANDOFF);
    // Another workspace's agent is no agent here.
    expect(
      (await post("/api/workspaces/south/agents/be-dev/relaunch")).status,
    ).toBe(404);
  });

  it("relaunch without a handoff answers 409 no_handoff with Start fresh", async () => {
    const r = await rig();
    await started(r);
    compact(r, "be-dev", 3);
    await stop(r);
    const post = await route(r);
    const no = await post("/api/workspaces/north/agents/be-dev/relaunch");
    expect(no.status).toBe(409);
    expect(no.json).toMatchObject({ code: "no_handoff" });
    expect(String((no.json.hints as string[])[0])).toMatch(/^Start fresh/);
  });
});

describe("Start fresh on a rotated agent", () => {
  it("keeps the old handoff aside, so the new conversation needs its own", async () => {
    const r = await rig();
    await started(r);
    compact(r, "be-dev", 3);
    writeHandoff(r, "be-dev");
    await stop(r);
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "be-dev",
        "--id",
        "be-dev",
      ),
    ).toBe(0);
    expect(fs.existsSync(path.join(files(r, "be-dev"), "handoff.md"))).toBe(
      false,
    );
    expect(
      fs.readdirSync(path.join(files(r, "be-dev"), "handoffs"))[0],
    ).toMatch(/-unused\.md$/);
    compact(r, "be-dev", 3);
    const [row] = await listRows(r);
    expect(row.rotation).toMatchObject({ handoff: "missing", ready: false });
  });
});
