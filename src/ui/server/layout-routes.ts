/**
 * Issue 786 (part 3b): Settings › Navigation › Layout snapshots. The
 * person lists the rolling snapshots of their layout (layout-snapshots.ts)
 * and puts one back with a click.
 *
 *   GET  /api/layout/snapshots   { snapshots: [{ id, at, pins, hidden,
 *                                  collapsed, current }], shell_rev }
 *   POST /api/layout/restore     { id } → { ok, shell_rev }
 *
 * A restore first keeps the layout it replaces (no 15-minute gap), so it
 * can be undone. Every stored layout has a revision (shell_rev): a page
 * that saves its layout sends the revision it loaded (X-Den-Layout-Rev),
 * and a save from a page whose copy is older (another window restored one
 * meanwhile) is refused with 409 and the layout now, so the page shows it
 * instead of writing its old copy over the restore. A save without the
 * header (an older page) is taken as before.
 */
import { createHash } from "crypto";
import {
  listLayoutSnapshots,
  readLayoutSnapshot,
  snapshotLayout,
} from "../../shared/layout-snapshots.js";

/** The stored layout's revision: a short hash of user.yml's `shell`. */
export function layoutRev(shell: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(shell ?? null))
    .digest("hex")
    .slice(0, 16);
}

/** Whether a layout save was made from a copy older than the one stored. */
export function staleLayoutSave(sentRev: unknown, stored: unknown): boolean {
  return typeof sentRev === "string" && sentRev !== layoutRev(stored);
}

const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

export interface LayoutRow {
  id: string;
  at: string;
  pins: number;
  hidden: number;
  collapsed: boolean;
  /** This snapshot is the layout now. */
  current: boolean;
}

export function layoutSnapshotsAnswer(
  stateDir: string,
  stored: unknown,
): { snapshots: LayoutRow[]; shell_rev: string } {
  const rev = layoutRev(stored);
  return {
    snapshots: listLayoutSnapshots(stateDir).map((s) => {
      const sh = (s.shell ?? {}) as {
        pins?: unknown;
        hidden?: unknown;
        collapsed?: unknown;
      };
      return {
        id: s.id,
        at: s.at,
        pins: count(sh.pins),
        hidden: count(sh.hidden),
        collapsed: sh.collapsed === true,
        current: layoutRev(s.shell) === rev,
      };
    }),
    shell_rev: rev,
  };
}

export type RestoreAnswer =
  | { status: 200; body: { ok: true; shell_rev: string } }
  | { status: 400 | 404; body: { ok: false; error: string } };

export function restoreLayout(
  stateDir: string,
  id: unknown,
  readShell: () => unknown,
  writeShell: (shell: unknown) => void,
  now: Date = new Date(),
): RestoreAnswer {
  if (typeof id !== "string" || !id)
    return { status: 400, body: { ok: false, error: "id is required" } };
  const pick = readLayoutSnapshot(stateDir, id);
  if (!pick)
    return {
      status: 404,
      body: { ok: false, error: `no layout snapshot ${id}` },
    };
  snapshotLayout(stateDir, readShell(), now, { minGapMs: 0 });
  writeShell(pick.shell);
  return { status: 200, body: { ok: true, shell_rev: layoutRev(pick.shell) } };
}
