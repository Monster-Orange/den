/**
 * Issue 751: a cpu run waited behind every queued browser run. Now:
 *
 * 1. cpu and browser waiters queue in separate lines: a cpu waiter is
 *    never behind a browser waiter, and a browser waiter never behind a
 *    cpu waiter.
 * 2. cpu runs may run beside a browser holder, up to
 *    `cpu_slots_beside_browser` (default 2; 0 is "a browser run runs
 *    alone"). A browser holder on a test box is not this machine's.
 * 3. A release-priority run passes every plain waiter of its kind, however
 *    long they have waited. `priority_pass_limit_minutes` (default 0) now
 *    applies only between release-priority runs.
 *
 * Pure rules: no store, no Den, no suite runs.
 */
import { describe, expect, it } from "@jest/globals";
import { assign } from "../../../src/shared/gates/boxes.js";
import { readClasses } from "../../../src/shared/gates/classes.js";
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
  o: Partial<GateEntry> & {
    granted?: number;
    reason?: string;
    estimate?: number;
  } = {},
): GateEntry => {
  const { granted, reason, estimate, ...rest } = o;
  return {
    id,
    kind,
    who: id,
    label: id,
    pid: 1,
    askedAt: iso(askedMin),
    estimateMin: estimate ?? 10,
    ...(granted !== undefined ? { grantedAt: iso(granted) } : {}),
    ...(reason ? { priority: { for: "release" as const, reason } } : {}),
    ...rest,
  };
};
const ids = (es: GateEntry[]) => es.map((e) => e.id);
const ALONE = { ...GATE_DEFAULTS, cpuSlotsBesideBrowser: 0 };

describe("issue 751 rule 1: cpu and browser wait in separate lines", () => {
  const q = [
    entry("h", "browser", 0, { granted: 0, estimate: 60 }),
    entry("b1", "browser", 1, { estimate: 60 }),
    entry("b2", "browser", 2, { estimate: 60 }),
    entry("b3", "browser", 3, { estimate: 60 }),
    entry("c", "cpu", 4, { estimate: 5 }),
  ];

  it("a cpu waiter asked after three browser waiters is first in its line", () => {
    const busy = [entry("x", "cpu", 0, { granted: 0 }), ...q];
    const full = [entry("y", "cpu", 0, { granted: 0 }), ...busy];
    expect(queuePlace(full, "c", GATE_DEFAULTS, at(5))).toBe(1);
    expect(queuePlace(full, "b1", GATE_DEFAULTS, at(5))).toBe(1);
    expect(queuePlace(full, "b3", GATE_DEFAULTS, at(5))).toBe(3);
    // Its expected start is the end of a cpu holder, not of the browser line.
    expect(expectedStart(full, "c", at(5), GATE_DEFAULTS)).toBe(at(10));
  });

  it("a browser waiter is never behind a cpu waiter", () => {
    const es = [
      entry("c1", "cpu", 0, { granted: 0 }),
      entry("c2", "cpu", 0, { granted: 0 }),
      entry("c3", "cpu", 1),
      entry("b", "browser", 2),
    ];
    expect(queuePlace(es, "b", GATE_DEFAULTS, at(3))).toBe(1);
    // cpu is full; the browser run starts beside the two cpu holders.
    expect(grants(es, GATE_DEFAULTS, at(3))).toEqual(["b"]);
  });

  it("a waiting browser run never stops a cpu grant", () => {
    expect(grants(q, GATE_DEFAULTS, at(5))).toEqual(["c"]);
  });
});

