/**
 * Start and stop a test's child server so it never outlives the run.
 *
 * - `spawnServer` starts it as the leader of its own process group
 *   (`detached`), so a wrapper (the `tsx` CLI) and the server under it are
 *   stopped together, and records the group (tests/child-reaper.mjs).
 * - `stopServer` SIGTERMs the group, waits, then SIGKILLs whatever is left
 *   of it, and drops the record.
 * - A test process that ends without its afterAll (a timeout, a failure,
 *   --forceExit, a kill) leaves the record behind: the run's global teardown
 *   stops the group, or the next run's global setup does.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REGISTRY_DIR = path.join(os.tmpdir(), "den-test-children");
const recordOf = (pgid: number): string =>
  path.join(REGISTRY_DIR, `${pgid}.json`);

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* the group is gone */
  }
}

/**
 * `spawn(cmd, args, opts)` in a process group of its own, recorded. `marker`
 * (default: the last argument, the entry script) is what the reaper checks
 * the group still runs before it signals it.
 */
export function spawnServer(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
  marker: string = args[args.length - 1] ?? cmd,
): ChildProcess {
  const child = spawn(cmd, args, { ...opts, detached: true });
  if (child.pid) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.writeFileSync(
      recordOf(child.pid),
      JSON.stringify({
        pgid: child.pid,
        run: process.env.DEN_TEST_RUN ?? "",
        owner: process.pid,
        marker,
      }),
    );
  }
  return child;
}

/** Whether the group led by `pgid` still has a process in it. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * SIGTERM `child`'s group; after `graceMs` without the group ending,
 * SIGKILL it. Resolves once the group is gone (or after the SIGKILL).
 */
export async function stopServer(
  child: ChildProcess | undefined,
  graceMs = 5_000,
): Promise<void> {
  const pgid = child?.pid;
  if (!pgid) return;
  killGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  if (groupAlive(pgid)) killGroup(pgid, "SIGKILL");
  forgetServer(child);
}

/** Drop `child`'s record (its group was stopped some other way). */
export function forgetServer(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    fs.unlinkSync(recordOf(child.pid));
  } catch {
    /* not recorded */
  }
}
