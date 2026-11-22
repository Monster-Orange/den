/**
 * Issue 914: session rotation waits for the agent's running background
 * work. An agent whose rotation is due, with its turn over, is not
 * rotated while a helper it started (a background subagent, a workflow's
 * agent) or a job it left running (a gate run in a background shell)
 * still runs. It rotates right after they finish.
 *
 * If they still run after agents.rotation_wait_minutes (default 240), the
 * rotation goes ahead: Den asks for a handoff that lists each one (what it
 * was doing, its branch, its own handoff file), the handoff check refuses
 * one that leaves an item out, and the new session's first prompt says to
 * start each one again.
 *
 * A real host on a temp socket with a scripted PTY; helpers are Claude
 * Code's subagent files beside the transcript; jobs are a fake process
 * list. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { DenConfig } from "../../../src/shared/den-config.js";
import {
  AGENTS_RESERVED_KEYS,
  readAgentsConfig,
} from "../../../src/shared/den-config.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  noteCompaction,
  readHandoff,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import {
  resolveAgentsDeps,
  rotationTick,
  type AgentsResolved,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const rec = (r: Rig, id: string) => readRecord(r.stateDir, id)!;
const files = (r: Rig, id: string) => path.join(r.stateDir, "agent-files", id);
const transcriptDir = (r: Rig) => path.join(r.dir, "cc", "projects", "p");
const transcript = (r: Rig) =>
  path.join(transcriptDir(r), `${rec(r, "be-dev").resumeToken}.jsonl`);

async function started(r: Rig): Promise<string> {
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: path.join(r.dir, "cc") };
  r.deps.stopWaitMs = 2000;
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "be-dev"], r.deps),
  ).toBe(0);
  for (const pty of r.made) {
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      setTimeout(() => pty.exit(0), 10);
    };
  }
  await settle();
  return rec(r, "be-dev").resumeToken!;
}

/** Due after 3 compactions, its handoff written, its turn over. */
function due(r: Rig, handoff = GOOD_HANDOFF): void {
  const token = rec(r, "be-dev").resumeToken!;
  const after = readRotation(files(r, "be-dev"))!.after;
  for (let i = 0; i < 3; i++)
    noteCompaction(
      files(r, "be-dev"),
      { session_id: token, trigger: "auto" },
      after,
    );
  fs.writeFileSync(path.join(files(r, "be-dev"), "handoff.md"), handoff);
  endTurn(r);
}

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n");

/** The agent's transcript goes on: `notes` task notifications, then its turn ended. */
function endTurn(r: Rig, notes: string[] = []): void {
  fs.mkdirSync(transcriptDir(r), { recursive: true });
  // Appended, as Claude Code writes it (Den reads it on as it grows).
  fs.appendFileSync(
    transcript(r),
    lines(
      ...notes.map((n) => ({
        type: "user",
        timestamp: new Date().toISOString(),
        message: {
          content: `<task-notification><tool-use-id>${n}</tool-use-id><status>completed</status></task-notification>`,
        },
      })),
      {
        type: "assistant",
        message: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok" }],
        },
      },
    ) + "\n",
  );
}

