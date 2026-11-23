/**
 * Issue 781: the split-tree model behind free pane layouts on the Agents
 * and Terminals pages. Pure: no DOM, no fetch. Every function returns a
 * new tree and never changes the one it was given.
 *
 * A tree is a pane or a split:
 *   { pane: key | null }               an agent's (or shell's) key; null is
 *                                      an empty pane
 *   { split: "row" | "col", at, a, b } "row": a and b side by side, a on
 *                                      the left; "col": a above b. `at` is
 *                                      a's share of the box (0 to 1).
 * A pane is found by its path: the "a"/"b" steps from the top.
 *
 * Focus, Tabs and Tile 2x2 stay as presets (presetTree). An agent this
 * Den doesn't have stays in the tree (missingPanes lists it); the page
 * draws it as an empty pane and never drops it, so the layout still holds
 * it on a Den that has it.
 *
 * The account's layout value (issue 784's "layout" area, checkLayout):
 *   { v: 1, pages: { agents?: Page, terminals?: Page } }
 *   Page: { preset: "focus" | "tabs" | "tile" } or { tree } (or both: the
 *   preset it started from, and the tree as it is now).
 */

/** The presets, as today's layout switch names them (AG-4b). */
export const PRESETS = Object.freeze(["focus", "tabs", "tile"]);
/** The pages a layout is kept for. */
export const LAYOUT_PAGES = Object.freeze(["agents", "terminals"]);
/** Panes in one tree, unless the caller says otherwise (a Setting in the page). */
export const DEFAULT_MAX_PANES = 16;
/** Splits deep: past this a tree is refused as damaged. */
export const MAX_DEPTH = 24;
/** A key's length limit (agent and shell keys are far shorter). */
const MAX_KEY = 200;

/** A pane naming `key` (null: an empty pane). */
export const leaf = (key) => ({ pane: key ?? null });

const isPane = (t) => !!t && typeof t === "object" && "pane" in t;
const isSplit = (t) => !!t && typeof t === "object" && "split" in t;

/** The node at `path`, or undefined. */
function nodeAt(t, path) {
  let n = t;
  for (const step of path) {
    if (!isSplit(n) || (step !== "a" && step !== "b")) return undefined;
    n = n[step];
  }
  return n;
}

/** `t` with the node at `path` replaced by `fn(node)`. */
function replaceAt(t, path, fn) {
  if (!path.length) return fn(t);
  const [step, ...rest] = path;
  return { ...t, [step]: replaceAt(t[step], rest, fn) };
}

function panePath(t, path) {
  if (!Array.isArray(path) || !isPane(nodeAt(t, path)))
    throw new Error(`pane-tree: ${JSON.stringify(path)} is not a pane`);
}

/** Every pane in reading order (left to right, top to bottom), with its path. */
export function panesOf(t, path = []) {
  if (isPane(t)) return [{ path, key: t.pane }];
  return [...panesOf(t.a, [...path, "a"]), ...panesOf(t.b, [...path, "b"])];
}

/** The keys the tree names, in reading order (empty panes left out). */
export function keysOf(t) {
  return panesOf(t)
    .map((p) => p.key)
    .filter((k) => k !== null);
}

/**
 * Splits the pane at `path`: `side` is where the new pane goes (right,
 * left, down, up), and the old pane keeps the other half.
 */
export function splitPane(t, path, side, key, opts = {}) {
  panePath(t, path);
  const max = opts.maxPanes ?? DEFAULT_MAX_PANES;
  if (panesOf(t).length >= max)
    throw new Error(`pane-tree: at most ${max} panes`);
  const dir = { right: "row", left: "row", down: "col", up: "col" }[side];
  if (!dir) throw new Error(`pane-tree: no side ${side}`);
  const fresh = leaf(key);
  const first = side === "left" || side === "up";
  return replaceAt(t, path, (old) => ({
    split: dir,
    at: 0.5,
    a: first ? fresh : old,
    b: first ? old : fresh,
  }));
}

/**
 * Closes the pane at `path`: its neighbour (the other side of its split)
 * takes the space. The last pane leaves one empty pane.
 */
export function closePane(t, path) {
  panePath(t, path);
  if (!path.length) return leaf(null);
  const parent = path.slice(0, -1);
  const other = path.at(-1) === "a" ? "b" : "a";
  return replaceAt(t, parent, (s) => s[other]);
}

/**
 * Moves the divider of the split at `path` to `at`, held so neither side
 * is under `min` (a share; the page turns its pixel minimum into one).
 */
export function setShare(t, path, at, opts = {}) {
  if (!isSplit(nodeAt(t, path)))
    throw new Error(`pane-tree: ${JSON.stringify(path)} is not a split`);
  const min = Math.min(0.5, Math.max(0, opts.min ?? 0.05));
  const n = Number(at);
  const held = Math.min(1 - min, Math.max(min, Number.isFinite(n) ? n : 0.5));
  return replaceAt(t, path, (s) => ({ ...s, at: held }));
}

/**
 * The presets as trees: Focus and Tabs are one pane, the one in front;
 * Tile is today's grid (1; 2 side by side; 3 or 4 as 2x2).
 *
 * @param {string} name a preset: focus, tabs or tile
 * @param {(string | null)[]} keys the open panes, in order
 * @param {string | null} [front] the pane in front (Focus, Tabs)
 */
