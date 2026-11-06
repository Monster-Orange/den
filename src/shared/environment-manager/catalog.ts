/**
 * Service Catalog
 *
 * Manages config/local/service-catalog.yml — the per-engineer registry of
 * repos known to den, whether linked (developer's own checkout) or managed
 * (den clones and updates them).
 *
 * Gracefully returns an empty catalog when the file does not exist so that
 * all callers work on a fresh machine without requiring setup first.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import type { ServiceCatalog, ServiceCatalogEntry } from "../types/index.js";
import { getDistRoot } from "../paths.js";
import { readDenConfig, requireGithubOrg } from "../den-config.js";
import {
  parseRemote,
  repoSource,
  type WorkOrgsConfig,
} from "../org-sources.js";
import { checkedRemote, isGitRemote } from "./git-remote.js";

/** Fallback GitHub org when `config/den.yml` doesn't set `github_org`. */

const ROOT = getDistRoot();
const CATALOG_PATH = path.join(ROOT, "config", "local", "service-catalog.yml");

export function readCatalog(): ServiceCatalog {
  try {
    const raw = fs.readFileSync(CATALOG_PATH, "utf-8");
    const parsed = yaml.parse(raw) as unknown;
    if (parsed == null) return {}; // empty file
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `Malformed service catalog at ${CATALOG_PATH}: expected a mapping`,
      );
    }
    return parsed as ServiceCatalog;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export function writeCatalog(catalog: ServiceCatalog): void {
  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CATALOG_PATH, yaml.stringify(catalog), "utf-8");
}

export function upsertCatalogEntry(
  repoName: string,
  entry: ServiceCatalogEntry,
): void {
  const catalog = readCatalog();
  catalog[repoName] = entry;
  writeCatalog(catalog);
}

/**
 * GitHub slug to clone `repoName` from.
 *
 * The catalog's `gh` when set, else the conventional `<org>/<repo>`, where
 * `<org>` is the workspace's resolved org (`github_org` when none is given) —
 * the same rule `seedDefaultWorkspace` uses. Entries written by the
 * dev-managed add flow carry `gh: ""`, so a repo can be IN the catalog and
 * still have no slug; deriving it (rather than refusing to clone) is what lets
 * a repo switched to managed actually be cloned.
 */
export function resolveRepoGhSlug(
  repoName: string,
  catalog: ServiceCatalog = readCatalog(),
  /**
   * The owner for a repo with no `gh`: the workspace's resolved org
   * (`() => githubOrgFor(ws)`, ORG-1a). Called only when needed, so a repo
   * with a slug never needs an org. Defaults to `github_org`.
   */
  owner: () => string = () => requireGithubOrg(),
): string {
  const gh = catalog[repoName]?.gh?.trim();
  if (gh) return gh;
  return `${owner()}/${repoName}`;
}

/**
 * What `repoName` clones from (ORG-1d): a GitHub slug or a git URL (see
 * git-remote.ts). The repo's source decides: a GitHub source gives its slug
 * (`gh`, else `<owner>/<repo>`). A repo with no source and a `remote:` gives
 * that remote, through plain git. Anything else is the legacy GitHub slug
 * (resolveRepoGhSlug), so a catalog without `remote:` clones as before.
 */
export function resolveRepoCloneSource(
  repoName: string,
  catalog: ServiceCatalog = readCatalog(),
  owner: () => string = () => requireGithubOrg(),
  orgs: WorkOrgsConfig | undefined = readDenConfig().orgs,
): string {
  const entry = catalog[repoName];
  const gh = entry?.gh?.trim();
  const remote = entry?.remote?.trim();
  const src = repoSource(repoName, catalog, orgs ?? {});
  if (src?.host === "github") {
    if (gh) return gh;
    const fromRemote = remote ? parseRemote(remote) : null;
    return fromRemote?.host === "github"
      ? `${fromRemote.owner}/${repoName}`
      : `${src.owner ?? ""}/${repoName}`;
  }
  if (remote) return checkedRemote(repoName, remote);
  if (src)
    throw new Error(
      `${repoName}: its org's source is on ${src.host}, which Den clones only ` +
        `from a remote: — set ${repoName}.remote in the service catalog`,
    );
  return resolveRepoGhSlug(repoName, catalog, owner);
}

/**
 * Whether a clone source may be written back as the catalog's `gh` (the
 * empty-slug repair): only a GitHub slug, and only for an entry with no
 * `gh` and no `remote` of its own.
 */
export function needsGhRepair(
  entry: ServiceCatalogEntry | undefined,
  source: string,
): boolean {
  return !isGitRemote(source) && !entry?.gh?.trim() && !entry?.remote?.trim();
}

export function removeCatalogEntry(repoName: string): void {
  const catalog = readCatalog();
  delete catalog[repoName];
  writeCatalog(catalog);
}
