/**
 * Issue 774, mock v3 row 7b (Den Builder's ruling): this computer has a
 * tab open and push is on for it. The open tab shows the alert; the push
 * to this same device is skipped while a tab shows it. A device is its
 * push subscription's endpoint (per browser profile), never an IP or a
 * user agent. No ack in time, a hidden tab or a closed one: the push goes.
 * Reviewer A: the server names the tab and binds it to its person; a tab
 * claims only its person's own subscription; the endpoint is kept as a
 * hash; several tabs on one device: the first ack drops it in the others;
 * streams per person are capped, the oldest dropped.
 */
import { describe, expect, it } from "@jest/globals";
import {
  AlertHandoff,
  type TabEvent,
} from "../../../src/ui/server/alert-handoff.js";
import type { Alert } from "../../../src/ui/server/alert-feed.js";

const PHONE = "https://push.example/phone";
const LAPTOP = "https://push.example/laptop";
const OTHERS = "https://push.example/someone-else";
/** The stored subscriptions, by person (the claim check). */
const OWN: Record<string, string[]> = {
  "person:a": [PHONE, LAPTOP],
  "person:b": [OTHERS],
};

function rig(o: { windowMs?: number; maxTabs?: number } = {}) {
  const timers = new Map<number, () => void>();
  let next = 0;
  const pushed: string[][] = [];
  const h = new AlertHandoff({
    windowMs: () => o.windowMs ?? 3000,
    maxTabs: () => o.maxTabs ?? 20,
    setTimer: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    clearTimer: (t) => void timers.delete(t as number),
  });
  const events: Record<string, TabEvent[]> = {};
  const ended: string[] = [];
  const tab = (person: string, endpoint: string | null, visible: boolean) => {
    const got: TabEvent[] = [];
    const id = h.open(
      person,
      (e) => got.push(e),
      () => ended.push(id),
    );
    events[id] = got;
    if (endpoint !== null || visible)
      expect(
        h.presence(id, person, { endpoint, visible }, (ep) =>
          (OWN[person] ?? []).includes(ep),
        ),
      ).toBe("ok");
    return id;
  };
  const shown = (id: string) =>
    events[id]
      .filter((e) => e.type === "alert")
      .map((e) => (e as { alert: Alert }).alert.id);
  const dropped = (id: string) =>
    events[id]
      .filter((e) => e.type === "drop")
      .map((e) => (e as { id: string }).id);
  const alert = (id: string) => ({ id, seq: 1 }) as unknown as Alert;
  const deliver = (a: Alert, eps = [PHONE, LAPTOP, OTHERS]) =>
    h.deliver(a, eps, (sent) => pushed.push([...sent].sort()));
  const fire = () => {
    const all = [...timers.values()];
    timers.clear();
    all.forEach((f) => f());
  };
  return {
    h,
    tab,
    events,
    shown,
    dropped,
    ended,
    alert,
    deliver,
    pushed,
    fire,
    timers,
  };
}

