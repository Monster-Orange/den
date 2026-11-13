/**
 * setup-default-workspace
 *
 * Builds the "default" workspace non-interactively: every standard system repo,
 * all managed. No prompts, no cloning at setup time — den clones each
 * managed repo on first use, and per-repo mode is a one-click change in the web
 * UX afterwards for anything you actively develop.
 *
 * The repo set is the union of:
 *   1. shop-web (the entry system)
 *   2. the committed release fleet (config/den.yml `release.repos`) — the
 *      authoritative list of standard system repos. A dependency-graph walk
 *      alone misses islands: control-plane has no deps and nothing depends on
 *      it, so no walk from shop-web can ever reach it.
 *   3. a best-effort dependency walk from shop-web — catches deps that aren't
 *      in the release fleet, when sibling checkouts exist to read manifests
 *      from. On a bare machine this contributes nothing, and that's fine.
 *   4. infra-stack — the shared local-infra provider. It only appears as a
 *      dependency inside OTHER repos' manifests, so on a machine with no
 *      checkouts neither the fleet nor the walk can discover it.
 *
 * Usage:
 *   make setup                                    (called from Step 4)
 *   npx tsx src/scripts/setup-default-workspace.ts
 */

import * as fs from "fs";
import * as path from "path";
import { readManifest } from "../shared/manifest/read-manifest.js";
import { depService } from "../shared/manifest/deps.js";
import {
  readWorkspacesFile,
  writeWorkspacesFile,
} from "../shared/environment-manager/workspaces.js";
import { upsertCatalogEntry } from "../shared/environment-manager/catalog.js";
import { getGitHubCoords } from "../shared/smoke/git-remote.js";
import {
  getReposRoot,
  readDenConfig,
  readReleaseConfig,
  requireGithubOrg,
} from "../shared/den-config.js";
import type { WorkspaceServiceEntry } from "../shared/types/index.js";

import { product } from "../shared/product.js";
const WORKSPACE_KEY = "default";

/** The repo the dependency walk starts from: `defaults.workspace.entry`. */
function entryRepo(): string | undefined {
  return readDenConfig().defaults?.workspace?.entry?.trim() || undefined;
}

/**
 * Repos invisible to both the release fleet and a manifest walk on a fresh
 * machine: the shared local-infra repo (`graph.infra.repo`), if any.
 */
function extraStandardRepos(): string[] {
  const infra = readDenConfig().graph?.infra?.repo?.trim();
  return infra ? [infra] : [];
}

/** Extract unique dep repo names from a manifest (strips subsystem, e.g. "shop/api" → "shop"). */
function getDepsFromManifest(repoPath: string): string[] {
  const manifest = readManifest(repoPath);
  if (!manifest?.services) return [];
  const deps = new Set<string>();
  for (const svc of Object.values(manifest.services)) {
    for (const rawDep of svc.depends_on ?? []) {
      const dep = depService(rawDep);
      deps.add(dep.includes("/") ? dep.split("/")[0] : dep);
    }
  }
  return Array.from(deps);
}

/**
 * BFS through the dependency graph, only following repos that exist locally.
 * Returns all reachable dep repo names (excludes startRepoName itself),
 * ordered by discovery depth. Best-effort by construction: a repo that isn't
 * checked out truncates its branch of the walk, which is why the release
 * fleet — not this walk — is the primary seed source.
 */
function collectAllDeps(startRepoName: string, reposRoot: string): string[] {
  const visited = new Set<string>([startRepoName]);
  const ordered: string[] = [];
  const queue: string[] = [path.join(reposRoot, startRepoName)];

  while (queue.length > 0) {
    const repoPath = queue.shift()!;
    if (!fs.existsSync(repoPath)) continue;

    for (const depName of getDepsFromManifest(repoPath)) {
      if (!visited.has(depName)) {
        visited.add(depName);
        ordered.push(depName);
        queue.push(path.join(reposRoot, depName));
      }
    }
  }

  return ordered;
}

/** Union of seed sources, deduped, the entry repo first. Pure given its inputs. */
export function computeSeedRepos(
  fleetRepos: string[],
  graphDeps: string[],
  extras: string[] = [],
  entry?: string,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of [entry, ...fleetRepos, ...graphDeps, ...extras]) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  return ordered;
}

/** Resolve the full seed list from live config + a best-effort manifest walk. Read-only. */
export function deriveSeedRepos(): string[] {
  const reposRoot = getReposRoot();
  const fleet = (readReleaseConfig().repos ?? [])
    .filter((r) => r.enabled !== false)
    .map((r) => r.name);
  const entry = entryRepo();
  return computeSeedRepos(
    fleet,
    entry ? collectAllDeps(entry, reposRoot) : [],
    extraStandardRepos(),
    entry,
  );
}

/** Derive the GitHub slug from a local repo path, falling back to org/repoName. */
function ghSlugFor(repoPath: string, repoName: string, org: string): string {
  const coords = getGitHubCoords(repoPath);
  return coords ? `${coords.owner}/${coords.repo}` : `${org}/${repoName}`;
}

async function main() {
  console.log(`\n  ${product().cli} · Default Workspace Setup\n`);
  console.log(
    '  This builds the "default" workspace — every standard system repo,\n' +
      `  all managed: ${product().cli} clones and keeps each one up to date for\n` +
      "  you, no checkouts or decisions required. For anything you actively\n" +
      "  develop, flip that repo to dev-managed in the web UX (Workspaces)\n" +
      "  and point it at your own checkout.\n",
  );

  const reposRoot = getReposRoot();
  const org = requireGithubOrg();
  const seed = deriveSeedRepos();

  const services: Record<string, WorkspaceServiceEntry> = {};
  for (const repoName of seed) {
    const localPath = path.join(reposRoot, repoName);
    const exists = fs.existsSync(localPath);
    const slug = exists
      ? ghSlugFor(localPath, repoName, org)
      : `${org}/${repoName}`;

    services[repoName] = { mode: "managed", branch: "main" };
    upsertCatalogEntry(repoName, { gh: slug });

    // Every row gets a trailer — a bare row in a column of annotated rows
    // reads as "skipped" even though the entry was written either way.
    console.log(
      `  ✓ ${repoName.padEnd(18)} →  managed (main)${
        exists
          ? `   local checkout at ${localPath} left untouched`
          : `   no local checkout — ${product().cli} clones it on first use`
      }`,
    );
  }

  const wsFile = readWorkspacesFile();
  // Its services only: its other keys (hub_project, name, …) stay.
  wsFile.workspaces[WORKSPACE_KEY] = {
    ...wsFile.workspaces[WORKSPACE_KEY],
    services,
  };
  writeWorkspacesFile(wsFile);

  console.log(
    `\n  ✓ Default workspace configured with ${seed.length} service(s), all managed.`,
  );
  console.log(
    "  Change any repo to dev-managed in the web UX: make web → Workspaces.",
  );
  console.log(`  Run 'make ${product().cli}-up' to start your services.\n`);
}

// Importable without side effects (tests import computeSeedRepos/deriveSeedRepos);
// main runs only when executed directly. argv-based rather than import.meta:
// jest's CJS transform rejects import.meta, and this file must be importable
// under test.
const isDirectRun = Boolean(
  process.argv[1] && /setup-default-workspace\.(ts|js)$/.test(process.argv[1]),
);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
