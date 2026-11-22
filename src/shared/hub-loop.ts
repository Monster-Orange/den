/**
 * Issue 158: the Hub delivery loop, built into every Den. Every agent Den
 * starts in a project connected to Hub gets it in its instructions, after
 * the Hub line (HUB_PROMPT_LINE). On by default:
 *   - user.yml `hub.delivery_loop: false` turns it off for the install;
 *   - workspaces.yml `<project>.hub_delivery_loop: true | false` turns it
 *     on or off for one project, over the install (absent: as the
 *     install);
 *   - `<project>.hub_delivery_loop_extra` adds the project's own text
 *     after Den's. Den's copy is never edited: it ships with Den.
 * A change reaches an agent at its next start.
 */

/** Den's copy of the loop (generic, versioned with Den). */
export const HUB_DELIVERY_LOOP =
  "The Hub delivery loop (Den's default for projects connected to Hub):" +
  " work can start anywhere (a chat, an issue, a doc), and Hub connects it." +
  " Work that needs a person's agreement starts as a requirement doc in Hub." +
  " Link each doc to its issue in full form (owner/repo#number), and confirm the link is there." +
  " Submit the doc for review in Hub; feedback comes in Hub's threads, and you answer there." +
  " A build names its issue in the branch, the commits and the pull request; a build's status comes from git, so never set it by hand." +
  " Ask a person only for the critical parts; decide the rest yourself. A held action is always a person's decision." +
  " A Hub tool you need that is missing is a gap: say so, never skip the step.";

/** The most a project's own addition may be. */
export const HUB_LOOP_EXTRA_MAX = 2000;

/** A project's own setting: on, off or as the install; its addition. */
export interface ProjectHubLoop {
  on: boolean | null;
  extra: string;
}

/** `cfg`'s (a workspaces.yml project) own setting; bad values are unset. */
export function projectHubLoop(cfg: unknown): ProjectHubLoop {
  const c = (cfg ?? {}) as Record<string, unknown>;
  const on =
    typeof c.hub_delivery_loop === "boolean" ? c.hub_delivery_loop : null;
  const x = c.hub_delivery_loop_extra;
  const extra =
    typeof x === "string" ? x.trim().slice(0, HUB_LOOP_EXTRA_MAX) : "";
  return { on, extra };
}

/** Whether the loop is on for a project: its own setting, else the install's. */
export const hubLoopOn = (install: boolean, project: ProjectHubLoop): boolean =>
  project.on ?? install;

/**
 * The loop's text for an agent's instructions, or "" when it is off: Den's
 * copy, then the project's addition.
 */
export function hubLoopPrompt(
  install: boolean,
  project: ProjectHubLoop,
): string {
  if (!hubLoopOn(install, project)) return "";
  return project.extra
    ? `${HUB_DELIVERY_LOOP}\n\nThis project adds: ${project.extra}`
    : HUB_DELIVERY_LOOP;
}

/**
 * Check a POSTed project setting: `hub_delivery_loop` true, false or null
 * (as the install); `hub_delivery_loop_extra` text or null. Applies it to
 * `cfg` in place.
 */
export function patchProjectHubLoop(
  cfg: Record<string, unknown>,
  body: { hub_delivery_loop?: unknown; hub_delivery_loop_extra?: unknown },
): { ok: true } | { ok: false; error: string } {
  const on = body.hub_delivery_loop;
  if (on !== undefined && on !== null && typeof on !== "boolean")
    return {
      ok: false,
      error: "hub_delivery_loop must be true, false or null",
    };
  const x = body.hub_delivery_loop_extra;
  if (x !== undefined && x !== null && typeof x !== "string")
    return { ok: false, error: "hub_delivery_loop_extra must be text or null" };
  if (typeof x === "string" && x.trim().length > HUB_LOOP_EXTRA_MAX)
    return {
      ok: false,
      error: `hub_delivery_loop_extra is at most ${HUB_LOOP_EXTRA_MAX} characters`,
    };
  if (on === null) delete cfg.hub_delivery_loop;
  else if (on !== undefined) cfg.hub_delivery_loop = on;
  if (x === null || (typeof x === "string" && !x.trim()))
    delete cfg.hub_delivery_loop_extra;
  else if (typeof x === "string") cfg.hub_delivery_loop_extra = x.trim();
  return { ok: true };
}

/**
 * Apply a POSTed `hub_delivery_loop` to user.yml's hub block (in place): a
 * boolean sets hub.delivery_loop, null clears it (the default, on).
 */
export function patchHubDeliveryLoop(
  user: Record<string, unknown>,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (v !== null && typeof v !== "boolean")
    return {
      ok: false,
      error: "hub_delivery_loop must be true, false or null",
    };
  const hub = { ...((user.hub as Record<string, unknown> | undefined) ?? {}) };
  if (v === null || v === true) delete hub.delivery_loop;
  else hub.delivery_loop = v;
  if (Object.keys(hub).length) user.hub = hub;
  else delete user.hub;
  return { ok: true };
}
