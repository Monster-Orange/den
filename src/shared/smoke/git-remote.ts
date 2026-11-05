/**
 * Git remote URL utilities
 *
 * Extracts the GitHub owner/repo from a git remote URL so the rest of the
 * smoke pipeline can call the GitHub API without requiring this info to be
 * hardcoded in .den.yml.
 *
 * Supported URL formats:
 *   https://github.com/acme/api.git
 *   https://github.com/acme/api
 *   git@github.com:acme/api.git
 */

import { execSync } from "child_process";
import * as fs from "fs";
import { isPlaceholderGithubOrg } from "../den-config.js";

export interface GitHubCoords {
  owner: string;
  repo: string;
}

/**
 * Run `git remote get-url origin` inside the given directory.
 * Returns the raw remote URL string, or null if the directory is not a git
 * repo or has no origin remote.
 */
export function getGitRemoteOrigin(repoPath: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse GitHub owner and repo from a remote URL.
 * Returns null if the URL is not a recognisable GitHub URL.
 */
export function parseGitHubOwnerRepo(remoteUrl: string): GitHubCoords | null {
  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = remoteUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH: git@github.com:owner/repo[.git]
  const sshMatch = remoteUrl.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Convenience: get GitHub coords for a local repo path.
 * Returns null if the remote is absent or not a GitHub remote.
 */
export function getGitHubCoords(repoPath: string): GitHubCoords | null {
  const origin = getGitRemoteOrigin(repoPath);
  if (!origin) return null;
  return parseGitHubOwnerRepo(origin);
}

/**
 * The GitHub owner of the distribution's OWN checkout: `distRoot`'s origin,
 * and only when `distRoot` is the top of its own git repo. A distribution
 * with no repo of its own (one nested in another checkout, such as Den's)
 * has no owner here: the engine's (or any parent's) remote is never used to
 * pick the org whose repos Den lists. Null when there is none.
 */
export function distributionGitHubOwner(distRoot: string): string | null {
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: distRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    if (!top || fs.realpathSync(top) !== fs.realpathSync(distRoot)) return null;
  } catch {
    return null;
  }
  return getGitHubCoords(distRoot)?.owner ?? null;
}

/**
 * The GitHub org whose repos Den lists for "register a managed repo": the
 * org config's `github_org`, else the distribution's own checkout's owner.
 * Never the engine's. Null (the caller asks for github_org) when neither
 * names a valid owner.
 */
export function managedReposOrg(
  githubOrg: string | undefined,
  distRoot: string,
): string | null {
  const set = githubOrg?.trim();
  // A placeholder (`your-github-org`) is not an org: never list it.
  const configured = set && !isPlaceholderGithubOrg(set) ? set : "";
  const org = configured || distributionGitHubOwner(distRoot);
  return org && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org) ? org : null;
}
