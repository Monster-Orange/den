/**
 * Issue 459: the delivery loop and app feed pointers: a pointer waits
 * while the agent is mid-turn and is typed once it is idle; pointers keep
 * their own seen store (a busy feed never pushes Hub's ids out); one
 * paste holds at most pasteMaxChars (the rest go next); holds() says
 * whether an id still waits. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  embedDelivery,
  SeenDeliveries,
} from "../../../src/shared/hub-delivery";
import {
  DeliveryLoop,
  type AgentState,
} from "../../../src/shared/hub-delivery-loop";
import { feedPointerDelivery } from "../../../src/shared/agents/app-feeds";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dfeed-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const feed = { project: "north", name: "chat", agent: "north-helper" };

function setup(o: { pasteMaxChars?: number; seenCap?: number } = {}) {
  const states: Record<string, AgentState> = { "north-helper": "busy" };
  const typed: string[] = [];
  const seen = new SeenDeliveries(path.join(dir, "seen.json"), o.seenCap);
  const feedSeen = new SeenDeliveries(
    path.join(dir, "feed-seen.json"),
    o.seenCap,
  );
  const loop = new DeliveryLoop({
    hub: {
      stream: () => {
        throw new Error("no hub");
      },
      list: async () => [],
      ack: async () => undefined,
    },
    agents: {
      state: async (a) => states[a] ?? "missing",
      type: async (_agent, text) => {
        typed.push(text);
        return true;
      },
    },
    owner: () => null,
    seen,
    feedSeen,
    ...(o.pasteMaxChars ? { pasteMaxChars: () => o.pasteMaxChars! } : {}),
  });
  return { loop, states, typed, seen, feedSeen };
}

describe("issue 459: feed pointers in the delivery loop", () => {
  it("held while the agent is mid-turn, typed once it is idle, never twice", async () => {
    const s = setup();
    const dv = feedPointerDelivery(
      feed,
      1,
      "Den: the app feed has 1 unread event",
      1,
    );
    expect(await s.loop.takeLocal(dv)).toBe(true);
    expect(s.typed).toEqual([]);
    expect(s.loop.holds(dv.id)).toBe(true);
    s.states["north-helper"] = "idle";
    await s.loop.pump();
    expect(s.typed).toEqual(["Den: the app feed has 1 unread event"]);
    expect(await s.loop.takeLocal(dv)).toBe(false);
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
  });

  it("pointers keep their own seen store: Hub's ids stay in the shared one", async () => {
    const s = setup({ seenCap: 3 });
    const hubItem = embedDelivery({
      id: "m1",
      agent: "north-helper",
      project: "north",
      origin: "an app",
      text: "hi",
      at: 1,
    });
    await s.loop.takeLocal(hubItem);
    for (let i = 1; i <= 10; i++)
      await s.loop.takeLocal(feedPointerDelivery(feed, i, `p${i}`, i));
    expect(s.loop.seenLocal(hubItem.id)).toBe(true);
    expect(s.seen.has(hubItem.id)).toBe(true);
    expect(s.seen.has(feedPointerDelivery(feed, 10, "", 0).id)).toBe(false);
    expect(s.feedSeen.has(feedPointerDelivery(feed, 10, "", 0).id)).toBe(true);
  });

  it("one paste holds at most pasteMaxChars; the rest go in the next paste", async () => {
    const s = setup({ pasteMaxChars: 250 });
    for (let i = 1; i <= 3; i++)
      await s.loop.takeLocal(
        embedDelivery({
          id: `m${i}`,
          agent: "north-helper",
          project: "north",
          origin: "an app",
          text: `${i}`.repeat(100),
          at: i,
        }),
      );
    s.states["north-helper"] = "idle";
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0]).toContain("1".repeat(100));
    expect(s.typed[0]).toContain("2".repeat(100));
    expect(s.typed[0]).not.toContain("3".repeat(100));
    expect(s.loop.work("north-helper")?.queued).toBe(1);
  });

  it("an item alone past the cap still goes (never stuck)", async () => {
    const s = setup({ pasteMaxChars: 10 });
    await s.loop.takeLocal(
      embedDelivery({
        id: "big",
        agent: "north-helper",
        project: "north",
        origin: "an app",
        text: "z".repeat(50),
        at: 1,
      }),
    );
    s.states["north-helper"] = "idle";
    await s.loop.pump();
    expect(s.typed).toEqual(["z".repeat(50)]);
  });
});
