import * as fs from "fs";
import * as path from "path";
import { getInvokeCwd } from "../../shared/paths.js";
import type {
  ResolvedService,
  ServiceCatalog,
  WorkspaceConfig,
} from "../../shared/types/index.js";
import {
  listWorkspaceServices,
  parseAddress,
} from "../../shared/environment-manager/workspaces.js";
import { readManifest } from "../../shared/manifest/read-manifest.js";
import { getGitHubCoords } from "../../shared/smoke/git-remote.js";
import type { AliasResolver } from "../../shared/environment-manager/derivation/alias.js";
import { loadAliasResolver } from "../../shared/environment-manager/derivation/load-alias.js";

import { product } from "../../shared/product.js";
export interface InvocationTarget {
  repoRoot: string;
  repoName: string;
  addresses: string[];
}

function realPathSafe(input: string): string {
  try {
    return fs.realpathSync.native(input);
  } catch {
    return path.resolve(input);
  }
}

function hasRepoMarker(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, `${product().manifestYml}`)) ||
    fs.existsSync(path.join(dir, `${product().manifestJson}`)) ||
    fs.existsSync(path.join(dir, ".git"))
  );
}

export function findInvocationRepoRoot(
  cwd: string = getInvokeCwd(),
): string | null {
  let dir = path.resolve(cwd);
  while (dir.length > 0) {
    if (hasRepoMarker(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * The canonical repo-system the cwd belongs to (and its repo root), identified by
 * IDENTITY not exact path — so it resolves whether you're in a sibling checkout
 * or a managed clone. Tries, in order: the repo's `.den.yml` name, the
 * folder name, the parent folder name (managed clones live at `<repo>/<branch>/`).
 * Returns null when the cwd isn't inside a known repo.
 */
export function resolveCwdRepo(
  alias: AliasResolver = loadAliasResolver(),
): { repo: string; root: string } | null {
  const root = findInvocationRepoRoot();
  if (!root) return null;
  const candidates = [
    readManifest(root)?.name,
    path.basename(root),
    path.basename(path.dirname(root)),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const resolved = alias.resolve(c);
    const node =
      resolved && alias.knownRepos.has(resolved)
        ? resolved
        : alias.knownRepos.has(c)
          ? c
          : undefined;
    if (node) return { repo: node, root };
  }
  return null;
}

function uniqueServices(services: ResolvedService[]): ResolvedService[] {
  const seen = new Set<string>();
  const result: ResolvedService[] = [];
  for (const svc of services) {
    if (seen.has(svc.address)) continue;
    seen.add(svc.address);
    result.push(svc);
  }
  return result;
}

function servicesForRepoPath(
  repoRoot: string,
  services: ResolvedService[],
): ResolvedService[] {
  const target = realPathSafe(repoRoot);
  return services.filter((svc) => realPathSafe(svc.repoPath) === target);
}

function servicesForGitRemote(
  repoRoot: string,
  services: ResolvedService[],
  catalog: ServiceCatalog,
): ResolvedService[] {
  const coords = getGitHubCoords(repoRoot);
  if (!coords) return [];

  const slug = `${coords.owner}/${coords.repo}`.toLowerCase();
  return services.filter((svc) => {
    const catalogSlug = catalog[svc.repoName]?.gh?.toLowerCase();
    return catalogSlug === slug || svc.repoName === coords.repo;
  });
}

function selectAddresses(
  repoRoot: string,
  repoName: string,
  services: ResolvedService[],
): string[] {
  const unique = uniqueServices(services);
  const manifest = readManifest(repoRoot);
  const serviceKeys = Object.keys(manifest?.services ?? {});

  if (serviceKeys.length <= 1 || unique.length <= 1) {
    return [unique[0].address];
  }

  if (manifest?.entrypoint) {
    const entrypointAddress = `${repoName}/${manifest.entrypoint}`;
    const matched = unique.find(
      (svc) =>
        svc.address === entrypointAddress ||
        svc.subsystem === manifest.entrypoint,
    );
    return [matched?.address ?? entrypointAddress];
  }

  return unique.map((svc) => svc.address);
}

export function resolveInvocationTarget(
  workspaceName: string,
  workspace: WorkspaceConfig,
  catalog: ServiceCatalog,
  cwd: string = getInvokeCwd(),
): InvocationTarget | null {
  const repoRoot = findInvocationRepoRoot(cwd);
  if (!repoRoot) return null;

  const workspaceServices = listWorkspaceServices(
    workspace,
    catalog,
    workspaceName,
  );
  const matched = uniqueServices([
    ...servicesForRepoPath(repoRoot, workspaceServices),
    ...servicesForGitRemote(repoRoot, workspaceServices, catalog),
  ]);
  if (matched.length === 0) return null;

  const repoName =
    matched[0].repoName ||
    parseAddress(matched[0].address, catalog).repoName ||
    path.basename(repoRoot);

  return {
    repoRoot,
    repoName,
    addresses: selectAddresses(repoRoot, repoName, matched),
  };
}
