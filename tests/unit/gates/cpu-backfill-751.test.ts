/**
 * Issue 751: a cpu run waits only for the browser run holding the machine,
 * not for every browser run queued before it. When a browser run ends,
 * waiting cpu runs start (up to cpu_slots) before the next browser waiter;
 * a browser waiter past `priority_pass_limit_minutes` is never passed by a
 * new cpu run. Within a kind, the line keeps its order (issue 715's
 * priority included). Pure rules: no store, no Den, no suite runs.
 */
import { describe, expect, it } from "@jest/globals";
import {
  GATE_DEFAULTS,
  expectedStart,
  grants,
  queueOrder,
  queuePlace,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";

const T0 = Date.parse("2026-11-20T06:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const at = (min: number) => T0 + min * 60_000;
const entry = (
  id: string,
  kind: "browser" | "cpu",
  askedMin: number,
  o: { granted?: number; reason?: string; estimate?: number } = {},
): GateEntry => ({
  id,
  kind,
  who: id,
  label: id,
  pid: 1,
  askedAt: iso(askedMin),
  estimateMin: o.estimate ?? 10,
  ...(o.granted !== undefined ? { grantedAt: iso(o.granted) } : {}),
  ...(o.reason
    ? { priority: { for: "release" as const, reason: o.reason } }
    : {}),
});
const ids = (es: GateEntry[]) => es.map((e) => e.id);

describe("cpu runs fill in behind a browser holder (issue 751)", () => {
  const q = [
    entry("h", "browser", 0, { granted: 0, estimate: 60 }),
    entry("b1", "browser", 1, { estimate: 60 }),
    entry("b2", "browser", 2, { estimate: 60 }),
    entry("b3", "browser", 3, { estimate: 60 }),
    entry("c", "cpu", 4, { estimate: 5 }),
  ];

  it("three browser waiters and a cpu waiter asked last: the cpu run is next", () => {
    expect(ids(queueOrder(q, GATE_DEFAULTS, at(5)))).toEqual([
      "c",
      "b1",
      "b2",
      "b3",
    ]);
    // Never beside the browser holder.
    expect(grants(q, GATE_DEFAULTS, at(5))).toEqual([]);
    // The holder ends: the cpu run starts, the next browser run waits.
    const after = q.filter((e) => e.id !== "h");
    expect(grants(after, GATE_DEFAULTS, at(30))).toEqual(["c"]);
  });

  it("gate status tells the cpu waiter the truth: next, at the holder's end", () => {
    expect(queuePlace(q, "c", GATE_DEFAULTS, at(5))).toBe(1);
    expect(queuePlace(q, "b1", GATE_DEFAULTS, at(5))).toBe(2);
    expect(expectedStart(q, "c", at(5), GATE_DEFAULTS)).toBe(at(60));
  });

  it("cpu runs fill up to cpu_slots; the next browser run starts once they end", () => {
    const free = [
      entry("b1", "browser", 1),
      entry("c1", "cpu", 2),
      entry("c2", "cpu", 3),
      entry("c3", "cpu", 4),
    ];
    expect(grants(free, GATE_DEFAULTS, at(5))).toEqual(["c1", "c2"]);
    const running = [
      entry("b1", "browser", 1),
      entry("c1", "cpu", 2, { granted: 5 }),
      entry("c2", "cpu", 3, { granted: 5 }),
      entry("c3", "cpu", 4),
    ];
    expect(grants(running, GATE_DEFAULTS, at(6))).toEqual([]);
    expect(grants([entry("b1", "browser", 1)], GATE_DEFAULTS, at(20))).toEqual([
      "b1",
    ]);
  });

  it("a browser waiter past the pass limit blocks new cpu runs", () => {
    const q2 = [
      entry("b1", "browser", 0),
      entry("c1", "cpu", 1, { granted: 1 }),
      entry("c2", "cpu", 70),
    ];
    // At 30 min b1 is inside the limit: c2 may start beside c1.
    expect(grants(q2, GATE_DEFAULTS, at(30))).toEqual(["c2"]);
    // At 70 min b1 has waited past 60: c2 waits behind it.
    expect(ids(queueOrder(q2, GATE_DEFAULTS, at(70)))).toEqual(["b1", "c2"]);
    expect(grants(q2, GATE_DEFAULTS, at(70))).toEqual([]);
    // The limit is the setting.
    expect(
      grants(q2, { ...GATE_DEFAULTS, priorityPassLimitMinutes: 120 }, at(70)),
    ).toEqual(["c2"]);
    // With the slot free, b1 starts first.
    expect(grants([q2[0]!, q2[2]!], GATE_DEFAULTS, at(70))).toEqual(["b1"]);
  });

  it("a priority run keeps its place within its kind", () => {
    const q3 = [
      entry("h", "browser", 0, { granted: 0 }),
      entry("a", "browser", 1),
      entry("p", "browser", 2, { reason: "the person waits" }),
      entry("c1", "cpu", 3),
      entry("c2", "cpu", 4),
      entry("cp", "cpu", 5, { reason: "release check" }),
    ];
    expect(ids(queueOrder(q3, GATE_DEFAULTS, at(6)))).toEqual([
      "cp",
      "c1",
      "c2",
      "p",
      "a",
    ]);
  });
});
