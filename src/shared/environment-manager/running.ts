/**
 * WS-6.3: whether a service runs, so a workspace's status (Running n/m,
 * Partial n/m, Stopped) and its down count are facts from its services.
 *
 * A health check alone can't tell "stopped" from "down": both fail. A
 * service runs when:
 *  - its check answers up; or
 *  - Den started it and still tracks it (a daemon record): its check
 *    failing means it is down; or
 *  - a compose check finds its containers but they aren't healthy (down).
 *    "not running" from a compose check (no containers) is stopped.
 * Anything else that fails is stopped, not down: Stop & Switch leaves the
 * other workspaces stopped, never red.
 */

/** The fields of a health row this reads. */
export interface RunningRow {
  repo: string;
  service: string;
  ok: boolean | null;
  error?: string;
}

/** The addresses Den tracks as started, in both spellings of a single-service repo. */
export function trackedAddresses(
  daemons: readonly { address: string; repoName: string; subsystem: string }[],
): Set<string> {
  const out = new Set<string>();
  for (const d of daemons) {
    out.add(d.address);
    out.add(`${d.repoName}/${d.subsystem}`);
  }
  return out;
}

/** Whether `r` runs (see above). Pure. */
export function isRunning(
  r: RunningRow,
  tracked: ReadonlySet<string>,
): boolean {
  if (r.ok === true) return true;
  if (tracked.has(`${r.repo}/${r.service}`)) return true;
  if (r.repo === r.service && tracked.has(r.repo)) return true;
  // A compose verdict that lists containers (service, state, status per
  // line, tab-separated) found them: they run, unhealthy.
  if (r.ok === false && typeof r.error === "string" && r.error.includes("\t"))
    return true;
  return false;
}
