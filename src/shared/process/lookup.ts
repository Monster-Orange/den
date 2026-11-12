/**
 * A process lookup (lsof, ps) that tells "found nothing" from "couldn't
 * tell" (D38). A lookup that times out on a busy machine is retried with a
 * longer limit; if it still times out, LookupTimeoutError, never an empty
 * answer. Every caller that decides on a lookup goes through here:
 *
 *   - `web down|restart|up` (web-command): finding its server.
 *   - legacy-adopt: who listens on a service's port, its cwd, the process
 *     table. "Couldn't tell" there is its own verdict: `up` never starts a
 *     second copy and `down` never drops a record on it.
 *   - process-group: the process table for a recorded group. "Couldn't
 *     tell" is null, as when ps can't run: nothing is signalled.
 *   - server-identity: a server's cwd (null: unknown).
 *
 * Before, `web down` read a timed-out lookup as "no server" (0.4.29-dev.1's
 * gate), and the service code read one as "no process" (D38).
 */
import {
  execFile,
  spawnSync,
  type ExecFileException,
  type SpawnSyncReturns,
} from "child_process";
import { CLI_SPAWN_TIMEOUT_MS } from "../constants.js";

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

/** A lookup that couldn't answer: the tool can't run (`strict` only). */
export class LookupError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = "LookupError";
  }
}

/** Every try timed out: couldn't tell. */
export class LookupTimeoutError extends LookupError {
  constructor(command: string) {
    super(command, `${command} took too long to answer`);
    this.name = "LookupTimeoutError";
  }
}

/** ps and lsof print dates and messages in the C locale, whatever the user's. */
export const cLocaleEnv = (
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({ ...env, LC_ALL: "C", LANG: "C" });

export interface LookupOptions {
  /** The tool's env (default: the C locale over this process's). */
  env?: NodeJS.ProcessEnv;
  /** The tries' limits (default: lookupTimeouts()). */
  timeouts?: readonly number[];
  /**
   * A tool that can't run (not installed) is LookupError, not "" (found
   * nothing): for a caller to whom an empty answer means "gone".
   */
  strict?: boolean;
}

const cantRun = (cmd: string, code: unknown) =>
  new LookupError(cmd, `${cmd} couldn't run (${String(code ?? "error")})`);

export type Spawn = (
  cmd: string,
  args: string[],
  opts: { encoding: "utf-8"; timeout: number; env?: NodeJS.ProcessEnv },
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "error" | "signal">;

const timedOut = (r: ReturnType<Spawn>) =>
  (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
  (r.status === null && r.signal !== null && !r.error);

/**
 * `cmd args`' stdout: what it printed, or "" when it ran and found nothing
 * (lsof's and ps's non-zero exit for "no match") or isn't there. Throws
 * LookupTimeoutError when every try timed out.
 */
export function lookup(
  cmd: string,
  args: string[],
  spawn: Spawn = spawnSync,
  opts: LookupOptions = {},
): string {
  const env = opts.env ?? cLocaleEnv();
  for (const timeout of opts.timeouts ?? lookupTimeouts()) {
    const r = spawn(cmd, args, { encoding: "utf-8", timeout, env });
    if (timedOut(r)) continue;
    if (r.error) {
      if (opts.strict)
        throw cantRun(cmd, (r.error as NodeJS.ErrnoException).code);
      return "";
    }
    return r.stdout ?? "";
  }
  throw new LookupTimeoutError(cmd);
}

export type SpawnAsync = (
  cmd: string,
  args: string[],
  opts: { encoding: "utf-8"; timeout: number; env?: NodeJS.ProcessEnv },
  cb: (err: ExecFileException | null, stdout: string) => void,
) => void;

/** lookup, without blocking: the same answers and the same error. */
export async function lookupAsync(
  cmd: string,
  args: string[],
  spawn: SpawnAsync = execFile as unknown as SpawnAsync,
  opts: LookupOptions = {},
): Promise<string> {
  const env = opts.env ?? cLocaleEnv();
  for (const timeout of opts.timeouts ?? lookupTimeouts()) {
    const r = await new Promise<{ err: ExecFileException | null; out: string }>(
      (resolve) =>
        spawn(cmd, args, { encoding: "utf-8", timeout, env }, (err, out) =>
          resolve({ err, out: typeof out === "string" ? out : "" }),
        ),
    );
    // execFile kills a child past its timeout: killed, with its signal.
    if (r.err?.killed && r.err.signal) continue;
    if (r.err && typeof r.err.code !== "number") {
      if (opts.strict) throw cantRun(cmd, r.err.code);
      return "";
    }
    return r.out;
  }
  throw new LookupTimeoutError(cmd);
}
