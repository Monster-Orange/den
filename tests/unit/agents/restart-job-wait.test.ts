/**
 * 0.4.48: "after its turn" also waits for a job the agent left running (a
 * gate in the background), and how long it waits is a setting:
 * agents.restart_wait_minutes, default 2 h (a full end-to-end gate runs
 * about an hour). When the wait runs out:
 *
 *   - Den's own restart (to load Hub's tools) is skipped and tried again
 *     later; that try is not spent.
 *   - A restart a person asks for, while a job runs, asks first: "a job
 *     is still running (N min); restart anyway?" (code job_running).
 *
 * A real host on a temp socket with a scripted PTY: nothing runs. The
 * processes under the agent are a fake list. Invented names only.
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
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  AgentError,
  resolveAgentsDeps,
  restartAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { mcpReconnect } from "../../../src/ui/cli/mcp-reconnect.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

describe("agents.restart_wait_minutes", () => {
  const wait = (v: unknown) =>
    readAgentsConfig({
      agents: { restart_wait_minutes: v },
    } as unknown as DenConfig).restartWaitMs;

  it("unset: 2 h; set: in ms; it is no agent id", () => {
    expect(readAgentsConfig({} as DenConfig).restartWaitMs).toBe(120 * 60_000);
    expect(wait(240)).toBe(240 * 60_000);
    expect(wait(0.5)).toBe(30_000);
    expect(AGENTS_RESERVED_KEYS).toContain("restart_wait_minutes");
  });

  it("a bad value fails naming the key", () => {
    for (const bad of [0, -1, "8", true, Number.NaN])
      expect(() => wait(bad)).toThrow(/agents\.restart_wait_minutes: /);
  });
});

/** An agent whose turn ended, with a job of `minutes` running under it. */
async function withJob(minutes: number) {
  const r = await rig();
  endOnTerm(r);
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  await settle();
  const token = readRecord(r.stateDir, "planner")!.resumeToken!;
  endedTurn(r, token);
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
              "/bin/zsh -c source /home/x/.claude/shell-snapshots/snapshot-zsh-1-ab.sh && eval 'npm run e2e'",
          },
        ]
      : [];
  return { r, job };
}

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

function endedTurn(r: Rig, token: string): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "Gate it" } },
      {
        type: "assistant",
        message: {
          model: "opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Gate running." }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

describe("a restart a person asks for while a job runs", () => {
  it("asks first: job_running, with how long it has run; nothing stopped", async () => {
    const { r } = await withJob(61);
    const d = resolveAgentsDeps(r.deps);
    const err = await restartAgent(d, "planner", "north", "after-turn", {
      askIfJob: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("job_running");
    expect((err as AgentError).job).toEqual({ minutes: 61 });
    expect((err as AgentError).message).toMatch(/61 min/);
    expect(r.made[0].signals).toEqual([]);
  });

  it("no job: it goes ahead", async () => {
    const { r, job } = await withJob(5);
    job.on = false;
    const out = await restartAgent(
      resolveAgentsDeps(r.deps),
      "planner",
      "north",
      "after-turn",
      { askIfJob: true, pollMs: 20 },
    );
    expect(out.rec.id).toBe("planner");
  });
});

describe("the wait is the setting, and Den's own restart skips when it runs out", () => {
  it("waits as long as agents.restart_wait_minutes says, then still_busy, nothing stopped", async () => {
    const { r } = await withJob(10);
    r.config = { ...r.config, restartWaitMs: 150 };
    const d = resolveAgentsDeps(r.deps);
    const t0 = Date.now();
    const err = await restartAgent(d, "planner", "north", "after-turn", {
      pollMs: 20,
    }).catch((e: unknown) => e);
    expect((err as AgentError).code).toBe("still_busy");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(r.made[0].signals).toEqual([]);
  });

  it("Den's restart for Hub's tools: skipped, and the try isn't spent", async () => {
    const { r, job } = await withJob(10);
    r.config = { ...r.config, restartWaitMs: 100 };
    const d = resolveAgentsDeps(r.deps);
    const lines: string[] = [];
    const m = mcpReconnect(d, {
      hubUp: async () => true,
      attempts: () => 1,
      pollMs: 20,
      missing: async () => [{ id: "planner", workspace: "north" }],
      log: (l) => lines.push(l),
    });
    expect(await m.tick()).toEqual(["planner"]);
    await m.pending();
    expect(lines.join("\n")).toMatch(/still running a job/);
    // One attempt allowed, and it wasn't spent: the next pass tries again.
    job.on = false;
    expect(await m.tick()).toEqual(["planner"]);
    await m.pending();
    // Restarted the second time: the typed note waits for its prompt.
    expect(r.made).toHaveLength(2);
  }, 30_000);
});
