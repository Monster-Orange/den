/**
 * A test run's outcome beyond pass and fail (0.4.45): a run that ran
 * nothing, because every suite was skipped or none was declared, is its
 * own result and never a pass.
 */
import type { Pillar } from "./types/index.js";

/** The exit code the suites pillar ends with when nothing ran. */
export const NOTHING_RAN_EXIT = 3;

/**
 * Whether a run's exit means nothing ran. Only the suites pillar says so:
 * other tools use the same numbers for their own errors (ZAP exits 3).
 */
export function nothingRan(pillar: Pillar | string, exitCode: number): boolean {
  return pillar === "suites" && exitCode === NOTHING_RAN_EXIT;
}
