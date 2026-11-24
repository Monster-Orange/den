/**
 * Issue 1407: a bulk restart (restart-stale: the bell's and Settings'
 * "Restart N agents at their next idle") checks each agent first and
 * answers per agent, so nothing waits silently:
 *
 *   now      idle: restarting now
 *   turn     mid-turn: restarts when its turn ends
 *   job      its turn ended, but a background job it started still runs
 *            (what it runs, and for how long): not restarted until the
 *            person says Restart now, which ends the job
 *   unknown  Den can't tell when its turn ends: not restarted; Restart now
 *
 * A turn that ends while a job still runs reports the job, never a silent
 * wait to the timeout.
 *
 * A real host on a temp socket with a scripted PTY: nothing runs. The
 * processes under the agent are a fake list. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { jobCommandOf } from "../../../src/shared/process/jobs.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  resolveAgentsDeps,
  restartMany,
  staleAgents,
  type RestartOutcome,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const SHELL = (cmd: string) =>
  `/bin/zsh -c source /home/x/.claude/shell-snapshots/snapshot-zsh-1-ab.sh && eval '${cmd}' \\< /dev/null && pwd -P >| /tmp/claude-1-cwd`;

describe("jobCommandOf: what a background shell runs", () => {
  it("the command inside the runtime's shell", () => {
    expect(jobCommandOf(SHELL("npm run dev"))).toBe("npm run dev");
    expect(jobCommandOf(SHELL("gate run -- npx jest x"))).toBe(
      "gate run -- npx jest x",
    );
  });
  it("a secret on the command line is redacted (it reaches a page and a 409)", () => {
    const shown = jobCommandOf(
      SHELL(
        'curl -H "Authorization: Bearer abcdEFGH12345678xyz" https://x.test',
      ),
    );
    expect(shown).not.toContain("abcdEFGH12345678xyz");
    expect(shown).toContain("[REDACTED]");
  });
  it("anything else: the command line itself, on one line and short", () => {
    expect(jobCommandOf("node server.js\n--port 3")).toBe(
      "node server.js --port 3",
    );
    expect(jobCommandOf("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

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

/** Its transcript: the turn ended (`ended`), or a turn is running. */
function transcript(r: Rig, token: string, ended: boolean): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  const lines: unknown[] = [
    { type: "user", cwd: r.wsDir("north"), message: { content: "Go" } },
  ];
  if (ended)
    lines.push({
      type: "assistant",
      message: {
        model: "opus",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done." }],
      },
    });
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  if (ended) {
    const t = new Date(Date.now() - 60_000);
    fs.utimesSync(file, t, t);
  }
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

/** One running agent, "planner" in north; its session's pid. */
async function started() {
  const r = await rig();
  endOnTerm(r);
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  await settle();
  const token = readRecord(r.stateDir, "planner")!.resumeToken!;
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  const pid = (await c.list()).find((x) => !x.exited)!.pid;
  c.close();
  const job = { on: false, minutes: 12, cmd: "npm run dev" };
  r.deps.processes = () =>
    job.on
      ? [
          {
            pid: pid + 2,
            ppid: pid,
            secs: job.minutes * 60,
            command: SHELL(job.cmd),
          },
        ]
      : [];
  return { r, token, job };
}

const until = async (ok: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((x) => setTimeout(x, 20));
};

const one = [{ id: "planner", workspace: "north" }];

describe("issue 1407: a bulk restart answers per agent", () => {
  it("an idle agent with a background shell: 'job', with its command and minutes; nothing stopped", async () => {
    const { r, token, job } = await started();
    transcript(r, token, true);
    job.on = true;
    const plan = await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
    });
    expect(plan).toEqual([
      {
        id: "planner",
        workspace: "north",
        state: "job",
        job: { command: "npm run dev", minutes: 12 },
      },
    ]);
    await settle();
    expect(r.made).toHaveLength(1);
    expect(r.made[0].signals).toEqual([]);
  });

  it("an idle agent with no job: 'now', and it restarts", async () => {
    const { r, token } = await started();
    transcript(r, token, true);
    const done: RestartOutcome[] = [];
    const plan = await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
      onDone: (o) => done.push(o),
    });
    expect(plan.map((p) => p.state)).toEqual(["now"]);
    await until(() => done.length > 0);
    expect(done).toEqual([
      { id: "planner", workspace: "north", outcome: "restarted" },
    ]);
    expect(r.made).toHaveLength(2);
  });

  it("a mid-turn agent: 'turn'; it restarts after its turn ends", async () => {
    const { r, token } = await started();
    transcript(r, token, false);
    const done: RestartOutcome[] = [];
    const plan = await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
      onDone: (o) => done.push(o),
    });
    expect(plan.map((p) => p.state)).toEqual(["turn"]);
    await new Promise((x) => setTimeout(x, 150));
    expect(r.made).toHaveLength(1);
    transcript(r, token, true);
    await until(() => done.length > 0);
    expect(done[0]?.outcome).toBe("restarted");
    expect(r.made).toHaveLength(2);
  });

  it("a turn that ends with a job still running reports the job, never a silent wait", async () => {
    const { r, token, job } = await started();
    transcript(r, token, false);
    const done: RestartOutcome[] = [];
    await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
      onDone: (o) => done.push(o),
    });
    job.on = true;
    transcript(r, token, true);
    await until(() => done.length > 0, 2_000);
    expect(done).toEqual([
      {
        id: "planner",
        workspace: "north",
        outcome: "job",
        job: { command: "npm run dev", minutes: 12 },
      },
    ]);
    expect(r.made[0].signals).toEqual([]);
  });

  it("can't tell when its turn ends: 'unknown', not restarted", async () => {
    const { r } = await started();
    // No transcript Den can read.
    r.deps.env = {
      ...r.deps.env,
      CLAUDE_CONFIG_DIR: path.join(r.dir, "none"),
    };
    const plan = await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
    });
    expect(plan.map((p) => p.state)).toEqual(["unknown"]);
    await settle();
    expect(r.made).toHaveLength(1);
  });

  it("a wait that runs out (the turn never ends): 'timedOut', with the minutes waited; not restarted", async () => {
    const { r, token } = await started();
    transcript(r, token, false);
    const done: RestartOutcome[] = [];
    await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
      maxMs: 120,
      onDone: (o) => done.push(o),
    });
    await until(() => done.length > 0);
    expect(done).toEqual([
      { id: "planner", workspace: "north", outcome: "timedOut", minutes: 0 },
    ]);
    expect(r.made).toHaveLength(1);
  });
});

describe("issue 1407: the stale list drops an agent the moment it is back", () => {
  it("restarted on current tools: no longer stale", async () => {
    const { r, token } = await started();
    transcript(r, token, true);
    const d = resolveAgentsDeps(r.deps);
    const rec = readRecord(r.stateDir, "planner")!;
    writeRecord(r.stateDir, { ...rec, denVersion: "0.0.1-old" });
    expect((await staleAgents(d, { fresh: true })).map((a) => a.id)).toEqual([
      "planner",
    ]);
    const done: RestartOutcome[] = [];
    await restartMany(d, one, { pollMs: 20, onDone: (o) => done.push(o) });
    await until(() => done.length > 0);
    expect(done[0]?.outcome).toBe("restarted");
    expect(await staleAgents(d, { fresh: true })).toEqual([]);
  });
});
