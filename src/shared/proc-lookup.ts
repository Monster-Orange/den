/**
 * A process lookup (lsof, ps) that tells "found nothing" from "couldn't
 * tell". A lookup that times out on a busy machine is retried with a longer
 * limit; if it still times out, LookupTimeoutError, never an empty answer.
 * Before, `web down` read a timed-out lookup as "no server", answered
 * `stopped: false`, and left the server running (0.4.29-dev.1's gate).
 */
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { CLI_SPAWN_TIMEOUT_MS } from "./constants.js";
import { readUserConfig } from "./den-config.js";

/**
 * Each try's limit, a Setting with a permissive default
 * (user.yml process_lookup.first_seconds, retry_seconds).
 */
export const LOOKUP_LIMITS = {
  first_seconds: { min: 0.5, max: 600, default: CLI_SPAWN_TIMEOUT_MS / 1000 },
  retry_seconds: { min: 1, max: 600, default: 20 },
} as const;

/** First try, then one longer one: a busy machine, not a hung tool. */
export const LOOKUP_TIMEOUTS_MS = [
  LOOKUP_LIMITS.first_seconds.default * 1000,
  LOOKUP_LIMITS.retry_seconds.default * 1000,
] as const;

/** user.yml, read at most once in a few seconds (each connection asks). */
let USER: { at: number; v: { process_lookup?: unknown } } | null = null;
function cachedUser(): { process_lookup?: unknown } {
  if (!USER || Date.now() - USER.at > 5_000)
    USER = { at: Date.now(), v: readUserConfig() };
  return USER.v;
}

/**
 * The tries' limits: DEN_LOOKUP_TIMEOUTS_MS (ms, comma-separated, each
 * above 0) when set and valid; else user.yml process_lookup;
 * else LOOKUP_TIMEOUTS_MS. A bad or missing value: its default.
 */
export function lookupTimeouts(
  env: NodeJS.ProcessEnv = process.env,
  read: () => { process_lookup?: unknown } = cachedUser,
): readonly number[] {
  const raw = env.DEN_LOOKUP_TIMEOUTS_MS?.trim();
  if (raw) {
    const ms = raw.split(",").map((x) => Number(x.trim()));
    if (ms.length > 0 && ms.every((n) => Number.isInteger(n) && n > 0))
      return ms;
  }
  let b: Record<string, unknown> = {};
  try {
    const v = read().process_lookup;
    if (v && typeof v === "object" && !Array.isArray(v))
      b = v as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const one = (k: keyof typeof LOOKUP_LIMITS) => {
    const l = LOOKUP_LIMITS[k];
    const v = b[k];
    return typeof v === "number" &&
      Number.isFinite(v) &&
      v >= l.min &&
      v <= l.max
      ? Math.round(v * 1000)
      : l.default * 1000;
  };
  return [one("first_seconds"), one("retry_seconds")];
}

export class LookupTimeoutError extends Error {
  constructor(readonly command: string) {
    super(`${command} took too long to answer`);
    this.name = "LookupTimeoutError";
  }
}

type Spawn = (
  cmd: string,
  args: string[],
  opts: { encoding: "utf-8"; timeout: number },
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "error" | "signal">;

const timedOut = (r: ReturnType<Spawn>) =>
  (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
  (r.status === null && r.signal !== null && !r.error);

/**
 * `cmd args`' stdout, or "" when it ran and found nothing (a non-zero
 * exit: lsof's "no match", ps's "no such pid") or isn't there. Throws
 * LookupTimeoutError when every try timed out.
 */
export function lookup(
  cmd: string,
  args: string[],
  spawn: Spawn = spawnSync,
  timeouts: readonly number[] = lookupTimeouts(),
): string {
  for (const timeout of timeouts) {
    const r = spawn(cmd, args, { encoding: "utf-8", timeout });
    if (timedOut(r)) continue;
    return r.status === 0 ? (r.stdout ?? "") : "";
  }
  throw new LookupTimeoutError(cmd);
}
