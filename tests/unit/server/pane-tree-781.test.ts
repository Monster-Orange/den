/**
 * Issue 781, slice 1: the split-tree model behind free pane layouts
 * (public/pane-tree.js). Pure: no DOM, no fetch.
 *
 * A tree is { split: "row" | "col", at, a, b } or { pane: key | null }.
 * "row" puts a and b side by side, "col" one above the other; `at` is a's
 * share. A pane names an agent (or shell) by key; null is an empty pane.
 *
 *  1. Split any pane left/right or top/bottom; drag a divider (clamped);
 *     close a pane, and its neighbour takes the space.
 *  2. Focus, Tabs and Tile 2x2 stay as presets, and the old per-install
 *     agents_layout maps to one.
 *  3. A saved tree is checked; an agent this Den doesn't have stays in the
 *     tree as a missing pane, never dropped.
 *  4. Keyboard: the pane to the left, right, above or below.
 */
import { describe, expect, it } from "@jest/globals";
import {
  checkLayout,
  checkTree,
  closePane,
  fromLegacy,
  keysOf,
  leaf,
  missingPanes,
  neighbour,
  panesOf,
  presetTree,
  rectsOf,
  setShare,
  splitPane,
} from "../../../src/ui/server/public/pane-tree.js";

const row = (a: unknown, b: unknown, at = 0.5) => ({ split: "row", at, a, b });
const col = (a: unknown, b: unknown, at = 0.5) => ({ split: "col", at, a, b });

describe("issue 781 (1): split, drag, close", () => {
  it("splits a pane to the right: the old pane keeps the left half", () => {
    expect(splitPane(leaf("scout"), [], "right", "keeper")).toEqual(
      row(leaf("scout"), leaf("keeper")),
    );
  });

  it("splits left, down and up too", () => {
    expect(splitPane(leaf("s"), [], "left", "k")).toEqual(
      row(leaf("k"), leaf("s")),
    );
    expect(splitPane(leaf("s"), [], "down", "k")).toEqual(
      col(leaf("s"), leaf("k")),
    );
    expect(splitPane(leaf("s"), [], "up", null)).toEqual(
      col(leaf(null), leaf("s")),
    );
  });

  it("splits a pane deep in the tree, by its path", () => {
    const t = row(leaf("a"), col(leaf("b"), leaf("c")));
    expect(splitPane(t, ["b", "b"], "right", "d")).toEqual(
      row(leaf("a"), col(leaf("b"), row(leaf("c"), leaf("d")))),
    );
  });

  it("never changes the tree it was given", () => {
    const t = row(leaf("a"), leaf("b"));
    const copy = JSON.parse(JSON.stringify(t));
    splitPane(t, ["a"], "down", "c");
    closePane(t, ["b"]);
    setShare(t, [], 0.3);
    expect(t).toEqual(copy);
  });

  it("refuses a path that isn't a pane", () => {
    const t = row(leaf("a"), leaf("b"));
    expect(() => splitPane(t, [], "right", "c")).toThrow(/not a pane/);
    expect(() => splitPane(t, ["a", "a"], "right", "c")).toThrow(/not a pane/);
    expect(() => closePane(t, ["x" as "a"])).toThrow(/not a pane/);
  });

  it("refuses a split past the pane limit", () => {
    // Each split is of the last pane (after the first, the top is a split).
    const last = (x: ReturnType<typeof leaf>) => panesOf(x).at(-1)!.path;
    let t = leaf("p0");
    for (let i = 1; i < 4; i++)
      t = splitPane(t, last(t), "right", `p${i}`, { maxPanes: 4 });
    expect(panesOf(t)).toHaveLength(4);
    expect(() => splitPane(t, last(t), "right", "p4", { maxPanes: 4 })).toThrow(
      /at most 4 panes/,
    );
  });

  it("closing a pane gives its neighbour the space", () => {
    const t = row(leaf("a"), col(leaf("b"), leaf("c"), 0.3), 0.4);
    expect(closePane(t, ["b", "a"])).toEqual(row(leaf("a"), leaf("c"), 0.4));
    expect(closePane(t, ["a"])).toEqual(col(leaf("b"), leaf("c"), 0.3));
  });

  it("closing the last pane leaves one empty pane", () => {
    expect(closePane(leaf("a"), [])).toEqual(leaf(null));
  });

  it("a divider moves, held so neither side is under the minimum", () => {
    const t = row(leaf("a"), leaf("b"));
    expect(setShare(t, [], 0.3)).toEqual(row(leaf("a"), leaf("b"), 0.3));
    expect(setShare(t, [], 0.01, { min: 0.1 })).toEqual(
      row(leaf("a"), leaf("b"), 0.1),
    );
    expect(setShare(t, [], 0.99, { min: 0.1 })).toEqual(
      row(leaf("a"), leaf("b"), 0.9),
    );
    expect(() => setShare(t, ["a"], 0.5)).toThrow(/not a split/);
  });

  it("lists panes in reading order, with their paths", () => {
    const t = row(leaf("a"), col(leaf(null), leaf("c")));
    expect(panesOf(t)).toEqual([
      { path: ["a"], key: "a" },
      { path: ["b", "a"], key: null },
      { path: ["b", "b"], key: "c" },
    ]);
    expect(keysOf(t)).toEqual(["a", "c"]);
  });
});

