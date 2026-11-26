import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenDeliveries } from "../../../src/shared/hub-delivery";
import {
  ACK_WORDS,
  DeliveryLoop,
  type AgentState,
} from "../../../src/shared/hub-delivery-loop";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1673-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const comment = (id: string) => ({
  id,
  agent: "ag-1",
  project: "web",
  thread: { kind: "comment", id: `th_${id}`, url: "", artifact: "Plan" },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: `comment ${id}`,
  created_at: "2026-11-12T18:00:00Z",
});

function setup(seenFile = path.join(dir, "seen.json")) {
  const state: { now: AgentState } = { now: "busy" };
  const acks: { id: string; state: string; reason?: unknown }[] = [];
  const typed: string[] = [];
  const asked: string[] = [];
  const journal: { id: string; outcome: string }[] = [];
  const bells: { agent: string; ids: string[]; at: number }[] = [];
  const loop = new DeliveryLoop({
    hub: {
      stream: () => {
        throw Object.assign(new Error("no stream"), { kind: "refused" });
      },
      list: async () => [],
      ack: async (id, body) => {
        acks.push({ id, state: String(body.state), reason: body.reason });
      },
    },
    agents: {
      state: async (a) => {
        asked.push(a);
        return state.now;
      },
      type: async (_a, text) => {
        typed.push(text);
        return true;
      },
    },
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    seen: new SeenDeliveries(seenFile),
    journal: (e) => journal.push({ id: e.id, outcome: e.outcome }),
    gone: (agent, items, at) =>
      bells.push({ agent, ids: items.map((d) => d.id), at }),
    now: () => 5_000,
  });
  return { loop, state, acks, typed, asked, journal, bells };
}

describe("issue 1673: a held item for an agent that is gone", () => {
  it("stops retrying, is still listed as gone, journaled, and the bell rings once", async () => {
    const s = setup();
    await s.loop.take(comment("c1"));
    expect(s.loop.holds("c1")).toBe(true);
    s.state.now = "missing";
    s.acks.length = 0;
    await s.loop.pump();
    expect(s.acks).toEqual([
      { id: "c1", state: "refused", reason: ACK_WORDS.missing },
    ]);
    expect(s.loop.holds("c1")).toBe(false);
    expect(s.loop.goneItems()).toEqual([
      { id: "c1", agent: "ag-1", project: "web", at: 5_000 },
    ]);
    expect(s.bells).toEqual([{ agent: "ag-1", ids: ["c1"], at: 5_000 }]);
    expect(s.journal.filter((e) => e.id === "c1").pop()?.outcome).toBe(
      "refused",
    );
    const n = s.asked.length;
    await s.loop.pump();
    await s.loop.pump();
    expect(s.asked.length).toBe(n);
    expect(s.acks).toHaveLength(1);
    expect(s.typed).toEqual([]);
    expect(s.bells).toHaveLength(1);
  });

  it("after a restart it is still listed as gone, never queued again, and the bell doesn't ring again", async () => {
    const seenFile = path.join(dir, "seen.json");
    const s = setup(seenFile);
    await s.loop.take(comment("c3"));
    s.state.now = "missing";
    await s.loop.pump();
    const t = setup(seenFile);
    t.state.now = "missing";
    expect(t.loop.goneItems().map((g) => g.id)).toEqual(["c3"]);
    expect(t.loop.holds("c3")).toBe(false);
    await t.loop.pump();
    expect(t.bells).toEqual([]);
    expect(t.asked).toEqual([]);
  });

  it("a busy agent still holds its item, and it is typed once it is idle", async () => {
    const s = setup();
    await s.loop.take(comment("c2"));
    await s.loop.pump();
    expect(s.loop.holds("c2")).toBe(true);
    s.state.now = "idle";
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
  });
});
