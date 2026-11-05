/**
 * Graph preferences: the `graph` block of /api/settings (direction, grouping,
 * card density, panel width), stored in the user config.
 */
import { describe, expect, it } from "@jest/globals";
import {
  GRAPH_DEFAULTS,
  graphPrefs,
  mergeGraphPrefs,
} from "../../../src/ui/server/graph-prefs.js";

describe("graphPrefs (what GET returns)", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(graphPrefs(undefined)).toEqual(GRAPH_DEFAULTS);
    expect(GRAPH_DEFAULTS).toEqual({
      direction: "down",
      group: "org",
      density: "detailed",
      panelWidth: 440,
      workspaces: "open",
    });
  });

  it("keeps valid stored fields and defaults the rest", () => {
    expect(graphPrefs({ direction: "right", panelWidth: 500 })).toEqual({
      ...GRAPH_DEFAULTS,
      direction: "right",
      panelWidth: 500,
    });
  });

  it("ignores a hand-edited value it does not know", () => {
    expect(
      graphPrefs({ direction: "sideways", density: 3, panelWidth: 99999 }),
    ).toEqual(GRAPH_DEFAULTS);
  });
});

describe("Local Dev's workspace list (R23, Ward QA 2026-11-05)", () => {
  it("open or collapsed; anything else is refused, a stored oddity is open", () => {
    expect(
      mergeGraphPrefs(GRAPH_DEFAULTS, { workspaces: "collapsed" }),
    ).toEqual({
      ok: true,
      value: { ...GRAPH_DEFAULTS, workspaces: "collapsed" },
    });
    expect(mergeGraphPrefs(GRAPH_DEFAULTS, { workspaces: "hidden" }).ok).toBe(
      false,
    );
    expect(graphPrefs({ workspaces: 40 }).workspaces).toBe("open");
  });
});

describe("mergeGraphPrefs (what POST accepts)", () => {
  it("merges a partial patch over the current prefs", () => {
    expect(
      mergeGraphPrefs(GRAPH_DEFAULTS, { group: "app", density: "compact" }),
    ).toEqual({
      ok: true,
      value: { ...GRAPH_DEFAULTS, group: "app", density: "compact" },
    });
  });

  it("rounds the panel width and rejects one outside 360–760", () => {
    expect(mergeGraphPrefs(GRAPH_DEFAULTS, { panelWidth: 512.6 })).toEqual({
      ok: true,
      value: { ...GRAPH_DEFAULTS, panelWidth: 513 },
    });
    expect(mergeGraphPrefs(GRAPH_DEFAULTS, { panelWidth: 200 })).toEqual({
      ok: false,
      error: "graph.panelWidth must be a number from 360 to 760",
    });
  });

  it("rejects an unknown value or key, naming it", () => {
    expect(mergeGraphPrefs(GRAPH_DEFAULTS, { direction: "up" })).toEqual({
      ok: false,
      error: 'graph.direction must be one of "down", "right"',
    });
    expect(mergeGraphPrefs(GRAPH_DEFAULTS, { zoom: 2 })).toEqual({
      ok: false,
      error: 'unknown graph setting "zoom"',
    });
  });

  it("rejects a graph block that is not an object", () => {
    expect(mergeGraphPrefs(GRAPH_DEFAULTS, "down")).toEqual({
      ok: false,
      error: "graph must be an object",
    });
    expect(mergeGraphPrefs(GRAPH_DEFAULTS, [1])).toEqual({
      ok: false,
      error: "graph must be an object",
    });
  });
});
