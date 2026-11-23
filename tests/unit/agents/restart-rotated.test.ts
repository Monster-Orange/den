/**
 * Issue 923: a restart of an agent whose rotation is ready (due, and its
 * handoff passes) never leaves it stopped. Den stopped it (a tool-list
 * change, a person's Restart), so it relaunches from the handoff in a new
 * conversation, as a rotation would; a plain resume is bound to be refused.
 * And the rotation sweep relaunches a due agent that a failed Den restart
 * left stopped, never one a person stopped.
 *
 * A real host on a temp socket with a scripted PTY: nothing real runs.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import {
  noteCompaction,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import {
  resolveAgentsDeps,
  restartAgent,
  rotationTick,
  stopAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { setRotateValue } from "../../../src/shared/agents/rotate-settings.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const rec = (r: Rig, id: string) => readRecord(r.stateDir, id)!;
const files = (r: Rig, id: string) => path.join(r.stateDir, "agent-files", id);

async function started(r: Rig, id = "be-dev"): Promise<string> {
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: path.join(r.dir, "cc") };
  r.deps.stopWaitMs = 2000;
  // Every session, the first and each one after, ends on TERM.
  const push = r.made.push.bind(r.made);
  r.made.push = (...ps) => {
    for (const p of ps) {
      const kill = p.kill.bind(p);
      p.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => p.exit(143), 10);
      };
    }
    return push(...ps);
  };
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", id], r.deps),
  ).toBe(0);
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(rec(r, id).session.id, Buffer.from("build the export\r"));
  await settle();
  c.close();
  return rec(r, id).resumeToken!;
}

/** Due (3 compactions), its handoff passing, idle. */
function due(r: Rig, id = "be-dev", handoff = true): void {
  const token = rec(r, id).resumeToken!;
  const after = readRotation(files(r, id))!.after;
  for (let i = 0; i < 3; i++)
    noteCompaction(files(r, id), { session_id: token, trigger: "auto" }, after);
  if (handoff)
    fs.writeFileSync(path.join(files(r, id), "handoff.md"), GOOD_HANDOFF);
  const dir = path.join(r.dir, "cc", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${token}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      message: {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
      },
    })}\n`,
  );
}

async function live(r: Rig, id = "be-dev"): Promise<boolean> {
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  try {
    const s = (await c.list()).find((x) => x.ref.id === rec(r, id).session.id);
    return Boolean(s && !s.exited);
  } finally {
    c.close();
  }
}

function bell(r: Rig): Array<Record<string, unknown>> {
  const f = path.join(r.stateDir, "notifications.json");
  if (!fs.existsSync(f)) return [];
  return (
    JSON.parse(fs.readFileSync(f, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    }
  ).items.filter((n) => n.subject === "agent:be-dev");
}

describe("issue 923: restart of an agent due for rotation", () => {
  it("relaunches it from its handoff in a new conversation", async () => {
    const r = await rig();
    const t1 = await started(r);
    due(r);
    const d = resolveAgentsDeps(r.deps);
    const out = await restartAgent(d, "be-dev", "north", "now");
    expect(out.relaunched?.why).toBe("3 compactions");
    const now = rec(r, "be-dev");
    expect(now.resumeToken).not.toBe(t1);
    expect(now.restartFailed).toBeUndefined();
    expect(now.rotations?.[0]).toMatchObject({ conversation: t1 });
    expect(await live(r)).toBe(true);
  });

  it("with no passing handoff yet it resumes its conversation, as before", async () => {
    const r = await rig();
    await started(r);
    due(r, "be-dev", false);
    const d = resolveAgentsDeps(r.deps);
    // Not ready (no handoff): resumes in the same conversation.
    const out = await restartAgent(d, "be-dev", "north", "now");
    expect(out.relaunched).toBeUndefined();
    expect(await live(r)).toBe(true);
  });
});

describe("issue 923: on_due ask", () => {
  it("a restart doesn't relaunch it: the person is told, and the sweep leaves it", async () => {
    const r = await rig();
    const t1 = await started(r);
    due(r);
    setRotateValue(r.stateDir, "install", undefined, "on_due", "ask");
    const d = resolveAgentsDeps(r.deps);
    await expect(restartAgent(d, "be-dev", "north", "now")).rejects.toThrow(
      /rotated after 3 compactions/,
    );
    expect(rec(r, "be-dev").restartFailed).toBeDefined();
    expect(bell(r)).toEqual([
      expect.objectContaining({
        kind: "waiting",
        msg: expect.objectContaining({ key: "bell.m.restartFailed" }),
      }),
    ]);
    expect(await rotationTick(d, new Date())).toEqual([]);
    expect(rec(r, "be-dev").resumeToken).toBe(t1);
  });
});

describe("issue 923: the rotation sweep and a stopped, due agent", () => {
  it("relaunches one a failed Den restart left stopped", async () => {
    const r = await rig();
    const t1 = await started(r);
    due(r);
    const d = resolveAgentsDeps(r.deps);
    // What an older Den left: stopped by its own restart, not back.
    await stopAgent(d, "be-dev", "north");
    const { stoppedAt: _s, ...rest } = rec(r, "be-dev");
    writeRecord(r.stateDir, {
      ...rest,
      restartFailed: { at: new Date().toISOString(), why: "rotated" },
    });
    const ev = await rotationTick(d, new Date());
    expect(ev).toEqual([
      expect.objectContaining({
        kind: "relaunched",
        agent: "be-dev",
        old: t1,
      }),
    ]);
    expect(rec(r, "be-dev").resumeToken).not.toBe(t1);
    expect(rec(r, "be-dev").restartFailed).toBeUndefined();
    expect(await live(r)).toBe(true);
  });

  it("a relaunch that fails is tried once: the person is told, then left be", async () => {
    const r = await rig();
    const t1 = await started(r);
    due(r);
    const d = resolveAgentsDeps(r.deps);
    await stopAgent(d, "be-dev", "north");
    const { stoppedAt: _s, ...rest } = rec(r, "be-dev");
    writeRecord(r.stateDir, {
      ...rest,
      restartFailed: { at: new Date().toISOString(), why: "rotated" },
    });
    // Its folder gone: the relaunch is refused.
    const cwd = rec(r, "be-dev").cwd;
    fs.rmSync(cwd, { recursive: true, force: true });
    const ev = await rotationTick(d, new Date());
    expect(ev).toEqual([
      expect.objectContaining({ kind: "failed", agent: "be-dev" }),
    ]);
    expect(rec(r, "be-dev").restartFailed).toMatchObject({
      relaunchTried: true,
    });
    expect(String(rec(r, "be-dev").restartFailed?.why)).toMatch(
      /relaunch from its handoff failed/,
    );
    expect(bell(r)).toHaveLength(1);
    // The next sweep leaves it be: no retry, no second notice.
    expect(await rotationTick(d, new Date())).toEqual([]);
    expect(bell(r)).toHaveLength(1);
    expect(rec(r, "be-dev").resumeToken).toBe(t1);
  });

  it("never relaunches one a person stopped", async () => {
    const r = await rig();
    const t1 = await started(r);
    due(r);
    const d = resolveAgentsDeps(r.deps);
    await stopAgent(d, "be-dev", "north");
    expect(await rotationTick(d, new Date())).toEqual([]);
    expect(rec(r, "be-dev").resumeToken).toBe(t1);
    expect(await live(r)).toBe(false);
  });
});
