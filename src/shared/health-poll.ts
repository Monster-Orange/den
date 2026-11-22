/**
 * Issue 1022: health checks poll slowly when nobody is looking.
 *
 * user.yml health_poll.visible_seconds (5 s by default, 2 to 300) is how
 * often a visible page polls; health_poll.hidden_seconds (60 s, 10 to
 * 3600) how often a hidden one does. A hidden page's poll says so
 * (`hidden=1`), and the server keeps its last answer for the slow interval
 * instead of re-running every check: with no visible page, the checks run
 * at most once per slow interval.
 */
import { readUserConfig, type UserConfig } from "./den-config.js";

/** A visible page's poll: the checks re-run once the answer is 8 s old. */
export const HEALTH_CACHE_TTL_MS = 8_000;

export const HEALTH_POLL = {
  visible: { default: 5, min: 2, max: 300 },
  hidden: { default: 60, min: 10, max: 3600 },
} as const;

function inRange(
  v: unknown,
  r: { default: number; min: number; max: number },
): number {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= r.min &&
    v <= r.max
    ? v
    : r.default;
}

/** Both intervals in seconds; a value out of range, or none, is the default. */
export function healthPollSeconds(read: () => UserConfig = readUserConfig): {
  visible: number;
  hidden: number;
} {
  let hp: { visible_seconds?: unknown; hidden_seconds?: unknown } | undefined;
  try {
    hp = read().health_poll;
  } catch {
    hp = undefined;
  }
  return {
    visible: inRange(hp?.visible_seconds, HEALTH_POLL.visible),
    hidden: inRange(hp?.hidden_seconds, HEALTH_POLL.hidden),
  };
}

/** How long the server keeps a health answer for a poll from this page. */
export function healthCacheTtlMs(
  hidden: boolean,
  read: () => UserConfig = readUserConfig,
): number {
  return hidden ? healthPollSeconds(read).hidden * 1000 : HEALTH_CACHE_TTL_MS;
}
