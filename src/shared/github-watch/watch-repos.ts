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
 * `gh api -i <path>` (gh-http.ts), with Den's existing GitHub sign-in. The
 * list grants no new access; it only lets the watcher read what that
 * sign-in can already read. Entries are checked here, where they are read:
 * only owner/name strings count, each once.
 */
import { readWorkspacesFile } from "../environment-manager/workspaces.js";
import type { WorkspacesFile } from "../types/index.js";

/** owner/name, as the watcher checks a repo (no dot segments, no slashes). */
const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** The setting's name, as refusals and docs say it. */
export const WATCH_REPOS_SETTING = "agents.watch_repos";

/** The owner/name entries of a raw `agents.watch_repos`, each once. */
export function parseWatchRepos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const r = v.trim();
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
