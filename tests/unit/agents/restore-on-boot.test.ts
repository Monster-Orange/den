/**
 * 0.4.46 agents.restore_on_boot (on by default): after the machine
 * restarts, every agent that was running comes back on its own
 * conversation, project and mode, not only standing personas and those
 * with resume_on_restart. An agent a person stopped stays stopped, and one
 * set to resume_on_restart off waits. Den waits for Hub first, so they start
 * with Hub's tools; if Hub doesn't answer in time they start anyway and the
 * bell says how many started without Hub.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  agentsRestoreHubWaitSeconds,
  agentsRestoreOnBoot,
} from "../../../src/shared/den-config.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  markInterrupted,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { noteStartedWithoutHub } from "../../../src/ui/server/agent-routes.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;

async function typeInto(r: Rig, id: string, text: string): Promise<void> {
  const sid = (record(r, id).session as { id: string }).id;
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(sid, Buffer.from(text));
  await settle();
  c.close();
  const token = record(r, id).resumeToken as string | undefined;
  if (token) {
    const claude = path.join(r.dir, "claude-config");
    const dir = path.join(claude, "projects", "-work");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${token}.jsonl`), "{}\n");
    r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  }
}

function persona(r: Rig, name: string, extra = ""): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n${extra}---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

const modeOf = (args: string[]) => {
  const i = args.indexOf("--permission-mode");
  return i >= 0 ? args[i + 1] : undefined;
};

/** planner (plain), helper (plain), stopper (stopped by a person), waiter (resume off). */
async function fourThenRestart(): Promise<Rig> {
  const r = await rig();
  for (const id of ["planner", "helper", "stopper", "waiter"]) persona(r, id);
  for (const id of ["planner", "helper", "stopper", "waiter"]) {
    expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
    await typeInto(r, id, "go\r");
  }
  expect(await agents(r, "stop", "stopper", "-w", "north")).toBe(0);
  expect(
    await agents(r, "set", "waiter", "-w", "north", "resume_on_restart", "off"),
  ).toBe(0);
  await r.restartHost();
  return r;
}

describe("0.4.46: agents.restore_on_boot", () => {
  it("every agent that was running comes back on its own conversation and mode; a stopped one stays stopped; resume off waits", async () => {
    const r = await fourThenRestart();
    const launched = new Map(
      r.made.map((p, i) => [i, { args: p.args }] as const),
    );
    const before = r.made.length;
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: true,
    });
    expect(found.interrupted.sort()).toEqual(["helper", "planner", "waiter"]);
    expect(found.resumed.sort()).toEqual(["helper", "planner"]);
    const back = r.made.slice(before);
    expect(back).toHaveLength(2);
    for (const p of back) {
      expect(p.args[0]).toBe("--resume");
      // The same mode it ran in.
      expect(modeOf(p.args)).toBe(modeOf(launched.get(0)!.args));
    }
    expect(record(r, "stopper").interruptedAt).toBeUndefined();
  }, 30_000);

  it("off: only standing personas and resume_on_restart come back (as before)", async () => {
    const r = await fourThenRestart();
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: false,
    });
    expect(found.resumed).toEqual([]);
  }, 30_000);

  it("waits for Hub before it starts them; if Hub never answers in time they start anyway, named as without Hub", async () => {
    const r = await fourThenRestart();
    let asked = 0;
    const order: string[] = [];
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: true,
      hubUp: async () => {
        asked++;
        order.push(`hub ${asked}`);
        return asked >= 3;
      },
      hubWaitMs: 5_000,
      hubPollMs: 10,
    });
    expect(asked).toBe(3);
    expect(found.resumed.sort()).toEqual(["helper", "planner"]);
    expect(found.withoutHub).toEqual([]);

    const r2 = await fourThenRestart();
    const late = await markInterrupted(resolveAgentsDeps(r2.deps), {
      restoreAll: true,
      hubUp: async () => false,
      hubWaitMs: 50,
      hubPollMs: 10,
    });
    expect(late.resumed.sort()).toEqual(["helper", "planner"]);
    expect(late.withoutHub.sort()).toEqual(["helper", "planner"]);
  }, 60_000);

  it("the bell says how many started without Hub", () => {
    const added: Record<string, unknown>[] = [];
    noteStartedWithoutHub({ add: (n) => (added.push(n as never), null) }, [
      "planner",
      "helper",
    ]);
    expect(added).toEqual([
      expect.objectContaining({
        kind: "service",
        subject: "record:agents-without-hub",
        text: "2 agents started without Hub",
        msg: { key: "bell.m.noHub", vars: { n: 2 } },
      }),
    ]);
    noteStartedWithoutHub({ add: (n) => (added.push(n as never), null) }, []);
    expect(added).toHaveLength(1);
  });

  it("agents.restore_on_boot (true) and agents.restore_hub_wait_seconds (120) are settings", () => {
    expect(agentsRestoreOnBoot(() => ({}))).toBe(true);
    expect(
      agentsRestoreOnBoot(() => ({ agents: { restore_on_boot: false } })),
    ).toBe(false);
    expect(() =>
      agentsRestoreOnBoot(() => ({ agents: { restore_on_boot: "yes" } })),
    ).toThrow("agents.restore_on_boot must be true or false");
    expect(agentsRestoreHubWaitSeconds(() => ({}))).toBe(120);
    expect(
      agentsRestoreHubWaitSeconds(() => ({
        agents: { restore_hub_wait_seconds: 30 },
      })),
    ).toBe(30);
    expect(() =>
      agentsRestoreHubWaitSeconds(() => ({
        agents: { restore_hub_wait_seconds: -5 },
      })),
    ).toThrow("agents.restore_hub_wait_seconds must be a number, at least 0");
  });
});
