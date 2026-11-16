/**
 * Issue 208: "what changed" (VERIFY-SPEC section 5, "Not all at once").
 *
 * Each module's latest result on an environment is kept with the commit
 * it ran at (<state>/verify/<project>/latest.json). A module changed
 * when its repo's tracked files changed since that commit (committed,
 * staged, or not yet committed) and its `watch` globs match one; with no `watch`, any
 * change in its repo counts. A module with no result yet was never
 * checked, so it counts too.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type ResultState = "passed" | "failed" | "error" | "blocked";

/** A module's latest result on one environment. */
export interface LatestResult {
  /** The commit it ran at (null: not a git checkout). */
  commit: string | null;
  state: ResultState;
  /** ISO time. */
  at: string;
  runId?: string;
}

/** Latest results by environment, then by module id. */
export type LatestByEnv = Record<string, Record<string, LatestResult>>;

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function latestFile(stateDir: string, project: string): string {
  if (!PROJECT_RE.test(project))
    throw new Error(`"${project}" is not a project's name`);
  return path.join(stateDir, "verify", project, "latest.json");
}

/** The project's latest results ({} when there are none yet). */
export function readLatest(stateDir: string, project: string): LatestByEnv {
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(latestFile(stateDir, project), "utf-8"),
    );
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as LatestByEnv)
      : {};
  } catch {
    return {};
  }
}

/** Records these results as the latest on `env` (others stay). */
export function writeLatest(
  stateDir: string,
  project: string,
  env: string,
  results: Record<string, LatestResult>,
): void {
  const file = latestFile(stateDir, project);
  const all = readLatest(stateDir, project);
  all[env] = { ...(all[env] ?? {}), ...results };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** What Den asks git about a repo. */
export interface GitProbe {
  /** The checked-out commit, or null (not a git checkout). */
  head(repoPath: string): string | null;
  /**
   * Files (from the repo's root) changed since `commit`, committed or
   * not; null when git can't say (the commit is gone): counts as changed.
   */
  changedSince(repoPath: string, commit: string): string[] | null;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export const realGit: GitProbe = {
  head(repoPath) {
    try {
      return git(repoPath, ["rev-parse", "HEAD"]).trim() || null;
    } catch {
      return null;
    }
  },
  changedSince(repoPath, commit) {
    // Tracked files only: an untracked file that stays (a local .env)
    // would count as a change on every run.
    try {
      return git(repoPath, ["diff", "--name-only", commit, "--"])
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return null;
    }
  },
};

/** A watch glob as a regular expression: `**` any folders, `*` and `?` in one. */
export function globRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, "");
  // A plain folder ("web/src" or "web/src/") stands for what is in it.
  if (!/[*?[]/.test(g)) g = g.replace(/\/$/, "") + "{,/**}";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (g.startsWith("{,/**}", i)) {
      re += "(?:/.*)?";
      i += 5;
    } else if (g.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (g.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export type ChangeState = "changed" | "never" | "unchanged";

/**
 * For each module (by id): changed since its latest result here, never
 * checked here, or unchanged. `latest`: the environment's latest results.
 */
export function moduleChanges(
  modules: readonly {
    id: string;
    repoPath: string;
    watch?: string[];
  }[],
  latest: Record<string, LatestResult>,
  probe: GitProbe = realGit,
): Record<string, ChangeState> {
  const seen = new Map<string, string[] | null>();
  const filesSince = (repoPath: string, commit: string) => {
    const k = `${repoPath}\0${commit}`;
    if (!seen.has(k)) seen.set(k, probe.changedSince(repoPath, commit));
    return seen.get(k) ?? null;
  };
  const out: Record<string, ChangeState> = {};
  for (const m of modules) {
    const rec = latest[m.id];
    if (!rec) {
      out[m.id] = "never";
      continue;
    }
    const files = rec.commit ? filesSince(m.repoPath, rec.commit) : null;
    if (files === null) {
      out[m.id] = "changed";
      continue;
    }
    const res = m.watch?.map(globRegExp);
    const hit = res
      ? files.some((f) => res.some((r) => r.test(f)))
      : files.length > 0;
    out[m.id] = hit ? "changed" : "unchanged";
  }
  return out;
}
