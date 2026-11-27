/**
 * Issue 732: a background job an agent left running (a Claude Code
 * background shell: a watcher, a gate) doesn't make it busy for typing.
 * What Den types (Hub comments, the bell's "busy") goes by its turn alone;
 * restarts still wait for the job, or ask about it, as 0.4.48 meant.
 *
 * A real host on a temp socket with a scripted PTY: nothing runs. The
 * processes under the agent are a fake list. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  AgentError,
  agentInputState,
  busyAgentHolds,
  busyAgentIds,
  resolveAgentsDeps,
  restartAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { SeenDeliveries } from "../../../src/shared/hub/hub-delivery.js";
import {
  DeliveryLoop,
  type DeliveryHub,
} from "../../../src/shared/hub/hub-delivery-loop.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

let tmp = "";
afterEach(async () => {
  await cleanupRigs();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

/** Its transcript: a turn that ended, or one still under way. */
function transcript(r: Rig, ended: boolean): void {
  const token = readRecord(r.stateDir, "planner")!.resumeToken!;
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, `${token}.jsonl`),
    line({
      type: "user",
      timestamp: now,
      message: { role: "user", content: "watch the log" },
    }) +
      (ended
        ? line({
            type: "assistant",
            timestamp: now,
            message: {
              role: "assistant",
              stop_reason: "end_turn",
              content: [{ type: "text", text: "Watching in the background." }],
            },
          })
        : ""),
  );
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

/**
 * Agent planner, at its input prompt, with a background shell of
 * `minutes` running under its session (`tail -f`, as Claude Code starts
 * one). `ended`: whether its transcript says the turn ended.
 */
async function withShell(minutes: number, ended = true) {
  const r = await rig();
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
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  await settle();
  transcript(r, ended);
  r.made[0].emit("> ");
  await settle();
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  const pid = (await c.list()).find((x) => !x.exited)!.pid;
  c.close();
  const job = { on: true };
  r.deps.processes = () =>
    job.on
      ? [
          {
            pid: pid + 2,
            ppid: pid,
            secs: minutes * 60,
            command:
              "/bin/zsh -c source /home/x/.claude/shell-snapshots/snapshot-zsh-1-ab.sh && eval 'tail -f /tmp/build.log'",
          },
        ]
      : [];
  return { r, job, d: () => resolveAgentsDeps(r.deps) };
}

const comment = (id: string) => ({
  id,
  agent: "planner",
  project: "north",
  thread: {
    kind: "comment",
    id: `th_${id}`,
    url: `https://hub.example.test/a/doc#th_${id}`,
    artifact: "Plan",
  },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: `comment ${id}`,
  created_at: "2026-11-20T08:00:00Z",
});

const hub: DeliveryHub = {
  stream: () => {
    throw Object.assign(new Error("no stream"), { kind: "refused" });
  },
  list: async () => [],
  ack: async () => undefined,
};

/** A delivery loop on agent planner's real input state. */
function loopOn(
  d: ReturnType<typeof resolveAgentsDeps>,
  seenFile: string,
  typed: string[],
) {
  return new DeliveryLoop({
    hub,
    agents: {
      state: (a) => agentInputState(d, a, new Set(), 200),
      type: async (_a, text) => {
        typed.push(text);
        return true;
      },
    },
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    seen: new SeenDeliveries(seenFile),
  });
}

describe("issue 732: typing goes by the turn", () => {
  it("turn ended, a background shell still running: idle, and a Hub comment is typed", async () => {
    const { d } = await withShell(600);
    expect(await agentInputState(d(), "planner", new Set(), 200)).toBe("idle");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-732-"));
    const typed: string[] = [];
    const loop = loopOn(d(), path.join(tmp, "seen.json"), typed);
    await loop.take(comment("c1"));
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("comment c1");
  }, 30_000);

  it("mid-turn, with the same shell: busy, and the comment waits", async () => {
    const { d } = await withShell(600, false);
    expect(await agentInputState(d(), "planner", new Set(), 200)).toBe("busy");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-732-"));
    const typed: string[] = [];
    const loop = loopOn(d(), path.join(tmp, "seen.json"), typed);
    await loop.take(comment("c1"));
    expect(typed).toEqual([]);
  }, 30_000);

  it("comments held across an update are typed at the next tick once the turn ended", async () => {
    const { d } = await withShell(600);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-732-"));
    const seenFile = path.join(tmp, "seen.json");
    // Held before the update (as the old rule held them).
    const before = new DeliveryLoop({
      hub,
      agents: { state: async () => "busy", type: async () => true },
      owner: () => ({ ownerId: "u_me", company: "Acme" }),
      seen: new SeenDeliveries(seenFile),
    });
    await before.take(comment("c1"));
    await before.take(comment("c2"));
    const typed: string[] = [];
    const after = loopOn(d(), seenFile, typed);
    await after.pump();
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("comment c1");
    expect(typed[0]).toContain("comment c2");
  }, 30_000);
});

describe("issue 732: restarts still count the job", () => {
  it("restart after its turn, asked by a person: job_running, with its minutes; nothing stopped", async () => {
    const { r, d } = await withShell(42);
    const err = await restartAgent(d(), "planner", "north", "after-turn", {
      askIfJob: true,
    }).catch((e: unknown) => e);
    expect((err as AgentError).code).toBe("job_running");
    expect((err as AgentError).job).toEqual({ minutes: 42 });
    expect(r.made[0].signals).toEqual([]);
  }, 30_000);

  it("restart after its turn: waits for the job, and says it is a background job, not a turn", async () => {
    const { r, d } = await withShell(42);
    r.config = { ...r.config, restartWaitMs: 150 };
    const err = await restartAgent(d(), "planner", "north", "after-turn", {
      pollMs: 20,
    }).catch((e: unknown) => e);
    expect((err as AgentError).code).toBe("still_busy");
    expect((err as AgentError).message).toMatch(
      /a background job it started is still running \(42 min\)/,
    );
    expect((err as AgentError).message).not.toMatch(/turn/);
    expect(r.made[0].signals).toEqual([]);
  }, 30_000);

  it("restart after its turn, the job ends: restarted", async () => {
    const { r, job, d } = await withShell(5);
    r.config = { ...r.config, restartWaitMs: 5_000 };
    setTimeout(() => {
      job.on = false;
    }, 150);
    const out = await restartAgent(d(), "planner", "north", "after-turn", {
      pollMs: 20,
    });
    expect(out.rec.id).toBe("planner");
  }, 30_000);

  it("the terminal host's restart wait still counts the job (it would end it)", async () => {
    const { job, d } = await withShell(10);
    expect(await busyAgentIds(d(), ["planner"])).toEqual(["planner"]);
    job.on = false;
    expect(await busyAgentIds(d(), ["planner"])).toEqual([]);
  }, 30_000);

  it("the wait knows it is the job, with its minutes, not a turn (doctor says so)", async () => {
    const { job, d } = await withShell(10);
    expect(await busyAgentHolds(d(), ["planner"])).toEqual([
      { agent: "planner", job: { minutes: expect.any(Number) } },
    ]);
    job.on = false;
    expect(await busyAgentHolds(d(), ["planner"])).toEqual([]);
  }, 30_000);
});
