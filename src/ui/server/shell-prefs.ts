/**
 * Shell preferences (0.3.0-dev.17): what this engineer pinned to the rail
 * and whether the rail is collapsed; since 0.3.0-dev.19 (R21 Navigation)
 * also the rail pages they hid and the order they put them in. Stored in the user config as `shell:`
 * and served by /api/settings, like `graph:` and `appearance:`. A view
 * preference only: pinning changes no edge route, container or service.
 * The shell mirrors it to localStorage so the first paint does not wait on
 * the server.
 */
import * as fs from "fs";
import * as path from "path";
import { WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import {
  checkPins,
  isObject,
  MAX_PINS,
  type Pin,
  type PinProjects,
} from "../../shared/shell-pins.js";

// Pins are read by the server and by doctor (issue 1217): the code is in
// src/shared/shell-pins.ts, exported here too for the server's callers.
export {
  MAX_PINS,
  pinNotes,
  pinnedItems,
  pinProjectsOf,
  type Pin,
  type PinProjects,
} from "../../shared/shell-pins.js";

export interface ShellPrefs {
  /** Pinned repos or services, with the project each was pinned in, in pin order. */
  pins: Pin[];
  /** The rail shows icons only. */
  collapsed: boolean;
  /** NAV page ids the rail leaves out (Settings is never one). */
  hidden: string[];
  /** NAV page ids in the engineer's order; pages not listed keep theirs. */
  order: string[];
  /** Issue 1444: the rail sections (group ids) this person folded. */
  folded: string[];
  /**
   * The runs dock is open (R16a, 0.3.0-dev.30, Ward QA 2026-11-05): it
   * starts collapsed to its bar; opening it is the engineer's choice and
   * remembered, never forced by a run starting.
   */
  dock: boolean;
  /** The open dock's output height in px; 0 is the default (170px). */
  dockHeight: number;
  /**
   * 0.4.45: project slugs in this person's order (Manage projects). Empty
   * is A to Z; a project not listed slots in A to Z. Never sent to Hub.
   */
  projectOrder: string[];
  /**
   * Issue 168: the colour this person chose for a project (slug to colour);
   * a project not listed is Automatic. Yours only, never sent to Hub.
   */
  projectColours: Record<string, ProjectColour>;
}

/**
 * Issue 168: the eight project colours (workspace-picker.js lists the
 * same). No orange and no red: orange is the brand and the selection, red
 * means a problem.
 */
export const PROJECT_COLOURS = [
  "blue",
  "teal",
  "green",
  "purple",
  "pink",
  "gold",
  "brown",
  "slate",
] as const;
export type ProjectColour = (typeof PROJECT_COLOURS)[number];

export const SHELL_DEFAULTS: ShellPrefs = {
  pins: [],
  collapsed: false,
  hidden: [],
  order: [],
  folded: [],
  dock: false,
  dockHeight: 0,
  projectOrder: [],
  projectColours: {},
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

/** How many project slugs projectOrder keeps (a guard, not a limit). */
export const MAX_PROJECT_IDS = 1000;

function checkProjectOrder(
  v: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(v))
    return { ok: false, error: "shell.projectOrder must be a list" };
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== "string" || !WORKSPACE_NAME_RE.test(id))
      return {
        ok: false,
        error: `shell.projectOrder: "${String(id)}" is not a project`,
      };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_PROJECT_IDS)
    return {
      ok: false,
      error: `shell.projectOrder: at most ${MAX_PROJECT_IDS}`,
    };
  return { ok: true, value: out };
}

function checkProjectColours(
  v: unknown,
  current: Record<string, ProjectColour> = {},
):
  | { ok: true; value: Record<string, ProjectColour> }
  | { ok: false; error: string } {
  if (!isObject(v))
    return {
      ok: false,
      error: "shell.projectColours must be an object of project to colour",
    };
  const out: Record<string, ProjectColour> = { ...current };
  for (const [slug, c] of Object.entries(v)) {
    if (!WORKSPACE_NAME_RE.test(slug))
      return {
        ok: false,
        error: `shell.projectColours: "${slug}" is not a project`,
      };
    if (c === null) {
      delete out[slug];
      continue;
    }
    if (!(PROJECT_COLOURS as readonly unknown[]).includes(c))
      return {
        ok: false,
        error: `shell.projectColours: "${String(c)}" is not one of ${PROJECT_COLOURS.join(", ")}`,
      };
    out[slug] = c as ProjectColour;
  }
  if (Object.keys(out).length > MAX_PROJECT_IDS)
    return {
      ok: false,
      error: `shell.projectColours: at most ${MAX_PROJECT_IDS}`,
    };
  return { ok: true, value: out };
}

