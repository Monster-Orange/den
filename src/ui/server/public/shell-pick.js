/**
 * Issue 448: which plain shell the rail's Terminal opens. No DOM here, so
 * the rules run without a browser (tests/unit/server/shell-pick.test.ts).
 */

/**
 * Issue 448: project `ws`'s running plain shell used last (`used`: id to
 * ms; else its start), or null when none runs there. `ws` null: in any
 * project.
 */
export function latestShell(rows, ws, used = {}) {
  const at = (r) =>
    Math.max(
      typeof used[r.id] === "number" ? used[r.id] : 0,
      Date.parse(r.startedAt ?? "") || 0,
    );
  let best = null;
  for (const r of rows ?? [])
    if (
      r?.kind === "session" &&
      !r.exited &&
      (ws === null || r.workspace === ws)
    )
      if (!best || at(r) >= at(best)) best = r;
  return best;
}
