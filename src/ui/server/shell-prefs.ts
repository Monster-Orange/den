/**
 * Shell preferences (0.3.0-dev.17): what this engineer pinned to the rail
 * and whether the rail is collapsed; since 0.3.0-dev.19 (R21 Navigation)
 * also the rail pages they hid and the order they put them in. Stored in the user config as `shell:`
 * and served by /api/settings, like `graph:` and `appearance:`. A view
 * preference only: pinning changes no edge route, container or service.
 * The shell mirrors it to localStorage so the first paint does not wait on
 * the server.
 */

export interface ShellPrefs {
  /** Pinned repos or services (`repo` or `repo/service`), in pin order. */
  pins: string[];
  /** The rail shows icons only. */
  collapsed: boolean;
  /** NAV page ids the rail leaves out (Settings is never one). */
  hidden: string[];
  /** NAV page ids in the engineer's order; pages not listed keep theirs. */
  order: string[];
  /**
   * The runs dock is open (R16a, 0.3.0-dev.30, Ward QA 2026-11-05): it
   * starts collapsed to its bar; opening it is the engineer's choice and
   * remembered, never forced by a run starting.
   */
  dock: boolean;
  /** The open dock's output height in px; 0 is the default (170px). */
  dockHeight: number;
}

export const SHELL_DEFAULTS: ShellPrefs = {
  pins: [],
  collapsed: false,
  hidden: [],
  order: [],
  dock: false,
  dockHeight: 0,
};

/** The dock height's bounds (the page also caps it at half the window). */
export const DOCK_MIN = 60;
export const DOCK_MAX = 2000;

function checkDockHeight(
  v: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof v !== "number" || !Number.isFinite(v))
    return { ok: false, error: dockHeightError() };
  const h = Math.round(v);
  if (h !== 0 && (h < DOCK_MIN || h > DOCK_MAX))
    return { ok: false, error: dockHeightError() };
  return { ok: true, value: h };
}
function dockHeightError(): string {
  return `shell.dockHeight must be 0 (the default) or a number from ${DOCK_MIN} to ${DOCK_MAX}`;
}

/** How many page ids `hidden` and `order` keep. */
export const MAX_NAV_IDS = 64;
/** A NAV id, as shell.js's registerNav takes it. */
const NAV_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** How many pins the rail keeps. */
export const MAX_PINS = 24;
const PIN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkPins(
  v: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(v))
    return { ok: false, error: "shell.pins must be a list" };
  const out: string[] = [];
  for (const p of v) {
    if (typeof p !== "string" || !PIN.test(p))
      return {
        ok: false,
        error: `shell.pins: "${String(p)}" is not a repo or repo/service name`,
      };
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_PINS)
    return { ok: false, error: `shell.pins: at most ${MAX_PINS}` };
  return { ok: true, value: out };
}

function checkNavIds(
  key: "hidden" | "order",
  v: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(v))
    return { ok: false, error: `shell.${key} must be a list` };
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== "string" || !NAV_ID.test(id))
      return {
        ok: false,
        error: `shell.${key}: "${String(id)}" is not a page id`,
      };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_NAV_IDS)
    return { ok: false, error: `shell.${key}: at most ${MAX_NAV_IDS}` };
  return { ok: true, value: out };
}

/** The stored block, normalised: a missing or hand-broken field is its default. */
export function shellPrefs(stored: unknown): ShellPrefs {
  const out: ShellPrefs = {
    pins: [],
    collapsed: false,
    hidden: [],
    order: [],
    dock: false,
    dockHeight: 0,
  };
  if (!isObject(stored)) return out;
  if (typeof stored.dock === "boolean") out.dock = stored.dock;
  if (stored.dockHeight !== undefined) {
    const h = checkDockHeight(stored.dockHeight);
    if (h.ok) out.dockHeight = h.value;
  }
  const pins = checkPins(stored.pins);
  if (pins.ok) out.pins = pins.value;
  if (typeof stored.collapsed === "boolean") out.collapsed = stored.collapsed;
  for (const key of ["hidden", "order"] as const) {
    const ids = checkNavIds(key, stored[key]);
    if (ids.ok) out[key] = ids.value;
  }
  return out;
}

/** Merge a POSTed (partial) block over the current prefs; any bad field fails it. */
export function mergeShellPrefs(
  current: ShellPrefs,
  patch: unknown,
): { ok: true; value: ShellPrefs } | { ok: false; error: string } {
  if (!isObject(patch)) return { ok: false, error: "shell must be an object" };
  const out: ShellPrefs = {
    ...current,
    pins: [...current.pins],
    hidden: [...current.hidden],
    order: [...current.order],
  };
  for (const key of Object.keys(patch)) {
    // null clears a pref back to its default (0.3.0-dev.32): the stored
    // block drops it, so set-then-clear leaves user.yml as it was.
    if (patch[key] === null && key in SHELL_DEFAULTS) {
      const d = SHELL_DEFAULTS[key as keyof ShellPrefs];
      (out as unknown as Record<string, unknown>)[key] = Array.isArray(d)
        ? []
        : d;
      continue;
    }
    if (key === "pins") {
      const p = checkPins(patch.pins);
      if (!p.ok) return p;
      out.pins = p.value;
    } else if (key === "collapsed") {
      if (typeof patch.collapsed !== "boolean")
        return { ok: false, error: "shell.collapsed must be true or false" };
      out.collapsed = patch.collapsed;
    } else if (key === "dock") {
      if (typeof patch.dock !== "boolean")
        return { ok: false, error: "shell.dock must be true or false" };
      out.dock = patch.dock;
    } else if (key === "dockHeight") {
      const h = checkDockHeight(patch.dockHeight);
      if (!h.ok) return h;
      out.dockHeight = h.value;
    } else if (key === "hidden" || key === "order") {
      const ids = checkNavIds(key, patch[key]);
      if (!ids.ok) return ids;
      out[key] = ids.value;
    } else return { ok: false, error: `shell.${key} is not a setting` };
  }
  return { ok: true, value: out };
}

/** The block to store: none for the defaults, so user.yml stays lean. */
export function storedShell(p: ShellPrefs): Partial<ShellPrefs> | undefined {
  const out: Partial<ShellPrefs> = {};
  if (p.pins.length) out.pins = p.pins;
  if (p.collapsed) out.collapsed = true;
  if (p.hidden.length) out.hidden = p.hidden;
  if (p.order.length) out.order = p.order;
  if (p.dock) out.dock = true;
  if (p.dockHeight) out.dockHeight = p.dockHeight;
  return Object.keys(out).length ? out : undefined;
}
