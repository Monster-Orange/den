/**
 * WS-6.10, the Workspaces settings (user.yml `switching`):
 *
 *   on_pick              what picking a workspace in the Workspace menu or
 *                        the Workspaces list does: "show" (just show it,
 *                        the default), "ask" (ask whether to start it) or
 *                        "switch" (start it automatically). Picking never
 *                        stops anything.
 *   confirm_stop_switch  ask before Stop & Switch (true, the default) or
 *                        don't ask (false).
 *
 * Defaults are never stored, so a cleared setting leaves user.yml as it was.
 */
export const ON_PICK = ["show", "ask", "switch"] as const;
export type OnPick = (typeof ON_PICK)[number];

export interface SwitchPrefs {
  on_pick: OnPick;
  confirm_stop_switch: boolean;
}

/** The prefs from what user.yml holds, defaults filled in. */
export function switchPrefs(raw: unknown): SwitchPrefs {
  const p =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    on_pick: (ON_PICK as readonly unknown[]).includes(p.on_pick)
      ? (p.on_pick as OnPick)
      : "show",
    confirm_stop_switch: p.confirm_stop_switch !== false,
  };
}

/** Apply a POST /api/settings `switching` patch; an unknown value is an error. */
export function mergeSwitchPrefs(
  current: SwitchPrefs,
  patch: unknown,
): { ok: true; value: SwitchPrefs } | { ok: false; error: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return { ok: false, error: "switching must be an object" };
  const p = patch as Record<string, unknown>;
  const next = { ...current };
  for (const k of Object.keys(p)) {
    if (k === "on_pick") {
      if (p.on_pick === null) next.on_pick = "show";
      else if ((ON_PICK as readonly unknown[]).includes(p.on_pick))
        next.on_pick = p.on_pick as OnPick;
      else
        return {
          ok: false,
          error: `switching.on_pick must be one of ${ON_PICK.map((v) => `"${v}"`).join(", ")}`,
        };
    } else if (k === "confirm_stop_switch") {
      if (p.confirm_stop_switch === null) next.confirm_stop_switch = true;
      else if (typeof p.confirm_stop_switch === "boolean")
        next.confirm_stop_switch = p.confirm_stop_switch;
      else
        return {
          ok: false,
          error: "switching.confirm_stop_switch must be true or false",
        };
    } else return { ok: false, error: `unknown switching key "${k}"` };
  }
  return { ok: true, value: next };
}

/** What to store: only what differs from the defaults, or nothing. */
export function storedSwitchPrefs(
  p: SwitchPrefs,
): Partial<SwitchPrefs> | undefined {
  const out: Partial<SwitchPrefs> = {};
  if (p.on_pick !== "show") out.on_pick = p.on_pick;
  if (!p.confirm_stop_switch) out.confirm_stop_switch = false;
  return Object.keys(out).length ? out : undefined;
}
