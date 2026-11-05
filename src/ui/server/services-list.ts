/**
 * The /api/services payload: every service of the legacy-discovered repos and
 * of the requested (or active) workspace, with commands, branch, deps and
 * graph rank.
 *
 * Built off the request path's critical section: the per-repo branch lookups
 * (`git rev-parse`, ~40ms each) run as async child processes in parallel
 * instead of one execSync after another. With ~a dozen repos the sequential
 * version held the event loop for 0.5-1.5s, so every other request (even
 * /api/server-info, which answers in ~1ms) waited behind it.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import type { Environment } from "../../shared/types/index.js";
import { discoverRepos } from "../../pillars/smoke/discover.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import {
  getActiveWorkspace,
  listWorkspaceServices,
  noAutostartRepos,
  readWorkspacesFile,
  resolveDepAddress,
} from "../../shared/environment-manager/workspaces.js";
import { deriveGraph } from "../../shared/environment-manager/derivation/derive-graph.js";
import { orderForDown } from "../../shared/environment-manager/derivation/derived-up.js";
import { listDaemons } from "../../shared/environment-manager/service-runner.js";
import { loadManifest } from "../../shared/manifest/read-manifest.js";
import { servicePlacement } from "../../shared/manifest/placement.js";
import { depService } from "../../shared/manifest/deps.js";
import { hasRuntime, repoKind } from "../../shared/repo-kind.js";
import { readDenConfig } from "../../shared/den-config.js";
import { GIT_REMOTE_TIMEOUT_MS } from "../../shared/constants.js";

/** `repoPath`'s checked-out branch, or null (not a checkout, git failed). */
export function currentBranch(repoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoPath, encoding: "utf-8", timeout: GIT_REMOTE_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout.trim()),
    );
  });
}

