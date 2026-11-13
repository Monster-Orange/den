/**
 * D70: a workspace has a name and a slug.
 *
 *   name  what the person typed, any text ("back office"); shown everywhere.
 *   slug  derived from it (lowercase, spaces to "-"): the key in
 *         config/local/workspaces.yml, and what paths, URLs, session names
 *         and the CLI use ("back-office"). A workspace whose name is already
 *         a slug has no separate name.
 *
 * Every entry point (MCP, the CLI, the API, the pages) takes either and
 * resolves it with resolveWorkspaceKey; creation checks workspaceNameRefusal
 * first, so nothing is created that the next step would refuse.
 */
import { WORKSPACE_NAME_RE } from "./agent-actor.js";

/** The longest name a person may type. */
export const WORKSPACE_NAME_MAX = 64;

/**
 * The slug for `name`, or null when it has no letter or digit to make one
 * from. Lowercase; runs of spaces and other separators become one "-";
 * what a slug can't hold is dropped; it starts with a letter or digit.
 */
export function workspaceSlug(name: string): string | null {
  const s = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, 64);
  return WORKSPACE_NAME_RE.test(s) ? s : null;
}

/** What a workspace config carries for D70 (only `name`). */
interface Named {
  name?: unknown;
}

/** The name a workspace shows: its own, else its slug. */
export function workspaceDisplayName(slug: string, cfg?: Named): string {
  return typeof cfg?.name === "string" && cfg.name.trim()
    ? cfg.name.trim()
    : slug;
}

/**
 * The name a project shows (0.4.45, LOGICAL-ERD): Hub's when it is linked
 * to a Hub project, else its own, else its slug. Every page and list uses
 * this one rule (the picker's projectLabel is its browser twin).
 */
export function projectDisplayName(
  slug: string,
  cfg?: Named & { hub_project?: unknown },
): string {
  const h = cfg?.hub_project as { name?: unknown } | undefined;
  return typeof h?.name === "string" && h.name.trim()
    ? h.name.trim()
    : workspaceDisplayName(slug, cfg);
}

/**
 * Why `name` can't be a new workspace among `existing` (slug → config), or
 * null. The one check every create path runs.
 */
export function workspaceNameRefusal(
  name: string | undefined,
  existing: Record<string, Named>,
): string | null {
  const n = String(name ?? "").trim();
  if (!n) return "name required";
  // eslint-disable-next-line no-control-regex
  if (/["\\/<>\x00-\x1f]/.test(n))
    return "name must not contain quotes, slashes, or control characters";
  if (n.length > WORKSPACE_NAME_MAX)
    return `name must be ${WORKSPACE_NAME_MAX} characters or fewer`;
  const slug = workspaceSlug(n);
  if (!slug) return "name needs at least one letter or digit";
  for (const [key, cfg] of Object.entries(existing)) {
    if (
      key === slug ||
      workspaceDisplayName(key, cfg).toLowerCase() === n.toLowerCase()
    )
      return `project "${workspaceDisplayName(key, cfg)}" already exists`;
  }
  return null;
}

/**
 * The workspace key (slug) that `input` names among `existing`: the key
 * itself, a workspace's name (any case), or the slug of what was typed.
 * Undefined when none matches (the caller's own error then says so).
 */
export function resolveWorkspaceKey(
  input: string | undefined | null,
  existing: Record<string, Named>,
): string | undefined {
  if (typeof input !== "string" || !input) return undefined;
  if (Object.prototype.hasOwnProperty.call(existing, input)) return input;
  const t = input.trim().toLowerCase();
  for (const [key, cfg] of Object.entries(existing))
    if (workspaceDisplayName(key, cfg).toLowerCase() === t) return key;
  const slug = workspaceSlug(input);
  if (slug && Object.prototype.hasOwnProperty.call(existing, slug)) return slug;
  return undefined;
}

/**
 * Keys that aren't slugs (written before D70: "back office") moved to
 * their slug, with the old key kept as the name. A key whose slug is taken,
 * or that has none, stays as it is. Returns the new map and whether any
 * moved, and each move (old → new) for `active` and `focus`.
 */
export function migrateWorkspaceKeys<T extends Named>(
  workspaces: Record<string, T>,
): { workspaces: Record<string, T>; moved: Map<string, string> } {
  const moved = new Map<string, string>();
  const out: Record<string, T> = {};
  const taken = new Set(
    Object.keys(workspaces).filter((k) => WORKSPACE_NAME_RE.test(k)),
  );
  for (const [key, cfg] of Object.entries(workspaces)) {
    if (WORKSPACE_NAME_RE.test(key)) {
      out[key] = cfg;
      continue;
    }
    // A slug already taken gets -2, -3, …: a key left as it was is a
    // project every page refuses (0.4.36, "den hub").
    const base = workspaceSlug(key);
    let slug = base;
    for (let n = 2; slug && taken.has(slug) && n < 100; n++)
      slug = `${base!.slice(0, 60)}-${n}`;
    if (!slug || taken.has(slug)) {
      out[key] = cfg;
      continue;
    }
    taken.add(slug);
    moved.set(key, slug);
    out[slug] = {
      ...cfg,
      name: typeof cfg?.name === "string" && cfg.name ? cfg.name : key,
    };
  }
  return { workspaces: out, moved };
}
