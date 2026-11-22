/**
 * Issue 583: read a file only inside allowed folders.
 *
 * `readWithin` resolves every symlink in the path, checks that the result
 * lies inside one of the roots (themselves resolved), then reads that same
 * resolved path: opened without following a final symlink, and confirmed
 * afterwards to still be the file it checked (same resolved path, same
 * file on disk). A file swapped for a link, or a folder above it swapped
 * for one, between the check and the read is refused, not followed.
 *
 * `broadRootReason` says why a configured repo root is far too broad to
 * read inside (the whole disk, a top-level folder, the home folder or one
 * that holds it, the state folder or one that holds it), or null.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** A read refused because the file is not inside an allowed folder. */
export class OutsideError extends Error {
  readonly code = "EOUTSIDE";
  constructor() {
    super("outside the folders Validate may read");
  }
}

/** `p` resolved through every symlink, or `p` as written when it is gone. */
function resolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Is `x` `root` or inside it (both already resolved)? */
export function isWithin(x: string, root: string): boolean {
  if (x === root) return true;
  const rel = path.relative(root, x);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The roots resolved through their symlinks; a missing one is dropped. */
export function realRoots(roots: readonly string[]): string[] {
  return roots.flatMap((r) => {
    try {
      return [fs.realpathSync(r)];
    } catch {
      return [];
    }
  });
}

export function readWithin(
  file: string,
  roots: readonly string[],
  hooks: { afterCheck?: () => void } = {},
): string {
  const allowed = realRoots(roots);
  const real = fs.realpathSync(file); // ENOENT stays ENOENT
  if (!allowed.some((r) => isWithin(real, r))) throw new OutsideError();
  hooks.afterCheck?.(); // tests only: a swap between the check and the read
  const fd = fs.openSync(
    real,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new OutsideError();
    // What was opened is still the file at the path that was checked.
    let now: fs.Stats;
    let again: string;
    try {
      again = fs.realpathSync(real);
      now = fs.statSync(again);
    } catch {
      throw new OutsideError();
    }
    if (again !== real || now.dev !== opened.dev || now.ino !== opened.ino)
      throw new OutsideError();
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

export interface BroadRootOptions {
  /** The home folder (default: os.homedir()). */
  home?: string;
  /** Den's state folder; a root holding it is refused. */
  stateDir?: string;
}

/** Why `root` is far too broad for a repo root, or null when it is not. */
export function broadRootReason(
  root: string,
  opts: BroadRootOptions = {},
): string | null {
  if (!root || !path.isAbsolute(root)) return null;
  const r = resolved(root);
  if (path.parse(r).root === r) return "it is the whole disk";
  if (path.relative(path.parse(r).root, r).split(path.sep).length < 2)
    return "it is a top-level folder";
  const home = resolved(opts.home ?? os.homedir());
  if (home && isWithin(home, r))
    return home === r ? "it is the home folder" : "it holds the home folder";
  if (opts.stateDir) {
    const state = resolved(opts.stateDir);
    if (isWithin(state, r)) return "it holds this install's state folder";
  }
  return null;
}
