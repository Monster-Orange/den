/**
 * Issue 124: a restart whose resume fails after Den's own stop never
 * leaves the agent stopped with no way back. Den marks it interrupted
 * (not stopped), so the page offers Resume and restore-on-boot brings it
 * back; and it tells the person: one audit row and one "needs you" item
 * in the bell. Each refusal kind reachable here: its folder gone, its
 * conversation open in another process, the cap, and an exit at once.
 *
 * A real host on a temp socket with a scripted PTY: nothing real runs.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import { procStartOf } from "../../../src/shared/agents/open-check.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  markInterrupted,
  resolveAgentsDeps,
  restartAgent,
  type AgentsResolved,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";
import { readAuditRows } from "../../../src/shared/audit-queue.js";

afterEach(cleanupRigs);

/** Stop waits for the session to end, and each scripted one ends on TERM. */
function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const push = r.made.push.bind(r.made);
  r.made.push = (...ps) => {
    for (const p of ps) {
      const kill = p.kill.bind(p);
      p.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => p.exit(143), 5);
      };
    }
    return push(...ps);
  };
}

/** Claude Code's config dir in the rig (its sessions/ and projects/). */
function claudeDir(r: Rig): string {
  const dir = path.join(r.dir, "claude-config");
  fs.mkdirSync(dir, { recursive: true });
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: dir };
  return dir;
}

async function running(id = "planner"): Promise<Rig> {
  const r = await rig();
  endOnTerm(r);
  claudeDir(r);
  expect(
    await cmdAgents(
      ["start", "-w", "north", "--persona", "planner", "--id", id],
      r.deps,
    ),
  ).toBe(0);
  await settle();
  return r;
}

async function stateOf(r: Rig, id = "planner"): Promise<string> {
  r.out.length = 0;
  expect(await cmdAgents(["list", "-w", "north", "--json"], r.deps)).toBe(0);
  const rows = JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
  return String(rows.find((x) => x.agent === id)?.state);
}

function auditRows(r: Rig): Record<string, unknown>[] {
  // Issue 1369: the file and the CLI's queue.
  return readAuditRows(r.stateDir);
}

function bell(r: Rig): Array<Record<string, unknown>> {
  const f = path.join(r.stateDir, "notifications.json");
  if (!fs.existsSync(f)) return [];
  return (
    JSON.parse(fs.readFileSync(f, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    }
  ).items;
}

/** Interrupted, not stopped; one audit row and one bell item say why. */
async function toldAndMarked(r: Rig, why: RegExp): Promise<void> {
  const rec = readRecord(r.stateDir, "planner")!;
  expect(rec.stoppedAt).toBeUndefined();
  expect(await stateOf(r)).toBe("interrupted");
  const rows = auditRows(r).filter((x) =>
    /restart planner in north/.test(String(x.detail)),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ verb: "agents", outcome: "refused" });
  expect(String(rows[0].detail)).toMatch(/not back; marked interrupted/);
  expect(String(rows[0].reason)).toMatch(why);
  const items = bell(r).filter((n) => n.subject === "agent:planner");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "waiting",
    scope: "workspace/north",
    read: false,
    msg: { key: "bell.m.restartFailed" },
  });
  expect(String(items[0].text)).toMatch(why);
}

describe("a restart whose resume fails after Den's stop (issue 124)", () => {
  it("its folder gone: interrupted, told; restore-on-boot brings it back", async () => {
    const r = await running();
    const d: AgentsResolved = resolveAgentsDeps(r.deps);
    const cwd = readRecord(r.stateDir, "planner")!.cwd;
    fs.rmSync(cwd, { recursive: true, force: true });
    await expect(restartAgent(d, "planner", "north", "now")).rejects.toThrow(
      /folder .* is gone/,
    );
    await toldAndMarked(r, /folder .* is gone/);
    // The folder back: Den's restart finds it and resumes it.
    fs.mkdirSync(cwd, { recursive: true });
    const found = await markInterrupted(d, { restoreAll: true });
    expect(found.interrupted).toEqual(["planner"]);
    expect(found.resumed).toEqual(["planner"]);
    expect(await stateOf(r)).toBe("running");
    expect(readRecord(r.stateDir, "planner")!.restartFailed).toBeUndefined();
  }, 20_000);

  it("its conversation open in another process: interrupted, told", async () => {
    const r = await running();
    const d = resolveAgentsDeps(r.deps);
    const token = readRecord(r.stateDir, "planner")!.resumeToken!;
    const sessions = path.join(claudeDir(r), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: token,
        cwd: r.dir,
        procStart: procStartOf(process.pid),
      }),
    );
    await expect(restartAgent(d, "planner", "north", "now")).rejects.toThrow(
      /open in another process/,
    );
    await toldAndMarked(r, /open in another process/);
  }, 20_000);

  it("the cap: interrupted, told", async () => {
    const r = await running();
    expect(
      await cmdAgents(
        ["start", "-w", "north", "--persona", "planner", "--id", "scout"],
        r.deps,
      ),
    ).toBe(0);
    await settle();
    // Two run; the cap is lowered to one under them.
    r.config.maxConcurrent = 1;
    const d = resolveAgentsDeps(r.deps);
    const e = await restartAgent(d, "planner", "north", "now").catch(
      (x: unknown) => x as { code?: string; message: string },
    );
    expect(e).toMatchObject({ code: "cap" });
    const said = new RegExp(
      (e as { message: string }).message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    await toldAndMarked(r, said);
    expect(await stateOf(r, "scout")).toBe("running");
  }, 20_000);

  it("an exit at once: interrupted, told", async () => {
    const r = await running();
    r.deps.exitWatchMs = 300;
    // The resumed session exits at once with nothing said.
    const push = r.made.push.bind(r.made);
    r.made.push = (...ps) => {
      for (const p of ps) setTimeout(() => p.exit(1), 5);
      return push(...ps);
    };
    const d = resolveAgentsDeps(r.deps);
    const out = await restartAgent(d, "planner", "north", "now");
    expect(out.early).toBeTruthy();
    await toldAndMarked(r, /exited at once/);
  }, 20_000);

  it("a stopped agent's failed restart leaves it stopped, as it was", async () => {
    const r = await running();
    expect(await cmdAgents(["stop", "planner"], r.deps)).toBe(0);
    await settle();
    const was = readRecord(r.stateDir, "planner")!.stoppedAt;
    const cwd = readRecord(r.stateDir, "planner")!.cwd;
    fs.rmSync(cwd, { recursive: true, force: true });
    const d = resolveAgentsDeps(r.deps);
    await expect(restartAgent(d, "planner", "north", "now")).rejects.toThrow(
      /folder .* is gone/,
    );
    expect(readRecord(r.stateDir, "planner")!.stoppedAt).toBe(was);
    expect(await stateOf(r)).toBe("stopped");
    expect(bell(r)).toEqual([]);
  }, 20_000);
});
