/**
 * Issue 786 clause 4: rolling snapshots of the person's layout (the rail's
 * pins, collapse, hidden and ordered pages, the dock: user.yml `shell:`),
 * so a broken layout can be put back.
 *
 * A snapshot is taken at most every MIN_GAP_MS (15 minutes), only when the
 * layout differs from the newest one, and the newest MAX_SNAPSHOTS (48) are
 * kept: half a day of steady change, or weeks of a layout that rarely
 * moves. The server takes one before it saves a new layout (so the one a
 * save broke is there to go back to) and one as it shuts down. Each is a
 * file `<state>/layout-snapshots/<time>.json`, written whole.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";

export const SNAPSHOT_DIR = "layout-snapshots";
export const MIN_GAP_MS = 15 * 60_000;
export const MAX_SNAPSHOTS = 48;

export interface LayoutSnapshot {
  /** The file's name without .json: sortable, the time it was taken. */
  id: string;
  /** ISO 8601. */
  at: string;
  /** The shell block as user.yml kept it (undefined: the defaults). */
  shell: unknown;
}

const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function snapshotDir(stateDir: string): string {
  return path.join(stateDir, SNAPSHOT_DIR);
}

function idOf(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/** The snapshots' ids, oldest first. */
function ids(stateDir: string): string[] {
  try {
    return fs
      .readdirSync(snapshotDir(stateDir))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .filter((id) => ID_RE.test(id))
      .sort();
  } catch {
    return [];
  }
}

/** One snapshot, or null (no such id, or unreadable). */
export function readLayoutSnapshot(
  stateDir: string,
  id: string,
): LayoutSnapshot | null {
  if (!ID_RE.test(id)) return null;
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(snapshotDir(stateDir), `${id}.json`), "utf8"),
    ) as { at?: unknown; shell?: unknown };
    if (typeof v.at !== "string") return null;
    return { id, at: v.at, shell: v.shell };
  } catch {
    return null;
  }
}

/** The snapshots, newest first. */
export function listLayoutSnapshots(stateDir: string): LayoutSnapshot[] {
  return ids(stateDir)
    .reverse()
    .flatMap((id) => {
      const s = readLayoutSnapshot(stateDir, id);
      return s ? [s] : [];
    });
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Take a snapshot of `shell` unless the newest is under MIN_GAP_MS old or
 * the same layout. Returns the snapshot taken, or null.
 */
export function snapshotLayout(
  stateDir: string,
  shell: unknown,
  now: Date = new Date(),
  o: { minGapMs?: number; max?: number } = {},
): LayoutSnapshot | null {
  const all = ids(stateDir);
  const newest = all.length
    ? readLayoutSnapshot(stateDir, all[all.length - 1])
    : null;
  if (newest) {
    if (same(newest.shell, shell)) return null;
    const age = now.getTime() - Date.parse(newest.at);
    if (age >= 0 && age < (o.minGapMs ?? MIN_GAP_MS)) return null;
  }
  const id = idOf(now);
  if (all.includes(id)) return null;
  const snap: LayoutSnapshot = { id, at: now.toISOString(), shell };
  writeFileAtomic(
    path.join(snapshotDir(stateDir), `${id}.json`),
    `${JSON.stringify({ at: snap.at, shell }, null, 1)}\n`,
    { mode: 0o600 },
  );
  const keep = o.max ?? MAX_SNAPSHOTS;
  const after = [...all, id];
  for (const old of after.slice(0, Math.max(0, after.length - keep)))
    fs.rmSync(path.join(snapshotDir(stateDir), `${old}.json`), { force: true });
  return snap;
}