export function presetTree(name, keys, front = null) {
  if (!PRESETS.includes(name))
    throw new Error(`pane-tree: no preset ${String(name)}`);
  if (name !== "tile") return leaf(front ?? keys.at(-1) ?? null);
  const k = keys.slice(0, 4);
  if (k.length <= 1) return leaf(k[0] ?? null);
  const pair = (x, y) => ({ split: "row", at: 0.5, a: leaf(x), b: leaf(y) });
  if (k.length === 2) return pair(k[0], k[1]);
  return { split: "col", at: 0.5, a: pair(k[0], k[1]), b: pair(k[2], k[3]) };
}

/** The old per-install agents_layout, as a page's starting value. */
export function fromLegacy(layout) {
  return { preset: PRESETS.includes(layout) ? layout : "focus" };
}

/** Why `t` isn't a tree this page can draw, or null when it is. */
export function checkTree(t, opts = {}) {
  const max = opts.maxPanes ?? DEFAULT_MAX_PANES;
  const seen = new Set();
  let count = 0;
  const walk = (n, depth) => {
    if (depth > MAX_DEPTH) return `a layout is never deeper than ${MAX_DEPTH}`;
    if (isPane(n)) {
      count++;
      const k = n.pane;
      if (k !== null && typeof k !== "string")
        return "a pane names a key or null";
      if (typeof k === "string") {
        if (!k || k.length > MAX_KEY)
          return "a pane's key is empty or too long";
        if (seen.has(k)) return `${k} is in the layout twice`;
        seen.add(k);
      }
      return null;
    }
    if (!isSplit(n)) return "a node is not a pane or a split";
    if (n.split !== "row" && n.split !== "col") return "a split is row or col";
    if (typeof n.at !== "number" || !(n.at > 0 && n.at < 1))
      return "a split's share is between 0 and 1";
    return walk(n.a, depth + 1) ?? walk(n.b, depth + 1);
  };
  const why = walk(t, 0);
  if (why) return why;
  return count > max ? `a layout has at most ${max} panes` : null;
}

/** Why `v` isn't the account's layout value, or null when it is. */
export function checkLayout(v, opts = {}) {
  if (!v || typeof v !== "object" || v.v !== 1)
    return "the layout value is v 1";
  if (!v.pages || typeof v.pages !== "object" || Array.isArray(v.pages))
    return "the layout value has pages";
  for (const [page, p] of Object.entries(v.pages)) {
    if (!LAYOUT_PAGES.includes(page))
      return `a page is agents or terminals, not ${page}`;
    if (!p || typeof p !== "object" || (!("preset" in p) && !("tree" in p)))
      return `${page} has a preset or a tree`;
    if ("preset" in p && !PRESETS.includes(p.preset))
      return `${page}'s preset is focus, tabs or tile`;
    if ("tree" in p) {
      const why = checkTree(p.tree, opts);
      if (why) return `${page}: ${why}`;
    }
  }
  return null;
}

/** The panes naming a key this Den doesn't have (`known`: a Set of keys). */
export function missingPanes(t, known) {
  return panesOf(t).filter((p) => p.key !== null && !known.has(p.key));
}

/** Each pane's box, as shares of the whole (x, y, w, h from 0 to 1). */
export function rectsOf(t, box = { x: 0, y: 0, w: 1, h: 1 }, path = []) {
  if (isPane(t)) return [{ path, key: t.pane, ...box }];
  const { x, y, w, h } = box;
  const [ba, bb] =
    t.split === "row"
      ? [
          { x, y, w: w * t.at, h },
          { x: x + w * t.at, y, w: w * (1 - t.at), h },
        ]
      : [
          { x, y, w, h: h * t.at },
          { x, y: y + h * t.at, w, h: h * (1 - t.at) },
        ];
  return [
    ...rectsOf(t.a, ba, [...path, "a"]),
    ...rectsOf(t.b, bb, [...path, "b"]),
  ];
}

const EPS = 1e-9;
const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

/**
 * The path of the pane next to `path` in `dir` (left, right, up, down):
 * one whose edge touches it and overlaps it most; null at the edge.
 */
export function neighbour(t, path, dir) {
  const rects = rectsOf(t);
  const me = rects.find((r) => r.path.join() === path.join());
  if (!me) return null;
  let best = null;
  let bestOverlap = EPS;
  for (const r of rects) {
    if (r === me) continue;
    let touches;
    let o;
    if (dir === "right" || dir === "left") {
      touches =
        dir === "right"
          ? Math.abs(r.x - (me.x + me.w)) < EPS
          : Math.abs(r.x + r.w - me.x) < EPS;
      o = overlap(me.y, me.y + me.h, r.y, r.y + r.h);
    } else {
      touches =
        dir === "down"
          ? Math.abs(r.y - (me.y + me.h)) < EPS
          : Math.abs(r.y + r.h - me.y) < EPS;
      o = overlap(me.x, me.x + me.w, r.x, r.x + r.w);
    }
    if (touches && o > bestOverlap) {
      best = r;
      bestOverlap = o;
    }
  }
  return best ? best.path : null;
}
