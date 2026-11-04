/**
 * Security scan target discovery (security pillar).
 *
 * Manifest-driven like journeys: each registered repo may declare a
 * top-level `security:` record keyed by service name in its .den.yml.
 * Discovery just flattens those blocks (sorted, deterministic) — scan
 * policy (modes, hosts) is applied later in plan.ts/run.ts so discovery
 * stays safe to call from interactive pickers.
 */

import { discoverRepos } from "../smoke/discover.js";
import { effectiveLocalCommands } from "../../shared/stacks/manifest-commands.js";
import type { WorkspaceService } from "../../shared/manifest/workspace-manifests.js";
import {
  servicePlacement,
  type Placement,
} from "../../shared/manifest/placement.js";
import type {
  DiscoveredRepo,
  SecurityServiceConfig,
} from "../../shared/types/index.js";

/** A declared security target with its source repo metadata. */
export interface DiscoveredSecurityTarget {
  /** Manifest name of the repo that declared the target. */
  repoName: string;
  /** Absolute path of the registered repo checkout (OpenAPI files resolve here). */
  repoPath: string;
  /** Service key under `security:`. */
  serviceName: string;
  config: SecurityServiceConfig;
  /** Derived by `security.auto_targets` from a health URL, not declared. */
  auto?: true;
  /**
   * Where the service runs from this machine (R13). A remote one is never
   * scanned as if it were local, and never at all when its target env counts
   * as production (see run.ts).
   */
  placement?: Placement;
}

/** Repo-qualified name used by --service and the module picker. */
export function securityTargetId(
  target: Pick<DiscoveredSecurityTarget, "repoName" | "serviceName">,
): string {
  return `${target.repoName}/${target.serviceName}`;
}

/**
 * Discover security targets across registered repos.
 *
 * @param repos Repo list to scan; defaults to discoverRepos(). Injectable
 *   for tests.
 */
export function discoverSecurityTargets(
  repos: DiscoveredRepo[] = discoverRepos(),
): DiscoveredSecurityTarget[] {
  const results: DiscoveredSecurityTarget[] = [];

  const sortedRepos = [...repos].sort((a, b) =>
    a.repoName.localeCompare(b.repoName),
  );

  for (const repo of sortedRepos) {
    const entries = Object.entries(repo.manifest.security ?? {}).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    for (const [serviceName, config] of entries) {
      results.push({
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        serviceName,
        config,
        placement: servicePlacement(repo.manifest, serviceName, "local"),
      });
    }
  }

  return results;
}

/**
 * Targets `security.auto_targets` adds: each service that runs locally (it has
 * local commands or compose) with an HTTP health URL, scanned at that URL's
 * origin in each env that has one. Never a service its manifest marks
 * `security.skip`, one already declared under `security:`, or one with no
 * local runtime (a remote or shell-checked service). A service whose
 * placement is remote is excluded explicitly, whatever commands it has. Host policy is applied
 * later as for any target: every URL must be on the owned-host allowlist.
 */
export function autoSecurityTargets(
  services: WorkspaceService[],
  declared: DiscoveredSecurityTarget[],
): DiscoveredSecurityTarget[] {
  const taken = new Set(declared.map(securityTargetId));
  const out: DiscoveredSecurityTarget[] = [];
  for (const s of services) {
    const id = securityTargetId({ repoName: s.repo, serviceName: s.service });
    if (taken.has(id) || s.config?.security?.skip) continue;
    // Explicitly: a service placed remote (R13) is never an automatic
    // target, even when it also has local commands.
    if (servicePlacement(s.manifest, s.service, "local").runs !== "local")
      continue;
    const runsLocally =
      Object.keys(effectiveLocalCommands(s.manifest, s.service, s.repo, "auto"))
        .length > 0;
    if (!runsLocally) continue;
    const hosts: SecurityServiceConfig["hosts"] = {};
    for (const [env, h] of Object.entries(s.config?.health ?? {})) {
      if (!h || h.type === "shell" || !/^https?:\/\//.test(h.url)) continue;
      hosts[env as keyof typeof hosts] = [new URL(h.url).origin + "/"];
    }
    if (Object.keys(hosts).length === 0) continue;
    taken.add(id);
    out.push({
      repoName: s.repo,
      repoPath: s.repoPath,
      serviceName: s.service,
      config: { hosts },
      auto: true,
    });
  }
  return out;
}
