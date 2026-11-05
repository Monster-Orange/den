/**
 * Shell preferences (0.3.0-dev.17): what this engineer pinned to the rail
 * and whether the rail is collapsed. Stored in the user config as `shell:`
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
}

export const SHELL_DEFAULTS: ShellPrefs = { pins: [], collapsed: false };

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

/** The stored block, normalised: a missing or hand-broken field is its default. */
export function shellPrefs(stored: unknown): ShellPrefs {
  const out: ShellPrefs = { pins: [], collapsed: false };
  if (!isObject(stored)) return out;
  const pins = checkPins(stored.pins);
  if (pins.ok) out.pins = pins.value;
  if (typeof stored.collapsed === "boolean") out.collapsed = stored.collapsed;
  return out;
}

/** Merge a POSTed (partial) block over the current prefs; any bad field fails it. */
export function mergeShellPrefs(
  current: ShellPrefs,
  patch: unknown,
): { ok: true; value: ShellPrefs } | { ok: false; error: string } {
  if (!isObject(patch)) return { ok: false, error: "shell must be an object" };
  const out: ShellPrefs = { ...current, pins: [...current.pins] };
  for (const key of Object.keys(patch)) {
    if (key === "pins") {
      const p = checkPins(patch.pins);
      if (!p.ok) return p;
      out.pins = p.value;
    } else if (key === "collapsed") {
      if (typeof patch.collapsed !== "boolean")
        return { ok: false, error: "shell.collapsed must be true or false" };
      out.collapsed = patch.collapsed;
    } else return { ok: false, error: `shell.${key} is not a setting` };
  }
  return { ok: true, value: out };
}

/** The block to store: none for the defaults, so user.yml stays lean. */
export function storedShell(p: ShellPrefs): Partial<ShellPrefs> | undefined {
  const out: Partial<ShellPrefs> = {};
  if (p.pins.length) out.pins = p.pins;
  if (p.collapsed) out.collapsed = true;
  return Object.keys(out).length ? out : undefined;
}
