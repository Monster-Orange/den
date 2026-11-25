/**
 * Issue 1592: when a file's stat may stand for its content.
 *
 * A file system stamps mtimes and ctimes by a coarse clock: Linux by its
 * timer tick, some file systems by the second or two. A write just after
 * a read can keep the stamps (and the size) the read saw, so a cache keyed
 * on them keeps a stale answer. As git treats a racily clean index entry:
 * an answer read from a file is kept only when the file last changed more
 * than MTIME_TICK_MS before the read. Any write after that read moves its
 * stamps, and the stat no longer matches.
 */
import type * as fs from "fs";

/** How coarse a file system's clock may be (ms). */
export const MTIME_TICK_MS = 2_000;

/**
 * Whether an answer read from a file with stat `st` at `readAt` (the wall
 * clock, ms; never a caller's fake now: stamps come from the wall clock)
 * may be kept while the stat stays the same. A file written within
 * MTIME_TICK_MS of the read, or stamped ahead of the clock, is read again.
 * Its ctime too when given (a cache that must see attribute changes, or
 * a file an install stamps with a fixed mtime).
 */
export function statSettled(
  st: Pick<fs.Stats, "mtimeMs"> & Partial<Pick<fs.Stats, "ctimeMs">>,
  readAt: number,
): boolean {
  return Math.max(st.mtimeMs, st.ctimeMs ?? 0) < readAt - MTIME_TICK_MS;
}
