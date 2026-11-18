/**
 * Issue 487: the GitHub budget guard's settings, user.yml github_budget.*:
 *
 *   poll_seconds       60    between the server's polls of a watched run
 *   reserve            1000  requests kept for releases and people; below
 *                            it, agents' non-essential calls through Den
 *                            are refused
 *   watch_min_seconds  120   the least `gh run watch --interval` the
 *                            PreToolUse hook lets an agent use
 *
 * A value out of its range, or unset, is its default.
 */
import * as path from "path";
import { getStateDir } from "../paths.js";

export const GITHUB_BUDGET_LIMITS = {
  poll_seconds: { min: 5, max: 3600, default: 60 },
  reserve: { min: 0, max: 1_000_000, default: 1000 },
  watch_min_seconds: { min: 0, max: 3600, default: 120 },
} as const;

export interface GithubBudgetSettings {
  pollSeconds: number;
  reserve: number;
  watchMinSeconds: number;
}

function inRange(
  v: unknown,
  l: { min: number; max: number; default: number },
): number {
  return typeof v === "number" && Number.isFinite(v) && v >= l.min && v <= l.max
    ? v
    : l.default;
}

export function githubBudgetSettings(block: unknown): GithubBudgetSettings {
  const b =
    block && typeof block === "object" && !Array.isArray(block)
      ? (block as Record<string, unknown>)
      : {};
  const L = GITHUB_BUDGET_LIMITS;
  return {
    pollSeconds: inRange(b.poll_seconds, L.poll_seconds),
    reserve: inRange(b.reserve, L.reserve),
    watchMinSeconds: inRange(b.watch_min_seconds, L.watch_min_seconds),
  };
}

/**
 * Where the server keeps the budget: the snapshot the hook and doctor read
 * (github-budget.json) and the spend log (github-spend.jsonl, one line per
 * request that cost the account, with who asked: Coach reads spend per
 * agent from it).
 */
export function githubBudgetPaths(dir: string = getStateDir()): {
  snapshot: string;
  spend: string;
} {
  return {
    snapshot: path.join(dir, "github-budget.json"),
    spend: path.join(dir, "github-spend.jsonl"),
  };
}
