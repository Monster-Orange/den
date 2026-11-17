/**
 * Issue 334: a web app's relayed message goes through the delivery loop
 * Hub's inbox uses, into a rig's scripted PTY (no real runtime runs):
 *
 *   - sent mid-turn: nothing is typed until the turn ends, then it is;
 *   - while the agent waits on its person: held, typed once it no longer
 *     waits;
 *   - stopped: held, typed at its next start;
 *   - with Hub not connected (no owner): typed all the same.
 *
 * Invented names only.
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
import {
  embedDelivery,
  SeenDeliveries,
} from "../../../src/shared/hub-delivery.js";
import { DeliveryLoop } from "../../../src/shared/hub-delivery-loop.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
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

const MESSAGE = "relayed: please summarize the open tickets";

/** The agent started, its transcript as given; returns where it lives. */
async function started(r: Rig, transcript: string): Promise<string> {
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  await settle();
  const rec = JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", "planner.json"), "utf-8"),
  ) as { resumeToken: string };
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${rec.resumeToken}.jsonl`);
  fs.writeFileSync(file, transcript);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  return file;
}

function loopFor(r: Rig, waiting: Set<string>) {
  const d = resolveAgentsDeps(r.deps);
  return new DeliveryLoop({
    hub: {
      stream: () => {
        throw Object.assign(new Error("no Hub"), { kind: "refused" });
      },
      list: async () => [],
      ack: async () => {
        throw new Error("a relayed message is never acked");
      },
    },
    agents: {
      state: (id) => agentInputState(d, id, waiting),
      type: (id, text) => typeIntoAgent(d, id, text),
    },
    // Hub not connected: nobody known.
    owner: () => null,
    seen: new SeenDeliveries(path.join(r.dir, "seen.json")),
  });
}

const relayed = () =>
  embedDelivery({
    id: "m1",
    agent: "planner",
    project: "north",
    origin: "http://127.0.0.1:5173",
    text: MESSAGE,
    at: Date.now(),
  });

const typed = (r: Rig) => Buffer.concat(r.made[0].writes).toString();

describe("a relayed message, through the delivery loop", () => {
  it("sent mid-turn: arrives after the turn ends, not before", async () => {
    const r = await rig();
    const transcript = await started(r, ask);
    r.made[0].emit("> ");
    const loop = loopFor(r, new Set());
    expect(await loop.takeLocal(relayed())).toBe(true);
    await loop.pump();
    await settle();
    expect(typed(r)).not.toContain(MESSAGE);
    expect(loop.work("planner")).toMatchObject({ queued: 1 });
    // The turn ends.
    fs.appendFileSync(transcript, answer);
    await loop.pump();
    await settle();
    expect(typed(r)).toContain(MESSAGE);
    expect(typed(r).endsWith("\r")).toBe(true);
    // Typed once.
    await loop.pump();
    await settle();
    expect(typed(r).split(MESSAGE)).toHaveLength(2);
  }, 60_000);

  it("waiting on its person: held, typed once it no longer waits", async () => {
    const r = await rig();
    await started(r, ask + answer);
    r.made[0].emit("> ");
    const waiting = new Set(["planner"]);
    const loop = loopFor(r, waiting);
    await loop.takeLocal(relayed());
    await loop.pump();
    await settle();
    expect(typed(r)).not.toContain(MESSAGE);
    waiting.clear();
    await loop.pump();
    await settle();
    expect(typed(r)).toContain(MESSAGE);
  }, 60_000);

  it("stopped: held, typed at its next start", async () => {
    const r = await rig();
    await started(r, ask + answer);
    expect(await agents(r, "stop", "planner", "-w", "north")).toBe(0);
    r.made[0].exit(0);
    await settle();
    const loop = loopFor(r, new Set());
    await loop.takeLocal(relayed());
    await loop.pump();
    expect(loop.work("planner")).toMatchObject({ queued: 1 });
    expect(await agents(r, "resume", "planner")).toBe(0);
    await settle();
    const pty = r.made[r.made.length - 1];
    pty.emit("> ");
    await loop.pump();
    await settle();
    expect(Buffer.concat(pty.writes).toString()).toContain(MESSAGE);
  }, 60_000);
});
