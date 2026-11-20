/**
 * Issue 631: a terminal host restart and an agent that relaunched itself
 * from its handoff (D28, on_due auto).
 *
 *   1. Every agent whose session runs is on the restart's list: one whose
 *      record still names an earlier session of its own, but whose live
 *      session (by its name) runs, too.
 *   2. A relaunched agent resumes in its new conversation (`--resume
 *      <new>`), never a fresh start under that conversation's id: the
 *      relaunch's first prompt was an argument, so nobody typed into it,
 *      but its conversation has begun.
 *   3. A resume that ended after it was started counts as failed, with
 *      its reason; the agent is marked, and the bell says so.
 *   4. Its row says it didn't come back after the restart, and why.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs), and a
 * `claude` shim that must never run. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  readRecord,
  writeRecord,
} from "../../../src/shared/agents/records.js";
import {
  noteCompaction,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import * as ops from "../../../src/ui/cli/agent-ops.js";
import {
  resolveAgentsDeps,
  resumeAfterHostRestart,
  rotationTick,
  runningAgentIds,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  await cleanupRigs();
});

const agents = (r: Rig, ...a: string[]) => cmdAgents(a, r.deps);
const rec = (r: Rig, id: string) => readRecord(r.stateDir, id)!;
const files = (r: Rig, id: string) => path.join(r.stateDir, "agent-files", id);

/** The PTYs end on TERM, as a real runtime does. */
function endOnTerm(r: Rig): void {
  for (const pty of r.made) {
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      setTimeout(() => pty.exit(0), 10);
    };
  }
}

async function started(r: Rig, id = "be-dev"): Promise<string> {
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: path.join(r.dir, "cc") };
  r.deps.stopWaitMs = 2000;
  expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
  endOnTerm(r);
  return rec(r, id).resumeToken!;
}

/** It compacted 3 times, wrote its handoff, and is idle: due, at idle. */
function dueAndIdle(r: Rig, id: string): void {
  const token = rec(r, id).resumeToken!;
  const after = readRotation(files(r, id))!.after;
  for (let i = 0; i < 3; i++)
    noteCompaction(files(r, id), { session_id: token, trigger: "auto" }, after);
  fs.writeFileSync(path.join(files(r, id), "handoff.md"), GOOD_HANDOFF);
  const dir = path.join(r.dir, "cc", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${token}.jsonl`),
    JSON.stringify({
      type: "assistant",
      message: { stop_reason: "end_turn", content: [] },
    }) + "\n",
  );
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

async function rows(r: Rig): Promise<Array<Record<string, unknown>>> {
  r.out.length = 0;
  expect(await agents(r, "list", "-w", "north", "--json")).toBe(0);
  return JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
}

describe("issue 631, clause 2: an agent relaunched from its handoff", () => {
  it("resumes in its new conversation after the terminal host restarted", async () => {
    const r = await rig();
    const t1 = await started(r);
    dueAndIdle(r, "be-dev");
    const d = resolveAgentsDeps(r.deps);
    const ev = await rotationTick(d, new Date(), { send: async () => true });
    expect(ev.map((e) => e.kind)).toEqual(["relaunched"]);
    const t2 = rec(r, "be-dev").resumeToken!;
    expect(t2).not.toBe(t1);
    expect(await runningAgentIds(d)).toEqual(["be-dev"]);

    await r.restartHost();
    await resumeAfterHostRestart(d, "be-dev", null);
    const last = r.made[r.made.length - 1];
    // Its conversation began with the handoff: it is resumed, by its id.
    expect(last.args.slice(0, 2)).toEqual(["--resume", t2]);
    expect(rec(r, "be-dev").resumeToken).toBe(t2);
  }, 30_000);
});

describe("issue 631, clause 1: every agent whose session runs is on the list", () => {
  it("one whose record names an earlier session of its own, while its session runs", async () => {
    const r = await rig();
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    const now = rec(r, "be-dev");
    writeRecord(r.stateDir, {
      ...now,
      session: { ...now.session, id: "0ld5e551" },
    });
    expect(await runningAgentIds(d)).toEqual(["be-dev"]);
  }, 30_000);
});

describe("issue 631, clauses 3 and 4: a resume that didn't hold", () => {
  it("an agent that ended after its resume: failed, with its code and last line", async () => {
    const r = await rig();
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    await r.restartHost();
    await resumeAfterHostRestart(d, "be-dev", null);
    const pty = r.made[r.made.length - 1];
    pty.emit("Error: the conversation could not be continued\r\n");
    pty.exit(1);
    await settle();
    const ended = await ops.endedAfterHostRestart(d, ["be-dev"]);
    expect(ended).toHaveLength(1);
    expect(ended[0].agent).toBe("be-dev");
    expect(ended[0].why).toMatch(/exited \(1\)/);
    expect(ended[0].why).toMatch(/could not be continued/);
  }, 30_000);

  it("one still running is not counted", async () => {
    const r = await rig();
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    expect(await ops.endedAfterHostRestart(d, ["be-dev"])).toEqual([]);
  }, 30_000);

  it("a failed one is marked, the bell says so, and its row says why", async () => {
    const r = await rig();
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    await r.restartHost();
    ops.noteNotBackAfterHostRestart(d, "be-dev", "exited (1) after its resume");
    const after = rec(r, "be-dev");
    expect(after.restartFailed?.why).toMatch(/terminal host restarted/);
    expect(after.restartFailed?.why).toMatch(/exited \(1\) after its resume/);
    // Den's own restore after the restart doesn't try it again unasked.
    expect(after.interruptedAt).toBeTruthy();
    const items = bell(r).filter((n) => n.subject === "agent:be-dev");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "waiting",
      scope: "workspace/north",
      msg: { key: "bell.m.restartFailed" },
    });
    expect(String(items[0].text)).toMatch(/exited \(1\) after its resume/);
    // Clause 4: the row has it, and `agents list` says it.
    const [row] = await rows(r);
    expect(row).toMatchObject({ state: "interrupted", resumable: true });
    expect(
      (row.restartFailed as { why: string } | undefined)?.why,
    ).toMatch(/exited \(1\) after its resume/);
    r.out.length = 0;
    expect(await agents(r, "list", "-w", "north")).toBe(0);
    expect(r.out.join("\n")).toMatch(
      /interrupted: didn't come back after a restart/,
    );
  }, 30_000);
});
