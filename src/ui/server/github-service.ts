/**
 * GitHub integration service.
 *
 * Extracted from server/index.ts to isolate GitHub API calls, caching,
 * and org detection from the HTTP handler layer.
 */

import { execFileSync, execSync } from "child_process";
import * as path from "path";
import { readDenConfig } from "../../shared/den-config.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import {
  GH_API_TIMEOUT_MS,
  GIT_REMOTE_TIMEOUT_MS,
  BRANCH_CACHE_TTL_MS,
  REPO_CACHE_TTL_MS,
} from "../../shared/constants.js";
import { getDistRoot } from "../../shared/paths.js";

import { product } from "../../shared/product.js";
// Anchored to the den root, NOT process.cwd(): "this repo" identification
// (basename + origin remote) must not depend on where the server was started.
const ROOT = getDistRoot();

/** Strict owner/repo format — rejects shell metacharacters. */
const SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

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

  /**
   * List branches for a GitHub repo slug ("owner/repo").
   * Cached per slug for BRANCH_CACHE_TTL_MS.
   */
  listBranches(gh: string): string[] {
    if (!gh || !SLUG_RE.test(gh)) return [];

    const cached = this.branchesCache.get(gh);
    if (cached && Date.now() - cached.fetchedAt < BRANCH_CACHE_TTL_MS) {
      return cached.names;
    }

    try {
      const raw = execFileSync(
        "gh",
        [
          "api",
          "--paginate",
          `repos/${gh}/branches?per_page=100`,
          "--jq",
          "[.[].name]",
        ],
        {
          encoding: "utf-8",
          timeout: GH_API_TIMEOUT_MS * 2,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ).trim();
      const names = raw
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => JSON.parse(line) as string[]);
      this.branchesCache.set(gh, { names, fetchedAt: Date.now() });
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
  listOrgRepos(forceRefresh = false): GitHubRepo[] {
    if (
      !forceRefresh &&
      this.reposCache &&
      Date.now() - this.reposCache.fetchedAt < REPO_CACHE_TTL_MS
    ) {
      return this.reposCache.data;
    }

    const orgs = this.resolveOrgs();
    if (orgs.length === 0) {
      console.warn(
        "[github-service] listOrgRepos: no GitHub org resolvable — " +
          `add \`github_org: <slug>\` to ${product().configFile}, or register at least ` +
          "one catalog entry with a slashed `gh:` field",
      );
      return [];
    }
    const data = orgs.flatMap((org) => this.listOneOrg(org));
    this.reposCache = { data, fetchedAt: Date.now() };
    return data;
  }

  private listOneOrg(org: string): GitHubRepo[] {
    try {
      const repoListCmd = `gh repo list "${org}" --json name,nameWithOwner,defaultBranchRef,isArchived --limit 200`;
      const denSearchCmd = `gh api "search/code?q=filename:${product().manifestYml}+org:${org}&per_page=100" --jq '[.items[].repository.name]'`;

      let denRaw: string;

      const raw = execSync(repoListCmd, {
        encoding: "utf-8",
        timeout: GH_API_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      });

      try {
        denRaw = execSync(denSearchCmd, {
          encoding: "utf-8",
          timeout: GH_API_TIMEOUT_MS,
          stdio: ["pipe", "pipe", "pipe"],
        });
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
      const err = e as Error & { stderr?: Buffer | string };
      const stderr =
        err.stderr instanceof Buffer
          ? err.stderr.toString().trim()
          : (err.stderr ?? "").toString().trim();
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
   * config/den.yml `orgs:`, then every owner in the catalog (several orgs'
   * repos can sit side by side). With none of those, fall back to
   * the den repo's own `origin` URL — makes upgraded installs Just
   *      Work without anyone editing config/den.yml. Existing users
   *      who pre-date `github_org` or had it commented out still get
   *      the right value as long as den itself was cloned from the
   *      same org as their services (the common case).
   */
  private resolveOrgs(): string[] {
    const config = readDenConfig();
    const orgs = new Set<string>();
    if (config.github_org) orgs.add(config.github_org);
    for (const id of Object.keys(config.orgs ?? {})) orgs.add(id);
    for (const entry of Object.values(readCatalog() ?? {})) {
      if (entry?.gh && entry.gh.includes("/")) {
        orgs.add(entry.gh.slice(0, entry.gh.indexOf("/")));
      }
    }
    // Org names reach a shell command: GitHub owners are letters, digits and
    // hyphens, so anything else is dropped.
    const valid = [...orgs].filter((o) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(o));
    if (valid.length > 0) return valid;
    const fallback = this.originOrg();
    return fallback ? [fallback] : [];
  }

  private originOrg(): string | null {
    // Fall back to the den repo's origin. Works for:
    //   SSH:   git@github.com:ORG/den.git
    //   HTTPS: https://github.com/ORG/den.git
    //          https://github.com/ORG/den
    try {
      const url = execFileSync(
        "git",
        ["-C", ROOT, "config", "--get", "remote.origin.url"],
        {
          encoding: "utf-8",
          timeout: GIT_REMOTE_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      const m = url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
      if (m) return m[1];
    } catch {
      /* no git remote available */
    }

    return null;
  }
}
