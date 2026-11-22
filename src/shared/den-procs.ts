/**
 * Sign-in: Den's own long-running processes (the web server, the session
 * host, a runner) each record their pid here while they run, so a check
 * of where a command runs can find them among its parents
 * (person-here.ts). One file per process, `<state dir>/den-procs/<role>-<pid>.json`
 * (0600, in a 0700 folder), removed when it exits.
 */
import * as fs from "fs";
import * as path from "path";

export const DEN_PROCS_DIR = "den-procs";

export type DenProcRole = "server" | "sessions-host" | "runner";

const dirOf = (stateDir: string) => path.join(stateDir, DEN_PROCS_DIR);

/**
 * Record this process (or `pid`) as Den's `role` until it exits. Returns
 * what removes the record (also run on exit).
 */
export function registerDenProcess(
  stateDir: string,
  role: DenProcRole,
  pid: number = process.pid,
): () => void {
  const dir = dirOf(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${role}-${pid}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ role, pid }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  const remove = () => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* gone already */
    }
  };
  if (pid === process.pid) process.once("exit", remove);
  return remove;
}

/** Whether a pid is a live process (one Den may not signal counts). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The pids of Den's running processes ([] with none recorded); null when
 * a record can't be read.
 */
export function denProcessPids(
  stateDir: string,
  alive: (pid: number) => boolean = pidAlive,
): number[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(dirOf(stateDir));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const pids: number[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    let rec: { pid?: unknown };
    try {
      rec = JSON.parse(
        fs.readFileSync(path.join(dirOf(stateDir), n), "utf-8"),
      ) as { pid?: unknown };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    if (!rec || !Number.isInteger(rec.pid) || (rec.pid as number) <= 0)
      return null;
    if (alive(rec.pid as number)) pids.push(rec.pid as number);
  }
  return pids;
}
