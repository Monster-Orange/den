/**
 * Issue 750 (Reached, Den's half): an agent whose Hub tools failed to load
 * can't answer in Hub. Den holds Hub's deliveries for it and says why:
 * - `held` with reason `hub_tools_unavailable`, only when Hub lists the
 *   feature `deliveries.ack_held`;
 * - else `queued` with the same reason (an older Hub refuses `held`);
 * - once its tools load (a restart), the delivery is typed and acked
 *   `delivered` as before;
 * - Den's own items (a relayed message) are never held for it.
 * Fake Hub, fake agents. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACK_HELD_FEATURE,
  ackBody,
  EMBED_PREFIX,
  HUB_TOOLS_UNAVAILABLE,
  SeenDeliveries,
  toolsHeldAck,
} from "../../../src/shared/hub-delivery";
import {
  DeliveryLoop,
  type DeliveryHub,
} from "../../../src/shared/hub-delivery-loop";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dhtools-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const dv = (id: string) => ({
  id,
  agent: "ag-1",
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
  created_at: "2026-11-20T18:00:00Z",
});

function setup(o: { ackHeld: boolean; tools: boolean | null }) {
  const acks: { id: string; state: string; reason?: unknown }[] = [];
  const typed: string[] = [];
  const st = { tools: o.tools, ackHeld: o.ackHeld };
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
      state: async () => "idle",
      type: async (_a, text) => {
        typed.push(text);
        return true;
      },
      hubTools: () => st.tools,
    },
    ackHeld: () => st.ackHeld,
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    seen: new SeenDeliveries(path.join(dir, "seen.json")),
  });
  return {
    loop,
    acks,
    typed,
    st,
    of: (id: string) => acks.filter((a) => a.id === id),
  };
}

describe("issue 750: the held ack", () => {
  it("ackBody takes held with its reason", () => {
    expect(ackBody("held", { reason: HUB_TOOLS_UNAVAILABLE })).toEqual({
      state: "held",
      reason: "hub_tools_unavailable",
    });
  });

  it("toolsHeldAck: held when Hub lists the feature, else queued; same reason", () => {
    expect(ACK_HELD_FEATURE).toBe("deliveries.ack_held");
    expect(toolsHeldAck([ACK_HELD_FEATURE])).toEqual({
      state: "held",
      reason: "hub_tools_unavailable",
    });
    expect(toolsHeldAck(["deliveries.all_comments"])).toEqual({
      state: "queued",
      reason: "hub_tools_unavailable",
    });
    expect(toolsHeldAck(undefined).state).toBe("queued");
  });
});

describe("issue 750: an agent whose Hub tools failed to load", () => {
  it("Hub lists deliveries.ack_held: acked held, hub_tools_unavailable, not typed", async () => {
    const s = setup({ ackHeld: true, tools: false });
    await s.loop.take(dv("d1"));
    await s.loop.pump();
    expect(s.typed).toEqual([]);
    expect(s.of("d1")).toEqual([
      { id: "d1", state: "held", reason: "hub_tools_unavailable" },
    ]);
  });

  it("an older Hub (no feature): acked queued with the same reason, once", async () => {
    const s = setup({ ackHeld: false, tools: false });
    await s.loop.take(dv("d1"));
    await s.loop.pump();
    await s.loop.pump();
    expect(s.typed).toEqual([]);
    expect(s.of("d1")).toEqual([
      { id: "d1", state: "queued", reason: "hub_tools_unavailable" },
    ]);
  });

  it("a repeat from Hub is acked held again, with its reason", async () => {
    const s = setup({ ackHeld: true, tools: false });
    await s.loop.take(dv("d1"));
    await s.loop.take(dv("d1"));
    expect(s.of("d1")).toEqual([
      { id: "d1", state: "held", reason: "hub_tools_unavailable" },
      { id: "d1", state: "held", reason: "hub_tools_unavailable" },
    ]);
  });

  it("once its tools load (a restart), it is typed and acked delivered", async () => {
    const s = setup({ ackHeld: true, tools: false });
    await s.loop.take(dv("d1"));
    s.st.tools = true;
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.of("d1").map((a) => a.state)).toEqual([
      "held",
      "delivered",
      "working",
    ]);
  });

  it("not known (null): delivered as before", async () => {
    const s = setup({ ackHeld: true, tools: null });
    await s.loop.take(dv("d1"));
    expect(s.typed).toHaveLength(1);
    expect(s.of("d1")[0].state).toBe("delivered");
  });

  it("Den's own relayed message is still typed; Hub's waits", async () => {
    const s = setup({ ackHeld: true, tools: false });
    await s.loop.take(dv("d1"));
    await s.loop.takeLocal({
      ...(await import("../../../src/shared/hub-delivery")).parseDelivery(
        dv("x"),
      )!,
      id: `${EMBED_PREFIX}m1`,
      text: "a message from a web app",
    });
    await s.loop.pump();
    expect(s.typed).toEqual(["a message from a web app"]);
    expect(s.of("d1")).toEqual([
      { id: "d1", state: "held", reason: "hub_tools_unavailable" },
    ]);
  });
});