describe("issue 751 rule 2: cpu runs beside a browser holder", () => {
  const q = [
    entry("h", "browser", 0, { granted: 0 }),
    entry("c1", "cpu", 1),
    entry("c2", "cpu", 2),
    entry("c3", "cpu", 3),
  ];

  it("up to cpu_slots_beside_browser (default 2) run beside it", () => {
    expect(GATE_DEFAULTS.cpuSlotsBesideBrowser).toBe(2);
    const wide = { ...GATE_DEFAULTS, cpuSlots: 4 };
    expect(grants(q, wide, at(5))).toEqual(["c1", "c2"]);
    // Without the browser holder, all cpu_slots are open.
    expect(grants(q.slice(1), wide, at(5))).toEqual(["c1", "c2", "c3"]);
    expect(grants(q, { ...wide, cpuSlotsBesideBrowser: 3 }, at(5))).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    // Never more than cpu_slots.
    expect(grants(q, GATE_DEFAULTS, at(5))).toEqual(["c1", "c2"]);
  });

  it("at 0, a browser run runs alone, as before", () => {
    expect(grants(q, ALONE, at(5))).toEqual([]);
    // A browser waiter held off by a cpu run stops new cpu runs, so it
    // can't be starved.
    const es = [
      entry("c1", "cpu", 0, { granted: 0 }),
      entry("b", "browser", 1),
      entry("c2", "cpu", 2),
    ];
    expect(grants(es, ALONE, at(3))).toEqual([]);
    expect(grants(es.slice(1), ALONE, at(4))).toEqual(["b"]);
    // At the default, nothing waits.
    expect(grants(es, GATE_DEFAULTS, at(3))).toEqual(["b", "c2"]);
  });

  it("a browser holder on a test box is not this machine's", () => {
    const es = [
      entry("h", "browser", 0, { granted: 0, box: "box1" }),
      entry("c1", "cpu", 1),
      entry("c2", "cpu", 2),
      entry("b", "browser", 3),
    ];
    expect(grants(es, ALONE, at(5))).toEqual(["c1", "c2"]);
    expect(grants([es[0]!, es[3]!], ALONE, at(5))).toEqual(["b"]);
    const box = [{ name: "box1", slots: 1, open: true }];
    expect(assign(es, ALONE, at(5), box)).toEqual([{ id: "c1" }, { id: "c2" }]);
    // A local browser holder at 0: nothing beside it.
    const local = [entry("h", "browser", 0, { granted: 0 }), es[1]!];
    expect(assign(local, ALONE, at(5), box)).toEqual([]);
  });
});

describe("issue 751 rule 3: release priority passes every plain waiter", () => {
  it("whatever their wait; the pass limit defaults to 0", () => {
    expect(GATE_DEFAULTS.priorityPassLimitMinutes).toBe(0);
    const es = [
      entry("h", "browser", 0, { granted: 0 }),
      entry("old", "browser", 1),
      entry("p", "browser", 200, { reason: "the person waits" }),
    ];
    expect(ids(queueOrder(es, GATE_DEFAULTS, at(201)))).toEqual(["p", "old"]);
    // A pass limit no longer protects a plain waiter.
    expect(
      ids(
        queueOrder(
          es,
          { ...GATE_DEFAULTS, priorityPassLimitMinutes: 60 },
          at(201),
        ),
      ),
    ).toEqual(["p", "old"]);
  });

  it("the pass limit applies only between release-priority runs", () => {
    // `rel` asked first and holds priority; `hi`, marked too, waits as a
    // plain run but sits ahead of it by class.
    const classes = readClasses("p0, p1", "top=p0, *=p1", undefined)!;
    const es = [
      entry("rel", "browser", 0, { reason: "first", project: "low" }),
      entry("hi", "browser", 10, { reason: "second", project: "top" }),
      entry("plain", "browser", 20, { project: "top" }),
    ];
    const s = { ...GATE_DEFAULTS, classes };
    // At 0, `rel` never passes another marked run; it still passes `plain`.
    expect(ids(queueOrder(es, s, at(100)))).toEqual(["hi", "rel", "plain"]);
    // With a limit, it passes a marked run that has waited less.
    const lim = { ...s, priorityPassLimitMinutes: 120 };
    expect(ids(queueOrder(es, lim, at(100)))).toEqual(["rel", "hi", "plain"]);
    // ...and not one that has waited longer.
    const short = { ...s, priorityPassLimitMinutes: 60 };
    expect(ids(queueOrder(es, short, at(100)))).toEqual(["hi", "rel", "plain"]);
  });
});
