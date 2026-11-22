/**
 * A checkout's `origin` URL, read from its git config file instead of by
 * running `git`. Callers on the web server's request path (manifest
 * resolution for every repo without its own manifest) used to spawn
 * `git config --get remote.origin.url` synchronously, one repo after another:
 * ~40-100ms each, which held the event loop for a second on a cold server.
 *
 * Same answer as `git -C <dir> config --get remote.origin.url` for ordinary
 * checkouts and linked worktrees: the repo is found by walking up from `dir`
 * to the first `.git` (a directory, or a `gitdir:` file), and a worktree's
 * config is its common dir's.
 *
 * Issue 583: with `roots` (resolved, checked repo roots), the lookup stays
 * inside them: the walk stops at the root holding `dir`, and the `.git`
 * pointer, the git dir, the common dir and the config file must each be
 * inside a root (the repo itself, or a configured main repo for a linked
 * worktree); anything else is no origin, so the caller falls back to the
 * folder's name. Every file is read without waiting, and only when it is
 * a regular file.
 */
import * as fs from "fs";
import * as path from "path";
import { isWithin, readWithin } from "../manifest/contained-read.js";

/** Keep the lookup inside these resolved repo roots. */
export interface GitLookup {
  roots: readonly string[];
}

/** A regular file's text, read without waiting; else it throws. */
function readRegular(file: string): string {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("not a regular file");
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

/** The git directory for `start` (walking up), or null outside a repo. */
export function findGitDir(start: string, look?: GitLookup): string | null {
  if (look) return findGitDirWithin(start, look.roots);
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      if (st.isFile()) {
        const m = GITDIR_LINE.exec(readRegular(dotGit));
        if (m) return path.resolve(dir, m[1]);
      }
    } catch {
      /* no .git here: keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `p` resolved, when it really is inside one of `roots`; else null. */
function insideRoots(p: string, roots: readonly string[]): string | null {
  try {
    const real = fs.realpathSync.native(p);
    return roots.some((r) => isWithin(real, r)) ? real : null;
  } catch {
    return null;
  }
}

function findGitDirWithin(
  start: string,
  roots: readonly string[],
): string | null {
  let dir = insideRoots(start, roots);
  if (!dir) return null;
  const here = dir;
  // The root holding `start` (the innermost one): the walk ends there.
  const stop = roots
    .filter((r) => isWithin(here, r))
    .sort((a, b) => b.length - a.length)[0];
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(dotGit);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) return dotGit;
    if (st?.isFile()) {
      let text: string;
      try {
        text = readWithin(dotGit, [stop]);
      } catch {
        return null;
      }
      const m = GITDIR_LINE.exec(text);
      if (m) return insideRoots(path.resolve(dir, m[1]), roots);
    }
    if (dir === stop) return null;
    dir = path.dirname(dir);
  }
}

/** The `url` of `[remote "origin"]` in a git config file's text, or null. */
export function originUrlFromConfig(text: string): string | null {
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.*)$/i.exec(line);
    if (m) {
      const value = m[1].replace(/\s+[#;].*$/, "").trim();
      return value.replace(/^"(.*)"$/, "$1") || null;
    }
  }
  return null;
}

/**
 * `dir`'s origin URL, or null (not a checkout, or no origin). Never spawns.
 * With `look`, only inside its roots (see the top of this file).
 */
export function readOriginUrl(dir: string, look?: GitLookup): string | null {
  const gitDir = findGitDir(dir, look);
  if (!gitDir) return null;
  const read = (file: string) =>
    look ? readWithin(file, look.roots) : readRegular(file);
  let common = gitDir;
  let rel = "";
  try {
    rel = read(path.join(gitDir, "commondir")).trim();
  } catch {
    /* not a linked worktree */
  }
  if (rel) {
    const at = path.resolve(gitDir, rel);
    const inside = look ? insideRoots(at, look.roots) : at;
    if (!inside) return null;
    common = inside;
  }
  try {
    return originUrlFromConfig(read(path.join(common, "config")));
  } catch {
    return null;
  }
}
