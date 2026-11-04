/**
 * Manifest Discovery
 *
 * Generic layer: scans .den/ for repos that have a .den.json
 * manifest file and returns the raw parsed manifest.
 *
 * Smoke-specific helpers (resolveService) live below and read from the
 * `smoke` key — unrelated to the `services` (service management) key.
 *
 * Local:  .den/<repo> → symlink to sibling repo  (make smoke-link)
 * CI:     .den/<repo> → actual checkout           (smoke.yml workflow)
 */

import * as fs from "fs";
import * as path from "path";
import { readManifest } from "../../shared/manifest/read-manifest.js";
import { cloneDirFor } from "../../shared/smoke/repo-cloner.js";
import { isLocalEnabled } from "../../shared/den-config.js";
import {
  getActiveWorkspace,
  listWorkspaceServices,
} from "../../shared/environment-manager/workspaces.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import { getDistRoot } from "../../shared/paths.js";
import type {
  DiscoveredRepo,
  Environment,
  PerformanceServiceConfig,
  SmokeServiceConfig,
} from "../../shared/types/index.js";

import { product } from "../../shared/product.js";
// Den-root anchored so the legacy-registry branch agrees with the already
// anchored workspace branch from any cwd (reads only — never written).
const ROOT = getDistRoot();
const REGISTERED_FILE = path.resolve(
  ROOT,
  "config",
  "local",
  "registered-repos.json",
);
const LINKED_REPOS_DIR = path.resolve(ROOT, `.${product().name}`);

// ── Generic layer ─────────────────────────────────────────────────────────────

/**
 * Discover all registered repos.
 *
 * When Local Dev is enabled, the active workspace is the source of truth —
 * tests run against the same repos you're developing against. When Local Dev
 * is disabled, we fall back to the legacy registry:
 *   1. config/local/registered-repos.json  (set via `make register-repos`)
 *   2. .den/ symlinks / checkouts       (CI / legacy manual links)
 */
export function discoverRepos(): DiscoveredRepo[] {
  if (isLocalEnabled()) {
    return discoverFromWorkspace();
  }
  return discoverFromRegistry();
}

/** Resolve repos from the active workspace's service set. */
function discoverFromWorkspace(): DiscoveredRepo[] {
  const active = getActiveWorkspace();
  if (!active) return discoverFromRegistry(); // no workspace → fall back

  const catalog = readCatalog();
  const services = listWorkspaceServices(active.config, catalog, active.name);

  const results: DiscoveredRepo[] = [];
  const seen = new Set<string>();

  for (const svc of services) {
    if (!svc.repoPath || seen.has(svc.repoName)) continue;
    seen.add(svc.repoName);
    addRepo(results, seen, svc.repoPath, svc.repoName);
  }

  return results;
}

/** Legacy discovery from registered-repos.json and .den/ symlinks. */
function discoverFromRegistry(): DiscoveredRepo[] {
  const results: DiscoveredRepo[] = [];
  const seen = new Set<string>();

  // Source 1: config/local/registered-repos.json
  if (fs.existsSync(REGISTERED_FILE)) {
    try {
      const paths = JSON.parse(
        fs.readFileSync(REGISTERED_FILE, "utf-8"),
      ) as string[];
      for (const p of paths) addRepo(results, seen, p, path.basename(p));
    } catch (err) {
      console.warn(`  ⚠  Failed to read ${REGISTERED_FILE}: ${err}`);
    }
  }

  // Source 2: .den/ symlinks / CI checkouts
  if (fs.existsSync(LINKED_REPOS_DIR)) {
    for (const entry of fs.readdirSync(LINKED_REPOS_DIR)) {
      const repoPath = path.join(LINKED_REPOS_DIR, entry);
      try {
        fs.lstatSync(repoPath);
      } catch {
        continue;
      }
      addRepo(results, seen, repoPath, entry);
    }
  }

  return results;
}

