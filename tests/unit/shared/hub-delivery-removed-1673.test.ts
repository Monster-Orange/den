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

function setup(
  seenFile = path.join(dir, "seen.json"),
  o: { now?: number; keepMs?: number } = {},
) {
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
    now: () => o.now ?? 5_000,
    ...(o.keepMs !== undefined ? { goneKeepMs: () => o.keepMs! } : {}),
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

  it("hub.delivery_gone_keep_days: an item older than the limit is dropped at a restart; 0 keeps it", async () => {
    const seenFile = path.join(dir, "seen.json");
    const day = 86_400_000;
    const s = setup(seenFile, { keepMs: 30 * day });
    await s.loop.take(comment("c4"));
    s.state.now = "missing";
    await s.loop.pump();
    expect(
      setup(seenFile, {
        now: 5_000 + 30 * day,
        keepMs: 30 * day,
      }).loop.goneItems(),
    ).toHaveLength(1);
    expect(
      setup(seenFile, { now: 5_000 + 31 * day, keepMs: 0 }).loop.goneItems(),
    ).toHaveLength(1);
    const late = setup(seenFile, { now: 5_000 + 31 * day, keepMs: 30 * day });
    expect(late.loop.goneItems()).toEqual([]);
    await late.loop.pump();
    expect(
      setup(seenFile, { now: 5_000 + 31 * day, keepMs: 0 }).loop.goneItems(),
    ).toEqual([]);
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

describe("hub.delivery_gone_keep_days in user.yml", () => {
  it("30 by default; 0 or more is kept; anything else says so", async () => {
    const { readHubConfig } = await import("../../../src/shared/hub");
    const at = (delivery_gone_keep_days?: unknown) =>
      readHubConfig({
        hub: {
          url: "https://hub.example.test",
          ...(delivery_gone_keep_days === undefined
            ? {}
            : { delivery_gone_keep_days }),
        },
      } as never);
    expect(at()?.deliveryGoneKeepDays).toBe(30);
    expect(at(0)?.deliveryGoneKeepDays).toBe(0);
    expect(at(90)?.deliveryGoneKeepDays).toBe(90);
    expect(() => at(-1)).toThrow(/hub\.delivery_gone_keep_days/);
    expect(() => at("forever")).toThrow(/hub\.delivery_gone_keep_days/);
  });
});
