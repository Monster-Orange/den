/**
 * Issue 278: agents stuck compacting, and instruction files that eat the
 * context.
 *
 *   - Compaction loop: the runtime's record of each compaction (Claude
 *     Code's compact_boundary records, transcript-follow.ts) is counted
 *     per agent. More than `loopCount` automatic ones within
 *     `loopMinutes` is one episode: one bell and one log line when it
 *     starts, none for the compactions after. It ends once no more than
 *     `loopCount` fall in the last `loopMinutes`. With `pause` on, Den
 *     holds new deliveries to the agent from the bell until a person
 *     clears it on the Agents page. Kept in agent-files/<id>/compacting.json.
 *   - Instruction size: the instruction files the runtime loads at start
 *     for the agent's folder, by size only (stat; never read). Over
 *     `sharePercent` of the model's context is a warning on its row and
 *     in doctor, naming the largest file. Kept in
 *     agent-files/<id>/instructions.json, written at each start.
 *
 * Settings (user.yml agent_context.*): compaction_loop_count (3),
 * compaction_loop_minutes (10), pause_after_loop (false),
 * instruction_share_percent (15), context_tokens (200000).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writePrivate } from "./records.js";
import type { Compaction } from "./transcript-follow.js";

export interface ContextWatchSettings {
  /** More automatic compactions than this within loopMinutes is a loop. */
  loopCount: number;
  loopMinutes: number;
  /** Hold new deliveries to a looping agent until a person clears it. */
  pause: boolean;
  /** Instructions over this share of the context warn. */
  sharePercent: number;
  /** The context size when Den doesn't know the model's. */
  contextTokens: number;
}

export const CONTEXT_WATCH_DEFAULTS: ContextWatchSettings = {
  loopCount: 3,
  loopMinutes: 10,
  pause: false,
  sharePercent: 15,
  contextTokens: 200_000,
};

/** One user.yml agent_context key: its field here, and its range. */
export const CONTEXT_WATCH_KEYS = {
  compaction_loop_count: { min: 1, max: 1000, int: true },
  compaction_loop_minutes: { min: 1, max: 1440, int: true },
  instruction_share_percent: { min: 1, max: 100, int: false },
  context_tokens: { min: 1000, max: 100_000_000, int: true },
} as const;

function num(
  b: Record<string, unknown>,
  key: keyof typeof CONTEXT_WATCH_KEYS,
  dflt: number,
): number {
  const v = b[key];
  const l = CONTEXT_WATCH_KEYS[key];
  return typeof v === "number" &&
    Number.isFinite(v) &&
    v >= l.min &&
    v <= l.max &&
    (!l.int || Number.isInteger(v))
    ? v
    : dflt;
}

/** The settings from user.yml's `agent_context` (a missing or bad value: its default). */
export function contextWatchSettings(block: unknown): ContextWatchSettings {
  const b =
    block && typeof block === "object" && !Array.isArray(block)
      ? (block as Record<string, unknown>)
      : {};
  const d = CONTEXT_WATCH_DEFAULTS;
  return {
    loopCount: num(b, "compaction_loop_count", d.loopCount),
    loopMinutes: num(b, "compaction_loop_minutes", d.loopMinutes),
    pause:
      typeof b.pause_after_loop === "boolean" ? b.pause_after_loop : d.pause,
    sharePercent: num(b, "instruction_share_percent", d.sharePercent),
    contextTokens: num(b, "context_tokens", d.contextTokens),
  };
}

/**
 * The model's context in tokens when Den knows it from the model's name (a
 * `[1m]` model has a million), else `fallback` (the context_tokens setting).
 */
export function contextTokensFor(
  model: string | undefined,
  version: string | undefined,
  fallback: number,
): number {
  return /\[1m\]/i.test(`${model ?? ""} ${version ?? ""}`)
    ? 1_000_000
    : fallback;
}

// ── Instruction size ──────────────────────────────────────────────────────

