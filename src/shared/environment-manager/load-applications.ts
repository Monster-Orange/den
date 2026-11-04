/** Applications for a workspace, from config and repo manifests. */
import { readDenConfig } from "../den-config.js";
import { resolveApplications, type Application } from "../applications.js";
import { readManifest } from "../manifest/read-manifest.js";
import { contributesTo, repoKind } from "../repo-kind.js";
import type { RepoKind } from "../types/index.js";
import { deriveGraph } from "./derivation/derive-graph.js";
import type { DerivedGraph } from "./derivation/types.js";
import { getWorkspaceServices } from "./service-runner.js";
import { readOrg, type Org } from "../org.js";
import {
  rollupPlacement,
  servicePlacement,
  type Placement,
  type RollupPlacement,
} from "../manifest/placement.js";

export function loadApplications(workspace?: string): Application[] {
  const services = getWorkspaceServices(workspace);
  const repos = [...new Set(services.map((s) => s.repoName))];
  const manifestApplications: Record<string, string> = {};
  const kinds: Record<string, RepoKind> = {};
  const contributes: Record<string, string[]> = {};
  // The graph only tells a module/library where it ships; derive it lazily.
  let graph: DerivedGraph | undefined;
  for (const s of services) {
    const a = readManifest(s.repoPath)?.application;
    if (a) manifestApplications[s.repoName] = a;
    const kind = repoKind(s.repoPath);
    if (kind !== "service") {
      graph ??= deriveGraph({
        scope: "all",
        ...(workspace ? { workspace } : {}),
      });
      kinds[s.repoName] = kind;
      contributes[s.repoName] = contributesTo(s.repoName, s.repoPath, graph);
    }
  }
  return resolveApplications({
    repos,
    config: readDenConfig().applications,
    manifestApplications,
    kinds,
    contributesTo: contributes,
  });
}

/** An application with what the workspace runs of it. */
export interface ApplicationView extends Application {
  /** repo → its service addresses in the workspace ("repo" or "repo/sub"). */
  services: Record<string, string[]>;
  /** Every service address in the application, for app-wide up/down. */
  addresses: string[];
  /** Repos the team config lists for it that are not in this workspace. */
  absent: string[];
  /** address → where that service runs locally, and where a remote one is. */
  placements: Record<string, Placement>;
  /** local | remote | hybrid | none, over its services (R13). */
  placement: RollupPlacement;
  /** "shop-frontend local · shop-core remote (dev)" */
  summary: string;
}

/** Org > Application > Repo > Services for a workspace (CLI `apps`, web UI). */
export function loadApplicationTree(workspace?: string): {
  org?: Org;
  applications: ApplicationView[];
} {
  const byRepo = new Map<string, string[]>();
  const placed = new Map<
    string,
    Placement & { repo: string; service: string }
  >();
  for (const s of getWorkspaceServices(workspace)) {
    if (!byRepo.has(s.repoName)) byRepo.set(s.repoName, []);
    byRepo.get(s.repoName)!.push(s.address);
    placed.set(s.address, {
      repo: s.repoName,
      service: s.subsystem,
      ...servicePlacement(readManifest(s.repoPath), s.subsystem, "local"),
    });
  }
  const config = readDenConfig().applications ?? {};
  const org = readOrg();
  return {
    ...(org ? { org } : {}),
    applications: loadApplications(workspace).map((a) => {
      const services = Object.fromEntries(
        a.repos.map((r) => [r, byRepo.get(r) ?? []]),
      );
      const addresses = Object.values(services).flat();
      const rows = addresses.flatMap((addr) => placed.get(addr) ?? []);
      return {
        ...a,
        services,
        addresses,
        absent: (config[a.name]?.repos ?? []).filter((r) => !byRepo.has(r)),
        placements: Object.fromEntries(
          addresses.flatMap((addr) => {
            const p = placed.get(addr);
            return p ? [[addr, { runs: p.runs, target: p.target }]] : [];
          }),
        ),
        ...rollupPlacement(rows),
      };
    }),
  };
}
