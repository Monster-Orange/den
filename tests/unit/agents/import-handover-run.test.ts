/**
 * Issue 159, end to end through runAgentImport (the held write's run): a
 * conversation still open in a terminal is no longer refused. The Allow's
 * answer asks it for its hand-off; once that is written and the terminal
 * is closed, Den continues the conversation as the agent and tells it so.
 *
 * A real host on a temp socket with a scripted PTY: nothing runs, and the
 * `claude` shim must never run. A temp CLAUDE_CONFIG_DIR, never ~/.claude.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { claudeSlug } from "../../../src/shared/agents/conversations.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { agentFilesDir } from "../../../src/shared/agents/records.js";
import {
  HANDOVER_MARKER,
  resolveAgentsDeps,
  runAgentImport,
  sweepHandovers,
} from "../../../src/ui/cli/agent-ops.js";
import type { HandoverFailure } from "../../../src/shared/agents/import-handover.js";
import { procStartOf } from "../../../src/shared/agents/open-check.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

const kids: ChildProcess[] = [];
afterEach(async () => {
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  await cleanupRigs();
});

/** A live process standing in for a terminal (it never runs claude). */
async function terminal(): Promise<ChildProcess> {
  const k = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
  kids.push(k);
  await new Promise((r) => setTimeout(r, 50));
  return k;
}

const alive = (k: ChildProcess) => k.exitCode === null && k.signalCode === null;

/**
 * Claude Code's own record that process `pid` holds the conversation
 * (D56); `procStart` wrong: a live process with that number that is not
 * the one that wrote it (a pid the OS gave to something else).
 */
function holds(r: Rig, pid: number, procStart = procStartOf(pid) ?? "") {
  const dir = path.join(r.dir, "claude-config", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: TOKEN, procStart }),
  );
}

/** Its turn ended: the last record is an answer that stopped. */
function turnEnded(file: string): void {
  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Written." }] } })}\n`,
  );
}

const TOKEN = "0f1e2d3c-aaaa-bbbb-cccc-000000000159";

/** A Claude Code transcript that ran in `cwd`, last written `ageMs` ago. */
function conversation(r: Rig, cwd: string, ageMs: number): string {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", claudeSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${TOKEN}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "user", cwd, message: { content: "Tidy the docs" } })}\n`,
  );
  age(file, ageMs);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  return file;
}

const age = (file: string, ageMs: number) => {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
};

const ask = { project: "north", session: TOKEN, persona: "planner" };

