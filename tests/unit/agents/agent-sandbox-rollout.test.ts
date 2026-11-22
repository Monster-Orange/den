/**
 * Issue 936, the rollout: the sandbox is on for agents started after the
 * update. An agent that existed before it keeps starting as before until
 * the person turns the sandbox on: doctor warns ("Sandbox is off for N
 * agents"), and Den asks once, as a held write in the bell, to turn it on
 * (agents.sandbox: on in user.yml). An agent's own `off` still wins.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  askSandboxOn,
  LEGACY_SANDBOX_REASON,
  legacyAgentIds,
  sandboxOnHeldOp,
} from "../../../src/shared/agents/sandbox-rollout.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, loginPath: async () => {} });
const recFile = (r: Rig) => path.join(r.stateDir, "agents", "planner.json");
const record = (r: Rig) =>
  JSON.parse(fs.readFileSync(recFile(r), "utf-8")) as {
    sandbox?: Record<string, unknown>;
  };

/** A planner that started before the update: its record has no sandbox. */
async function fromBefore(): Promise<Rig> {
  const r = await rig();
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, "planner.md"),
    "---\nname: planner\n---\nYou plan.\n",
  );
  r.config.personaPacks = ["personas"];
  r.deps.agentSandbox = (argv) => ({
    applied: true,
    tool: "test-box",
    argv: ["/sbx", ...argv],
    env: {},
  });
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  expect(r.made[0]!.file).toBe("/sbx");
  const rec = record(r);
  delete rec.sandbox;
  fs.writeFileSync(recFile(r), JSON.stringify(rec));
  expect(await agents(r, "stop", "planner")).toBe(0);
  r.made[0]!.exit(0);
  await settle();
  return r;
}

async function resumed(r: Rig) {
  r.out.length = 0;
  r.err.length = 0;
  expect(await agents(r, "resume", "planner")).toBe(0);
  return r.made.at(-1)!;
}

async function stopped(r: Rig) {
  expect(await agents(r, "stop", "planner")).toBe(0);
  r.made.at(-1)!.exit(0);
  await settle();
}

describe("an agent from before the sandbox (issue 936 rollout)", () => {
  it("resumes outside it, recorded as from before, and says how to turn it on", async () => {
    const r = await fromBefore();
    const p = await resumed(r);
    expect(p.file).not.toBe("/sbx");
    expect(record(r).sandbox).toEqual({
      applied: false,
      legacy: true,
      reason: LEGACY_SANDBOX_REASON,
    });
    expect([...r.out, ...r.err].join("\n")).toContain(
      `planner runs outside the agent sandbox (Den's state is writable to it): ${LEGACY_SANDBOX_REASON}`,
    );
  });

  it("stays outside at its next start too", async () => {
    const r = await fromBefore();
    await resumed(r);
    await stopped(r);
    expect((await resumed(r)).file).not.toBe("/sbx");
    expect(record(r).sandbox?.legacy).toBe(true);
  });

  it("goes inside at its next start once agents.sandbox: on is set", async () => {
    const r = await fromBefore();
    await resumed(r);
    await stopped(r);
    r.config.sandbox = true;
    expect((await resumed(r)).file).toBe("/sbx");
    expect(record(r).sandbox).toEqual({ applied: true, tool: "test-box" });
  });

  it("one started inside since the update is never from before, with no setting", async () => {
    const r = await fromBefore();
    const rec = record(r);
    rec.sandbox = { applied: true, tool: "test-box" };
    fs.writeFileSync(recFile(r), JSON.stringify(rec));
    expect((await resumed(r)).file).toBe("/sbx");
    expect(record(r).sandbox).toEqual({ applied: true, tool: "test-box" });
  });

  it("a new agent starts inside, with no setting", async () => {
    const r = await fromBefore();
    expect(r.made[0]!.file).toBe("/sbx");
  });

  it("doctor warns: Sandbox is off for N agents, and how to turn it on", async () => {
    const r = await fromBefore();
    await resumed(r);
    r.out.length = 0;
    await agents(r, "doctor");
    expect(r.out.join("\n")).toContain(
      "  ⚠ Sandbox is off for 1 agent (started before it): Allow Turn on in the bell, or set agents.sandbox: on in config/local/user.yml",
    );
  });
});

describe("legacyAgentIds (issue 936 rollout)", () => {
  const recs = [
    { id: "old" },
    { id: "kept", sandbox: { applied: false, legacy: true } },
    { id: "new", sandbox: { applied: true } },
    { id: "off", sandbox: { applied: false, reason: "off" } },
    { id: "own-off" },
  ];
  it("names agents from before it, unless a setting decides", () => {
    expect(
      legacyAgentIds(recs, { agents: { "own-off": { sandbox: false } } }),
    ).toEqual(["old", "kept"]);
    expect(legacyAgentIds(recs, { sandbox: true, agents: {} })).toEqual([]);
    expect(legacyAgentIds(recs, { sandbox: false, agents: {} })).toEqual([]);
  });
});

describe("Turn on, a held write (issue 936 rollout)", () => {
  it("checks there is an agent to turn on, and its run sets agents.sandbox: on", async () => {
    let n = 2;
    let wrote = 0;
    const op = sandboxOnHeldOp({ count: () => n, turnOn: () => void wrote++ });
    const ok = await op.check({});
    expect(ok).toMatchObject({
      ok: true,
      args: {},
      params: { count: "2" },
    });
    expect((ok as { summary: string }).summary).toBe(
      "turn on the agent sandbox for 2 agents started before it (each at its next start)",
    );
    expect(await op.run({})).toEqual({ ok: true });
    expect(wrote).toBe(1);
    n = 0;
    expect(await op.check({})).toMatchObject({ ok: false });
  });

  it("Den asks once: none while one waits, none when no agent needs it", async () => {
    const asked: { actor: string; action: string }[] = [];
    const pending: { action: string }[] = [];
    const queue = {
      pending: () => pending,
      request: (r: { actor: string; action: string }) => {
        asked.push(r);
        pending.push(r);
        return r;
      },
    };
    let n = 1;
    const op = sandboxOnHeldOp({ count: () => n, turnOn: () => {} });
    expect(await askSandboxOn(queue, op)).toBe(true);
    expect(await askSandboxOn(queue, op)).toBe(false);
    expect(asked).toEqual([
      expect.objectContaining({
        actor: "den:sandbox",
        action: "den_sandbox_on",
      }),
    ]);
    pending.length = 0;
    n = 0;
    expect(await askSandboxOn(queue, op)).toBe(false);
    expect(asked).toHaveLength(1);
  });
});
