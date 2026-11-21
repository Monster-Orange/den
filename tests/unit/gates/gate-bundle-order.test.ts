/**
 * Issues 715/739, 803, 795, 625 and 714 together: the queue applies every
 * rule at once, in this precedence. A granted slot is never pre-empted;
 * release priority goes first, past any class; then classes; then yields,
 * which never move a run past one that outranks it (other than the
 * yielder); then first come. A window's hold applies last, and 625's box
 * assignment honours it. Pure rules, plus one store bed for 714 with 625.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assign } from "../../../src/shared/gates/boxes.js";
import { readClasses } from "../../../src/shared/gates/classes.js";
import {
  GATE_DEFAULTS,
  grants,
  queueOrder,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import { GateStore } from "../../../src/shared/gates/store.js";

const T0 = Date.parse("2026-11-20T19:00:00");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const entry = (
  id: string,
  min: number,
  o: Partial<GateEntry> = {},
): GateEntry => ({
  id,
  kind: "browser",
  who: "w",
  label: id,
  pid: 1,
  askedAt: at(min),
  estimateMin: 5,
  ...o,
});

const order = (
  entries: GateEntry[],
  s: Partial<typeof GATE_DEFAULTS> = {},
  now = T0 + 10 * 60_000,
) => queueOrder(entries, { ...GATE_DEFAULTS, ...s }, now).map((e) => e.id);

const classes = (windows?: string) =>
  readClasses("p0, p1, p2", "top=p0, mid=p1, *=p2", windows)!;

describe("the gate queue, every rule together", () => {
  it("release priority goes first, past a higher class", () => {
    const es = [
      entry("hi", 0, { project: "top" }),
      entry("mid", 1, { project: "mid" }),
      entry("rel", 2, {
        project: "low",
        priority: { for: "release", reason: "a person waits" },
      }),
    ];
    expect(order(es, { classes: classes() })).toEqual(["rel", "hi", "mid"]);
  });

  it("release priority still never passes a waiter past the pass limit", () => {
    const es = [
      entry("old", 0, { project: "top" }),
      entry("rel", 70, {
        project: "low",
        priority: { for: "release", reason: "a person waits" },
      }),
    ];
    expect(order(es, { classes: classes() }, T0 + 75 * 60_000)).toEqual([
      "old",
      "rel",
    ]);
  });

  it("classes order the rest; within a class, first come", () => {
    const es = [
      entry("low1", 0, { project: "low" }),
      entry("mid1", 1, { project: "mid" }),
      entry("top1", 2, { project: "top" }),
      entry("low2", 3, { project: "low" }),
    ];
    expect(order(es, { classes: classes() })).toEqual([
      "top1",
      "mid1",
      "low1",
      "low2",
    ]);
  });

  it("a yield within a class moves the run just ahead of the yielder", () => {
    const es = [
      entry("a", 0, { project: "low", yields: [{ to: "c", at: at(5) }] }),
      entry("b", 1, { project: "low" }),
      entry("c", 2, { project: "low" }),
    ];
    expect(order(es, { classes: classes() })).toEqual(["c", "a", "b"]);
  });

  it("a yield never moves a run past a higher class between them", () => {
    const es = [
      entry("a", 0, { project: "top", yields: [{ to: "c", at: at(5) }] }),
      entry("b", 1, { project: "top" }),
      entry("c", 2, { project: "low" }),
    ];
    expect(order(es, { classes: classes() })).toEqual(["a", "b", "c"]);
  });

  it("the yielder itself may let a lower class ahead of it", () => {
    const es = [
      entry("a", 0, { project: "top", yields: [{ to: "c", at: at(5) }] }),
      entry("c", 2, { project: "low" }),
    ];
    expect(order(es, { classes: classes() })).toEqual(["c", "a"]);
  });

  it("a yield never moves a run past a release-priority run", () => {
    const es = [
      entry("a", 0, { yields: [{ to: "c", at: at(5) }] }),
      entry("rel", 1, {
        priority: { for: "release", reason: "a person waits" },
      }),
      entry("c", 2),
    ];
    // rel goes first (priority); a then lets c ahead of it.
    expect(order(es)).toEqual(["rel", "c", "a"]);
    // A priority run held behind the yielder (it waited past the pass
    // limit) stays ahead of the run the yielder lets through.
    const es2 = [
      entry("y", 0, { yields: [{ to: "c", at: at(80) }] }),
      entry("rel", 70, {
        priority: { for: "release", reason: "a person waits" },
      }),
      entry("c", 71),
    ];
    expect(order(es2, {}, T0 + 90 * 60_000)).toEqual(["y", "rel", "c"]);
  });

  it("a granted slot is never pre-empted by priority, class or yield", () => {
    const es = [
      entry("held", 0, { project: "low", grantedAt: at(0) }),
      entry("rel", 1, {
        project: "top",
        priority: { for: "release", reason: "a person waits" },
      }),
    ];
    const s = { ...GATE_DEFAULTS, classes: classes() };
    expect(grants(es, s, T0 + 10 * 60_000)).toEqual([]);
    expect(assign(es, s, T0 + 10 * 60_000)).toEqual([]);
  });

  it("625's assign skips a run its window holds, and it blocks no one", () => {
    // 19:10 local, outside p2's 22:00-06:00 window; a p0 run waits.
    const c = classes("p2=22:00-06:00/30");
    const es = [
      entry("long", 0, { project: "low", estimateMin: 60, kind: "cpu" }),
      entry("top", 1, { project: "top", kind: "browser", where: "box1" }),
    ];
    const s = { ...GATE_DEFAULTS, cpuSlots: 2, classes: c };
    const box = [{ name: "box1", slots: 1, open: true }];
    const now = T0 + 10 * 60_000;
    // top takes the box; this machine is free, yet long still waits.
    expect(assign(es, s, now, box)).toEqual([{ id: "top", box: "box1" }]);
    // No higher class waits or holds: it starts at once.
    expect(assign([es[0]!], s, now, box)).toEqual([{ id: "long" }]);
  });
});

describe("714 with 625: an unclaimed slot gives its box back", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  it("passes on with no box, so a later grant picks its place afresh", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-bundle-"));
    tmps.push(dir);
    let now = T0;
    const store = new GateStore({ dir, now: () => now, alive: () => true });
    const holder = store.ask({
      kind: "browser",
      who: "w",
      label: "first",
      pid: 1,
      estimateMin: 5,
    });
    const mcp = store.ask({
      kind: "browser",
      who: "w",
      label: "agent",
      pid: 2,
      estimateMin: 5,
      agent: true,
      mcp: { install: dir },
    });
    expect(store.get(mcp.id)?.grantedAt).toBeUndefined();
    store.release(holder.id);
    const granted = store.get(mcp.id)!;
    expect(granted.mcp?.claimBy).toBeDefined();
    // A third run waits behind it.
    const next = store.ask({
      kind: "browser",
      who: "w",
      label: "next",
      pid: 3,
      estimateMin: 5,
    });
    expect(next.grantedAt).toBeUndefined();
    // As if 625 had put it on a box when it was granted while waiting.
    fs.writeFileSync(
      path.join(dir, "slots", `${mcp.id}.json`),
      JSON.stringify({ ...granted, box: "box1", boxTimeScale: 2 }),
    );
    // The claim time runs out.
    now += (GATE_DEFAULTS.claimMinutes + 1) * 60_000;
    const back = store.list().find((e) => e.id === mcp.id)!;
    expect(store.events().some((r) => r.event === "passed-unclaimed")).toBe(
      true,
    );
    expect(back.box).toBeUndefined();
    expect(back.boxTimeScale).toBeUndefined();
  });
});
