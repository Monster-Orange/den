/**
 * Default-workspace blueprint + seeding.
 *
 * `config/den.yml` `defaults.workspace` declares the out-of-the-box repo set,
 * all managed. On a fresh clone (no local workspace) den offers — once —
 * to seed the `default` workspace from it so `den graph` / `den up` show the
 * full system graph immediately; `den init` (run in the den root) re-seeds.
 * Catalog clone URLs derive as `<github_org>/<repo>`. Switch any repo to a local
 * checkout with `den use-local <repo>`.
 */
import {
  parseAddress,
  readWorkspacesFile,
  writeWorkspacesFile,
} from "./workspaces.js";
import { readCatalog, writeCatalog } from "./catalog.js";
import {
  readWorkspaceBlueprints,
  requireGithubOrg,
  type ResolvedWorkspaceBlueprint,
} from "../den-config.js";
import type {
  ServiceCatalog,
  WorkspaceConfig,
  WorkspaceServiceEntry,
  WorkspacesFile,
} from "../types/index.js";

/** The single-workspace blueprint (`defaults.workspace`), or null. */
function singleBlueprint(): ResolvedWorkspaceBlueprint | null {
  const bps = readWorkspaceBlueprints();
  return bps.shape === "single" ? bps.workspaces[0] : null;
}

/** True when the distribution uses `defaults.workspaces` (named workspaces). */
export function isMultiBlueprint(): boolean {
  return readWorkspaceBlueprints().shape === "multi";
}

/** The workspaces a fresh setup would seed, each with at least one repo. */
export function blueprintWorkspaces(): ResolvedWorkspaceBlueprint[] {
  return readWorkspaceBlueprints().workspaces.filter((b) => b.repos.length > 0);
}

/** `defaults.workspace.repos` — the single blueprint's repos (empty for the multi shape). */
export function defaultWorkspaceRepos(): string[] {
  return singleBlueprint()?.repos ?? [];
}

function org(): string {
  return requireGithubOrg();
}

function blueprintServices(
  bp: ResolvedWorkspaceBlueprint,
  repos: string[] = bp.repos,
): Record<string, WorkspaceServiceEntry> {
  // Team default for systems a fresh workspace should NOT auto-start (e.g.
  // billing-api's `make up` opens an interactive Stripe tab). Personal after
  // seeding — toggled per system in the web ⋮ menu.
  const autostartOff = new Set(bp.autostartOff);
  const services: Record<string, WorkspaceServiceEntry> = {};
  for (const repo of repos) {
    services[repo] = {
      mode: "managed",
      branch: bp.branch,
      ...(autostartOff.has(repo) ? { autostart: false } : {}),
    };
  }
  return services;
}

function fillCatalog(
  repos: string[],
  catalog: ServiceCatalog = readCatalog(),
): void {
  const o = org();
  for (const repo of repos) {
    if (!catalog[repo]?.gh) catalog[repo] = { gh: `${o}/${repo}` };
  }
  writeCatalog(catalog);
}

/**
 * A genuine fresh setup: no workspace but `default` exists, `default` holds no
 * services, and no blueprint was ever applied to it (`seeded_repos` unset —
 * seeding, top-up and a declined offer all record it). An emptied `default`,
 * or one next to other workspaces, is the user's deliberate state.
 */
export function isFreshWorkspaceSetup(
  file: WorkspacesFile = readWorkspacesFile(),
): boolean {
  const names = Object.keys(file.workspaces);
  if (names.some((n) => n !== "default")) return false;
  const def = file.workspaces["default"];
  if (!def) return true;
  return (
    Object.keys(def.services ?? {}).length === 0 &&
    def.seeded_repos === undefined
  );
}

/** True on a genuine fresh setup with a non-empty blueprint (single or multi). */
export function defaultWorkspaceNeedsSeeding(): boolean {
  if (blueprintWorkspaces().length === 0) return false;
  return isFreshWorkspaceSetup();
}

