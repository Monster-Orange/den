/**
 * Issue 751 follow-up: cpu runs beside a release-priority browser run
 * slowed a release's own checks (requests over 1 s went from 13 to 134).
 * While a release browser run holds this machine, at most
 * `cpu_slots_beside_release_browser` cpu runs (default 0) run beside it;
 * a waiting release browser run lets the cpu runs drain to that count.
 * Plain browser runs keep `cpu_slots_beside_browser`.
 *
 * Pure rules: no store, no Den, no suite runs.
 */
import { describe, expect, it } from "@jest/globals";
import { assign } from "../../../src/shared/gates/boxes.js";
import {
  GATE_DEFAULTS,
  grants,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";

const T0 = Date.parse("2026-11-20T06:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const at = (min: number) => T0 + min * 60_000;
const entry = (
  id: string,
  kind: "browser" | "cpu",
  askedMin: number,
  o: { granted?: number; release?: boolean; box?: string } = {},
): GateEntry => ({
  id,
  kind,
  who: id,
  label: id,
  pid: 1,
  askedAt: iso(askedMin),
  estimateMin: 10,
  ...(o.granted !== undefined ? { grantedAt: iso(o.granted) } : {}),
  ...(o.release ? { priority: { for: "release" as const, reason: "r" } } : {}),
  ...(o.box ? { box: o.box } : {}),
});

describe("a release browser run holds this machine", () => {
  const holding = [
    entry("rel", "browser", 0, { granted: 0, release: true }),
    entry("c1", "cpu", 1),
  ];

  it("a cpu ask waits (default 0 beside it)", () => {
    expect(grants(holding, GATE_DEFAULTS, at(2))).toEqual([]);
    expect(assign(holding, GATE_DEFAULTS, at(2))).toEqual([]);
  });

  it("the setting lets cpu runs beside it", () => {
    const s = { ...GATE_DEFAULTS, cpuSlotsBesideReleaseBrowser: 1 };
    expect(grants(holding, s, at(2))).toEqual(["c1"]);
  });

  it("a plain browser run still lets cpu_slots_beside_browser beside it", () => {
    const plain = [
      entry("b", "browser", 0, { granted: 0 }),
      entry("c1", "cpu", 1),
    ];
    expect(grants(plain, GATE_DEFAULTS, at(2))).toEqual(["c1"]);
  });

  it("one on a test box doesn't hold this machine", () => {
    const boxed = [
      entry("rel", "browser", 0, { granted: 0, release: true, box: "mini" }),
      entry("c1", "cpu", 1),
    ];
    expect(grants(boxed, GATE_DEFAULTS, at(2))).toEqual(["c1"]);
  });
});

describe("a release browser run waits", () => {
  it("cpu runs drain to 0 before it starts, and none start meanwhile", () => {
    const q = [
      entry("c0", "cpu", 0, { granted: 0 }),
      entry("rel", "browser", 1, { release: true }),
      entry("c1", "cpu", 2),
    ];
    expect(grants(q, GATE_DEFAULTS, at(3))).toEqual([]);
    expect(assign(q, GATE_DEFAULTS, at(3))).toEqual([]);
    const drained = q.filter((e) => e.id !== "c0");
    expect(grants(drained, GATE_DEFAULTS, at(4))).toEqual(["rel"]);
  });

  it("a plain browser run starts beside cpu runs, as before", () => {
    const q = [entry("c0", "cpu", 0, { granted: 0 }), entry("b", "browser", 1)];
    expect(grants(q, GATE_DEFAULTS, at(3))).toEqual(["b"]);
  });
});

describe("the setting", () => {
  it("the server accepts cpu_slots_beside_release_browser, 0 to 64 whole", async () => {
    const { checkGatePatch } =
      await import("../../../src/shared/gates/store.js");
    expect(
      checkGatePatch({ cpu_slots_beside_release_browser: 1 }),
    ).toMatchObject({
      ok: true,
      patch: { cpu_slots_beside_release_browser: 1 },
    });
    expect(checkGatePatch({ cpu_slots_beside_release_browser: -1 }).ok).toBe(
      false,
    );
    expect(GATE_DEFAULTS.cpuSlotsBesideReleaseBrowser).toBe(0);
  });
});