export async function buildServicesList(
  env: Environment,
  wsOverride: string | null,
) {
  // Conventional lifecycle locally: `down` is opctl-conventional (stops
  // running containers with no declared command, no-ops gracefully), and
  // `restart` is orchestrated by the exec runner as down → verify → up — so
  // every service with an `up` can offer both even when the manifest doesn't
  // declare them.
  const withDown = (cmds: string[]): string[] => {
    if (env !== "local") return cmds;
    const out = [...cmds];
    if (!out.includes("down")) out.push("down");
    if (!out.includes("restart") && out.includes("up")) out.push("restart");
    return out;
  };

  // Legacy: discovered repos from .den/ symlinks / registered-repos.json
  const legacyRepos = discoverRepos();
  const legacyEntries = legacyRepos.flatMap((repo) => {
    const manifestLayers = loadManifest(repo.repoPath).layers;
    return Object.entries(repo.manifest.services ?? {}).map(
      ([svcName, svc]) => ({
        repo: repo.repoName,
        service: svcName,
        address: `${repo.repoName}/${svcName}`,
        repoPath: repo.repoPath,
        commands: withDown(Object.keys(svc.commands?.[env] ?? {})),
        logs: svc.logs?.[env] ?? null,
        mode: "dev-managed" as const,
        branch: null as string | null,
        fromCatalog: false,
        isEntrypoint: repo.manifest.entrypoint === svcName,
        autostart: true, // legacy discovery has no workspace entry to toggle
        deps: (svc.depends_on ?? []).map(depService),
        cloned: true, // legacy discovery only ever finds on-disk repos
        manifestLayers,
        ...servicePlacement(repo.manifest, svcName, env),
      }),
    );
  });

  // Catalog entries (workspace-aware)
  const catalog = readCatalog();
  const wsFile = wsOverride ? readWorkspacesFile() : null;
  const ws = wsOverride
    ? wsFile?.workspaces[wsOverride]
      ? { name: wsOverride, config: wsFile.workspaces[wsOverride] }
      : null
    : getActiveWorkspace();

  // One lookup per checkout, all in flight at once; filled in below.
  const branches = new Map<string, Promise<string | null>>();
  const branchOf = (repoPath: string): Promise<string | null> => {
    let p = branches.get(repoPath);
    if (!p) branches.set(repoPath, (p = currentBranch(repoPath)));
    return p;
  };

  const noAutostart = ws
    ? noAutostartRepos(ws.config, catalog)
    : new Set<string>();
  const daemonOwners = new Map(
    listDaemons().map((d) => [d.address, d.workspaces ?? []] as const),
  );
  // Modules and libraries have no runtime: no card, health or commands.
  // They show as contributors on the Applications tab instead.
  const pendingBranches: Promise<void>[] = [];
  const catalogEntries = ws
    ? listWorkspaceServices(ws.config, catalog, ws.name)
        .filter((r) => hasRuntime(repoKind(r.repoPath)))
        .flatMap((resolved) => {
          // The manifest and the layers it was built from: repo or held,
          // plus override when manifests/<repo>.override.yml applied.
          const { manifest, layers: manifestLayers } = loadManifest(
            resolved.repoPath,
          );
          const svc = manifest?.services?.[resolved.subsystem];
          if (!manifest || !svc) {
            // Workspace membership is config-driven: a managed entry
            // whose clone isn't on disk yet (or a checkout without a usable
            // manifest) must still render everywhere — flagged `cloned:false`
            // so the UI can offer Sync/clone instead of dropping the system.
            // `branch` comes from the workspace entry; never probe git on a
            // path that may not exist.
            return [
              {
                repo: resolved.repoName,
                service: resolved.subsystem,
                address: resolved.address,
                repoPath: resolved.repoPath,
                commands: [] as string[],
                logs: null,
                mode: resolved.mode,
                branch: resolved.branch as string | null,
                fromCatalog: true,
                isEntrypoint: false,
                autostart: !noAutostart.has(resolved.repoName),
                owners: daemonOwners.get(resolved.address) ?? [],
                deps: [] as string[],
                cloned: fs.existsSync(resolved.repoPath),
                manifestLayers,
                ...servicePlacement(null, resolved.subsystem, env),
              },
            ];
          }
          const entry = {
            repo: resolved.repoName,
            service: resolved.subsystem,
            address: resolved.address,
            repoPath: resolved.repoPath,
            commands: withDown(Object.keys(svc.commands?.[env] ?? {})),
            logs: svc.logs?.[env] ?? null,
            mode: resolved.mode,
            branch: resolved.branch as string | null,
            fromCatalog: true,
            isEntrypoint: manifest.entrypoint === resolved.subsystem,
            autostart: !noAutostart.has(resolved.repoName),
            owners: daemonOwners.get(resolved.address) ?? [],
            deps: (svc.depends_on ?? []).map((d) =>
              resolveDepAddress(depService(d), catalog, ws.config, ws.name),
            ),
            cloned: true,
            manifestLayers,
            ...servicePlacement(manifest, resolved.subsystem, env),
          };
          if (entry.branch == null)
            pendingBranches.push(
              branchOf(resolved.repoPath).then((b) => {
                entry.branch = b;
              }),
            );
          return [entry];
        })
    : [];

  // Merge: catalog entries take precedence over legacy for same repo.
  // When a workspace filter is active, also exclude legacy entries not in
  // the workspace (legacy discovery is not workspace-scoped).
  const catalogRepos = new Set(Object.keys(catalog));
  const wsServiceKeys = ws ? new Set(Object.keys(ws.config.services)) : null;
  const merged = [
    ...legacyEntries.filter((e) => {
      if (catalogRepos.has(e.repo)) return false;
      if (wsServiceKeys && !wsServiceKeys.has(e.repo)) return false;
      return true;
    }),
    ...catalogEntries,
  ];

  // Attach the dependency-graph position so consumers can present systems
  // top-down (entry repo first, infra-stack last) — the same order the
  // health row and `den status` use. Added as a FIELD rather than by
  // re-sorting the array, because four pages consume this payload and some
  // rely on the current order.
  const graphRank = new Map(
    orderForDown(deriveGraph({ scope: "all", workspace: ws?.name })).map(
      (repo, i) => [repo, i],
    ),
  );
  const infraRepo = readDenConfig()?.graph?.infra?.repo ?? null;
  await Promise.all(pendingBranches);
  return merged.map((e) => ({
    ...e,
    graphRank: graphRank.get(e.repo) ?? Number.MAX_SAFE_INTEGER,
    infra: infraRepo !== null && e.repo === infraRepo,
  }));
}

export type ServicesList = Awaited<ReturnType<typeof buildServicesList>>;
