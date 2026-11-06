/**
 * The child servers a test started (tests/child-servers.ts), recorded so a
 * run can stop the ones its tests could not: a test process killed by a
 * timeout, --forceExit, the OOM limit or Ctrl-C runs no afterAll, and its
 * servers lived on as orphans.
 *
 * One JSON file per process group, in <tmpdir>/den-test-children:
 * { pgid, run, owner, marker }. `run` is the jest run's pid (global setup
 * sets DEN_TEST_RUN), `owner` the test process's, `marker` a string the
 * group's leader's command line must contain before anything is signalled
 * (a pid the system reused is never touched).
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const REGISTRY_DIR = path.join(os.tmpdir(), "den-test-children");

/** Whether `pid` is alive (signal 0). */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

/** Every recorded group, with the file that records it. */
export function records() {
  let names = [];
  try {
    names = fs.readdirSync(REGISTRY_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const file = path.join(REGISTRY_DIR, n);
    try {
      out.push({ file, ...JSON.parse(fs.readFileSync(file, "utf-8")) });
    } catch {
      /* half-written or gone */
    }
  }
  return out;
}

/** The pids of the processes in group `pgid` whose command has `marker`. */
function members(pgid, marker) {
  let ps = "";
  try {
    ps = execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], {
      encoding: "utf-8",
    });
  } catch {
    return [];
  }
  const pids = [];
  let marked = false;
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[2]) !== pgid) continue;
    pids.push(Number(m[1]));
    if (m[3].includes(marker)) marked = true;
  }
  return marked ? pids : [];
}

/**
 * SIGKILL each recorded group that `pick` selects and that still runs what
 * was recorded; drop its record. Returns the groups killed.
 */
export function reap(pick) {
  const killed = [];
  for (const r of records()) {
    if (!pick(r)) continue;
    const pgid = Number(r.pgid);
    if (Number.isInteger(pgid) && pgid > 1 && members(pgid, r.marker).length) {
      try {
        process.kill(-pgid, "SIGKILL");
        killed.push(pgid);
      } catch {
        /* already gone */
      }
    }
    try {
      fs.unlinkSync(r.file);
    } catch {
      /* gone */
    }
  }
  return killed;
}
