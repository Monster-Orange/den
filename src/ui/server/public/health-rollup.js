/**
 * One repo's health from its services' checks: the single rule the header
 * row, its "+N" chip, the graph's repo cards and `<cli> status` all use, so
 * they never disagree (0.3.0-dev.10).
 *
 * A signal is one service's check: `ok` true (up), false (down or failing)
 * or null (not checked: no probe, not probed yet, or nothing to say). Only
 * checked signals count, so a repo of 26 remote services with one probe is
 * judged by that one probe.
 *
 *   down      the entry service (the repo's own health URL) is down
 *   degraded  another checked service is down
 *   ok        at least one signal is checked and none fails
 *   unknown   nothing about the repo is checked (neutral, never green)
 *
 * The entry service is the one marked `isEntrypoint` (the manifest's
 * `entrypoint`), else the service named like the repo, else the only one.
 *
 * Plain ES module with no imports: the browser loads it as /health-rollup.js,
 * and the server and CLI import it from TypeScript.
 */

/** Sort rank: problems first, then unknown, then healthy. */
export const STATE_RANK = { down: 0, degraded: 1, unknown: 2, ok: 3 };

/**
 * @typedef {{ service: string, ok: boolean | null | undefined, isEntrypoint?: boolean }} HealthSignal
 * @typedef {"down" | "degraded" | "ok" | "unknown"} RepoState
 * @typedef {{ state: RepoState, entry: string | null, down: string[], checked: number, unchecked: number }} RepoRollup
 */

/**
 * The entry service among `signals`, or null.
 * @param {string} repo
 * @param {HealthSignal[]} signals
 * @returns {HealthSignal | null}
 */
export function entrySignal(repo, signals) {
  return (
    signals.find((s) => s.isEntrypoint) ??
    signals.find((s) => s.service === repo) ??
    (signals.length === 1 ? signals[0] : null)
  );
}

/**
 * Roll one repo's signals up to its state.
 * @param {string} repo
 * @param {HealthSignal[]} signals
 * @returns {RepoRollup}
 */
export function rollupRepo(repo, signals) {
  const entry = entrySignal(repo, signals);
  const checked = signals.filter((s) => s.ok === true || s.ok === false);
  const down = checked.filter((s) => s.ok === false).map((s) => s.service);
  const state =
    entry && entry.ok === false
      ? "down"
      : down.length > 0
        ? "degraded"
        : checked.length > 0
          ? "ok"
          : "unknown";
  return {
    state,
    entry: entry ? entry.service : null,
    down,
    checked: checked.length,
    unchecked: signals.length - checked.length,
  };
}

/**
 * Every repo's rollup from flat per-service rows (as /api/health sends
 * them), in first-seen order.
 * @param {Array<HealthSignal & { repo: string }>} rows
 * @returns {Map<string, RepoRollup>}
 */
export function rollupRows(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!by.has(r.repo)) by.set(r.repo, []);
    by.get(r.repo).push(r);
  }
  return new Map([...by].map(([repo, s]) => [repo, rollupRepo(repo, s)]));
}

/**
 * "down (web down)", "degraded (mailpit down)", "healthy",
 * "healthy, 25 not checked", "unknown (not checked)".
 * @param {RepoRollup} r
 * @returns {string}
 */
export function describeRollup(r) {
  const notChecked = r.unchecked > 0 ? `${r.unchecked} not checked` : "";
  if (r.state === "unknown") return "unknown (not checked)";
  if (r.state === "ok")
    return notChecked ? `healthy, ${notChecked}` : "healthy";
  return `${r.state} (${r.down.join(", ")} down)`;
}

/**
 * Order repos: problems first, then unknown, then healthy; within a state
 * the focused workspace's repos first, then by name.
 * @param {{ state: RepoState, repo: string, focused?: boolean }} a
 * @param {{ state: RepoState, repo: string, focused?: boolean }} b
 * @returns {number}
 */
export function compareRepos(a, b) {
  return (
    (STATE_RANK[a.state] ?? 2) - (STATE_RANK[b.state] ?? 2) ||
    Number(!!b.focused) - Number(!!a.focused) ||
    String(a.repo).localeCompare(String(b.repo))
  );
}
