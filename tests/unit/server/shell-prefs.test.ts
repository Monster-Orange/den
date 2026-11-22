/**
 * The rail's prefs (R14): pins and collapse, as /api/settings stores them;
 * and (R21 Navigation, 0.3.0-dev.19) the pages hidden from the rail and
 * their order.
 */
import { describe, expect, it } from "@jest/globals";
import {
  MAX_NAV_IDS,
  MAX_PINS,
  applyShellSave,
  mergeShellPrefs,
  shellPrefs,
  storedShell,
} from "../../../src/ui/server/shell-prefs.js";

describe("shellPrefs", () => {
  it("defaults: no pins, not collapsed; a broken block falls back", () => {
    const none = {
      hidden: [],
      order: [],
      dock: false,
      dockHeight: 0,
      projectOrder: [],
    };
    expect(shellPrefs(undefined)).toEqual({
      pins: [],
      collapsed: false,
      ...none,
    });
    expect(
      shellPrefs({ pins: "shop", collapsed: "yes", hidden: "tests" }),
    ).toEqual({ pins: [], collapsed: false, ...none });
    expect(
      shellPrefs({
        pins: ["shop", "shop", "a/b"],
        collapsed: true,
        hidden: ["tests", "tests"],
        order: ["logs", "services"],
      }),
    ).toEqual({
      // Issue 402: an old id-only pin with no project map is none.
      pins: [
        { item: "shop", project: null },
        { item: "a/b", project: null },
      ],
      collapsed: true,
      hidden: ["tests"],
      order: ["logs", "services"],
      dock: false,
      dockHeight: 0,
      projectOrder: [],
    });
  });
  it("the runs dock (R16a): collapsed and 170px by default; a stored height outside 60–2000 falls back", () => {
    expect(shellPrefs({ dock: true, dockHeight: 320 })).toMatchObject({
      dock: true,
      dockHeight: 320,
    });
    expect(shellPrefs({ dock: "yes", dockHeight: 5 })).toMatchObject({
      dock: false,
      dockHeight: 0,
    });
  });
});

describe("mergeShellPrefs", () => {
  const cur = {
    pins: [{ item: "shop", project: "alpha" as string | null }],
    collapsed: false,
    hidden: [],
    order: [],
    dock: false,
    dockHeight: 0,
    projectOrder: [] as string[],
  };
  it("replaces pins and sets collapsed, keeping the rest", () => {
    expect(mergeShellPrefs(cur, { collapsed: true })).toEqual({
      ok: true,
      value: { ...cur, collapsed: true },
    });
    expect(
      mergeShellPrefs(cur, {
        pins: [{ item: "billing/api", project: "beta" }],
      }),
    ).toEqual({
      ok: true,
      value: { ...cur, pins: [{ item: "billing/api", project: "beta" }] },
    });
  });
  it("sets the runs dock open and its height (R16a), rounded; 0 is the default", () => {
    expect(mergeShellPrefs(cur, { dock: true, dockHeight: 240.4 })).toEqual({
      ok: true,
      value: { ...cur, dock: true, dockHeight: 240 },
    });
    expect(mergeShellPrefs(cur, { dockHeight: 0 })).toEqual({
      ok: true,
      value: cur,
    });
    for (const patch of [
      { dock: "open" },
      { dockHeight: 10 },
      { dockHeight: 5000 },
      { dockHeight: "200" },
    ])
      expect([patch, mergeShellPrefs(cur, patch).ok]).toEqual([patch, false]);
  });
  it("sets the hidden pages and their order (R21 Navigation)", () => {
    expect(
      mergeShellPrefs(cur, { hidden: ["tests"], order: ["logs", "services"] }),
    ).toEqual({
      ok: true,
      value: { ...cur, hidden: ["tests"], order: ["logs", "services"] },
    });
    expect(mergeShellPrefs(cur, { hidden: [] })).toEqual({
      ok: true,
      value: cur,
    });
  });
  it("refuses what isn't a repo or repo/service, too many pins, or an unknown key", () => {
    for (const patch of [
      { pins: ["../etc"] },
      { pins: ["a/b/c"] },
      { pins: [3] },
      { pins: Array.from({ length: MAX_PINS + 1 }, (_, i) => `r${i}`) },
      { collapsed: "true" },
      { hidden: "tests" },
      { hidden: ["Tests"] },
      { order: ["../x"] },
      { order: Array.from({ length: MAX_NAV_IDS + 1 }, (_, i) => `p${i}`) },
      { nope: [] },
      "x",
    ])
      expect([patch, mergeShellPrefs(cur, patch).ok]).toEqual([patch, false]);
  });
  it("stores nothing for the defaults", () => {
    const none = {
      hidden: [],
      order: [],
      dock: false,
      dockHeight: 0,
      projectOrder: [],
    };
    expect(
      storedShell({ pins: [], collapsed: false, ...none }),
    ).toBeUndefined();
    expect(
      storedShell({
        pins: [{ item: "shop", project: "alpha" }],
        collapsed: false,
        ...none,
      }),
    ).toEqual({
      pins: [{ item: "shop", project: "alpha" }],
    });
    expect(
      storedShell({
        pins: [],
        collapsed: false,
        hidden: ["tests"],
        order: ["logs"],
        dock: false,
        dockHeight: 0,
      }),
    ).toEqual({ hidden: ["tests"], order: ["logs"] });
    expect(
      storedShell({
        pins: [],
        collapsed: false,
        ...none,
        dock: true,
        dockHeight: 300,
      }),
    ).toEqual({ dock: true, dockHeight: 300 });
  });
});

