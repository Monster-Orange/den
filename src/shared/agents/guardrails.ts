/**
 * Guardrails (den#5): what Den adds to a launch of a default-pack persona,
 * from Den-owned files in guardrails/:
 *
 *   instructions.md  the shared persona instructions (plain writing, reading
 *                    and waiting, the hand-back template). Appended to the
 *                    role prompt (personas.ts rolePrompt), so every runtime
 *                    gets them.
 *   hooks.json       a Claude Code settings fragment: a PreToolUse hook on
 *                    Bash and Read (pretooluse.mjs), a Stop hook
 *                    (stop-hook.ts, the hand-back check), and PreCompact
 *                    and SessionStart (compact, resume) hooks
 *                    (rotation-hook.ts, session rotation: den#4). den-claude
 *                    merges it into the agent's own --settings file; Den
 *                    never writes the user's ~/.claude.
 *
 * On by default for Den's default pack, off for a distribution's packs.
 * A distribution turns them off or on per pack (agents.default_pack, a
 * persona_packs entry's `hooks` / `instructions`) and per persona (front
 * matter `den_hooks` / `den_instructions`), the persona winning.
 */
import * as fs from "fs";
import * as path from "path";
import { enginePath, scriptEntrypoint, type EngineCommand } from "../engine.js";

export interface Guardrails {
  /** Den's Claude Code hooks (PreToolUse reads and sleeps, Stop hand-back). */
  hooks: boolean;
  /** The shared persona instructions in the role prompt. */
  instructions: boolean;
}

/** Den's default pack: both on. */
export const DEFAULT_PACK_GUARDRAILS: Guardrails = {
  hooks: true,
  instructions: true,
};

/** A distribution's pack: both off unless it opts in. */
export const PACK_GUARDRAILS: Guardrails = {
  hooks: false,
  instructions: false,
};

/** Where the guardrail files ship (src/ ships whole). */
export const GUARDRAILS_DIR = enginePath(
  "src",
  "shared",
  "agents",
  "guardrails",
);

/** What the server agent reads in place of "Handing work back" (ON-6). */
export const NO_HANDBACK_SECTION = `### Talking with the person

You talk with the person as you go; there is no work to hand back, so don't
write a hand-back. End each turn with a plain sentence or one question.
Every message you end a turn with is read by a person: explain each ID in it.`;

/**
 * The shared persona instructions, as Den ships them. `handback: false`
 * (the server agent, ON-6) swaps the "Handing work back" section, a build
 * agent's template (URL, Branch, yes/no decisions), for NO_HANDBACK_SECTION.
 */
export function sharedInstructions(
  dir: string = GUARDRAILS_DIR,
  opts: { handback?: boolean } = {},
): string {
  const text = fs
    .readFileSync(path.join(dir, "instructions.md"), "utf-8")
    .trim();
  if (opts.handback !== false) return text;
  const at = text.indexOf("### Handing work back");
  if (at < 0) return text;
  const next = text.indexOf("\n### ", at + 1);
  return (
    text.slice(0, at) +
    NO_HANDBACK_SECTION +
    (next < 0 ? "" : `\n${text.slice(next)}`)
  ).trim();
}

/** One argument for a POSIX shell, single-quoted when it needs it. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s)
    ? s
    : `'${s.replace(/'/g, `'\\''`)}'`;
}

const commandLine = (c: EngineCommand): string =>
  [c.command, ...c.args].map(shellQuote).join(" ");

export interface HookCommands {
  /** The PreToolUse hook's command line. */
  pretooluse: string;
  /** The Stop hook's command line. */
  stop: string;
  /** The PreCompact and SessionStart hooks' command line (den#4). */
  rotation: string;
}

/**
 * Where an agent's rotation state lives and its limit (den#4): its files
 * dir, and the compactions after which it rotates (0: never).
 */
export interface RotationArgs {
  files: string;
  after: number;
}

/** The command lines Den's hooks run: this node, Den's own scripts. */
export function hookCommands(
  dir: string = GUARDRAILS_DIR,
  node: string = process.execPath,
  rotation?: RotationArgs,
  /** ID-shaped words in Den's own names, for the Stop hook (stop-hook.ts). */
  known: readonly string[] = [],
  /** false: the Stop hook never runs the hand-back check (the server agent). */
  handback: boolean = true,
): HookCommands {
  const more = (c: EngineCommand): EngineCommand =>
    rotation
      ? {
          command: c.command,
          args: [
            ...c.args,
            "--files",
            rotation.files,
            "--after",
            String(rotation.after),
          ],
        }
      : c;
  return {
    pretooluse: commandLine({
      command: node,
      args: [path.join(dir, "pretooluse.mjs")],
    }),
    stop: commandLine(
      ((c: EngineCommand): EngineCommand => ({
        command: c.command,
        args: [
          ...c.args,
          ...known.flatMap((k) => ["--known", k]),
          ...(handback ? [] : ["--no-handback"]),
        ],
      }))(more(scriptEntrypoint("src/shared/agents/guardrails/stop-hook.ts"))),
    ),
    rotation: commandLine(
      more(scriptEntrypoint("src/shared/agents/guardrails/rotation-hook.ts")),
    ),
  };
}

/**
 * The `hooks` block of the agent's settings file: hooks.json with each
 * `{pretooluse}` / `{stop}` / `{rotation}` placeholder replaced by its
 * command line.
 */
export function guardrailHooks(
  dir: string = GUARDRAILS_DIR,
  cmds: HookCommands = hookCommands(dir),
): Record<string, unknown> {
  const fragment = JSON.parse(
    fs.readFileSync(path.join(dir, "hooks.json"), "utf-8"),
  ) as { hooks: Record<string, unknown> };
  const fill = (v: unknown): unknown => {
    if (typeof v === "string")
      return v.replace(
        /\{(pretooluse|stop|rotation)\}/g,
        (_, k: keyof HookCommands) => cmds[k],
      );
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, fill(x)]),
      );
    return v;
  };
  return fill(fragment.hooks) as Record<string, unknown>;
}