/** A background helper (a subagent) working now. */
function helper(
  r: Rig,
  id: string,
  description: string,
  branch?: string,
): string {
  const sub = path.join(transcript(r).replace(/\.jsonl$/, ""), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const toolUseId = `toolu_${id}`;
  fs.writeFileSync(
    path.join(sub, `agent-${id}.meta.json`),
    JSON.stringify({
      agentType: "general-purpose",
      description,
      toolUseId,
      requestShape: "background",
      ...(branch ? { worktreeBranch: branch } : {}),
    }),
  );
  fs.writeFileSync(
    path.join(sub, `agent-${id}.jsonl`),
    lines({
      type: "user",
      timestamp: new Date().toISOString(),
      message: { content: description },
    }) + "\n",
  );
  return toolUseId;
}

/** A gate run in a background shell under the agent's session. */
async function job(r: Rig): Promise<{ on: boolean }> {
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  const pid = (await c.list()).find((x) => !x.exited)!.pid;
  c.close();
  const j = { on: true };
  r.deps.processes = () =>
    j.on
      ? [
          {
            pid: pid + 2,
            ppid: pid,
            secs: 600,
            command:
              "/bin/zsh -c source /home/x/.claude/shell-snapshots/snapshot-zsh-1-ab.sh && eval 'npm run gate'",
          },
        ]
      : [];
  return j;
}

function sender() {
  const sent: string[] = [];
  const send = async (
    _d: AgentsResolved,
    _session: string,
    _rt: string,
    text: string,
  ) => {
    sent.push(text);
    return true;
  };
  return { sent, send };
}

const T0 = new Date("2026-11-10T12:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

describe("agents.rotation_wait_minutes", () => {
  const wait = (v: unknown) =>
    readAgentsConfig({
      agents: { rotation_wait_minutes: v },
    } as unknown as DenConfig).rotationWaitMs;

  it("unset: 4 h; set: in ms; it is no agent id", () => {
    expect(readAgentsConfig({} as DenConfig).rotationWaitMs).toBe(240 * MIN);
    expect(wait(30)).toBe(30 * MIN);
    expect(AGENTS_RESERVED_KEYS).toContain("rotation_wait_minutes");
  });

  it("a bad value fails naming the key", () => {
    for (const bad of [0, -1, "8", true, Number.NaN])
      expect(() => wait(bad)).toThrow(/agents\.rotation_wait_minutes: /);
  });
});

describe("rotation waits for running background work (issue 914)", () => {
  it("a running background helper holds the rotation; it rotates right after the helper finishes", async () => {
    const r = await rig();
    const t1 = await started(r);
    due(r);
    const tool = helper(r, "a1b2c3", "Build the export page", "feat/export");
    const d = resolveAgentsDeps(r.deps);
    const { send } = sender();
    const ev = await rotationTick(d, T0, { send });
    expect(ev.map((e) => e.kind)).not.toContain("relaunched");
    expect(ev).toEqual([
      { kind: "waiting", agent: "be-dev", workspace: "north", running: 1 },
    ]);
    // Still running a minute on: still waiting, and said only once.
    expect(await rotationTick(d, later(MIN), { send })).toEqual([]);
    expect(rec(r, "be-dev").resumeToken).toBe(t1);
    // The helper finished: the next look rotates it.
    endTurn(r, [tool]);
    const next = await rotationTick(d, later(2 * MIN), { send });
    expect(next[0]).toMatchObject({ kind: "relaunched", agent: "be-dev" });
    expect(rec(r, "be-dev").resumeToken).not.toBe(t1);
  });

  it("a running gate run (a background shell) holds the rotation until it ends", async () => {
    const r = await rig();
    const t1 = await started(r);
    due(r);
    const j = await job(r);
    const d = resolveAgentsDeps(r.deps);
    const { send } = sender();
    expect(
      (await rotationTick(d, T0, { send })).map((e) => e.kind),
    ).not.toContain("relaunched");
    expect(rec(r, "be-dev").resumeToken).toBe(t1);
    j.on = false;
    expect((await rotationTick(d, later(MIN), { send }))[0]).toMatchObject({
      kind: "relaunched",
    });
  });

  it("past the wait, the rotation goes ahead: the handoff must list each running item", async () => {
    const r = await rig();
    await started(r);
    r.config.rotationWaitMs = 30 * MIN;
    due(r);
    helper(r, "a1b2c3", "Build the export page", "feat/export");
    const d = resolveAgentsDeps(r.deps);
    const { sent, send } = sender();
    await rotationTick(d, T0, { send });
    expect(sent).toEqual([]);
    // Thirty minutes on, still running: forced. The handoff on file
    // leaves the helper out, so it is refused, and Den asks for one
    // that lists it.
    const forced = await rotationTick(d, later(31 * MIN), { send });
    expect(forced).toEqual([
      { kind: "asked", agent: "be-dev", workspace: "north", asked: 1 },
    ]);
    expect(sent[0]).toContain("a1b2c3");
    expect(sent[0]).toContain("Build the export page");
    expect(sent[0]).toContain("feat/export");
    const own = path.join(files(r, "be-dev"), "handoffs", "helper-a1b2c3.md");
    expect(sent[0]).toContain(own);
    const h = readHandoff(files(r, "be-dev"));
    expect(h.status).toBe("invalid");
    expect(h.problems.join(" ")).toMatch(/a1b2c3/);
    expect(rec(r, "be-dev").rotations ?? []).toEqual([]);
    // Listed, with its own handoff file: it passes, and Den relaunches.
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, GOOD_HANDOFF);
    fs.writeFileSync(
      path.join(files(r, "be-dev"), "handoff.md"),
      GOOD_HANDOFF.replace(
        "- The CSV header is in English only.",
        `- The CSV header is in English only.\n- Helper a1b2c3 (Build the export page) was still running on branch feat/export; its handoff is ${own}.`,
      ),
    );
    expect(readHandoff(files(r, "be-dev")).status).toBe("ok");
    const ev = await rotationTick(d, later(32 * MIN), { send });
    expect(ev[0]).toMatchObject({ kind: "relaunched" });
  });

  it("the handoff check refuses a handoff that names the item but has no handoff file for it", async () => {
    const r = await rig();
    await started(r);
    r.config.rotationWaitMs = 30 * MIN;
    due(r);
    helper(r, "d4e5f6", "Write the import tests");
    const d = resolveAgentsDeps(r.deps);
    const { send } = sender();
    await rotationTick(d, T0, { send });
    await rotationTick(d, later(31 * MIN), { send });
    fs.writeFileSync(
      path.join(files(r, "be-dev"), "handoff.md"),
      GOOD_HANDOFF.replace(
        "- The CSV header is in English only.",
        "- Helper d4e5f6 (Write the import tests) was still running.",
      ),
    );
    const h = readHandoff(files(r, "be-dev"));
    expect(h.status).toBe("invalid");
    expect(h.problems.join(" ")).toContain("helper-d4e5f6.md");
  });

  it("the new session's first prompt says to start each listed item again", async () => {
    const r = await rig();
    await started(r);
    r.config.rotationWaitMs = 30 * MIN;
    due(r);
    helper(r, "a1b2c3", "Build the export page", "feat/export");
    const d = resolveAgentsDeps(r.deps);
    const { send } = sender();
    await rotationTick(d, T0, { send });
    await rotationTick(d, later(31 * MIN), { send });
    const own = path.join(files(r, "be-dev"), "handoffs", "helper-a1b2c3.md");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, GOOD_HANDOFF);
    fs.writeFileSync(
      path.join(files(r, "be-dev"), "handoff.md"),
      `${GOOD_HANDOFF}\nHelper a1b2c3 (Build the export page): its handoff is ${own}.\n`,
    );
    const ev = await rotationTick(d, later(32 * MIN), { send });
    expect(ev[0]).toMatchObject({ kind: "relaunched" });
    const p = r.made[r.made.length - 1];
    const first = p.args[p.args.length - 1];
    expect(first).toContain("start each one again");
    expect(first).toContain("a1b2c3");
  });

  it("items that finish before the rotation is forced need no listing", async () => {
    const r = await rig();
    await started(r);
    r.config.rotationWaitMs = 30 * MIN;
    due(r);
    const tool = helper(r, "a1b2c3", "Build the export page");
    const d = resolveAgentsDeps(r.deps);
    const { send } = sender();
    await rotationTick(d, T0, { send });
    endTurn(r, [tool]);
    const ev = await rotationTick(d, later(5 * MIN), { send });
    expect(ev[0]).toMatchObject({ kind: "relaunched" });
    expect(readRotation(files(r, "be-dev"))?.leftRunning).toBeUndefined();
  });
});
