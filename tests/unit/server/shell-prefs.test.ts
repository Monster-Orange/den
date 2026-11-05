/**
 * The rail's prefs (R14): pins and collapse, as /api/settings stores them.
 */
import { describe, expect, it } from "@jest/globals";
import {
  MAX_PINS,
  mergeShellPrefs,
  shellPrefs,
  storedShell,
} from "../../../src/ui/server/shell-prefs.js";

describe("shellPrefs", () => {
  it("defaults: no pins, not collapsed; a broken block falls back", () => {
    expect(shellPrefs(undefined)).toEqual({ pins: [], collapsed: false });
    expect(shellPrefs({ pins: "shop", collapsed: "yes" })).toEqual({
      pins: [],
      collapsed: false,
    });
    expect(
      shellPrefs({ pins: ["shop", "shop", "a/b"], collapsed: true }),
    ).toEqual({
      pins: ["shop", "a/b"],
      collapsed: true,
    });
  });
});

describe("mergeShellPrefs", () => {
  const cur = { pins: ["shop"], collapsed: false };
  it("replaces pins and sets collapsed, keeping the rest", () => {
    expect(mergeShellPrefs(cur, { collapsed: true })).toEqual({
      ok: true,
      value: { pins: ["shop"], collapsed: true },
    });
    expect(mergeShellPrefs(cur, { pins: ["billing/api"] })).toEqual({
      ok: true,
      value: { pins: ["billing/api"], collapsed: false },
    });
  });
  it("refuses what isn't a repo or repo/service, too many pins, or an unknown key", () => {
    for (const patch of [
      { pins: ["../etc"] },
      { pins: ["a/b/c"] },
      { pins: [3] },
      { pins: Array.from({ length: MAX_PINS + 1 }, (_, i) => `r${i}`) },
      { collapsed: "true" },
      { hidden: [] },
      "x",
    ])
      expect([patch, mergeShellPrefs(cur, patch).ok]).toEqual([patch, false]);
  });
  it("stores nothing for the defaults", () => {
    expect(storedShell({ pins: [], collapsed: false })).toBeUndefined();
    expect(storedShell({ pins: ["shop"], collapsed: false })).toEqual({
      pins: ["shop"],
    });
  });
});
