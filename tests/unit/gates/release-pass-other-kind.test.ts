import { describe, expect, it } from "@jest/globals";
import { assign } from "../../../src/shared/gates/boxes.js";
import {
  GATE_DEFAULTS,
  grants,
  passedBy,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";

const T0 = Date.parse("2026-11-25T06:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const at = (min: number) => T0 + min * 60_000;
const entry = (
  id: string,
  kind: "browser" | "cpu",
  askedMin: number,
  o: {
    granted?: number;
    release?: boolean;
    yields?: { to: string; at: string }[];
    where?: string;
  } = {},
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
  ...(o.yields ? { yields: o.yields } : {}),
  ...(o.where ? { where: o.where } : {}),
});

const OFF = { ...GATE_DEFAULTS, releasePassOtherKindMinutes: 0 };

describe("a waiting browser release run and a cpu ask made before it", () => {
  const h1 = entry("h1", "cpu", 0, { granted: 0 });
  const c0 = entry("c0", "cpu", 1);
  const rel = entry("rel", "browser", 5, { release: true });

  it("the default lets it pass: 30 minutes", () => {
    expect(GATE_DEFAULTS.releasePassOtherKindMinutes).toBe(30);
    expect(GATE_DEFAULTS.priorityPassLimitMinutes).toBe(0);
  });

  it("under the bound, the cpu ask isn't given the slot the release run needs", () => {
    expect(grants([h1, c0, rel], GATE_DEFAULTS, at(10))).toEqual([]);
    expect(assign([h1, c0, rel], GATE_DEFAULTS, at(10))).toEqual([]);
    expect(grants([c0, rel], GATE_DEFAULTS, at(12))).toEqual(["rel"]);
  });

  it("past the bound, the cpu ask is given its slot", () => {
    expect(grants([h1, c0, rel], GATE_DEFAULTS, at(40))).toEqual(["c0"]);
  });

  it("at 0, today's order: the cpu ask goes first", () => {
    expect(grants([h1, c0, rel], OFF, at(10))).toEqual(["c0"]);
    expect(passedBy([h1, c0, rel], "rel", OFF, at(10))).toEqual([]);
  });

  it("a live holder is never pre-empted, nor counted as passed", () => {
    expect(grants([h1, c0, rel], GATE_DEFAULTS, at(10))).not.toContain("rel");
    expect(passedBy([h1, c0, rel], "rel", GATE_DEFAULTS, at(10))).toEqual([
      "c0",
    ]);
  });

  it("on a free test box, it goes there and the cpu ask starts here", () => {
    const box = [{ name: "box1", slots: 1, open: true }];
    const anywhere = entry("rel", "browser", 5, {
      release: true,
      where: "any",
    });
    expect(assign([h1, c0, anywhere], GATE_DEFAULTS, at(10), box)).toEqual(
      expect.arrayContaining([{ id: "rel", box: "box1" }, { id: "c0" }]),
    );
  });

  it("a yield can't put a later cpu ask ahead of it", () => {
    const old = entry("old", "cpu", 0, {
      yields: [{ to: "late", at: iso(36) }],
    });
    const late = entry("late", "cpu", 35);
    const r = entry("rel", "browser", 30, { release: true });
    expect(grants([h1, old, r, late], GATE_DEFAULTS, at(40))).toEqual(["old"]);
  });
});

describe("a waiting cpu release run and a browser ask made before it", () => {
  const s = { ...GATE_DEFAULTS, cpuSlotsBesideBrowser: 1 };
  const h1 = entry("h1", "cpu", 0, { granted: 0 });
  const b = entry("b", "browser", 1);
  const rel = entry("rel", "cpu", 5, { release: true });

  it("under the bound, the browser ask waits and the release run starts", () => {
    expect(grants([h1, b, rel], s, at(10))).toEqual(["rel"]);
    expect(passedBy([h1, b, rel], "rel", s, at(10))).toEqual(["b"]);
  });

  it("at 0, today's order: the browser ask starts first", () => {
    expect(
      grants([h1, b, rel], { ...s, releasePassOtherKindMinutes: 0 }, at(10)),
    ).toEqual(["b"]);
  });
});

describe("the setting", () => {
  it("the server accepts release_pass_other_kind_minutes, 0 to 1440", async () => {
    const { checkGatePatch } =
      await import("../../../src/shared/gates/store.js");
    expect(
      checkGatePatch({ release_pass_other_kind_minutes: 45 }),
    ).toMatchObject({
      ok: true,
      patch: { release_pass_other_kind_minutes: 45 },
    });
    expect(checkGatePatch({ release_pass_other_kind_minutes: -1 }).ok).toBe(
      false,
    );
    expect(checkGatePatch({ release_pass_other_kind_minutes: 1441 }).ok).toBe(
      false,
    );
  });
});
