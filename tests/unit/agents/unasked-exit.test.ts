/**
 * Issue 926: an agent's session that ends without Den asking (a signal
 * from outside Den, say) was left down with nothing recorded. Now the
 * exit sweep:
 *   1. writes an audit row (agent, exit code);
 *   2. tells the person in the bell;
 *   3. brings it back once: resumes it, or relaunches it from its handoff
 *      when its rotation is ready (issue 923's rule);
 *   4. leaves one that exited 0 by itself (the agent or person quit) down,
 *      with an audit row only;
 *   5. never loops: a second unasked exit within the window is told, not
 *      brought back;
 *   6. never acts on a stop Den or a person asked for.
 *
 * A real host on a temp socket with a scripted PTY: nothing real runs.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  noteCompaction,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import {
  exitTick,
  resolveAgentsDeps,
  stopAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const rec = (r: Rig, id = "be-dev") => readRecord(r.stateDir, id)!;
const files = (r: Rig, id = "be-dev") =>
  path.join(r.stateDir, "agent-files", id);

async function started(r: Rig, id = "be-dev"): Promise<string> {
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: path.join(r.dir, "cc") };
  r.deps.stopWaitMs = 2000;
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

/** Its process ends from outside Den (no stop asked): `code`. */
async function killed(r: Rig, code: number): Promise<void> {
  r.made.at(-1)!.exit(code);
  await settle(400);
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

function audit(r: Rig): Record<string, unknown>[] {
  const f = path.join(r.stateDir, "audit.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((x) => /ended without Den asking/.test(String(x.detail)));
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

/** `min` minutes on (a sweep looks at an exit 5 s after it). */
const T = (min: number) => new Date(Date.now() + 10_000 + min * 60_000);

describe("issue 926: a session that ends without Den asking", () => {
  it("TERM from outside: an audit row, a bell item, and the agent back", async () => {
    const r = await rig();
    const t1 = await started(r);
    await killed(r, 143);
    const d = resolveAgentsDeps(r.deps);
    const ev = await exitTick(d, T(0));
    expect(ev).toEqual([
      expect.objectContaining({ kind: "resumed", agent: "be-dev", code: 143 }),
    ]);
    expect(audit(r)).toHaveLength(1);
    expect(String(audit(r)[0].detail)).toMatch(/be-dev .*exit 143/);
    expect(bell(r)).toEqual([
      expect.objectContaining({
        msg: expect.objectContaining({ key: "bell.m.unaskedExit" }),
      }),
    ]);
    expect(await live(r)).toBe(true);
    expect(rec(r).resumeToken).toBe(t1);
    // Nothing more to do: it runs.
    expect(await exitTick(d, T(1))).toEqual([]);
  });

  it("with a ready rotation it comes back from its handoff in a new conversation", async () => {
    const r = await rig();
    const t1 = await started(r);
    const after = readRotation(files(r))!.after;
    for (let i = 0; i < 3; i++)
      noteCompaction(files(r), { session_id: t1, trigger: "auto" }, after);
    fs.writeFileSync(path.join(files(r), "handoff.md"), GOOD_HANDOFF);
    await killed(r, 143);
    const d = resolveAgentsDeps(r.deps);
    const ev = await exitTick(d, T(0));
    expect(ev).toEqual([
      expect.objectContaining({ kind: "relaunched", agent: "be-dev" }),
    ]);
    expect(rec(r).resumeToken).not.toBe(t1);
    expect(await live(r)).toBe(true);
  });

  it("exit 0 by itself: recorded, not brought back", async () => {
    const r = await rig();
    await started(r);
    await killed(r, 0);
    const d = resolveAgentsDeps(r.deps);
    expect(await exitTick(d, T(0))).toEqual([
      expect.objectContaining({ kind: "recorded", code: 0 }),
    ]);
    expect(audit(r)).toHaveLength(1);
    expect(bell(r)).toHaveLength(0);
    expect(await live(r)).toBe(false);
    expect(await exitTick(d, T(1))).toEqual([]);
  });

  it("a second unasked exit within the window is told, not brought back", async () => {
    const r = await rig();
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    await killed(r, 143);
    expect((await exitTick(d, T(0)))[0]?.kind).toBe("resumed");
    await killed(r, 143);
    expect(await exitTick(d, T(2))).toEqual([
      expect.objectContaining({ kind: "left", agent: "be-dev" }),
    ]);
    expect(await live(r)).toBe(false);
    expect(bell(r).at(-1)).toMatchObject({ kind: "waiting" });
    expect(await exitTick(d, T(3))).toEqual([]);
  });

  it("an exit under 5 s old waits for the next sweep", async () => {
    const r = await rig();
    await started(r);
    await killed(r, 143);
    const d = resolveAgentsDeps(r.deps);
    expect(await exitTick(d, new Date())).toEqual([]);
    expect((await exitTick(d, T(0)))[0]?.kind).toBe("resumed");
  });

  it("never acts on a stop that was asked for", async () => {
    const r = await rig();
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    await stopAgent(d, "be-dev", "north");
    await settle(200);
    expect(await exitTick(d, T(0))).toEqual([]);
    expect(audit(r)).toHaveLength(0);
    expect(await live(r)).toBe(false);
  });
});
