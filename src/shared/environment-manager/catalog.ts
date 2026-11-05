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
import { requireGithubOrg } from "../den-config.js";

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

export function removeCatalogEntry(repoName: string): void {
  const catalog = readCatalog();
  delete catalog[repoName];
  writeCatalog(catalog);
}
