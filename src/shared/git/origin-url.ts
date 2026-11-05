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
 */
import * as fs from "fs";
import * as path from "path";

/** The git directory for `start` (walking up), or null outside a repo. */
export function findGitDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(
          fs.readFileSync(dotGit, "utf-8"),
        );
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

/** `dir`'s origin URL, or null (not a checkout, or no origin). Never spawns. */
export function readOriginUrl(dir: string): string | null {
  const gitDir = findGitDir(dir);
  if (!gitDir) return null;
  let common = gitDir;
  try {
    const rel = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
    if (rel) common = path.resolve(gitDir, rel);
  } catch {
    /* not a linked worktree */
  }
  try {
    return originUrlFromConfig(
      fs.readFileSync(path.join(common, "config"), "utf-8"),
    );
  } catch {
    return null;
  }
}
