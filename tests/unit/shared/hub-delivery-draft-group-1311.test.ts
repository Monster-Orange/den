/**
 * Issue 1311 with issue 750: a group's message (Hub's composer, sent to
 * <group>/all) reaches each member agent as a Hub delivery. While its
 * person's draft is on the line, it waits like any other: held with the
 * draft's reason, never refused or dropped, and typed after the draft is
 * sent, in order. A draft begun in the quiet wait (type refuses) requeues
 * it. Fake Hub, fake agents. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenDeliveries } from "../../../src/shared/hub-delivery";
import {
  DeliveryLoop,
  type DeliveryHub,
} from "../../../src/shared/hub-delivery-loop";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dhdraft-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const dv = (id: string, body: string, to?: string) => ({
  id,
  agent: "ag-1",
  project: "web",
  ...(to ? { to } : {}),
  thread: {
    kind: "message",
    id: `th_${id}`,
    url: `https://hub.example.test/g/release-crew#th_${id}`,
  },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body,
  created_at: "2026-11-20T18:00:00Z",
});

function setup() {
  const acks: { id: string; state: string; reason?: unknown }[] = [];
  const typed: string[] = [];
  const st = { draft: true, refuseOnce: false };
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
      state: async () => (st.draft ? "busy" : "idle"),
      why: async () => (st.draft ? "draft" : null),
      type: async (_a, text) => {
        // A draft begun after the state said idle: typeIntoAgent refuses.
        if (st.refuseOnce) {
          st.refuseOnce = false;
          return false;
        }
        typed.push(text);
        return true;
      },
      hubTools: () => true,
    },
    ackHeld: () => true,
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

describe("issue 1311 × 750: a group's message and its person's draft", () => {
  it("held on the draft (never refused or dropped), then typed after Enter, in order", async () => {
    const s = setup();
    await s.loop.take(dv("d1", "a comment first"));
    await s.loop.take(dv("g1", "standup at ten", "release-crew/all"));
    await s.loop.pump();
    expect(s.typed).toEqual([]);
    for (const id of ["d1", "g1"]) {
      const a = s.of(id);
      expect(a.length).toBeGreaterThan(0);
      expect(a.every((x) => x.state === "queued")).toBe(true);
      expect(String(a[a.length - 1].reason)).toMatch(/typing a message/);
    }
    expect(s.loop.waitingOnDraft("ag-1")).toBe(2);

    // The person presses Enter: the draft goes, then both, in order.
    s.st.draft = false;
    await s.loop.pump();
    await s.loop.pump();
    // Typed as one turn or two, the earlier one first.
    const all = s.typed.join("\n");
    expect(all.indexOf("a comment first")).toBeGreaterThanOrEqual(0);
    expect(all.indexOf("standup at ten")).toBeGreaterThan(
      all.indexOf("a comment first"),
    );
    expect(s.of("g1").some((x) => x.state === "delivered")).toBe(true);
    expect(
      s.acks.some((x) => x.state === "refused" || x.state === "failed"),
    ).toBe(false);
  });

  it("a draft begun in the quiet wait: type refuses, the message is requeued and typed later", async () => {
    const s = setup();
    s.st.draft = false;
    s.st.refuseOnce = true;
    // take() tries at once: type refuses (the draft), the message stays.
    await s.loop.take(dv("g1", "standup at ten", "release-crew/all"));
    expect(s.st.refuseOnce).toBe(false);
    expect(s.typed).toEqual([]);
    expect(
      s.of("g1").some((x) => x.state === "refused" || x.state === "failed"),
    ).toBe(false);
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0]).toContain("standup at ten");
    expect(s.of("g1").some((x) => x.state === "delivered")).toBe(true);
  });
});