function checkNavIds(
  key: "hidden" | "order" | "folded",
  v: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(v))
    return { ok: false, error: `shell.${key} must be a list` };
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== "string" || !NAV_ID.test(id))
      return {
        ok: false,
        error: `shell.${key}: "${String(id)}" is not a ${key === "folded" ? "rail section" : "page"} id`,
      };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_NAV_IDS)
    return { ok: false, error: `shell.${key}: at most ${MAX_NAV_IDS}` };
  return { ok: true, value: out };
}

/**
 * The stored block, normalised: a missing or hand-broken field is its
 * default. Old id-only pins migrate (issue 402, clause 6) by `projectsOf`.
 */
export function shellPrefs(
  stored: unknown,
  projectsOf?: PinProjects,
): ShellPrefs {
  const out: ShellPrefs = {
    pins: [],
    collapsed: false,
    hidden: [],
    order: [],
    folded: [],
    dock: false,
    dockHeight: 0,
    projectOrder: [],
    projectColours: {},
  };
  if (!isObject(stored)) return out;
  // Issue 168: a hand-broken entry is Automatic; the others stay.
  if (isObject(stored.projectColours))
    for (const [slug, c] of Object.entries(stored.projectColours)) {
      const one = checkProjectColours({ [slug]: c });
      if (one.ok) Object.assign(out.projectColours, one.value);
    }
  if (stored.projectOrder !== undefined) {
    const o = checkProjectOrder(stored.projectOrder);
    if (o.ok) out.projectOrder = o.value;
  }
  if (typeof stored.dock === "boolean") out.dock = stored.dock;
  if (stored.dockHeight !== undefined) {
    const h = checkDockHeight(stored.dockHeight);
    if (h.ok) out.dockHeight = h.value;
  }
  const pins = checkPins(stored.pins, projectsOf, true);
  if (pins.ok) out.pins = pins.value;
  if (typeof stored.collapsed === "boolean") out.collapsed = stored.collapsed;
  for (const key of ["hidden", "order", "folded"] as const) {
    const ids = checkNavIds(key, stored[key]);
    if (ids.ok) out[key] = ids.value;
  }
  return out;
}

/** Merge a POSTed (partial) block over the current prefs; any bad field fails it. */
export function mergeShellPrefs(
  current: ShellPrefs,
  patch: unknown,
  projectsOf?: PinProjects,
): { ok: true; value: ShellPrefs } | { ok: false; error: string } {
  if (!isObject(patch)) return { ok: false, error: "shell must be an object" };
  const out: ShellPrefs = {
    ...current,
    pins: current.pins.map((p) => ({ ...p })),
    hidden: [...current.hidden],
    order: [...current.order],
    folded: [...(current.folded ?? [])],
    projectOrder: [...(current.projectOrder ?? [])],
    projectColours: { ...(current.projectColours ?? {}) },
  };
  for (const key of Object.keys(patch)) {
    // null clears a pref back to its default (0.3.0-dev.32): the stored
    // block drops it, so set-then-clear leaves user.yml as it was.
    if (patch[key] === null && key in SHELL_DEFAULTS) {
      const d = SHELL_DEFAULTS[key as keyof ShellPrefs];
      (out as unknown as Record<string, unknown>)[key] = Array.isArray(d)
        ? []
        : isObject(d)
          ? {}
          : d;
      continue;
    }
    if (key === "pins") {
      // Issue 1217: old pins moved to each of their projects can load past
      // MAX_PINS, and the page posts the whole list, so a save is held to
      // the larger of the cap and what was stored: unpinning always saves,
      // and no save grows a list past the cap.
      const p = checkPins(
        patch.pins,
        projectsOf,
        false,
        Math.max(MAX_PINS, current.pins.length),
      );
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
    } else if (key === "projectOrder") {
      const o = checkProjectOrder(patch.projectOrder);
      if (!o.ok) return o;
      out.projectOrder = o.value;
    } else if (key === "projectColours") {
      // Issue 168: one project's colour at a time; null is Automatic.
      const c = checkProjectColours(patch.projectColours, out.projectColours);
      if (!c.ok) return c;
      out.projectColours = c.value;
    } else if (key === "hidden" || key === "order" || key === "folded") {
      const ids = checkNavIds(key, patch[key]);
      if (!ids.ok) return ids;
      out[key] = ids.value;
    } else return { ok: false, error: `shell.${key} is not a setting` };
  }
  return { ok: true, value: out };
}

