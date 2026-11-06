/**
 * Appearance preferences: the theme and mode this engineer chose. Stored in
 * the user config as `appearance:` and served by /api/settings, like the
 * graph prefs. A pure UI preference: changing it writes this block of
 * config/local/user.yml and nothing else (no edge, services or restart).
 */

export type ModePref = "system" | "dark" | "light";

export interface AppearancePrefs {
  /**
   * A theme id, or null to follow the org default (the org config's
   * `brand.theme`, else den). A named theme is pinned even when it is the
   * org default today: you keep it when the org changes `brand.theme`.
   */
  theme: string | null;
  /** system follows prefers-color-scheme. */
  mode: ModePref;
}

export const APPEARANCE_DEFAULTS: AppearancePrefs = {
  theme: null,
  mode: "system",
};

export const MODES: readonly ModePref[] = ["system", "dark", "light"];
const THEME_ID = /^[a-z][a-z0-9-]{1,39}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The stored block, normalised. A stored theme id is kept even when that
 * theme is not installed now (resolution warns and falls back), so a theme
 * that is briefly missing does not lose the preference.
 */
export function appearancePrefs(stored: unknown): AppearancePrefs {
  const out: AppearancePrefs = { ...APPEARANCE_DEFAULTS };
  if (!isObject(stored)) return out;
  if (typeof stored.theme === "string" && THEME_ID.test(stored.theme))
    out.theme = stored.theme;
  if (MODES.includes(stored.mode as ModePref))
    out.mode = stored.mode as ModePref;
  return out;
}

/**
 * Merge a POSTed (partial) block. `theme` must name an installed theme that
 * validates; null or "" clears it ("Org default": follow the org); any bad
 * field fails the whole patch.
 *
 * A theme picked by name is stored by name, even one that is the org
 * default now (0.3.0-dev.11): that is a pin, and the menu shows it as one.
 * Only "Org default" follows the org when it changes `brand.theme`.
 */
export function mergeAppearancePrefs(
  current: AppearancePrefs,
  patch: unknown,
  isUsableTheme: (id: string) => boolean,
): { ok: true; value: AppearancePrefs } | { ok: false; error: string } {
  if (!isObject(patch))
    return { ok: false, error: "appearance must be an object" };
  const out: AppearancePrefs = { ...current };
  for (const [key, v] of Object.entries(patch)) {
    if (key === "mode") {
      // null clears it to the default (0.3.0-dev.32), as theme's does.
      if (v === null) out.mode = APPEARANCE_DEFAULTS.mode;
      else if (!MODES.includes(v as ModePref))
        return {
          ok: false,
          error: `appearance.mode must be one of ${MODES.map((m) => `"${m}"`).join(", ")}`,
        };
      else out.mode = v as ModePref;
    } else if (key === "theme") {
      if (v === null || v === "") out.theme = null;
      else if (typeof v !== "string" || !THEME_ID.test(v) || !isUsableTheme(v))
        return {
          ok: false,
          error: `appearance.theme: no valid installed theme "${String(v)}"`,
        };
      else out.theme = v;
    } else return { ok: false, error: `unknown appearance setting "${key}"` };
  }
  return { ok: true, value: out };
}

/** What user.yml stores: only what differs from the defaults. */
export function storedAppearance(
  p: AppearancePrefs,
): { theme?: string; mode?: ModePref } | undefined {
  const out: { theme?: string; mode?: ModePref } = {};
  if (p.theme) out.theme = p.theme;
  if (p.mode !== APPEARANCE_DEFAULTS.mode) out.mode = p.mode;
  return Object.keys(out).length ? out : undefined;
}
