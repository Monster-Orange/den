/**
 * WS-6.3: whether a service runs, so a workspace's status (Running n/m,
 * Partial n/m, Stopped) and its down count are facts from its services.
 *
 * A health check alone can't tell "stopped" from "down": both fail. A
 * service runs when:
 *  - its check answers up; or
 *  - Den started it and still tracks it (a daemon record whose process
 *    group is alive): its check failing means it is down; or
 *  - a compose check finds its containers but they aren't healthy (down).
 *    "not running" from a compose check (no containers) is stopped.
 * Anything else that fails is stopped, not down: Stop & Switch leaves the
 * other workspaces stopped, never red.
 *
 * A record whose process group has exited (or whose pid another process
 * now holds) is stale: the service died without `down`. It doesn't run, so
 * Switch starts it, and with a failing check it is down (it crashed; nobody
 * stopped it). A record Den can't check is trusted, as before: one without
 * a process group (written before 0.3.0-dev.37), one with containers (they
 * outlive the command that started them), one whose command handed off and
 * exited 0 (`make up`), or any record when `ps` can't run.
 */
import { classifyGroup, type PsRow } from "../process/process-group.js";

/** The fields of a health row this reads. */
export interface RunningRow {
  repo: string;
  service: string;
  ok: boolean | null;
  error?: string;
}

/** The fields of a daemon record this reads. */
export interface TrackedRecord {
  address: string;
  repoName: string;
  subsystem: string;
  pgid?: number;
  pgidStartedAt?: string;
  containers?: string[];
  handedOff?: boolean;
}

/**
 * Whether a record's process still runs (see above): "dead" only when its
 * process group is verifiably gone or reused; `rows` is one `ps` listing
 * (processRows), null when it couldn't be read. Pure.
 */
export function recordLiveness(
  d: TrackedRecord,
  rows: readonly PsRow[] | null,
): "live" | "dead" {
  if (!rows) return "live";
  if (typeof d.pgid !== "number" || !d.pgidStartedAt) return "live";
  if ((d.containers?.length ?? 0) > 0 || d.handedOff) return "live";
  const state = classifyGroup({ pgid: d.pgid, startedAt: d.pgidStartedAt }, [
    ...rows,
  ]).state;
  return state === "ours" ? "live" : "dead";
}

function addressesOf(daemons: readonly TrackedRecord[]): Set<string> {
  const out = new Set<string>();
  for (const d of daemons) {
    out.add(d.address);
    out.add(`${d.repoName}/${d.subsystem}`);
  }
  return out;
}

/**
 * The addresses Den tracks as started and still running, in both
 * spellings of a single-service repo. Without `rows` every record counts.
 */
export function trackedAddresses(
  daemons: readonly TrackedRecord[],
  rows: readonly PsRow[] | null = null,
): Set<string> {
  return addressesOf(daemons.filter((d) => recordLiveness(d, rows) === "live"));
}

/** The addresses whose record is stale: its process died without `down`. */
export function deadAddresses(
  daemons: readonly TrackedRecord[],
  rows: readonly PsRow[] | null,
): Set<string> {
  return addressesOf(daemons.filter((d) => recordLiveness(d, rows) === "dead"));
}

function hasRow(set: ReadonlySet<string>, r: RunningRow): boolean {
  return (
    set.has(`${r.repo}/${r.service}`) ||
    (r.repo === r.service && set.has(r.repo))
  );
}

/** Whether `r` runs (see above). Pure. */
export function isRunning(
  r: RunningRow,
  tracked: ReadonlySet<string>,
): boolean {
  if (r.ok === true) return true;
  if (hasRow(tracked, r)) return true;
  // A compose verdict that lists containers (service, state, status per
  // line, tab-separated) found them: they run, unhealthy.
  if (r.ok === false && typeof r.error === "string" && r.error.includes("\t"))
    return true;
  return false;
}

/**
 * Whether `r` is down: it runs and its check fails, or Den started it, its
 * process died without `down` (a stale record, `dead`), and its check
 * fails. A service that was stopped is never down. Pure.
 */
export function isDown(
  r: RunningRow,
  tracked: ReadonlySet<string>,
  dead: ReadonlySet<string> = new Set(),
): boolean {
  if (r.ok !== false) return false;
  return isRunning(r, tracked) || hasRow(dead, r);
}
