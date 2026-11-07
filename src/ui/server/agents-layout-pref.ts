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
