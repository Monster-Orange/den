import { readUserConfig, type UserConfig } from "./den-config.js";

export const GIT_READS = { default: 16, min: 1, max: 64 } as const;

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