describe("774 row 7b: the open tab first, then push", () => {
  it("the server names the tab: its first event", () => {
    const r = rig();
    const t = r.tab("person:a", null, false);
    expect(r.events[t][0]).toEqual({ type: "tab", tab: t });
    expect(t).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it("a visible tab on this device: it gets the alert and acks; no push to this device", () => {
    const r = rig();
    const t = r.tab("person:a", LAPTOP, true);
    r.deliver(r.alert("x1"));
    expect(r.shown(t)).toEqual(["x1"]);
    // The other devices have no tab: pushed at once.
    expect(r.pushed).toEqual([[PHONE, OTHERS]]);
    expect(r.h.ack(t, "person:a", "x1")).toBe("ok");
    r.fire();
    expect(r.pushed).toEqual([[PHONE, OTHERS]]);
    expect(r.h.pendingCount()).toBe(0);
  });

  it("a hidden tab: the push goes to this device as now", () => {
    const r = rig();
    const t = r.tab("person:a", LAPTOP, false);
    r.deliver(r.alert("x1"));
    expect(r.shown(t)).toEqual([]);
    expect(r.pushed).toEqual([[LAPTOP, PHONE, OTHERS]]);
    expect(r.h.pendingCount()).toBe(0);
  });

  it("no ack in time: the push goes to this device", () => {
    const r = rig();
    r.tab("person:a", LAPTOP, true);
    r.deliver(r.alert("x1"));
    r.fire();
    expect(r.pushed).toEqual([[PHONE, OTHERS], [LAPTOP]]);
    expect(r.h.pendingCount()).toBe(0);
  });

  it("two devices, each with a visible tab: each gets exactly one alert", () => {
    const r = rig();
    const lap = r.tab("person:a", LAPTOP, true);
    const ph = r.tab("person:a", PHONE, true);
    r.deliver(r.alert("x1"), [PHONE, LAPTOP]);
    expect(r.shown(lap)).toEqual(["x1"]);
    expect(r.shown(ph)).toEqual(["x1"]);
    r.h.ack(lap, "person:a", "x1");
    r.h.ack(ph, "person:a", "x1");
    r.fire();
    expect(r.pushed).toEqual([]);
  });

  it("several tabs on one device: all get it; the first ack drops it in the others", () => {
    const r = rig();
    const a = r.tab("person:a", LAPTOP, true);
    const b = r.tab("person:a", LAPTOP, true);
    r.deliver(r.alert("x1"), [LAPTOP]);
    expect(r.shown(a)).toEqual(["x1"]);
    expect(r.shown(b)).toEqual(["x1"]);
    expect(r.h.ack(a, "person:a", "x1")).toBe("ok");
    expect(r.dropped(b)).toEqual(["x1"]);
    expect(r.dropped(a)).toEqual([]);
    // b's late ack: nothing pending any more.
    expect(r.h.ack(b, "person:a", "x1")).toBe("not_pending");
    r.fire();
    expect(r.pushed).toEqual([]);
  });

  it("the tab closes mid-window: the push goes at once; nothing is left", () => {
    const r = rig();
    const t = r.tab("person:a", LAPTOP, true);
    r.deliver(r.alert("x1"), [LAPTOP]);
    r.h.close(t);
    expect(r.pushed).toEqual([[LAPTOP]]);
    expect(r.h.pendingCount()).toBe(0);
    expect(r.timers.size).toBe(0);
    expect(r.h.tabCount()).toBe(0);
  });

  it("the tab goes hidden mid-window: the push goes at once", () => {
    const r = rig();
    const t = r.tab("person:a", LAPTOP, true);
    r.deliver(r.alert("x1"), [LAPTOP]);
    expect(
      r.h.presence(
        t,
        "person:a",
        { endpoint: LAPTOP, visible: false },
        () => true,
      ),
    ).toBe("ok");
    expect(r.pushed).toEqual([[LAPTOP]]);
    expect(r.h.pendingCount()).toBe(0);
  });

  it("two tabs on this device: one closing leaves the other to answer", () => {
    const r = rig();
    const a = r.tab("person:a", LAPTOP, true);
    const b = r.tab("person:a", LAPTOP, true);
    r.deliver(r.alert("x1"), [LAPTOP]);
    r.h.close(a);
    expect(r.pushed).toEqual([]);
    r.h.ack(b, "person:a", "x1");
    r.fire();
    expect(r.pushed).toEqual([]);
    expect(r.h.pendingCount()).toBe(0);
  });

  it("presence and ack only from the tab's own person; an ack names a pending alert", () => {
    const r = rig();
    const t = r.tab("person:a", LAPTOP, true);
    r.deliver(r.alert("x1"), [LAPTOP]);
    expect(r.h.ack(t, "person:b", "x1")).toBe("forbidden");
    expect(r.h.ack("no-such-tab", "person:a", "x1")).toBe("forbidden");
    expect(r.h.ack(t, "person:a", "x2")).toBe("not_pending");
    expect(
      r.h.presence(
        t,
        "person:b",
        { endpoint: null, visible: false },
        () => true,
      ),
    ).toBe("forbidden");
    r.fire();
    expect(r.pushed).toEqual([[LAPTOP]]);
  });

  it("a tab claims only its person's own subscription: another's pushes are never swallowed", () => {
    const r = rig();
    const t = r.tab("person:a", null, true);
    expect(
      r.h.presence(t, "person:a", { endpoint: OTHERS, visible: true }, (ep) =>
        OWN["person:a"].includes(ep),
      ),
    ).toBe("not_yours");
    r.deliver(r.alert("x1"), [OTHERS]);
    expect(r.shown(t)).toEqual([]);
    expect(r.pushed).toEqual([[OTHERS]]);
  });

  it("a tab with no push endpoint is never a device's stand-in", () => {
    const r = rig();
    r.tab("person:a", null, true);
    r.deliver(r.alert("x1"), [LAPTOP]);
    expect(r.pushed).toEqual([[LAPTOP]]);
  });

  it("streams per person are capped: past it, the oldest is dropped", () => {
    const r = rig({ maxTabs: 2 });
    const a = r.tab("person:a", LAPTOP, true);
    const b = r.tab("person:a", null, false);
    r.tab("person:b", null, false);
    expect(r.ended).toEqual([]);
    r.tab("person:a", null, false);
    expect(r.ended).toEqual([a]);
    expect(r.h.tabCount()).toBe(3);
    // The dropped tab no longer stands in for the laptop.
    r.deliver(r.alert("x1"), [LAPTOP]);
    expect(r.pushed).toEqual([[LAPTOP]]);
    expect(r.ended).not.toContain(b);
  });

  it("keeps the endpoint only as a hash", () => {
    const r = rig();
    r.tab("person:a", LAPTOP, true);
    expect(JSON.stringify(r.h.debugState())).not.toContain("push.example");
  });
});
