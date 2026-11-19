/**
 * Issue 169 (T2, Den Design's ruling, option a): a project's terminals are
 * named "terminal-1", "terminal-2", ... and shown as "Terminal N". N is per
 * project and the lowest number no listed terminal there holds (exited
 * ones the host still lists included), so it is stable for the session's
 * life and comes back only once the terminal that had it was removed.
 * An older release's names count: "shell" is 1, "shell-2" is 2.
 */

const RE = /^(?:terminal-([1-9]\d{0,8})|shell(?:-([1-9]\d{0,8}))?)$/;

/**
 * The number in a terminal's own name: "terminal-3" and "shell-3" are 3,
 * "shell" is 1. Else null (a name that isn't a terminal's).
 */
export function terminalNumber(name: string): number | null {
  const m = RE.exec(name);
  if (!m) return null;
  return Number(m[1] ?? m[2] ?? 1);
}

/** The lowest number from 1 not in `taken`. */
function lowestFree(taken: Set<number>): number {
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/**
 * The next terminal name in a project: the lowest number no name in
 * `live` holds (every session the host lists there, exited ones too,
 * without the `<dist>-<ws>:` part).
 */
export function nextTerminalName(live: Iterable<string>): string {
  const taken = new Set<number>();
  for (const name of live) {
    const n = terminalNumber(name);
    if (n !== null) taken.add(n);
  }
  return `terminal-${lowestFree(taken)}`;
}

/**
 * The number each of one project's terminals shows (id to N): its name's
 * own, unless one started earlier holds it (an older "shell" and a new
 * "terminal-1"); then the lowest free. A name that isn't a terminal's
 * gets none: it is shown as it is.
 */
export function terminalNumbers(
  rows: readonly { id: string; name: string; startedAt?: string }[],
): Map<string, number> {
  const withNo = rows
    .map((r) => ({ r, n: terminalNumber(r.name) }))
    .filter((x): x is { r: (typeof rows)[number]; n: number } => x.n !== null)
    .sort(
      (a, b) =>
        (a.r.startedAt ?? "").localeCompare(b.r.startedAt ?? "") ||
        a.r.id.localeCompare(b.r.id),
    );
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const { r, n } of withNo) {
    const got = taken.has(n) ? lowestFree(taken) : n;
    taken.add(got);
    out.set(r.id, got);
  }
  return out;
}
