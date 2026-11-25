/**
 * Issue 1270: a project's `agents.watch_repos` in the workspaces file, the
 * extra repos (owner/name) its agents may watch with `github_watch`, beyond
 * the project's own:
 *
 *   workspaces:
 *     north:
 *       agents:
 *         watch_repos: [shared/pipeline]
 *
 * Read-only by construction: the watcher's GitHub client only ever runs
 * `gh api -i <path>` (gh-http.ts). A listed repo adds read-only watching of
 * that repo for the project's agents, with Den's own GitHub sign-in. It is
 * for repos outside Den: one of another Den project's repos is left out
 * (github-watch-routes.ts), since grants are the way into another project.
 * Entries are checked here, where they are read: only owner/name strings
 * count, each once.
 */
import { readWorkspacesFile } from "../environment-manager/workspaces.js";
import type { WorkspacesFile } from "../types/index.js";

/** owner/name, as the watcher checks a repo (no dot segments, no slashes). */
const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** The setting's name, as refusals and docs say it. */
export const WATCH_REPOS_SETTING = "agents.watch_repos";

/**
 * The longest repo arg or entry read, before .git comes off: GitHub's owner
 * is at most 39 characters and its name 100.
 */
export const REPO_MAX = 200;

/**
 * owner/name without its trailing .git, every one (any case): the same
 * repo. A loop, linear in the length (a /(\.git)+$/ regex is quadratic on
 * a long run of .git that doesn't end the name).
 */
export function stripGit(r: string): string {
  let end = r.length;
  while (end >= 4 && r.slice(end - 4, end).toLowerCase() === ".git") end -= 4;
  return end === r.length ? r : r.slice(0, end);
}

/** The owner/name entries of a raw `agents.watch_repos`, each once. */
export function parseWatchRepos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.length > REPO_MAX) continue;
    const r = stripGit(v.trim());
    if (!REPO_RE.test(r)) continue;
    if (out.some((o) => o.toLowerCase() === r.toLowerCase())) continue;
    out.push(r);
  }
  return out;
}

/** Project `ws`'s extra watchable repos; none when unset or unreadable. */
export function projectWatchRepos(
  ws: string,
  read: () => WorkspacesFile = readWorkspacesFile,
): string[] {
  try {
    return parseWatchRepos(read().workspaces[ws]?.agents?.watch_repos);
  } catch {
    return [];
  }
}
