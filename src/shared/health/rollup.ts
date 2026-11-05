/**
 * The repo health rollup, typed for TypeScript callers (`<cli> status`).
 *
 * The rule itself is one plain ES module, src/ui/server/public/health-rollup.js,
 * because the browser runs it too (the header row and the graph): one
 * function everywhere, so the row, its chip, the graph and `status` never
 * disagree. See that file for the rule.
 */
import * as rollup from "../../ui/server/public/health-rollup.js";

export type RepoState = "down" | "degraded" | "ok" | "unknown";

export interface HealthSignal {
  service: string;
  /** true up, false down or failing, null not checked (or not yet). */
  ok: boolean | null | undefined;
  isEntrypoint?: boolean;
  /** Not answered yet this cycle: the repo stays unknown until it has. */
  awaiting?: boolean;
}

export interface RepoRollup {
  state: RepoState;
  /** The entry service's name, or null when none can be told. */
  entry: string | null;
  /** Checked services that are down, by name. */
  down: string[];
  checked: number;
  unchecked: number;
  /** Checks that haven't answered yet; any holds the state at unknown. */
  awaiting: number;
}

export const STATE_RANK: Record<RepoState, number> = rollup.STATE_RANK;

export const rollupRepo = rollup.rollupRepo as (
  repo: string,
  signals: HealthSignal[],
) => RepoRollup;

export const describeRollup = rollup.describeRollup as (
  r: RepoRollup,
) => string;

export const compareRepos = rollup.compareRepos as (
  a: { state: RepoState; repo: string; focused?: boolean },
  b: { state: RepoState; repo: string; focused?: boolean },
) => number;
