/**
 * Issue 225: the one place an agent's mode is chosen, with where it comes
 * from. A person set every project's mode, yet agents with a mode of their
 * own kept another one, and nothing said so. Every start, resume, restart,
 * the mode check and the Agents page read the mode here, so what a page
 * shows is what runs.
 *
 * The order:
 *
 *   own       a mode a person chose for this agent (an override: the Start
 *             dialog, `agents permission <id>`, the agent's own setting)
 *   project   its project's mode (`<project>.agents.permission`)
 *   install   the mode for every agent (agents.default_mode)
 *   persona   its persona's `permission_mode`
 *   default   none of these: Den's default, ask
 *
 * A persona mode Den doesn't know (a typo, Claude Code's plan) is no
 * intent: the mode is undefined with source persona, and the runtime says
 * why at its next start.
 */
import {
  DEFAULT_INTENT,
  intentOf,
  type PermissionIntent,
} from "./permissions.js";

export type ModeSource = "own" | "project" | "install" | "persona" | "default";

export const MODE_SOURCES: readonly ModeSource[] = [
  "own",
  "project",
  "install",
  "persona",
  "default",
];

export interface ModeInputs {
  /** The agent's own mode (an override), if it has one. */
  own?: PermissionIntent;
  /** Its project's mode, if set. */
  project?: PermissionIntent;
  /** The mode for every agent, if set. */
  install?: PermissionIntent;
  /** Its persona's `permission_mode` as written (undefined: none). */
  persona?: string;
}

export interface EffectiveMode {
  mode: PermissionIntent | undefined;
  source: ModeSource;
}

/** The mode an agent runs in, and where it comes from. Pure. */
export function resolveMode(i: ModeInputs): EffectiveMode {
  if (i.own) return { mode: i.own, source: "own" };
  if (i.project) return { mode: i.project, source: "project" };
  if (i.install) return { mode: i.install, source: "install" };
  if (i.persona !== undefined)
    return { mode: intentOf(i.persona), source: "persona" };
  return { mode: DEFAULT_INTENT, source: "default" };
}
