/**
 * Issue 964: a scheduled command runs from the commit its Allow named.
 *
 * When a person allows a schedule that runs a command on a shared
 * environment, Den records each repo's commit. The run then uses a copy
 * of that commit's files (`git archive`, kept under Den's state folder),
 * never the working tree, so a later edit to a script the command calls,
 * committed or not, can't reach the run. The repo itself is only read.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface PinProbe {
  /** Files among `files` (from the repo root) that differ from HEAD, or untracked. */
  dirty(repoPath: string, files: string[]): string[];
  /** Paths that are symlinks in `commit` (git mode 120000): a pin refuses them. */
  symlinks(repoPath: string, commit: string): string[];
  /** A folder holding the repo's files at `commit`, made fresh; throws when git can't make one, or the commit holds a symlink. */
  tree(
    stateDir: string,
    project: string,
    repoPath: string,
    commit: string,
  ): string;
}

const git = (repoPath: string, args: string[], input?: Buffer) =>
  execFileSync("git", ["-C", repoPath, ...args], {
    stdio: [input ? "pipe" : "ignore", "pipe", "ignore"],
    ...(input ? { input } : {}),
  });

const SHA_RE = /^[0-9a-f]{7,64}$/;

export const realPin: PinProbe = {
  symlinks(repoPath, commit) {
    if (!SHA_RE.test(commit)) throw new Error(`not a commit: ${commit}`);
    return git(repoPath, ["ls-tree", "-r", "-z", commit])
      .toString("utf-8")
      .split("\0")
      .filter((l) => l.startsWith("120000 "))
      .map((l) => l.slice(l.indexOf("\t") + 1));
  },
  dirty(repoPath, files) {
    if (!files.length) return [];
    try {
      return git(repoPath, ["status", "--porcelain", "--", ...files])
        .toString("utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(3).trim());
    } catch {
      return files;
    }
  },
  tree(stateDir, project, repoPath, commit) {
    if (!SHA_RE.test(commit)) throw new Error(`not a commit: ${commit}`);
    // A symlink would run whatever it points at now, not what was allowed.
    const links = realPin.symlinks(repoPath, commit);
    if (links.length)
      throw new Error(`the commit holds symlinks: ${links.join(", ")}`);
    const dir = path.join(
      stateDir,
      "verify",
      project,
      "pins",
      `${path.basename(repoPath)}-${commit}`,
    );
    // Made fresh for each run: a folder left from before may have been changed.
    const tmp = `${dir}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const tar = git(repoPath, ["archive", "--format=tar", commit]);
      execFileSync("tar", ["-x", "-C", tmp], {
        input: tar,
        stdio: ["pipe", "ignore", "ignore"],
      });
      fs.writeFileSync(path.join(tmp, ".den-pin"), commit + "\n");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
      return dir;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
};
