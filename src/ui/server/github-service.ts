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
import {
  BadCursor,
  branchPage,
  GH_PAGE_MAX,
  type GhRun,
  repoPage,
} from "./github-pages.js";
import type { Page, PageAsk } from "./paging.js";
// Anchored to the den root, NOT process.cwd(): "this repo" identification
// (basename + origin remote) must not depend on where the server was started.
const ROOT = getDistRoot();

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

const ownerOf = (nameWithOwner: string) =>
  nameWithOwner.slice(0, nameWithOwner.indexOf("/"));

function warnOrg(org: string, e: Error): void {
  const stderr = ((e as Error & { stderr?: string }).stderr ?? "").trim();
  console.warn(
    `[github-service] listOrgRepos: listing ${org} failed — ` +
      `${e.message}${stderr ? ` | stderr: ${stderr}` : ""}. ` +
      `Check: (1) \`gh auth status\`, (2) \`gh\` is on the PATH of the process running \`make web\`, ` +
      `(3) your PAT is SSO-authorized for ${org}.`,
  );
}

export interface GitHubRepo {
  name: string;
  nameWithOwner: string;
  defaultBranch: string;
  hasDen: boolean;
  isArchived: boolean;
}

export class GitHubService {
  private pages = new Map<string, { raw: Promise<string>; at: number }>();
  private denRepos = new Map<string, { names: Set<string>; at: number }>();
  private warnedNotConfigured = false;

  private cachedGh(ttl: number): GhRun {
    return (args) => {
      const k = args.join("\0");
      const hit = this.pages.get(k);
      if (hit && Date.now() - hit.at < ttl) return hit.raw;
      if (this.pages.size >= 500) this.pages.clear();
      const raw = gh(args, GH_API_TIMEOUT_MS);
      this.pages.set(k, { raw, at: Date.now() });
      raw.catch(() => this.pages.delete(k));
      return raw;
    };
  }

  /**
   * One page of a GitHub repo's branches ("owner/repo"), names starting
   * with q when set. Each GitHub page is cached for BRANCH_CACHE_TTL_MS.
   */
  async listBranches(
    slug: string,
    ask: PageAsk = { limit: GH_PAGE_MAX, after: null },
    q = "",
  ): Promise<Page<string>> {
    // Strict owner/name: no shell metacharacters, and never a
    // "." or ".." segment, which would reach another GitHub API path.
    if (!isRepoName(slug)) return { items: [], next: null };
    try {
      return await branchPage(this.cachedGh(BRANCH_CACHE_TTL_MS), slug, ask, q);
    } catch (e) {
      if (e instanceof BadCursor) throw e;
      return { items: [], next: null };
    }
  }

  /**
   * One page of the repos of every org Den knows (see resolveOrgs), org by
   * org, with a hasDen flag; names containing q when set. One org failing
   * (no access, SSO) leaves the others listed. Pages are cached for
   * REPO_CACHE_TTL_MS unless forceRefresh is true.
   */
  async listOrgRepos(
    ask: PageAsk = { limit: GH_PAGE_MAX, after: null },
    q = "",
    forceRefresh = false,
  ): Promise<Page<GitHubRepo>> {
    if (forceRefresh) {
      this.pages.clear();
      this.denRepos.clear();
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
      return { items: [], next: null };
    }
    let page;
    try {
      page = await repoPage(
        this.cachedGh(REPO_CACHE_TTL_MS),
        orgs,
        ask,
        q,
        (org, e) => warnOrg(org, e),
      );
    } catch (e) {
      if (e instanceof BadCursor) throw e;
      warnOrg(orgs.join(","), e as Error);
      return { items: [], next: null };
    }
    const owners = [
      ...new Set(page.nodes.map((r) => ownerOf(r.nameWithOwner))),
    ];
    const den = new Map(
      await Promise.all(
        owners.map(async (o) => [o, await this.denReposOf(o)] as const),
      ),
    );
    const thisRepo = path.basename(ROOT);
    const items = page.nodes
      .filter((r) => r.name !== thisRepo)
      .map((r) => ({
        name: r.name,
        nameWithOwner: r.nameWithOwner,
        defaultBranch: r.defaultBranchRef?.name ?? "main",
        hasDen: den.get(ownerOf(r.nameWithOwner))?.has(r.name) ?? false,
        isArchived: r.isArchived ?? false,
      }));
    return { items, next: page.next };
  }

  private async denReposOf(org: string): Promise<Set<string>> {
    const hit = this.denRepos.get(org);
    if (hit && Date.now() - hit.at < REPO_CACHE_TTL_MS) return hit.names;
    let names = new Set<string>();
    try {
      const raw = await gh(
        [
          "api",
          `search/code?q=filename:${product().manifestYml}+org:${org}&per_page=100`,
          "--jq",
          "[.items[].repository.name]",
        ],
        GH_API_TIMEOUT_MS,
      );
      names = new Set(JSON.parse(raw.trim() || "[]") as string[]);
    } catch (e) {
      console.warn(
        `[github-service] listOrgRepos: ${product().manifestYml} search failed (has${product().title} flags will be false): ${(e as Error).message}`,
      );
    }
    this.denRepos.set(org, { names, at: Date.now() });
    return names;
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