export interface InstructionFile {
  path: string;
  bytes: number;
  /** The user's own (in Claude Code's config folder), not the folder's. */
  user?: true;
}

/** The instruction files Claude Code looks for in each folder it reads. */
const FOLDER_FILES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  path.join(".claude", "CLAUDE.md"),
  "AGENTS.md",
];

/**
 * The instruction files Claude Code loads at start for folder `cwd`, by
 * size (stat only: never read). Its documented lookup:
 *   - the user's own: CLAUDE.md in its config folder ($CLAUDE_CONFIG_DIR,
 *     else ~/.claude);
 *   - in `cwd` and each folder above it: CLAUDE.md, CLAUDE.local.md and
 *     .claude/CLAUDE.md. AGENTS.md is counted too, as many folders keep
 *     their instructions there for every tool.
 * Claude Code reads up to (not including) `/`. Den stops at the home
 * folder, or, for a folder outside home, at its repo's root (a folder with
 * .git). Not counted: files Claude Code loads only on demand (in folders
 * below `cwd`), what an @import pulls in (that needs the contents), and
 * an organization's managed policy file.
 */
export function instructionFiles(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): InstructionFile[] {
  const home = path.resolve(env.HOME || os.homedir());
  const config = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const out: InstructionFile[] = [];
  const seen = new Set<string>();
  const add = (p: string, user = false) => {
    if (seen.has(p)) return;
    seen.add(p);
    try {
      const st = fs.statSync(p);
      if (st.isFile())
        out.push({ path: p, bytes: st.size, ...(user ? { user: true } : {}) });
    } catch {
      /* not there */
    }
  };
  add(path.join(config, "CLAUDE.md"), true);
  const underHome = (d: string) => d === home || d.startsWith(home + path.sep);
  let dir = path.resolve(cwd);
  const inHome = underHome(dir);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // `/` itself: never read
    for (const f of FOLDER_FILES) add(path.join(dir, f));
    if (dir === home) break;
    if (!inHome && fs.existsSync(path.join(dir, ".git"))) break;
    dir = parent;
  }
  return out;
}

export interface InstructionCheck {
  /** When it was measured (ISO 8601). */
  at: string;
  files: number;
  totalBytes: number;
  /** An estimate: bytes / 4 (about four bytes of English per token). */
  tokens: number;
  contextTokens: number;
  sharePercent: number;
  /** Over sharePercent of contextTokens. */
  over: boolean;
  /** The largest file: its path relative to the folder, and its size. */
  largest?: { path: string; bytes: number };
}

/** A file's path as the warning names it: relative to the folder, or ~/… for the user's own. */
function shownPath(f: InstructionFile, cwd: string, home: string): string {
  if (!f.user) return path.relative(cwd, f.path) || path.basename(f.path);
  return f.path.startsWith(home + path.sep)
    ? `~${path.sep}${path.relative(home, f.path)}`
    : f.path;
}

/** How the files measure against the context's share. */
export function instructionCheck(
  files: readonly InstructionFile[],
  cwd: string,
  o: { sharePercent: number; contextTokens: number; home?: string },
  now: Date = new Date(),
): InstructionCheck {
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  // Tokens are estimated as bytes / 4: about right for English text and
  // code. Den reads sizes only, so it can't count them.
  const tokens = Math.ceil(totalBytes / 4);
  const limit = (o.contextTokens * o.sharePercent) / 100;
  const big = files.reduce<InstructionFile | null>(
    (a, f) => (!a || f.bytes > a.bytes ? f : a),
    null,
  );
  const home = path.resolve(o.home ?? os.homedir());
  return {
    at: now.toISOString(),
    files: files.length,
    totalBytes,
    tokens,
    contextTokens: o.contextTokens,
    sharePercent: o.sharePercent,
    over: tokens > limit,
    ...(big
      ? {
          largest: {
            path: shownPath(big, path.resolve(cwd), home),
            bytes: big.bytes,
          },
        }
      : {}),
  };
}