/** Whether a workspace the blueprint seeds already has services (so seeding would reset it). */
export function defaultWorkspaceHasServices(): boolean {
  const file = readWorkspacesFile();
  const names = isMultiBlueprint()
    ? blueprintWorkspaces().map((b) => b.name)
    : ["default"];
  return names.some(
    (n) => Object.keys(file.workspaces[n]?.services ?? {}).length > 0,
  );
}

function sameEntry(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return (
    ka.length === kb.length &&
    ka.every(
      (k, i) =>
        k === kb[i] &&
        sameEntry(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}

/**
 * Whether seeding now would change nothing: every workspace the blueprint
 * seeds holds exactly what seeding writes (same repos, all managed on the
 * blueprint's branch, same autostart defaults), records the blueprint as
 * applied, and (multi blueprint) is active. A workspace the user changed
 * since (a repo switched to a local checkout, one added or removed) is not
 * "already seeded": seeding would reset it.
 */
export function blueprintAlreadySeeded(
  file: WorkspacesFile = readWorkspacesFile(),
): boolean {
  const bps = blueprintWorkspaces();
  if (bps.length === 0) return false;
  const multi = isMultiBlueprint();
  return bps.every((bp) => {
    const name = multi ? bp.name : "default";
    const ws = file.workspaces[name];
    if (!ws) return false;
    if (multi && !(file.active ?? []).includes(name)) return false;
    const applied = ws.seeded_repos ?? [];
    if (
      applied.length !== bp.repos.length ||
      bp.repos.some((r, i) => applied[i] !== r)
    )
      return false;
    return sameEntry(ws.services ?? {}, blueprintServices(bp));
  });
}

/**
 * Seed (or reset) the `default` workspace from the blueprint — every repo as a
 * bare, first-class managed entry on `branch` — and ensure the catalog has
 * clone URLs (`<org>/<repo>`, only filled where missing). Returns the seeded
 * repos. With the multi blueprint (`defaults.workspaces`), seeds every named
 * workspace instead (see seedBlueprintWorkspaces).
 */
export function seedDefaultWorkspace(): string[] {
  if (isMultiBlueprint())
    return seedBlueprintWorkspaces().flatMap((w) => w.repos);
  const bp = singleBlueprint();
  if (!bp) return [];
  const repos = bp.repos;

  const file = readWorkspacesFile();
  file.workspaces.default = {
    ...(file.workspaces.default ?? {}),
    services: blueprintServices(bp),
    seeded_repos: [...repos],
  };
  if (!file.active?.length) {
    file.active = ["default"];
    file.focus = "default";
  }
  writeWorkspacesFile(file);
  fillCatalog(repos);
  return repos;
}

/**
 * Create (or reset) each workspace `defaults.workspaces` names with its repos,
 * activate them all, and focus the one marked `focus: true` (else the first).
 * Workspaces the blueprint does not name are left as they are. Returns what
 * was seeded, in blueprint order.
 */
export function seedBlueprintWorkspaces(): { name: string; repos: string[] }[] {
  const bps = blueprintWorkspaces();
  if (bps.length === 0) return [];
  const file = readWorkspacesFile();
  for (const bp of bps) {
    const prev: WorkspaceConfig | undefined = file.workspaces[bp.name];
    file.workspaces[bp.name] = {
      ...(prev ?? {}),
      services: blueprintServices(bp),
      seeded_repos: [...bp.repos],
    };
  }
  const names = bps.map((b) => b.name);
  // The untouched placeholder `default` of a fresh file is not the user's:
  // only the blueprint's workspaces are active.
  const kept = (file.active ?? []).filter(
    (n) =>
      names.includes(n) ||
      n !== "default" ||
      Object.keys(file.workspaces[n]?.services ?? {}).length > 0,
  );
  file.active = [...names, ...kept.filter((n) => !names.includes(n))];
  file.focus = (bps.find((b) => b.focus) ?? bps[0]).name;
  writeWorkspacesFile(file);
  fillCatalog([...new Set(bps.flatMap((b) => b.repos))]);
  return bps.map((b) => ({ name: b.name, repos: [...b.repos] }));
}

/**
 * Converge an EXISTING `default` workspace on the blueprint. Seeding is
 * one-shot, so a workspace seeded before a repo joined
 * `defaults.workspace.repos` (tasks-api, say) would never gain it on its own.
 *
 * Converges on blueprint DELTAS, not set difference: only repos that JOINED
 * the blueprint since it was last applied (`seeded_repos`) are candidates, so
 * a standard repo the user removed from the workspace stays removed. A
 * candidate is skipped when any workspace already holds it, checked at REPO
 * level (workspace keys may be `repo/subsystem` addresses). Added repos get
 * exactly what seeding writes: bare managed entry on `branch`, team
 * autostart default, catalog clone URL where absent. Returns the added names.
 *
 * Never runs once the user has other workspaces: `default` is then one
 * workspace among theirs, and repos they moved out must stay out. Also a
 * no-op (no file writes once converged) for the multi blueprint, an empty
 * blueprint, or an empty/missing `default` (that state belongs to the
 * seeding flow). Workspaces from before `seeded_repos` existed treat the
 * whole blueprint as new once; afterwards removals stick.
 */
export function topUpDefaultWorkspace(): string[] {
  const bp = singleBlueprint();
  if (!bp || bp.repos.length === 0) return [];
  const repos = bp.repos;

  const file = readWorkspacesFile();
  if (Object.keys(file.workspaces).some((n) => n !== "default")) return [];
  const def = file.workspaces["default"];
  if (!def || Object.keys(def.services ?? {}).length === 0) return [];

  const applied = new Set(def.seeded_repos ?? []);
  const catalog = readCatalog();
  const present = new Set(
    Object.values(file.workspaces).flatMap((ws) =>
      Object.keys(ws.services ?? {}).map(
        (k) => parseAddress(k, catalog).repoName,
      ),
    ),
  );

  const missing = repos.filter((r) => !applied.has(r) && !present.has(r));
  Object.assign(def.services, blueprintServices(bp, missing));

  const blueprintChanged =
    def.seeded_repos?.length !== repos.length ||
    repos.some((r, i) => def.seeded_repos?.[i] !== r);
  if (missing.length === 0 && !blueprintChanged) return [];

  def.seeded_repos = [...repos];
  writeWorkspacesFile(file);
  if (missing.length > 0) fillCatalog(missing, catalog);
  return missing;
}

/**
 * Record that the user removed `repoName` from workspace `wsName`, so top-up
 * never re-adds it. Only the `default` workspace is topped up, and only a
 * blueprint repo could come back; `seeded_repos` already covers repos the
 * blueprint applied. This closes the gap for a `default` from before
 * `seeded_repos` existed, which top-up would otherwise migrate by re-adding
 * the whole blueprint. Mutates `file` in place; the caller writes it.
 */
export function recordRemovedFromWorkspace(
  file: WorkspacesFile,
  wsName: string,
  repoName: string,
): void {
  if (wsName !== "default") return;
  const def = file.workspaces["default"];
  if (!def) return;
  let blueprint: string[] = [];
  try {
    blueprint = defaultWorkspaceRepos();
  } catch {
    return; // a malformed blueprint is reported where seeding reads it
  }
  if (!blueprint.includes(repoName)) return;
  const seeded = def.seeded_repos ?? [];
  if (!seeded.includes(repoName)) def.seeded_repos = [...seeded, repoName];
}

/**
 * Persist an empty `default` workspace, with an empty `seeded_repos`, so the
 * one-time auto-seed prompt isn't asked again after the user declines it.
 */
export function markDefaultWorkspaceDeclined(): void {
  const file = readWorkspacesFile();
  file.workspaces.default = file.workspaces.default ?? { services: {} };
  file.workspaces.default.seeded_repos ??= [];
  if (!file.active?.length) {
    file.active = ["default"];
    file.focus = "default";
  }
  writeWorkspacesFile(file);
}
