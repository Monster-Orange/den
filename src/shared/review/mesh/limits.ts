/**
 * Issue 476 (REVIEW-MESH-SPEC RV-2): the limits that make a reviewer skip a
 * claim, each named with what it had and needed. Usage comes from
 * UsageLeftReader (src/shared/usage/left.ts). When a usage limit is set and
 * usage can't be read, the reviewer doesn't claim (fails closed).
 */
import type { UsageLeft } from "../../usage/left.js";
import type { ReviewSettings } from "./settings.js";

export interface LimitSkip {
  limit:
    | "min_session_left_pct"
    | "min_weekly_left_pct"
    | "max_concurrent"
    | "usage_unreadable";
  have: number | null;
  need: number;
}

export function limitsSkip(
  s: ReviewSettings,
  usage: UsageLeft | null,
  running: number,
): LimitSkip | null {
  if (running >= s.maxConcurrent)
    return { limit: "max_concurrent", have: running, need: s.maxConcurrent };
  const needsUsage = s.minSessionLeftPct > 0 || s.minWeeklyLeftPct > 0;
  if (!needsUsage) return null;
  if (!usage)
    return {
      limit: "usage_unreadable",
      have: null,
      need: Math.max(s.minSessionLeftPct, s.minWeeklyLeftPct),
    };
  if (usage.sessionLeftPct < s.minSessionLeftPct)
    return {
      limit: "min_session_left_pct",
      have: usage.sessionLeftPct,
      need: s.minSessionLeftPct,
    };
  if (usage.weeklyLeftPct < s.minWeeklyLeftPct)
    return {
      limit: "min_weekly_left_pct",
      have: usage.weeklyLeftPct,
      need: s.minWeeklyLeftPct,
    };
  return null;
}
