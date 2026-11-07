/**
 * Permissions as intent (AG-13): what a person chooses, before any
 * runtime's syntax.
 *
 *   ask    Ask for everything (the default)
 *   edits  Auto-approve edits in the worktree
 *   all    Auto-approve all (a session started so is always tagged)
 *
 * And extra allowed commands: plain command prefixes ("npm test"), one per
 * entry, no patterns. Each runtime translates both into its own launch
 * config (den-claude.ts); a runtime that can't express one says so, and it
 * is never silently dropped. What a persona pack shares is this intent
 * only, never vendor syntax.
 */

export const PERMISSION_INTENTS = ["ask", "edits", "all"] as const;
export type PermissionIntent = (typeof PERMISSION_INTENTS)[number];
export const DEFAULT_INTENT: PermissionIntent = "ask";

/**
 * A persona's `permission_mode` as an intent. Den's three intents are
 * themselves; Claude Code's own modes from before AG-13 read as the intent
 * they meant (default, acceptEdits, bypassPermissions). Anything else
 * (Claude Code's plan, a typo) is not an intent: undefined, and the
 * runtime decides (den-claude refuses a mode it doesn't know).
 */
export function intentOf(
  mode: string | undefined,
): PermissionIntent | undefined {
  if (mode === undefined) return DEFAULT_INTENT;
  if ((PERMISSION_INTENTS as readonly string[]).includes(mode))
    return mode as PermissionIntent;
  if (mode === "default") return "ask";
  if (mode === "acceptEdits") return "edits";
  if (mode === "bypassPermissions") return "all";
  return undefined;
}

/** The most extra commands one persona or launch takes. */
export const MAX_COMMANDS = 32;
/** The longest command prefix. */
export const MAX_COMMAND_LEN = 120;
/**
 * What a plain prefix is made of: letters, digits, spaces and . _ / : = @
 * % + , -. No shell syntax (quotes, ;, &, |, $, backticks, redirects) and
 * no pattern characters (* ? [ ] ^ ( ) { }): Den translates a prefix, it
 * never passes one through a shell.
 */
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/:=@%+,-]*$/;
const PATTERN_RE = /[*?[\]^$(){}|]/;

export type CommandProblem = "pattern" | "invalid" | "long";

/** Why `c` isn't a plain prefix, or null when it is. */
export function commandProblem(c: string): CommandProblem | null {
  if ([...c].length > MAX_COMMAND_LEN) return "long";
  if (PATTERN_RE.test(c)) return "pattern";
  if (!PREFIX_RE.test(c) || /\s{2,}/.test(c) || c !== c.trim())
    return "invalid";
  return null;
}

const shown = (v: unknown) =>
  (JSON.stringify(v) ?? "undefined").replace(/[^\x20-\x7e]/g, "?").slice(0, 60);

/**
 * A list of extra allowed commands, checked: an array of plain prefixes
 * (each trimmed, duplicates dropped), at most MAX_COMMANDS. undefined or
 * null is none. Anything else throws, naming the entry and why.
 */
export function checkCommands(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v))
    throw new Error(`${where}: must be a list of command prefixes`);
  if (v.length > MAX_COMMANDS)
    throw new Error(`${where}: at most ${MAX_COMMANDS} commands`);
  const out: string[] = [];
  v.forEach((x, i) => {
    if (typeof x !== "string")
      throw new Error(`${where}[${i}]: must be a string`);
    const c = x.trim();
    const why = c ? commandProblem(c) : "invalid";
    if (why === "pattern")
      throw new Error(
        `${where}[${i}]: ${shown(c)} is a pattern: use a plain prefix ("npm test")`,
      );
    if (why === "long")
      throw new Error(`${where}[${i}]: at most ${MAX_COMMAND_LEN} characters`);
    if (why)
      throw new Error(
        `${where}[${i}]: ${shown(c)} must be a plain prefix: letters, digits, single spaces and . _ / : = @ % + , -`,
      );
    if (!out.includes(c)) out.push(c);
  });
  return out;
}

/** An intent, checked; a usage message naming `where` otherwise. */
export function checkIntent(v: unknown, where: string): PermissionIntent {
  if (
    typeof v === "string" &&
    (PERMISSION_INTENTS as readonly string[]).includes(v)
  )
    return v as PermissionIntent;
  throw new Error(
    `${where}: ${shown(v)} must be one of ${PERMISSION_INTENTS.join(", ")}`,
  );
}