/** "123 KB" (whole KB; under 1 KB: bytes). */
export function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** The warning's English, for the start's warnings, the log and doctor. */
export function instructionWarning(c: InstructionCheck): string {
  const big = c.largest
    ? `; the largest is ${c.largest.path} (${sizeText(c.largest.bytes)})`
    : "";
  return `instruction files are ${sizeText(c.totalBytes)}, about ${c.tokens} tokens: more than ${c.sharePercent}% of a ${c.contextTokens}-token context, loaded again after every compaction${big}`;
}

export const INSTRUCTIONS_FILE = "instructions.json";

export function writeInstructionCheck(
  filesDir: string,
  c: InstructionCheck,
): void {
  try {
    writePrivate(
      path.join(filesDir, INSTRUCTIONS_FILE),
      JSON.stringify(c) + "\n",
    );
  } catch {
    /* shown, not kept: the next start measures again */
  }
}

export function readInstructionCheck(
  filesDir: string,
): InstructionCheck | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(filesDir, INSTRUCTIONS_FILE), "utf-8"),
    ) as InstructionCheck;
    return v && typeof v.totalBytes === "number" && typeof v.over === "boolean"
      ? v
      : null;
  } catch {
    return null;
  }
}

// ── Compaction loop ───────────────────────────────────────────────────────

export interface CompactingState {
  /** The conversation counted: another one starts over. */
  token: string | null;
  /** A loop is happening now. */
  active: boolean;
  /** When this episode's bell rang (ISO 8601). */
  rangAt?: string;
  /** Automatic compactions in the last loopMinutes, at the last look. */
  count?: number;
  /** The newest automatic compaction (ISO 8601). */
  lastAt?: string;
  /** New deliveries wait until a person clears it. */
  paused?: boolean;
  /** A person cleared it: only compactions after this count. */
  clearedAt?: string;
}

export const COMPACTING_FILE = "compacting.json";

export function readCompacting(filesDir: string): CompactingState | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(filesDir, COMPACTING_FILE), "utf-8"),
    ) as CompactingState;
    return v && typeof v.active === "boolean" ? v : null;
  } catch {
    return null;
  }
}

export function writeCompacting(filesDir: string, s: CompactingState): void {
  writePrivate(path.join(filesDir, COMPACTING_FILE), JSON.stringify(s) + "\n");
}

/**
 * One look at an agent's compactions: the state after it, and whether a
 * new episode began (ring the bell once).
 */
export function stepCompacting(
  prev: CompactingState | null,
  list: readonly Compaction[],
  token: string | null,
  now: number,
  s: Pick<ContextWatchSettings, "loopCount" | "loopMinutes" | "pause">,
): { state: CompactingState; ring: boolean } {
  const base: CompactingState =
    prev && prev.token === token ? prev : { token, active: false };
  const cleared = base.clearedAt ? Date.parse(base.clearedAt) : -Infinity;
  const from = now - s.loopMinutes * 60_000;
  const recent = list.filter((c) => c.auto && c.at > cleared && c.at >= from);
  const looping = recent.length > s.loopCount;
  if (looping) {
    const lastAt = new Date(Math.max(...recent.map((c) => c.at))).toISOString();
    if (base.active)
      return {
        state: { ...base, count: recent.length, lastAt },
        ring: false,
      };
    return {
      state: {
        ...base,
        active: true,
        rangAt: new Date(now).toISOString(),
        count: recent.length,
        lastAt,
        ...(s.pause || base.paused ? { paused: true } : {}),
      },
      ring: true,
    };
  }
  if (!base.active) return { state: base, ring: false };
  // Over: the count stays as the last episode's; a pause stays for its person.
  return { state: { ...base, active: false }, ring: false };
}

/** A person cleared it: the loop is over for now, and deliveries go again. */
export function clearCompacting(
  token: string | null,
  now: Date = new Date(),
): CompactingState {
  return { token, active: false, clearedAt: now.toISOString() };
}
