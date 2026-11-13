/**
 * The rail's prefs (R14): pins and collapse, as /api/settings stores them;
 * and (R21 Navigation, 0.3.0-dev.19) the pages hidden from the rail and
 * their order.
 */
import { describe, expect, it } from "@jest/globals";
import {
  MAX_NAV_IDS,
  MAX_PINS,
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
      pins: ["shop", "a/b"],
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
    pins: ["shop"],
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
    expect(mergeShellPrefs(cur, { pins: ["billing/api"] })).toEqual({
      ok: true,
      value: { ...cur, pins: ["billing/api"] },
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
    expect(storedShell({ pins: ["shop"], collapsed: false, ...none })).toEqual({
      pins: ["shop"],
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
