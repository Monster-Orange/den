/**
 * Issue 1223 part B with issue 1407: the bell's Restart N agents (restart-
 * stale) checks each agent first (1407: restartMany) and sends only the
 * agents it clears (idle, or mid-turn) through the restart queue (1129: a
 * batch at a time), with how far it got in the bell row. One with a
 * background job, or whose turn Den can't read, is never queued: the row
 * lists it with why it waits and Restart now (ends the job).
 *
 * A real host on a temp socket with a scripted PTY: nothing runs. The
 * processes under the agent are a fake list. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  resolveAgentsDeps,
  restartMany,
  type RestartOutcome,
} from "../../../src/ui/cli/agent-ops.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import {
  resetToolsOld,
  toolsOldRow,
} from "../../../src/ui/server/tools-old-service.js";
import type { RestartJob } from "../../../src/shared/agents/restart-queue.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  resetToolsOld();
  await cleanupRigs();
});

const SHELL = (cmd: string) =>
  `/bin/zsh -c source /home/x/.claude/shell-snapshots/snapshot-zsh-1-ab.sh && eval '${cmd}' \\< /dev/null && pwd -P >| /tmp/claude-1-cwd`;

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

/** Its tools started on an older Den: restart-stale lists it. */
function onOlderTools(r: Rig): void {
  const rec = readRecord(r.stateDir, "planner")!;
  writeRecord(r.stateDir, { ...rec, denVersion: "0.0.1-old" });
}

/** restart-stale through handleAgentRoutes, with a queue that records. */
async function api(r: Rig) {
  const jobs: RestartJob[] = [];
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, {
      agents: r.deps,
      personaWait: { pollMs: 20 },
      restartQueue: () => ({
        add: (j: RestartJob) => {
          jobs.push(j);
          return j.run();
        },
      }),
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  const post = async () => {
    const res = await fetch(
      `http://localhost:${port}/api/agents/restart-stale`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
  return { post, jobs };
}

describe("issue 1223 × 1407: restartMany hands the agents it clears to a queue", () => {
  it("an idle agent: given to start, and restarted only when the queue runs it", async () => {
    const { r, token } = await started();
    transcript(r, token, true);
    const given: { id: string; go: () => Promise<unknown> }[] = [];
    const done: RestartOutcome[] = [];
    const plan = await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
      onDone: (o) => done.push(o),
      start: (a, go) => given.push({ id: a.id, go }),
    });
    expect(plan.map((p) => p.state)).toEqual(["now"]);
    expect(given.map((g) => g.id)).toEqual(["planner"]);
    await settle();
    expect(r.made).toHaveLength(1);
    await given[0]!.go();
    expect(done).toEqual([
      { id: "planner", workspace: "north", outcome: "restarted" },
    ]);
    expect(r.made).toHaveLength(2);
  });

  it("an agent with a background job: never given to start", async () => {
    const { r, token, job } = await started();
    transcript(r, token, true);
    job.on = true;
    const given: string[] = [];
    const plan = await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
      start: (a) => given.push(a.id),
    });
    expect(plan.map((p) => p.state)).toEqual(["job"]);
    expect(given).toEqual([]);
  });

  it("a restart that ends on a job: go rejects, so the queue counts it", async () => {
    const { r, token, job } = await started();
    transcript(r, token, false);
    let go: (() => Promise<unknown>) | null = null;
    const done: RestartOutcome[] = [];
    await restartMany(resolveAgentsDeps(r.deps), one, {
      pollMs: 20,
      onDone: (o) => done.push(o),
      start: (_a, g) => {
        go = g;
      },
    });
    const ran = go!();
    job.on = true;
    transcript(r, token, true);
    await expect(ran).rejects.toThrow(/background job/);
    expect(done[0]?.outcome).toBe("job");
  });
});

describe("issue 1223 × 1407: restart-stale queues only the cleared; the bell says who waits", () => {
  it("idle: through the queue, and the per-agent answer", async () => {
    const { r, token } = await started();
    transcript(r, token, true);
    onOlderTools(r);
    const { post, jobs } = await api(r);
    const go = await post();
    expect(go.status).toBe(202);
    expect(go.json.agents).toEqual([
      { id: "planner", workspace: "north", state: "now" },
    ]);
    expect(jobs.map((j) => [j.id, j.why])).toEqual([["planner", "tools"]]);
    expect(
      (go.json.queued as { id: string; workspace: string }[]).map((a) => [
        a.id,
        a.workspace,
      ]),
    ).toEqual([["planner", "north"]]);
  });

  it("a background job: not queued; the bell row lists it with why it waits", async () => {
    const { r, token, job } = await started();
    transcript(r, token, true);
    job.on = true;
    onOlderTools(r);
    const { post, jobs } = await api(r);
    const go = await post();
    expect(go.status).toBe(202);
    expect(go.json.agents).toEqual([
      {
        id: "planner",
        workspace: "north",
        state: "job",
        job: { command: "npm run dev", minutes: 12 },
      },
    ]);
    expect(go.json.queued).toEqual([]);
    expect(jobs).toEqual([]);
    const row = toolsOldRow(resolveAgentsDeps(r.deps), async () => one);
    expect(row).toMatchObject({
      kind: "tools_old",
      n: 0,
      agents: [
        {
          agent: "planner",
          workspace: "north",
          waits: "job",
          job: { command: "npm run dev", minutes: 12 },
        },
      ],
    });
    expect(row!.restarting).toBeUndefined();
    await settle();
    expect(r.made[0].signals).toEqual([]);
  });
});
