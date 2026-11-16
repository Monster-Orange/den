/**
 * Issue 216: two restarts of one agent at once never race. Both wait for
 * the same turn end; one stops and resumes it; the other finds it already
 * restarted after it asked, says so, and succeeds. Each `agents restart`,
 * `stop` and `resume` from the CLI leaves one audit row: who, which agent,
 * which project, and the outcome.
 *
 * A real host on a temp socket with a scripted PTY: nothing real runs.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { HostError } from "../../../src/shared/sessions/client.js";
import {
  resolveAgentsDeps,
  restartAgent,
  resumeAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

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

/** Its turn has ended (a transcript whose last reply is end_turn). */
function endedTurn(r: Rig, token: string): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "Plan it" } },
      {
        type: "assistant",
        message: {
          model: "opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Planned." }],
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

async function idleAgent(): Promise<Rig> {
  const r = await rig();
  endOnTerm(r);
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  await settle();
  endedTurn(r, readRecord(r.stateDir, "planner")!.resumeToken!);
  return r;
}

/** The audit rows the CLI wrote for agents (audit.jsonl in its state). */
function agentRows(r: Rig): Record<string, unknown>[] {
  const f = path.join(r.stateDir, "audit.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.verb === "agents");
}

describe("two restarts of one agent at once (issue 216)", () => {
  it("restarts once; both succeed; the second says it was already restarted", async () => {
    const r = await idleAgent();
    const d = resolveAgentsDeps(r.deps);
    const out = await Promise.allSettled([
      restartAgent(d, "planner", "north", "after-turn", { pollMs: 20 }),
      restartAgent(d, "planner", "north", "after-turn", { pollMs: 20 }),
    ]);
    expect(out.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    // The first session and one restart: never a second restart.
    expect(r.made).toHaveLength(2);
    const [a, b] = out.map(
      (o) =>
        (o as PromiseFulfilledResult<Awaited<ReturnType<typeof restartAgent>>>)
          .value,
    );
    expect(a.already).toBeUndefined();
    expect(b.already?.note).toMatch(
      /restarted by another request at .+; same conversation/,
    );
    expect(b.info.ref.id).toBe(a.info.ref.id);
  });

  it("from the CLI: both exit 0, the second says so, two audit rows", async () => {
    const r = await idleAgent();
    const codes = await Promise.all([
      cmdAgents(["restart", "planner"], r.deps),
      cmdAgents(["restart", "planner"], r.deps),
    ]);
    expect(codes).toEqual([0, 0]);
    expect(r.err.join("\n")).not.toMatch(/no session/);
    expect(r.out.join("\n")).toMatch(/restarted by another request at/);
    expect(r.made).toHaveLength(2);
    const rows = agentRows(r);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(String(row.principal)).toMatch(/^person:/);
      expect(String(row.detail)).toMatch(/restart planner in north/);
      expect(row.outcome).toBeUndefined();
    }
    expect(rows.map((x) => String(x.detail)).sort()).toEqual([
      expect.stringMatching(/: already restarted by another request at/),
      expect.stringMatching(/: restarted$/),
    ]);
  });

  it("a lone restart writes one row", async () => {
    const r = await idleAgent();
    expect(await cmdAgents(["restart", "planner"], r.deps)).toBe(0);
    const rows = agentRows(r);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].detail)).toMatch(
      /restart planner in north.*: restarted$/,
    );
  });

  it("stop and resume each write one row; a refused one says why", async () => {
    const r = await idleAgent();
    expect(await cmdAgents(["stop", "planner"], r.deps)).toBe(0);
    expect(await cmdAgents(["resume", "planner"], r.deps)).toBe(0);
    await settle();
    // Running: a second resume is refused.
    expect(await cmdAgents(["resume", "planner"], r.deps)).not.toBe(0);
    const rows = agentRows(r);
    expect(rows.map((x) => String(x.detail))).toEqual([
      expect.stringMatching(/^stop planner in north: stopped/),
      expect.stringMatching(/^resume planner in north: resumed/),
      expect.stringMatching(/^resume planner in north: refused/),
    ]);
    expect(rows[2].outcome).toBe("refused");
    expect(String(rows[2].reason)).toMatch(/running/);
  });

  it("stopped while it waited: not restarted, said plainly", async () => {
    const r = await idleAgent();
    const d = resolveAgentsDeps(r.deps);
    // Mid-turn, so the restart waits; meanwhile a person stops it.
    const tok = readRecord(r.stateDir, "planner")!.resumeToken!;
    const file = path.join(
      r.dir,
      "claude-config",
      "projects",
      "-work",
      `${tok}.jsonl`,
    );
    fs.appendFileSync(
      file,
      JSON.stringify({ type: "user", message: { content: "more" } }) + "\n",
    );
    const p = restartAgent(d, "planner", "north", "after-turn", { pollMs: 20 });
    await new Promise((res) => setTimeout(res, 60));
    expect(await cmdAgents(["stop", "planner"], r.deps)).toBe(0);
    const err = await p.catch((e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(
      /stopped while this restart waited; not restarted/,
    );
    expect(String((err as Error)?.message)).not.toMatch(/no session/);
    expect(r.made).toHaveLength(1);
  });

  it("issue 218: its stop finds the session gone and a newer one live: already restarted", async () => {
    const r = await idleAgent();
    const d = resolveAgentsDeps(r.deps);
    // Another process restarts it just as this one stops it: the kill
    // reaches a session that is gone, and a newer one runs.
    const connect = d.connect;
    let raced = false;
    d.connect = async () => {
      const c = await connect();
      const kill = c.kill.bind(c);
      c.kill = async (id, sig) => {
        if (raced) return kill(id, sig);
        raced = true;
        await kill(id, sig);
        await new Promise((res) => setTimeout(res, 60));
        await resumeAgent(d, "planner", "north");
        throw new HostError("not-found", `no session with id "${String(id)}"`);
      };
      return c;
    };
    const out = await restartAgent(d, "planner", "north", "after-turn", {
      pollMs: 20,
    });
    expect(raced).toBe(true);
    expect(out.already?.note).toMatch(
      /restarted by another request at .+; same conversation/,
    );
    // The first session and the other request's restart: no third.
    expect(r.made).toHaveLength(2);
  });
});
