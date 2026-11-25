/**
 * Issue 237: the server's git reads for a page (the Tests page reads each
 * repo's branch and short commit) run at most git_reads.at_once at a time
 * (user.yml; 16 by default, 1 to 64), not one process per read at once.
 */
import { readUserConfig, type UserConfig } from "./den-config.js";

export const GIT_READS = { default: 16, min: 1, max: 64 } as const;

/** git_reads.at_once; a value out of range, or none, is the default. */
export function gitReadsAtOnce(
  read: () => UserConfig = readUserConfig,
): number {
  let v: unknown;
  try {
    v = read().git_reads?.at_once;
  } catch {
    return GIT_READS.default;
  }
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= GIT_READS.min &&
    v <= GIT_READS.max
    ? v
    : GIT_READS.default;
}
