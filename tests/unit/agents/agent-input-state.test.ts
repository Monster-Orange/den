/**
 * 0.4.40 comment delivery: whether an agent can take a Hub comment now
 * (agentInputState), and typing one in (typeIntoAgent). A rig's scripted
 * PTY and a transcript written here; no real runtime runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentInputState,
  resolveAgentsDeps,
  typeIntoAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const ask = line({
  type: "user",
  timestamp: new Date().toISOString(),
  message: { role: "user", content: "plan the release" },
});
const answer = line({
  type: "assistant",
  timestamp: new Date().toISOString(),
  message: { role: "assistant", stop_reason: "end_turn", content: [] },
});

async function started(r: Rig, transcript: string | null): Promise<void> {
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  await settle();
  if (transcript === null) return;
  const token = record(r, "planner").resumeToken as string;
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${token}.jsonl`), transcript);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

describe("agentInputState", () => {
  it("no such agent: missing", async () => {
    const r = await rig();
    expect(await agentInputState(resolveAgentsDeps(r.deps), "nobody")).toBe(
      "missing",
    );
  });

  it("its turn ended: idle; an approval waiting on it: busy", async () => {
    const r = await rig();
    await started(r, ask + answer);
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner")).toBe("idle");
    expect(await agentInputState(d, "planner", new Set(["planner"]))).toBe(
      "busy",
    );
  });

  it("mid-turn: busy", async () => {
    const r = await rig();
    await started(r, ask);
    expect(await agentInputState(resolveAgentsDeps(r.deps), "planner")).toBe(
      "busy",
    );
  });

  it("stopped: stopped; no session host running: stopped, and none started", async () => {
    const r = await rig();
    await started(r, ask + answer);
    const d = resolveAgentsDeps(r.deps);
    let connects = 0;
    const none = {
      ...d,
      connectExisting: async () => null,
      connect: async () => {
        connects++;
        throw new Error("must not start a host");
      },
    };
    // Running by its record, but no host: stopped, and no host started.
    expect(await agentInputState(none, "planner")).toBe("stopped");
    expect(connects).toBe(0);
    expect(await agents(r, "stop", "planner", "-w", "north")).toBe(0);
    await settle();
    expect(await agentInputState(d, "planner")).toBe("stopped");
  });

  it("a turn Den can't read: quiet output is idle, output still coming is busy", async () => {
    const r = await rig();
    await started(r, null);
    r.made[0].emit("> ");
    await settle();
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner", new Set(), 200)).toBe("idle");
    const spin = setInterval(() => r.made[0].emit("."), 40);
    try {
      expect(await agentInputState(d, "planner", new Set(), 300)).toBe("busy");
    } finally {
      clearInterval(spin);
    }
  });
});

describe("typeIntoAgent", () => {
  it("types the comment into its session, then Enter", async () => {
    const r = await rig();
    await started(r, ask + answer);
    r.made[0].emit("> ");
    const ok = await typeIntoAgent(
      resolveAgentsDeps(r.deps),
      "planner",
      "from: Pat (your person · verified by Hub session)\nshorter heading",
    );
    expect(ok).toBe(true);
    await settle();
    const sent = Buffer.concat(r.made[0].writes).toString();
    expect(sent).toContain("shorter heading");
    expect(sent.endsWith("\r")).toBe(true);
  }, 30_000);

  it("no such agent: false", async () => {
    const r = await rig();
    expect(await typeIntoAgent(resolveAgentsDeps(r.deps), "nobody", "x")).toBe(
      false,
    );
  });
});
