/**
 * A process lookup (lsof, ps) that tells "found nothing" from "couldn't
 * tell". A lookup that times out on a busy machine is retried with a longer
 * limit; if it still times out, LookupTimeoutError, never an empty answer.
 * Before, `web down` read a timed-out lookup as "no server", answered
 * `stopped: false`, and left the server running (0.4.29-dev.1's gate).
 */
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { CLI_SPAWN_TIMEOUT_MS } from "../../shared/constants.js";

/** First try, then one longer one: a busy machine, not a hung tool. */
export const LOOKUP_TIMEOUTS_MS = [CLI_SPAWN_TIMEOUT_MS, 20_000] as const;

/**
 * The tries' limits: DEN_LOOKUP_TIMEOUTS_MS (ms, comma-separated, each
 * above 0), else LOOKUP_TIMEOUTS_MS. A bad value: the defaults.
 */
export function lookupTimeouts(
  env: NodeJS.ProcessEnv = process.env,
): readonly number[] {
  const raw = env.DEN_LOOKUP_TIMEOUTS_MS?.trim();
  if (!raw) return LOOKUP_TIMEOUTS_MS;
  const ms = raw.split(",").map((x) => Number(x.trim()));
  return ms.length > 0 && ms.every((n) => Number.isInteger(n) && n > 0)
    ? ms
    : LOOKUP_TIMEOUTS_MS;
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
