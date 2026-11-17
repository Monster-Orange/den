/**
 * One way to replace a file that another process or request may be reading
 * (#380): the body goes to a temp file in the same folder, is flushed to
 * disk, then renamed over the target. A reader sees the old file or the new
 * one, never an empty or half-written one. A plain fs.writeFileSync empties
 * the file first, and a reader in that window got "er-engineer preferences"
 * instead of a config.
 *
 * Logs and other append-only files do not need this; config and state do.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface AtomicWriteOptions {
  /**
   * The file's mode. When left out, an existing file keeps its mode; a new
   * one gets the usual default (0666 less the umask).
   */
  mode?: number;
  /**
   * Create only: fail with EEXIST when the file is already there, like
   * writeFileSync's `wx` flag, but the file appears whole (a hard link from
   * the temp file, not a rename).
   */
  exclusive?: boolean;
}

/** The temp file's name: same folder, unique per process and call. */
export function atomicTempPath(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

/** Writes `data` to `file` whole: temp file, flush, rename (see top). */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = opts.mode ?? existingMode(file);
  const tmp = atomicTempPath(file);
  try {
    fs.writeFileSync(tmp, data, {
      flag: "wx",
      flush: true,
      ...(mode === undefined ? {} : { mode }),
    });
    // The open's mode is masked by the umask; set the one asked for exactly.
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    if (opts.exclusive) {
      fs.linkSync(tmp, file);
      fs.rmSync(tmp, { force: true });
    } else fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function existingMode(file: string): number | undefined {
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    return st ? st.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}
