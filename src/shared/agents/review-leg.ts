/**
 * Issue 476: a review leg's agent id, and the launch narrowing that goes
 * with it. Every launch Den builds for an agent (its first start, a resume
 * after a restart, a rotation) goes through agent-ops launchInput, which
 * spreads reviewLegLaunch(id): so a leg is narrowed every time it runs, by
 * its id alone. Fail-safe: an agent that takes the prefix only narrows
 * itself.
 */
import type { LaunchInput } from "./runtime.js";

const PREFIX = "review-leg-";
const LEG_ID_RE = /^[0-9a-f]{32}$/;

/** The only Den tools a leg's server registers. */
export const REVIEW_LEG_TOOLS: readonly string[] = ["review_submit"];

/** A leg's agent id, from its leg id (32 hex). */
export function reviewLegId(legId: string): string {
  if (!LEG_ID_RE.test(legId)) throw new Error("a leg id is 32 hex digits");
  return `${PREFIX}${legId.slice(0, 16)}`;
}

export function isReviewLegId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** The launch fields a leg gets: none for any other agent. */
export function reviewLegLaunch(id: string): Pick<LaunchInput, "review"> {
  return isReviewLegId(id) ? { review: { tools: [...REVIEW_LEG_TOOLS] } } : {};
}
