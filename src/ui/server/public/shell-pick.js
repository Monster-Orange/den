/**
 * Issue 448: which plain shell the rail's Terminal opens. No DOM here, so
 * the rules run without a browser (tests/unit/server/shell-pick.test.ts).
 */

/**
 * Issue 448: when shell row `r` was last used, in ms: the latest of when a
 * person last typed in it (`r.inputAt`, the server's, any browser), when
 * this browser last used it (`used[r.id]`), and when it started.
 */
export function shellUsedAt(r, used = {}) {
  return Math.max(
    typeof used[r.id] === "number" ? used[r.id] : 0,
    Date.parse(r.inputAt ?? "") || 0,
    Date.parse(r.startedAt ?? "") || 0,
  );
}

/**
 * Issue 448: project `ws`'s running plain shell used last (shellUsedAt),
 * or null when none runs there. `ws` null: in any project (All projects).
 * An exited shell is never one. The list's order never decides.
 */
export function latestShell(rows, ws, used = {}) {
  let best = null;
  for (const r of rows ?? [])
    if (
      r?.kind === "session" &&
      !r.exited &&
      (ws === null || r.workspace === ws)
    )
      if (!best || shellUsedAt(r, used) >= shellUsedAt(best, used)) best = r;
  return best;
}
