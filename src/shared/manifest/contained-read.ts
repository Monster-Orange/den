/**
 * Issue 583: read a file only inside allowed folders.
 *
 * `readWithin` resolves every symlink in the path, checks that the result
 * lies inside one of the roots, then reads that same resolved path: opened
 * without following a final symlink and without waiting, refused unless it
 * is a regular file, and confirmed afterwards to still be the file it
 * checked (same resolved path, same file on disk). The roots are used as
 * given: callers resolve and check them once (`realRoots`), up front.
 *
 * `rootRefusal` says why a configured repo root can't be a root: far too
 * broad to read inside (`broadRootReason`: the whole disk, a top-level
 * folder, the home folder or one that holds it, the state folder or one
 * that holds it, however the path is spelled), or not a git checkout.
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
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** The macOS data volume, which reaches the same folders by another path. */
const DATA_VOLUME = "/System/Volumes/Data";

/**
 * A resolved path in one spelling for comparing: on macOS without the data
 * volume's prefix, and in lower case where the disk ignores case.
 */
function comparable(p: string): string {
  let q = p;
  if (process.platform === "darwin") {
    if (q === DATA_VOLUME) q = "/";
    else if (q.startsWith(DATA_VOLUME + "/")) q = q.slice(DATA_VOLUME.length);
  }
  return process.platform === "darwin" || process.platform === "win32"
    ? q.toLowerCase()
    : q;
}

/** Is `x` `root` or inside it (both already resolved)? */
export function isWithin(x: string, root: string): boolean {
  if (x === root) return true;
  const rel = path.relative(root, x);
  return (
    !!rel &&
    rel !== ".." &&
    !rel.startsWith(".." + path.sep) &&
    !path.isAbsolute(rel)
  );
}

/** The roots resolved through their symlinks; a missing one is dropped. */
export function realRoots(roots: readonly string[]): string[] {
  return roots.flatMap((r) => {
    try {
      return [fs.realpathSync.native(r)];
    } catch {
      return [];
    }
  });
}

/** `file`'s text, when it really is inside one of `roots` (as given). */
export function readWithin(
  file: string,
  roots: readonly string[],
  hooks: { afterCheck?: () => void } = {},
): string {
  const real = fs.realpathSync.native(file); // ENOENT stays ENOENT
  if (!roots.some((r) => isWithin(real, r))) throw new OutsideError();
  hooks.afterCheck?.(); // tests only: a swap between the check and the read
  const fd = fs.openSync(
    real,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new OutsideError();
    // What was opened is still the file at the path that was checked.
    let now: fs.Stats;
    let again: string;
    try {
      again = fs.realpathSync.native(real);
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
  /** This install's state folder; a root holding it is refused. */
  stateDir?: string;
}

/** Why `root` is far too broad for a repo root, or null when it is not. */
export function broadRootReason(
  root: string,
  opts: BroadRootOptions = {},
): string | null {
  if (!root || !path.isAbsolute(root)) return null;
  const r = comparable(resolved(root));
  if (path.parse(r).root === r) return "it is the whole disk";
  if (path.relative(path.parse(r).root, r).split(path.sep).length < 2)
    return "it is a top-level folder";
  const home = comparable(resolved(opts.home ?? os.homedir()));
  if (home && isWithin(home, r))
    return home === r ? "it is the home folder" : "it holds the home folder";
  if (opts.stateDir) {
    const state = comparable(resolved(opts.stateDir));
    if (isWithin(state, r)) return "it holds this install's state folder";
  }
  return null;
}

/** Does `root` hold a `.git` (a folder, or a worktree's pointer file)? */
export function holdsGit(root: string): boolean {
  try {
    const st = fs.lstatSync(path.join(root, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * The top of the git work tree `root` is in (resolved): `root` itself or
 * the nearest folder above it that holds a `.git`; null outside one.
 */
export function gitTop(root: string): string | null {
  let dir: string;
  try {
    dir = fs.realpathSync.native(root);
  } catch {
    return null;
  }
  for (;;) {
    if (holdsGit(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Why `root` can't be a repo root, or null when it can: it is far too
 * broad, or it is not in a git work tree whose top is itself a sound root
 * (a home folder kept in git makes no folder in it a root). A folder inside
 * a repo (a monorepo's app) can be a root.
 */
export function rootRefusal(
  root: string,
  opts: BroadRootOptions = {},
): string | null {
  if (!root || !path.isAbsolute(root)) return "it is not an absolute path";
  const broad = broadRootReason(root, opts);
  if (broad) return broad;
  const top = gitTop(root);
  if (!top)
    return "it is not a git checkout, nor in one (no .git in it or above it)";
  const topBroad = broadRootReason(top, opts);
  return topBroad
    ? `the git checkout it is in is far too broad (${topBroad})`
    : null;
}
