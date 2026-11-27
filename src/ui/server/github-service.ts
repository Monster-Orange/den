/**
 * GitHub integration service.
 *
 * Extracted from server/index.ts to isolate GitHub API calls, caching,
 * and org detection from the HTTP handler layer.
 */

import { execFile } from "child_process";
import * as path from "path";
import {
  configuredGithubOrg,
  isPlaceholderGithubOrg,
  readDenConfig,
} from "../../shared/den-config.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import { githubOwnersOf } from "../../shared/org-sources.js";
import {
  GH_API_TIMEOUT_MS,
  BRANCH_CACHE_TTL_MS,
  REPO_CACHE_TTL_MS,
} from "../../shared/constants.js";
import { getDistRoot } from "../../shared/paths.js";

import { product } from "../../shared/product.js";
import { isRepoName } from "../../shared/repo-name.js";
// Anchored to the den root, NOT process.cwd(): "this repo" identification
// (basename + origin remote) must not depend on where the server was started.
const ROOT = getDistRoot();

// gh with its args as an array (no shell), off the event loop, with a timeout.
function gh(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { encoding: "utf-8", timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err
          ? reject(Object.assign(err, { stderr: String(stderr ?? "") }))
          : resolve(String(stdout)),
    );
  });
}

export interface GitHubRepo {
  name: string;
  nameWithOwner: string;
  defaultBranch: string;
  hasDen: boolean;
  isArchived: boolean;
}

export class GitHubService {
  private branchesCache = new Map<
    string,
    { names: string[]; fetchedAt: number }
  >();
  private reposCache: { data: GitHubRepo[]; fetchedAt: number } | null = null;
  private warnedNotConfigured = false;

  /**
   * List branches for a GitHub repo slug ("owner/repo").
   * Cached per slug for BRANCH_CACHE_TTL_MS.
   */
  async listBranches(slug: string): Promise<string[]> {
    // Strict owner/name: no shell metacharacters, and never a
    // "." or ".." segment, which would reach another GitHub API path.
    if (!isRepoName(slug)) return [];

    const cached = this.branchesCache.get(slug);
    if (cached && Date.now() - cached.fetchedAt < BRANCH_CACHE_TTL_MS) {
      return cached.names;
    }

    try {
      const raw = await gh(
        ["api", `repos/${slug}/branches?per_page=100`, "--jq", "[.[].name]"],
        GH_API_TIMEOUT_MS,
      );
      const names = JSON.parse(raw.trim() || "[]") as string[];
      this.branchesCache.set(slug, { names, fetchedAt: Date.now() });
      return names;
    } catch {
      return [];
    }
  }

  /**
   * List the repos of every org Den knows (see resolveOrgs), with a hasDen
   * flag. One org failing (no access, SSO) leaves the others listed.
   * Cached for REPO_CACHE_TTL_MS unless forceRefresh is true.
   */
  async listOrgRepos(forceRefresh = false): Promise<GitHubRepo[]> {
    if (
      !forceRefresh &&
      this.reposCache &&
      Date.now() - this.reposCache.fetchedAt < REPO_CACHE_TTL_MS
    ) {
      return this.reposCache.data;
    }

    const orgs = this.resolveOrgs();
    if (orgs.length === 0) {
      if (!this.warnedNotConfigured) {
        this.warnedNotConfigured = true;
        console.log(
          "[github-service] GitHub repos not configured: set `github_org: <your-org>` in " +
            `${product().configFile} to list them (no gh is run until then)`,
        );
      }
      return [];
    }
    const data = (
      await Promise.all(orgs.map((org) => this.listOneOrg(org)))
    ).flat();
    this.reposCache = { data, fetchedAt: Date.now() };
    return data;
  }

  private async listOneOrg(org: string): Promise<GitHubRepo[]> {
    try {
      const raw = await gh(
        [
          "repo",
          "list",
          org,
          "--json",
          "name,nameWithOwner,defaultBranchRef,isArchived",
          "--limit",
          "100",
        ],
        GH_API_TIMEOUT_MS,
      );

      let denRaw: string;
      try {
        denRaw = await gh(
          [
            "api",
            `search/code?q=filename:${product().manifestYml}+org:${org}&per_page=100`,
            "--jq",
            "[.items[].repository.name]",
          ],
          GH_API_TIMEOUT_MS,
        );
      } catch (e) {
        console.warn(
          `[github-service] listOrgRepos: ${product().manifestYml} search failed (has${product().title} flags will be false): ${(e as Error).message}`,
        );
        denRaw = "[]";
      }

      const parsed = JSON.parse(raw) as Array<{
        name: string;
        nameWithOwner: string;
        defaultBranchRef?: { name: string } | null;
        isArchived?: boolean;
      }>;
      const denRepos = new Set<string>(JSON.parse(denRaw) as string[]);

      const thisRepo = path.basename(ROOT);
      const data = parsed
        .filter((r) => r.name !== thisRepo)
        .map((r) => ({
          name: r.name,
          nameWithOwner: r.nameWithOwner,
          defaultBranch: r.defaultBranchRef?.name ?? "main",
          hasDen: denRepos.has(r.name),
          isArchived: r.isArchived ?? false,
        }));

      return data;
    } catch (e) {
      const err = e as Error & { stderr?: string };
      const stderr = (err.stderr ?? "").trim();
      console.warn(
        `[github-service] listOrgRepos: \`gh repo list ${org}\` failed — ` +
          `${err.message}${stderr ? ` | stderr: ${stderr}` : ""}. ` +
          `Check: (1) \`gh auth status\`, (2) \`gh\` is on the PATH of the process running \`make web\`, ` +
          `(3) your PAT is SSO-authorized for ${org}.`,
      );
      return [];
    }
  }

  /**
   * Every GitHub org Den lists repos from: `github_org`, then the orgs in
   * the org config's `orgs:`, then every owner in the catalog (several
   * orgs' repos can sit side by side). With `github_org` unset or still a
   * placeholder (`your-github-org`), none: GitHub is not configured, and Den
   * runs no gh for it.
   */
  private resolveOrgs(): string[] {
    const config = readDenConfig();
    const primary = configuredGithubOrg(config);
    if (!primary) return [];
    const orgs = new Set<string>([primary]);
    // A legacy `orgs:` key is a GitHub owner; an ORG-1d org lists its GitHub
    // sources' owners, and one with no GitHub source adds none (discovery is
    // hidden for it).
    for (const id of Object.keys(config.orgs ?? {}))
      for (const owner of githubOwnersOf(id, config.orgs)) orgs.add(owner);
    for (const entry of Object.values(readCatalog() ?? {})) {
      if (entry?.gh && entry.gh.includes("/")) {
        orgs.add(entry.gh.slice(0, entry.gh.indexOf("/")));
      }
    }
    // GitHub owners are letters, digits and hyphens: anything else is dropped.
    return [...orgs].filter(
      (o) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(o) && !isPlaceholderGithubOrg(o),
    );
  }
}