describe("issue 394: applyShellSave keeps the newer save of each key", () => {
  it("a save stamps its keys with changedAt; the stamps are stored, not served", () => {
    const r = applyShellSave(undefined, { pins: ["a"], changedAt: 100 });
    expect(r).toEqual({
      ok: true,
      value: { pins: ["a"], changedAt: { pins: 100 } },
      ignored: [],
    });
    expect(shellPrefs(r.ok ? r.value : null).pins).toEqual(["a"]);
    expect(shellPrefs(r.ok ? r.value : null)).not.toHaveProperty("changedAt");
  });

  it("an older save of a key doesn't overwrite a newer one; other keys still apply", () => {
    const first = applyShellSave(undefined, { pins: [], changedAt: 200 });
    const stored = first.ok ? first.value : undefined;
    const late = applyShellSave(stored, {
      pins: ["a"],
      collapsed: true,
      changedAt: 100,
    });
    expect(late).toEqual({
      ok: true,
      value: { collapsed: true, changedAt: { pins: 200, collapsed: 100 } },
      ignored: ["pins"],
    });
  });

  it("the same save twice (the fetch and the beacon) is stored once, the same", () => {
    const a = applyShellSave(undefined, { pins: ["a"], changedAt: 300 });
    const b = applyShellSave(a.ok ? a.value : undefined, {
      pins: ["a"],
      changedAt: 300,
    });
    expect(b.ok && b.value).toEqual(a.ok && a.value);
  });

  it("a newer save wins; a key cleared to its default keeps its stamp", () => {
    const a = applyShellSave(undefined, { pins: ["a"], changedAt: 100 });
    const b = applyShellSave(a.ok ? a.value : undefined, {
      pins: [],
      changedAt: 200,
    });
    expect(b.ok && b.value).toEqual({ changedAt: { pins: 200 } });
    const c = applyShellSave(b.ok ? b.value : undefined, {
      pins: ["a"],
      changedAt: 150,
    });
    expect(c.ok && c.value).toEqual({ changedAt: { pins: 200 } });
  });

  it("a save with no changedAt (an older page) applies and clears that key's stamp", () => {
    const a = applyShellSave(undefined, { pins: ["a"], changedAt: 100 });
    const b = applyShellSave(a.ok ? a.value : undefined, { pins: ["b"] });
    expect(b.ok && b.value).toEqual({ pins: ["b"] });
  });

  it("a bad changedAt or a bad field is refused", () => {
    for (const changedAt of ["1", -1, Number.NaN, null, {}])
      expect(applyShellSave(undefined, { pins: [], changedAt }).ok).toBe(false);
    expect(applyShellSave(undefined, { pins: "x", changedAt: 1 }).ok).toBe(
      false,
    );
    expect(applyShellSave(undefined, { nope: 1, changedAt: 1 }).ok).toBe(false);
    expect(applyShellSave(undefined, "x").ok).toBe(false);
  });

  it("a hand-broken stamp block is ignored", () => {
    const r = applyShellSave(
      { pins: ["a"], changedAt: { pins: "soon", order: 5 } },
      { pins: ["b"], changedAt: 1 },
    );
    expect(r.ok && r.value).toEqual({
      pins: ["b"],
      changedAt: { pins: 1, order: 5 },
    });
  });
});

describe("issue 394 review: inherited names and far-future stamps", () => {
  it("an inherited name (constructor, toString, __proto__) is not a key, even set to null", () => {
    for (const k of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
    ]) {
      const patch = JSON.parse(`{"${k}":null,"changedAt":1}`);
      expect(applyShellSave(undefined, patch).ok).toBe(false);
      expect(
        mergeShellPrefs(shellPrefs(undefined), JSON.parse(`{"${k}":null}`)).ok,
      ).toBe(false);
    }
  });

  it("a stored stamp under an inherited name is dropped", () => {
    const r = applyShellSave(
      { pins: ["a"], changedAt: JSON.parse('{"constructor":5,"toString":6}') },
      { pins: ["b"], changedAt: 1 },
    );
    expect(r.ok && r.value).toEqual({ pins: ["b"], changedAt: { pins: 1 } });
  });

  it("a changedAt later than now plus the allowance is stored as now; the next real save wins", () => {
    const now = 1_000_000;
    const at = { now, skewMs: 300_000 };
    const far = applyShellSave(
      undefined,
      { collapsed: true, changedAt: 8.64e15 },
      at,
    );
    expect(far.ok && far.value).toEqual({
      collapsed: true,
      changedAt: { collapsed: now },
    });
    const next = applyShellSave(
      far.ok ? far.value : undefined,
      { collapsed: false, changedAt: now + 1 },
      { now: now + 1, skewMs: 300_000 },
    );
    expect(next.ok && next.ignored).toEqual([]);
    expect(next.ok && next.value).toEqual({
      changedAt: { collapsed: now + 1 },
    });
  });

  it("within the allowance a changedAt is kept as given (a clock a little ahead)", () => {
    const r = applyShellSave(
      undefined,
      { pins: ["a"], changedAt: 1_000_000 + 299_000 },
      { now: 1_000_000, skewMs: 300_000 },
    );
    expect(r.ok && r.value).toEqual({
      pins: ["a"],
      changedAt: { pins: 1_299_000 },
    });
  });

  it("a far-future stamp already stored counts as now, so a real save still wins", () => {
    const r = applyShellSave(
      { collapsed: true, changedAt: { collapsed: 8.64e15 } },
      { collapsed: false, changedAt: 2_000_000 },
      { now: 2_000_000, skewMs: 300_000 },
    );
    expect(r.ok && r.ignored).toEqual([]);
    expect(r.ok && r.value).toEqual({ changedAt: { collapsed: 2_000_000 } });
  });
});
