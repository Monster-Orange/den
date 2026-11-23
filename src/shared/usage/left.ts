/**
 * Issue 476: how much usage is left, as Den can count it.
 *
 * Den can't read a provider's real quota, so this never scrapes or guesses
 * it. It counts the tokens Den's own transcripts show in the session window
 * and in the last 7 days, against caps the person sets in user.yml:
 *
 *   usage:
 *     session_token_cap: 0     # tokens per session window; 0 = no cap
 *     session_hours: 5         # the session window's length
 *     weekly_token_cap: 0      # tokens per 7 days; 0 = no cap
 *
 * Counted tokens are input, output and cache writes. Cache reads are left
 * out: they are cheap and would swamp the count.
 *
 * The interface is UsageLeftReader. The review mesh's reviewer uses it for
 * its limits, and Coach can adopt it. A real quota, if one becomes readable,
 * slots in behind the same interface.
 */
import type { TranscriptStats } from "./transcript.js";
import { usageSources, type UsageSource } from "./sources.js";

/** The share of each window left, 0–100. A window with no cap is 100. */
export interface UsageLeft {
  sessionLeftPct: number;
  weeklyLeftPct: number;
}

/** Reads what's left; null when Den can't read it (callers fail closed). */
export type UsageLeftReader = () => Promise<UsageLeft | null>;

export interface UsageCaps {
  /** Tokens per session window; 0 = no cap. */
  sessionTokens: number;
  sessionHours: number;
  /** Tokens per 7 days; 0 = no cap. */
  weeklyTokens: number;
}

/** Each key's range and default (Settings and `config` check against these). */
export const USAGE_CAP_LIMITS = {
  session_token_cap: { min: 0, max: 1e12, def: 0 },
  session_hours: { min: 1, max: 168, def: 5 },
  weekly_token_cap: { min: 0, max: 1e13, def: 0 },
} as const;

type Key = keyof typeof USAGE_CAP_LIMITS;

function num(block: Record<string, unknown>, k: Key): number {
  const l = USAGE_CAP_LIMITS[k];
  const v = block[k];
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= l.min &&
    v <= l.max
    ? v
    : l.def;
}

/** The caps from a user.yml (its parsed object). */
export function usageCaps(user: unknown): UsageCaps {
  const u = user && typeof user === "object" ? user : {};
  const b = (u as { usage?: unknown }).usage;
  const block =
    b && typeof b === "object" && !Array.isArray(b)
      ? (b as Record<string, unknown>)
      : {};
  return {
    sessionTokens: num(block, "session_token_cap"),
    sessionHours: num(block, "session_hours"),
    weeklyTokens: num(block, "weekly_token_cap"),
  };
}

/** The share of `cap` left after `used`, 0–100, whole. No cap: 100. */
export function leftPct(used: number, cap: number): number {
  if (cap <= 0) return 100;
  return Math.max(0, Math.round(100 * (1 - used / cap)));
}

const counted = (s: TranscriptStats) =>
  s.tokens.input + s.tokens.output + s.tokens.cacheWrite;

async function tokensSince(
  sources: readonly UsageSource[],
  since: number,
): Promise<number> {
  let total = 0;
  for (const src of sources)
    for (const f of src.files(since))
      total += counted(await src.mine(f, { since }));
  return total;
}

const WEEK_MS = 7 * 24 * 3600_000;

/**
 * What's left under `caps`, from Den's transcripts. Null when a transcript
 * can't be read. With no caps it reads nothing and reports all left.
 */
export async function readUsageLeft(
  caps: UsageCaps,
  opts: { sources?: readonly UsageSource[]; now?: number } = {},
): Promise<UsageLeft | null> {
  const now = opts.now ?? Date.now();
  const sources = opts.sources ?? usageSources();
  try {
    const session =
      caps.sessionTokens > 0
        ? await tokensSince(sources, now - caps.sessionHours * 3600_000)
        : 0;
    const week =
      caps.weeklyTokens > 0 ? await tokensSince(sources, now - WEEK_MS) : 0;
    return {
      sessionLeftPct: leftPct(session, caps.sessionTokens),
      weeklyLeftPct: leftPct(week, caps.weeklyTokens),
    };
  } catch {
    return null;
  }
}