describe("issue 159: agent_import after the Allow", () => {
  it("a conversation not open elsewhere comes in at once, as before", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), 10 * 60_000);
    const out = await runAgentImport(resolveAgentsDeps(r.deps), ask);
    expect(out).toMatchObject({ ok: true, id: "planner", project: "north" });
    expect(out).not.toHaveProperty("handover");
    expect(r.made[0].args.slice(0, 2)).toEqual(["--resume", TOKEN]);
  });

  it("one still open: the answer asks for its hand-off; once written and closed, Den brings it in and tells it", async () => {
    const r = await rig();
    const file = conversation(r, r.wsDir("north"), 5_000);
    const failures: HandoverFailure[] = [];
    let finished: (v: unknown) => void = () => undefined;
    const done = new Promise((res) => (finished = res));
    const out = (await runAgentImport(resolveAgentsDeps(r.deps), ask, {
      pollMs: 20,
      fail: (f) => failures.push(f),
      done: finished,
    })) as Record<string, unknown>;
    const handoff = path.join(
      agentFilesDir(r.stateDir, "planner"),
      "handoff.md",
    );
    expect(out).toMatchObject({
      ok: true,
      id: "planner",
      handover: "waiting",
      handoff,
    });
    expect(String(out.next)).toContain(handoff);
    // Nothing started yet: the conversation is still open.
    expect(r.made).toHaveLength(0);
    // It writes its hand-off and its terminal goes quiet.
    fs.writeFileSync(handoff, GOOD_HANDOFF);
    age(file, 5 * 60_000);
    expect(await done).toMatchObject({ ok: true, id: "planner" });
    expect(failures).toEqual([]);
    expect(r.made[0].args.slice(0, 2)).toEqual(["--resume", TOKEN]);
    expect(readRecord(r.stateDir, "planner")?.resumeToken).toBe(TOKEN);
  });

  it("the Allow's holder is gone and its pid now names another live process: that process is never signalled, and it comes in", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), 10 * 60_000);
    const held = await terminal();
    holds(r, held.pid!);
    let finished: (v: unknown) => void = () => undefined;
    const done = new Promise((res) => (finished = res));
    const out = (await runAgentImport(resolveAgentsDeps(r.deps), ask, {
      pollMs: 20,
      fail: () => undefined,
      done: finished,
    })) as Record<string, unknown>;
    expect(out.handover).toBe("waiting");
    // The terminal ended and its number went to an unrelated process: the
    // runtime's record no longer proves that process holds it.
    holds(r, held.pid!, "Thu Jan  1 00:00:00 1970");
    expect(await done).toMatchObject({ ok: true, id: "planner" });
    expect(alive(held)).toBe(true);
    expect(readRecord(r.stateDir, "planner")?.resumeToken).toBe(TOKEN);
  });

  it("the holder changed during the wait (reopened in another terminal): neither is signalled, and it stops", async () => {
    const r = await rig();
    const file = conversation(r, r.wsDir("north"), 10 * 60_000);
    const first = await terminal();
    holds(r, first.pid!);
    const failures: HandoverFailure[] = [];
    let finished: (v: unknown) => void = () => undefined;
    const done = new Promise((res) => (finished = res));
    const out = (await runAgentImport(resolveAgentsDeps(r.deps), ask, {
      pollMs: 20,
      fail: (f) => failures.push(f),
      done: finished,
    })) as Record<string, unknown>;
    const second = await terminal();
    holds(r, second.pid!);
    fs.writeFileSync(String(out.handoff), GOOD_HANDOFF);
    turnEnded(file);
    expect(await done).toMatchObject({ ok: false });
    expect(failures.map((f) => f.code)).toEqual(["holderChanged"]);
    expect(alive(first)).toBe(true);
    expect(alive(second)).toBe(true);
    expect(r.made).toHaveLength(0);
  });

  it("the Allow's holder still holds it after the hand-off: that one is closed, then it comes in", async () => {
    const r = await rig();
    const file = conversation(r, r.wsDir("north"), 10 * 60_000);
    const held = await terminal();
    holds(r, held.pid!);
    let finished: (v: unknown) => void = () => undefined;
    const done = new Promise((res) => (finished = res));
    const out = (await runAgentImport(resolveAgentsDeps(r.deps), ask, {
      pollMs: 20,
      fail: () => undefined,
      done: finished,
    })) as Record<string, unknown>;
    fs.writeFileSync(String(out.handoff), GOOD_HANDOFF);
    turnEnded(file);
    expect(await done).toMatchObject({ ok: true, id: "planner" });
    expect(alive(held)).toBe(false);
    expect(r.made[0].args.slice(0, 2)).toEqual(["--resume", TOKEN]);
  });

  it("a second Allow for the same conversation while one waits starts nothing, and says one is waiting", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), 5_000);
    const d = resolveAgentsDeps(r.deps);
    const first = (await runAgentImport(d, ask, {
      pollMs: 20,
      fail: () => undefined,
    })) as Record<string, unknown>;
    expect(first.handover).toBe("waiting");
    const second = await runAgentImport(d, ask, {
      pollMs: 20,
      fail: () => undefined,
    });
    expect(second).toEqual({
      ok: false,
      error: expect.stringMatching(/already waiting/),
    });
    // Its id stays reserved for the first: a new agent of the persona gets another.
    expect(fs.readdirSync(path.dirname(String(first.handoff)))).toContain(
      HANDOVER_MARKER,
    );
  });

  it("the id stays reserved across the wait: another conversation brought in meanwhile gets the next id", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), 5_000);
    const d = resolveAgentsDeps(r.deps);
    const first = (await runAgentImport(d, ask, {
      pollMs: 20,
      fail: () => undefined,
    })) as Record<string, unknown>;
    expect(first.id).toBe("planner");
    // A second conversation, closed long ago, in the same folder.
    const other = "0f1e2d3c-aaaa-bbbb-cccc-000000000160";
    const dir = path.join(
      r.dir,
      "claude-config",
      "projects",
      claudeSlug(r.wsDir("north")),
    );
    const f = path.join(dir, `${other}.jsonl`);
    fs.writeFileSync(
      f,
      `${JSON.stringify({ type: "user", cwd: r.wsDir("north"), message: { content: "Fix the build" } })}\n`,
    );
    age(f, 10 * 60_000);
    const second = await runAgentImport(d, { ...ask, session: other });
    expect(second).toMatchObject({ ok: true, id: "planner-2" });
  });

  it("a restart drops a waiting hand-over: the sweep names it once and frees its id", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    // A marker no hand-over in this process owns (a restart's leftover).
    const folder = agentFilesDir(r.stateDir, "planner");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, HANDOVER_MARKER),
      JSON.stringify({
        session: TOKEN,
        project: "north",
        persona: "planner",
        at: new Date().toISOString(),
      }),
    );
    expect(sweepHandovers(d)).toEqual([
      { agent: "planner", session: TOKEN, project: "north" },
    ]);
    expect(fs.existsSync(path.join(folder, HANDOVER_MARKER))).toBe(false);
    expect(sweepHandovers(d)).toEqual([]);
  });

  it("the sweep leaves a hand-over this process still runs alone", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), 5_000);
    const d = resolveAgentsDeps(r.deps);
    await runAgentImport(d, ask, { pollMs: 20, fail: () => undefined });
    expect(sweepHandovers(d)).toEqual([]);
  });

  it("an old hand-off left in the agent's folder is set aside, never taken as this one", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), 5_000);
    const folder = agentFilesDir(r.stateDir, "planner");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "handoff.md"), GOOD_HANDOFF);
    const out = (await runAgentImport(resolveAgentsDeps(r.deps), ask, {
      pollMs: 20,
      fail: () => undefined,
    })) as Record<string, unknown>;
    expect(out.handover).toBe("waiting");
    expect(fs.existsSync(path.join(folder, "handoff.md"))).toBe(false);
  });
});