describe("issue 781 (2): presets and the old setting", () => {
  it("Focus and Tabs are one pane: the one in front", () => {
    expect(presetTree("focus", ["a", "b"], "b")).toEqual(leaf("b"));
    expect(presetTree("tabs", ["a", "b"], "a")).toEqual(leaf("a"));
    expect(presetTree("focus", [], null)).toEqual(leaf(null));
  });

  it("Tile is today's grid: 1, 2 side by side, 3 and 4 as 2x2", () => {
    expect(presetTree("tile", ["a"])).toEqual(leaf("a"));
    expect(presetTree("tile", ["a", "b"])).toEqual(row(leaf("a"), leaf("b")));
    expect(presetTree("tile", ["a", "b", "c"])).toEqual(
      col(row(leaf("a"), leaf("b")), row(leaf("c"), leaf(null))),
    );
    expect(presetTree("tile", ["a", "b", "c", "d"])).toEqual(
      col(row(leaf("a"), leaf("b")), row(leaf("c"), leaf("d"))),
    );
  });

  it("an unknown preset throws", () => {
    expect(() => presetTree("grid" as "tile", ["a"])).toThrow(/preset/);
  });

  it("the old agents_layout becomes the page's preset", () => {
    expect(fromLegacy("tile")).toEqual({ preset: "tile" });
    expect(fromLegacy("tabs")).toEqual({ preset: "tabs" });
    expect(fromLegacy(undefined)).toEqual({ preset: "focus" });
    expect(fromLegacy("nonsense")).toEqual({ preset: "focus" });
  });
});

describe("issue 781 (3): a saved tree is checked; missing agents stay", () => {
  it("a good tree passes", () => {
    expect(checkTree(row(leaf("a"), col(leaf(null), leaf("c"))))).toBeNull();
  });

  it("a bad tree says why", () => {
    expect(checkTree(null)).toMatch(/not a pane or a split/);
    expect(
      checkTree({ split: "diag", at: 0.5, a: leaf("a"), b: leaf("b") }),
    ).toMatch(/row or col/);
    expect(checkTree(row(leaf("a"), leaf("b"), 1.5))).toMatch(
      /between 0 and 1/,
    );
    expect(checkTree({ pane: 7 })).toMatch(/key or null/);
    expect(checkTree({ pane: "x".repeat(300) })).toMatch(/too long/);
    expect(checkTree(row(leaf("a"), leaf("a")))).toMatch(/twice/);
  });

  it("a tree too deep or with too many panes is refused", () => {
    let t: unknown = leaf("p0");
    for (let i = 1; i <= 20; i++) t = row(t, leaf(`p${i}`));
    expect(checkTree(t, { maxPanes: 16 })).toMatch(/at most 16 panes/);
    let deep: unknown = leaf("d");
    for (let i = 0; i < 40; i++) deep = row(deep, leaf(null));
    expect(checkTree(deep, { maxPanes: 100 })).toMatch(/deeper than/);
  });

  it("the account's layout value: v 1 and a tree or preset per page", () => {
    expect(
      checkLayout({
        v: 1,
        pages: {
          agents: { preset: "tile" },
          terminals: { tree: row(leaf("sh1"), leaf("sh2")) },
        },
      }),
    ).toBeNull();
    expect(checkLayout({ v: 2, pages: {} })).toMatch(/v 1/);
    expect(checkLayout({ v: 1, pages: { other: { preset: "tile" } } })).toMatch(
      /agents or terminals/,
    );
    expect(checkLayout({ v: 1, pages: { agents: {} } })).toMatch(
      /preset or a tree/,
    );
    expect(
      checkLayout({ v: 1, pages: { agents: { preset: "grid" } } }),
    ).toMatch(/preset/);
  });

  it("panes for agents this Den doesn't have are listed, and kept in the tree", () => {
    const t = row(leaf("here"), col(leaf("elsewhere"), leaf(null)));
    expect(missingPanes(t, new Set(["here"]))).toEqual([
      { path: ["b", "a"], key: "elsewhere" },
    ]);
    // Nothing is dropped: the tree still names it.
    expect(keysOf(t)).toContain("elsewhere");
  });
});

describe("issue 781 (4): the pane in a direction", () => {
  // a | b
  // --+--
  // a | c      (a spans the left half; b over c on the right)
  const t = row(leaf("a"), col(leaf("b"), leaf("c")));

  it("lays panes out as shares of the box", () => {
    expect(rectsOf(t)).toEqual([
      { path: ["a"], key: "a", x: 0, y: 0, w: 0.5, h: 1 },
      { path: ["b", "a"], key: "b", x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { path: ["b", "b"], key: "c", x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ]);
  });

  it("moves right, left, up and down to the pane that touches", () => {
    expect(neighbour(t, ["a"], "right")).toEqual(["b", "a"]);
    expect(neighbour(t, ["b", "b"], "left")).toEqual(["a"]);
    expect(neighbour(t, ["b", "b"], "up")).toEqual(["b", "a"]);
    expect(neighbour(t, ["b", "a"], "down")).toEqual(["b", "b"]);
  });

  it("at an edge there is no pane that way", () => {
    expect(neighbour(t, ["a"], "left")).toBeNull();
    expect(neighbour(t, ["b", "a"], "up")).toBeNull();
  });

  it("prefers the pane that overlaps most", () => {
    // left: x over y (at 0.8); right: one pane z.
    const u = row(col(leaf("x"), leaf("y"), 0.8), leaf("z"));
    expect(neighbour(u, ["b"], "left")).toEqual(["a", "a"]);
  });
});