function addRepo(
  results: DiscoveredRepo[],
  seen: Set<string>,
  repoPath: string,
  fallbackName: string,
): void {
  const manifest = readManifest(repoPath);
  if (!manifest) return;
  try {
    const resolved = fs.realpathSync(repoPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    results.push({
      repoName: manifest.name ?? fallbackName,
      repoPath: resolved,
      manifest,
    });
  } catch (err) {
    // A held manifest can resolve for a managed clone that was never made.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(
        `  ⚠  ${fallbackName}: no checkout at ${repoPath}, skipped. ` +
          `Use your own (${product().cli} use-local ${fallbackName}) or let ${product().cli} clone it (${product().cli} up ${fallbackName}).`,
      );
      return;
    }
    console.warn(`  ⚠  Failed to register repo at ${repoPath}: ${err}`);
  }
}

/**
 * Registered sibling checkout path (no smoke-clone semantics).
 * Used when environment is `local`, `useLocalCheckout` is true, or callers only
 * need the linked repo root (e.g. repo-owned perf tests staging from checkout).
 */
export function resolveRegisteredRepoPath(discovered: DiscoveredRepo): string {
  return discovered.repoPath;
}

/**
 * Resolve the local filesystem path for a repo given a target environment.
 *
 * - local  → the registered/symlinked path (existing behaviour, no clone)
 * - other  → .smoke-clones/{repoName}/{environment}/ by default
 * - any env with useLocalCheckout=true → the registered/symlinked path
 *
 * This is the single integration point for environment-aware path resolution.
 * All callers (setup.ts, setup-global.ts) should go through here instead of
 * reaching into DiscoveredRepo.repoPath directly when running against non-local
 * environments.
 */
export function resolveRepoPath(
  discovered: DiscoveredRepo,
  environment: Environment,
  useLocalCheckout = false,
): string {
  if (environment === "local" || useLocalCheckout) {
    return resolveRegisteredRepoPath(discovered);
  }

  const cloneDir = cloneDirFor(discovered.repoName, environment);
  if (!fs.existsSync(cloneDir)) {
    throw new Error(
      `Smoke clone for "${discovered.repoName}@${environment}" not found at ${cloneDir}.\n` +
        `  Run first: npx tsx src/pillars/smoke/setup-env.ts --env ${environment} --repo ${discovered.repoName}\n` +
        `  Or via make: make smoke-clone env=${environment} repo=${discovered.repoName}`,
    );
  }
  return cloneDir;
}

/**
 * Find a specific repo manifest by name.
 */
export function findManifest(repoName: string): DiscoveredRepo | null {
  const all = discoverRepos();
  return (
    all.find(
      (r) => r.repoName === repoName || path.basename(r.repoPath) === repoName,
    ) ?? null
  );
}

// ── Smoke-specific layer ──────────────────────────────────────────────────────

export interface ResolvedSmokeService extends SmokeServiceConfig {
  /** Absolute path to the smoke test directory */
  testDir: string;
}

export interface ResolvedPerformanceService extends PerformanceServiceConfig {
  /** Absolute path to the performance test directory */
  testDir: string;
}

/**
 * Resolve a smoke service config to absolute paths.
 * Reads from `manifest.smoke.<serviceName>` — not `services`.
 * Returns null if the service is not defined in the manifest.
 */
export function resolveService(
  discovered: DiscoveredRepo,
  serviceName: string,
): ResolvedSmokeService | null {
  const svc = discovered.manifest.smoke?.[serviceName];
  if (!svc) return null;
  return {
    ...svc,
    testDir: path.resolve(discovered.repoPath, svc.testDir),
  };
}

export function resolvePerformanceService(
  discovered: DiscoveredRepo,
  moduleName: string,
): ResolvedPerformanceService | null {
  const perf = discovered.manifest.performance?.[moduleName];
  if (!perf) return null;
  return {
    ...perf,
    testDir: path.resolve(discovered.repoPath, perf.testDir),
  };
}
