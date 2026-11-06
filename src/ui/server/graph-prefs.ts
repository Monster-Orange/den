/**
 * Graph preferences: how the graph is laid out for this engineer, and the
 * Workspaces page's own view prefs (its list, its table's grouping).
 * Stored in the user config as `graph:` and served by /api/settings, so the
 * layout is remembered between sessions (the page mirrors it to localStorage
 * so the first paint does not wait on the server).
 */

export interface GraphPrefs {
  /** Layout direction: top-down or left-right. */
  direction: "down" | "right";
  /** The outer frames: by org or by application. */
  group: "org" | "app";
  /** Card size: detailed (236×104) or compact (176×52). */
  density: "detailed" | "compact";
  /** Details panel width in px. */
  panelWidth: number;
  /**
   * The Workspaces page's workspace list: open, or collapsed to a 40px strip (R23,
   * 0.3.0-dev.30, Ward QA 2026-11-05), so the graph gets the width.
   */
  workspaces: "open" | "collapsed";
  /**
   * The Workspaces page's repo table (R24d, 0.3.0-dev.35): grouped by
   * nothing, by application (as `<cli> apps`) or by org.
   */
  groupBy: "none" | "app" | "org";
}

export const GRAPH_DEFAULTS: GraphPrefs = {
  direction: "down",
  group: "org",
  density: "detailed",
  panelWidth: 440,
  workspaces: "open",
  groupBy: "none",
};

const CHOICES = {
  direction: ["down", "right"],
  group: ["org", "app"],
  density: ["detailed", "compact"],
  workspaces: ["open", "collapsed"],
  groupBy: ["none", "app", "org"],
} as const;

const PANEL_MIN = 360;
const PANEL_MAX = 760;

type Check = { ok: true; value: unknown } | { ok: false; error: string };

function check(key: keyof GraphPrefs, v: unknown): Check {
  if (key === "panelWidth") {
    if (typeof v !== "number" || !Number.isFinite(v))
      return { ok: false, error: panelError() };
    const w = Math.round(v);
    if (w < PANEL_MIN || w > PANEL_MAX)
      return { ok: false, error: panelError() };
    return { ok: true, value: w };
  }
  const allowed: readonly string[] = CHOICES[key];
  if (typeof v !== "string" || !allowed.includes(v))
    return {
      ok: false,
      error: `graph.${key} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`,
    };
  return { ok: true, value: v };
}

function panelError(): string {
  return `graph.panelWidth must be a number from ${PANEL_MIN} to ${PANEL_MAX}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The stored block, normalised: a missing or hand-broken field is its default. */
export function graphPrefs(stored: unknown): GraphPrefs {
  const out: GraphPrefs = { ...GRAPH_DEFAULTS };
  if (!isObject(stored)) return out;
  for (const key of Object.keys(GRAPH_DEFAULTS) as (keyof GraphPrefs)[]) {
    if (!(key in stored)) continue;
    const c = check(key, stored[key]);
    if (c.ok) (out as unknown as Record<string, unknown>)[key] = c.value;
  }
  return out;
}

/** Merge a POSTed (partial) block over the current prefs; any bad field fails it. */
export function mergeGraphPrefs(
  current: GraphPrefs,
  patch: unknown,
): { ok: true; value: GraphPrefs } | { ok: false; error: string } {
  if (!isObject(patch)) return { ok: false, error: "graph must be an object" };
  const out: GraphPrefs = { ...current };
  for (const [key, v] of Object.entries(patch)) {
    if (!(key in GRAPH_DEFAULTS))
      return { ok: false, error: `unknown graph setting "${key}"` };
    const c = check(key as keyof GraphPrefs, v);
    if (!c.ok) return c;
    (out as unknown as Record<string, unknown>)[key] = c.value;
  }
  return { ok: true, value: out };
}

/**
 * The stored block after a POSTed patch (0.3.0-dev.32, a consumer's nit):
 * only the keys someone set are kept, and a key set to null is removed, so
 * setting a pref and clearing it again leaves user.yml as it was. Nothing
 * left: undefined (the caller drops `graph:`). Any bad field fails it.
 */
export function patchStoredGraph(
  stored: unknown,
  patch: unknown,
):
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string } {
  if (!isObject(patch)) return { ok: false, error: "graph must be an object" };
  const out: Record<string, unknown> = isObject(stored) ? { ...stored } : {};
  for (const [key, v] of Object.entries(patch)) {
    if (!(key in GRAPH_DEFAULTS))
      return { ok: false, error: `unknown graph setting "${key}"` };
    if (v === null) {
      delete out[key];
      continue;
    }
    const c = check(key as keyof GraphPrefs, v);
    if (!c.ok) return c;
    out[key] = c.value;
  }
  return { ok: true, value: Object.keys(out).length ? out : undefined };
}
