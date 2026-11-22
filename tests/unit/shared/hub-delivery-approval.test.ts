/**
 * P0-D2: the delivery loop tells Den about an owner's approval when it
 * arrives (once per delivery), not when it is typed: the agent may be
 * busy for hours. Fake Hub, fake agents. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SeenDeliveries,
  type Delivery,
} from "../../../src/shared/hub-delivery";
import {
  DeliveryLoop,
  type DeliveryHub,
} from "../../../src/shared/hub-delivery-loop";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-d2loop-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const raw = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  agent: "ag-1",
  project: "web",
  thread: {
    kind: "comment",
    id: `th_${id}`,
    url: "https://hub.example.test/a/doc",
    artifact: "Pricing page",
  },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: "",
  created_at: "2026-11-12T18:00:00Z",
  ...o,
});

function setup(known = true) {
  const approved: Delivery[] = [];
  const who = { known, asked: 0 };
  const hub: DeliveryHub = {
    stream: () => {
      throw Object.assign(new Error("no stream"), { kind: "refused" });
    },
    list: async () => [],
    ack: async () => undefined,
  };
  const loop = new DeliveryLoop({
    hub,
    agents: {
      state: async () => "busy",
      why: async () => null,
      type: async () => true,
    },
    ownerWanted: () => {
      who.asked++;
    },
    owner: () => (who.known ? { ownerId: "u_me", company: "Acme" } : null),
    seen: new SeenDeliveries(path.join(dir, "seen.json")),
    approved: (d: Delivery) => approved.push(d),
  } as ConstructorParameters<typeof DeliveryLoop>[0]);
  return { loop, approved, who };
}

describe("P0-D2: approvals reach Den on arrival", () => {
  it("an owner's approve, while the agent is busy, once", async () => {
    const { loop, approved } = setup();
    await loop.take(raw("a1", { kind: "approve", version: 3 }));
    await loop.take(raw("a1", { kind: "approve", version: 3 }));
    expect(approved.map((d) => d.id)).toEqual(["a1"]);
  });

  it("an 'approved v3 of' info comment and a held decision count; a plain comment doesn't", async () => {
    const { loop, approved } = setup();
    await loop.take(
      raw("c1", { intent: "info", body: "@pat approved v3 of Pricing page" }),
    );
    await loop.take(raw("h1", { kind: "held", body: "applied" }));
    await loop.take(raw("h2", { kind: "held", body: "denied" }));
    await loop.take(raw("c3", { body: "@pat approved v3 of Pricing page" }));
    await loop.take(raw("c2", { body: "nice work" }));
    expect(approved.map((d) => d.id)).toEqual(["c1", "h1"]);
  });

  it("someone else's approval doesn't count", async () => {
    const { loop, approved } = setup();
    await loop.take(
      raw("a2", {
        kind: "approve",
        author: {
          id: "u_sam",
          login: "sam",
          name: "Sam Example",
          kind: "person",
          verified: "hub_session",
        },
      }),
    );
    expect(approved).toEqual([]);
  });

  it("one that arrives before Den knows its person counts once it does, once", async () => {
    const { loop, approved, who } = setup(false);
    await loop.take(raw("a3", { kind: "approve", version: 1 }));
    await loop.take(raw("c4", { body: "nice work" }));
    await loop.pump();
    expect(approved).toEqual([]);
    // The agent is busy: the loop asks for its person itself.
    expect(who.asked).toBeGreaterThan(0);
    who.known = true;
    await loop.pump();
    await loop.pump();
    expect(approved.map((d) => d.id)).toEqual(["a3"]);
  });
});