/** A pin as user.yml keeps it: no `project` for none. */
export type StoredPin = { item: string; project?: string };
/** The shell block as user.yml keeps it. */
export type StoredShell = Omit<Partial<ShellPrefs>, "pins"> & {
  pins?: StoredPin[];
};

/** The block to store: none for the defaults, so user.yml stays lean. */
export function storedShell(p: ShellPrefs): StoredShell | undefined {
  const out: StoredShell = {};
  if (p.pins.length)
    out.pins = p.pins.map((x) =>
      x.project === null
        ? { item: x.item }
        : { item: x.item, project: x.project },
    );
  if (p.collapsed) out.collapsed = true;
  if (p.hidden.length) out.hidden = p.hidden;
  if (p.folded?.length) out.folded = p.folded;
  if (p.order.length) out.order = p.order;
  if (p.dock) out.dock = true;
  if (p.dockHeight) out.dockHeight = p.dockHeight;
  if (p.projectOrder?.length) out.projectOrder = p.projectOrder;
  if (p.projectColours && Object.keys(p.projectColours).length)
    out.projectColours = p.projectColours;
  return Object.keys(out).length ? out : undefined;
}

/** Issue 946: one pin's key (item and project). */
const pinKey = (p: Pin) => `${p.item}\u0000${p.project ?? ""}`;

/**
 * Issue 946: a pin is more than a view pref: a held write on a pinned item
 * waits for an Allow (approval-policy.ts, favorited). So a save by the
 * fixture person (a test install's live checks) adds pins and takes off
 * only the ones it added (`added`, kept in the state dir, never user.yml).
 * The person's own pins always stay, in place; the fixture's follow, in
 * the order it asked. Returns the pins to store and what the fixture owns.
 */
export function fixtureSave(
  before: readonly Pin[],
  asked: readonly Pin[],
  added: readonly Pin[],
): { pins: Pin[]; added: Pin[] } {
  const own = new Set(added.map(pinKey));
  const persons = before.filter((p) => !own.has(pinKey(p)));
  const theirs = new Set(persons.map(pinKey));
  const seen = new Set<string>();
  const mine: Pin[] = [];
  for (const p of asked) {
    const k = pinKey(p);
    if (theirs.has(k) || seen.has(k)) continue;
    seen.add(k);
    mine.push({ item: p.item, project: p.project ?? null });
  }
  return { pins: [...persons, ...mine], added: mine };
}

/** Issue 946: where the fixture person's own pins are recorded. */
export function fixturePinsFile(stateDir: string): string {
  return path.join(stateDir, "fixture-pins.json");
}

/** Issue 946: the pins the fixture person added (none when unreadable). */
export function readFixturePins(stateDir: string): Pin[] {
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(fixturePinsFile(stateDir), "utf8"),
    );
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) =>
      x && typeof x === "object" && typeof (x as Pin).item === "string"
        ? [
            {
              item: (x as Pin).item,
              project:
                typeof (x as Pin).project === "string"
                  ? (x as Pin).project
                  : null,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

/** Issue 946: record the fixture person's own pins (only those still stored). */
export function writeFixturePins(
  stateDir: string,
  added: readonly Pin[],
  stored: readonly Pin[],
): void {
  const now = new Set(stored.map(pinKey));
  const keep = added.filter((p) => now.has(pinKey(p)));
  const file = fixturePinsFile(stateDir);
  if (!keep.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(keep), { mode: 0o600 });
}

/**
 * Issue 957: the fixture person's own pins, kept only while they are still
 * stored. A pin dropped from user.yml (by hand, or any other way) leaves
 * the record at once, so the same pin made again later is the person's.
 * Rewrites the record when it shrinks.
 */
export function prunedFixturePins(
  stateDir: string,
  stored: readonly Pin[],
): Pin[] {
  const had = readFixturePins(stateDir);
  const now = new Set(stored.map(pinKey));
  const keep = had.filter((p) => now.has(pinKey(p)));
  if (keep.length !== had.length) writeFixturePins(stateDir, keep, stored);
  return keep;
}
