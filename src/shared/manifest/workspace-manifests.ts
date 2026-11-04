/**
 * Every service of the active workspaces, with its repo's manifest: the one
 * list the security scan, the repo suites and the release check walk.
 *
 * Mirrors the server's health walk: the focused workspace first, then the
 * other active ones; an address listed twice keeps its first owner.
 */

import { readCatalog } from "../environment-manager/catalog.js";
import {
  getActiveWorkspaces,
  getFocusedWorkspaceName,
  getWorkspaceByName,
  listWorkspaceServices,
  readManifestAnyBranch,
} from "../environment-manager/workspaces.js";
import type {
  RawManifest,
  ServiceCatalog,
  ServiceManagementConfig,
} from "../types/index.js";
import { orgOf } from "./service-links.js";

export interface WorkspaceService {
  address: string;
  repo: string;
  service: string;
  repoPath: string;
  org: string;
  manifest: RawManifest;
  config: ServiceManagementConfig | undefined;
  isEntrypoint: boolean;
}

export function workspaceNames(workspaceName?: string | null): string[] {
  if (workspaceName)
    return getWorkspaceByName(workspaceName) ? [workspaceName] : [];
  const focus = getFocusedWorkspaceName();
  return [
    ...(focus ? [focus] : []),
    ...getActiveWorkspaces().filter((n) => n !== focus),
  ];
}

export function listServicesWithManifests(
  workspaceName?: string | null,
  catalog: ServiceCatalog = readCatalog(),
): WorkspaceService[] {
  const seen = new Set<string>();
  const out: WorkspaceService[] = [];
  for (const name of workspaceNames(workspaceName)) {
    const ws = getWorkspaceByName(name);
    if (!ws) continue;
    for (const svc of listWorkspaceServices(ws.config, catalog, name)) {
      if (seen.has(svc.address)) continue;
      seen.add(svc.address);
      const manifest = readManifestAnyBranch(svc.repoName, svc.repoPath);
      if (!manifest) continue;
      out.push({
        address: svc.address,
        repo: svc.repoName,
        service: svc.subsystem,
        repoPath: svc.repoPath,
        org: orgOf(svc.repoName, catalog),
        manifest,
        config: manifest.services?.[svc.subsystem],
        isEntrypoint: manifest.entrypoint === svc.subsystem,
      });
    }
  }
  return out;
}

/** One entry per repo (its first service carries the manifest). */
export function listReposWithManifests(
  workspaceName?: string | null,
  catalog: ServiceCatalog = readCatalog(),
): Array<Pick<WorkspaceService, "repo" | "repoPath" | "org" | "manifest">> {
  const byRepo = new Map<
    string,
    Pick<WorkspaceService, "repo" | "repoPath" | "org" | "manifest">
  >();
  for (const s of listServicesWithManifests(workspaceName, catalog))
    if (!byRepo.has(s.repo))
      byRepo.set(s.repo, {
        repo: s.repo,
        repoPath: s.repoPath,
        org: s.org,
        manifest: s.manifest,
      });
  return [...byRepo.values()];
}
