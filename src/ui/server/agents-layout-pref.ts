/**
 * The Agents tab's layout (AG-4b), a person's view preference: Focus (one
 * pane, the default), Tabs or Tile. Stored in the user config as
 * `agents.layout` and served by /api/settings as `agents_layout`, like the
 * other view prefs (graph-prefs.ts, shell-prefs.ts). It changes no session
 * and no agent: only how the page lays out their terminals.
 */
import type { UserConfig } from "../../shared/den-config.js";

export const AGENTS_LAYOUTS = ["focus", "tabs", "tile"] as const;
export type AgentsLayout = (typeof AGENTS_LAYOUTS)[number];
export const AGENTS_LAYOUT_DEFAULT: AgentsLayout = "focus";

const isLayout = (v: unknown): v is AgentsLayout =>
  typeof v === "string" && (AGENTS_LAYOUTS as readonly string[]).includes(v);

/** The stored layout, or the default when unset or hand-broken. */
export function agentsLayout(user: UserConfig): AgentsLayout {
  const v = (user.agents as { layout?: unknown } | undefined)?.layout;
  return isLayout(v) ? v : AGENTS_LAYOUT_DEFAULT;
}

/**
 * Apply a POSTed `agents_layout` to `user` (in place): a layout sets
 * agents.layout, null clears it (and an agents block left empty goes).
 * Anything else: the error to answer with.
 */
export function patchAgentsLayout(
  user: UserConfig,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (v !== null && !isLayout(v))
    return {
      ok: false,
      error: `agents_layout must be one of ${AGENTS_LAYOUTS.map((l) => `"${l}"`).join(", ")}, or null`,
    };
  const agents = { ...(user.agents ?? {}) } as Record<string, unknown>;
  if (v === null) delete agents.layout;
  else agents.layout = v;
  if (Object.keys(agents).length) user.agents = agents as UserConfig["agents"];
  else delete user.agents;
  return { ok: true };
}

/**
 * 0.4.45 (#80): how many running helpers an agent's open badge shows under
 * it (`agents.helpers_shown`, served as `agents_helpers_shown`): 1, 3, 5
 * or 10, default 3. More open in Show all. A view preference only.
 */
export const HELPERS_SHOWN = [1, 3, 5, 10] as const;
export const HELPERS_SHOWN_DEFAULT = 3;

const isShown = (v: unknown): v is number =>
  typeof v === "number" && (HELPERS_SHOWN as readonly number[]).includes(v);

/** The stored count, or the default when unset or hand-broken. */
export function helpersShown(user: UserConfig): number {
  const v = (user.agents as { helpers_shown?: unknown } | undefined)
    ?.helpers_shown;
  return isShown(v) ? v : HELPERS_SHOWN_DEFAULT;
}

/** Apply a POSTed `agents_helpers_shown` (null clears it), as the layout. */
export function patchHelpersShown(
  user: UserConfig,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (v !== null && !isShown(v))
    return {
      ok: false,
      error: `agents_helpers_shown must be one of ${HELPERS_SHOWN.join(", ")}, or null`,
    };
  const agents = { ...(user.agents ?? {}) } as Record<string, unknown>;
  if (v === null) delete agents.helpers_shown;
  else agents.helpers_shown = v;
  if (Object.keys(agents).length) user.agents = agents as UserConfig["agents"];
  else delete user.agents;
  return { ok: true };
}

/**
 * Issue 52: the Coach tab's "Show counts as", Total or Per day
 * (`agents.coach_counts`, served as `coach_counts`), default total. Per day
 * changes the counts only, never the percents or averages. A view
 * preference only.
 */
export const COACH_COUNTS = ["total", "per_day"] as const;
export type CoachCounts = (typeof COACH_COUNTS)[number];
export const COACH_COUNTS_DEFAULT: CoachCounts = "total";

const isCounts = (v: unknown): v is CoachCounts =>
  typeof v === "string" && (COACH_COUNTS as readonly string[]).includes(v);

/** The stored choice, or the default when unset or hand-broken. */
export function coachCounts(user: UserConfig): CoachCounts {
  const v = (user.agents as { coach_counts?: unknown } | undefined)
    ?.coach_counts;
  return isCounts(v) ? v : COACH_COUNTS_DEFAULT;
}

/** Apply a POSTed `coach_counts` to `user` (in place); null clears it. */
export function patchCoachCounts(
  user: UserConfig,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (v !== null && !isCounts(v))
    return {
      ok: false,
      error: `coach_counts must be one of ${COACH_COUNTS.map((c) => `"${c}"`).join(", ")}, or null`,
    };
  const agents = { ...(user.agents ?? {}) } as Record<string, unknown>;
  if (v === null) delete agents.coach_counts;
  else agents.coach_counts = v;
  if (Object.keys(agents).length) user.agents = agents as UserConfig["agents"];
  else delete user.agents;
  return { ok: true };
}
