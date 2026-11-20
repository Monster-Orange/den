/**
 * Issue 701 (part 2): one agent's stuck delivery held every other agent's
 * comments, and a typed comment whose turn never showed as ended stayed
 * "working" for hours.
 * - Each agent pumps on its own: a state read or a paste that never
 *   answers holds only its own agent, for at most its time limit.
 * - A comment held past hub.delivery_held_bell_minutes is said once (with
 *   its reason) to the bell.
 * - A typed comment with no end after hub.delivery_answer_minutes is
 *   acked "delivered, no answer yet", said to the bell, and the agent's
 *   queue moves on.
 * Fake Hub, fake agents, a fake clock. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenDeliveries } from "../../../src/shared/hub-delivery";
import {
  DeliveryLoop,
  HELD_WORDS,
  type AgentState,
  type DeliveryHub,
} from "../../../src/shared/hub-delivery-loop";

describe("issue 701: what Hub is told", () => {
  it("every held reason is lowercase plain words, no numbers, at most 300 characters", () => {
    for (const w of Object.values(HELD_WORDS)) {
      expect(w[0]).toBe(w[0].toLowerCase());
      expect(w).not.toMatch(/\d/);
      expect(w.length).toBeLessThanOrEqual(300);
    }
  });
});

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dpump-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const dv = (id: string, agent: string) => ({
  id,
  agent,
  project: "web",
  thread: {
    kind: "comment",
    id: `th_${id}`,
    url: `https://hub.example.test/a/doc#th_${id}`,
    artifact: "Pricing page",
  },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: `comment ${id}`,
  created_at: new Date(1_000_000).toISOString(),
});

const never = <T>() => new Promise<T>(() => undefined);

type Deps = ConstructorParameters<typeof DeliveryLoop>[0];

function setup(o: Partial<Deps> = {}) {
  const acks: { id: string; state: string; reason?: unknown }[] = [];
  const typed: { agent: string; text: string }[] = [];
  const notes: [string, number, number, string | undefined][] = [];
  const noAnswer: { agent: string; count: number }[] = [];
  const states: Record<string, AgentState> = {};
  const hang = new Set<string>();
  let clock = 1_000_000;
  const hub: DeliveryHub = {
    stream: () => {
      throw Object.assign(new Error("no stream"), { kind: "refused" });
    },
    list: async () => [],
    ack: async (id, body) => {
      acks.push({ id, state: String(body.state), reason: body.reason });
    },
  };
  const loop = new DeliveryLoop({
    hub,
    agents: {
      state: async (a) =>
        hang.has(`state:${a}`) ? never() : (states[a] ?? "missing"),
      type: async (agent, text) => {
        if (hang.has(`type:${agent}`)) return never();
        typed.push({ agent, text });
        return true;
      },
    },
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    seen: new SeenDeliveries(path.join(dir, "seen.json")),
    now: () => clock,
    stateTimeoutMs: 50,
    typeTimeoutMs: 50,
    answerTimeoutMs: 30 * 60_000,
    heldNote: (agent: string, n: number, waited: number, why?: string) =>
      notes.push([agent, n, waited, why]),
    noAnswer: (agent: string, w: { count: number }) =>
      noAnswer.push({ agent, count: w.count }),
    ...o,
  } as Deps);
  return {
    loop,
    acks,
    typed,
    notes,
    noAnswer,
    states,
    hang,
    tick: (ms: number) => (clock += ms),
    of: (id: string) => acks.filter((a) => a.id === id).map((a) => a.state),
  };
}

describe("issue 701: each agent pumps on its own", () => {
  it("a state read that never answers holds only its own agent", async () => {
    const s = setup();
    s.states["ag-a"] = "busy";
    s.states["ag-b"] = "busy";
    await s.loop.take(dv("a1", "ag-a"));
    await s.loop.take(dv("b1", "ag-b"));
    s.hang.add("state:ag-a");
    s.states["ag-b"] = "idle";
    await s.loop.pump();
    expect(s.typed.map((t) => t.agent)).toEqual(["ag-b"]);
  });

  it("a paste that never answers holds only its own agent, and isn't typed twice", async () => {
    const s = setup();
    s.states["ag-a"] = "busy";
    s.states["ag-b"] = "busy";
    await s.loop.take(dv("a1", "ag-a"));
    await s.loop.take(dv("b1", "ag-b"));
    s.hang.add("type:ag-a");
    s.states["ag-a"] = "idle";
    await s.loop.pump();
    s.states["ag-b"] = "idle";
    await s.loop.pump();
    await s.loop.pump();
    expect(s.typed.map((t) => t.agent)).toEqual(["ag-b"]);
  });
});

describe("issue 701: a held comment's note says why, whatever holds it", () => {
  it("issue 664's held note carries the reason and how long it has waited", async () => {
    const s = setup();
    s.states["ag-1"] = "busy";
    await s.loop.take(dv("d1", "ag-1"));
    s.tick(5 * 60_000);
    await s.loop.pump();
    expect(s.notes.at(-1)).toEqual(["ag-1", 1, 5 * 60_000, "busy"]);
    s.states["ag-1"] = "stopped";
    await s.loop.pump();
    expect(s.notes.at(-1)?.[3]).toBe("stopped");
    s.states["ag-1"] = "idle";
    await s.loop.pump();
    expect(s.notes.at(-1)).toEqual(["ag-1", 0, 0, undefined]);
  });
});

describe("issue 701: a typed comment's turn that never ends", () => {
  it("after the setting: delivered, no answer yet; the queue moves on", async () => {
    const s = setup();
    s.states["ag-1"] = "idle";
    await s.loop.take(dv("d1", "ag-1"));
    s.states["ag-1"] = "busy";
    await s.loop.pump();
    await s.loop.take(dv("d2", "ag-1"));
    s.tick(30 * 60_000 + 1);
    await s.loop.pump();
    expect(s.noAnswer).toEqual([{ agent: "ag-1", count: 1 }]);
    const last = s.acks.filter((a) => a.id === "d1").pop();
    expect(last?.state).toBe("delivered");
    expect(last?.reason).toBe("typed in; no answer yet");
    expect(s.loop.work("ag-1")?.working ?? 0).toBe(0);
    s.states["ag-1"] = "idle";
    await s.loop.pump();
    expect(s.typed.map((t) => t.text)).toEqual([
      expect.stringContaining("comment d1"),
      expect.stringContaining("comment d2"),
    ]);
  });
});
