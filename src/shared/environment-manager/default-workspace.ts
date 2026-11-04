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
import { readDenConfig, requireGithubOrg } from "../den-config.js";
import type { WorkspaceServiceEntry } from "../types/index.js";

const DEFAULT_BRANCH = "main";

export function defaultWorkspaceRepos(): string[] {
  return readDenConfig().defaults?.workspace?.repos ?? [];
}

function defaultBranch(): string {
  return readDenConfig().defaults?.workspace?.branch ?? DEFAULT_BRANCH;
}

function org(): string {
  return requireGithubOrg();
}

/** True on a fresh clone: a blueprint exists but the `default` workspace is empty. */
export function defaultWorkspaceNeedsSeeding(): boolean {
  if (defaultWorkspaceRepos().length === 0) return false;
  const def = readWorkspacesFile().workspaces["default"];
  return !def || Object.keys(def.services ?? {}).length === 0;
}

/** Whether the `default` workspace already has services (so seeding would reset it). */
export function defaultWorkspaceHasServices(): boolean {
  const def = readWorkspacesFile().workspaces["default"];
  return !!def && Object.keys(def.services ?? {}).length > 0;
}

/**
 * Seed (or reset) the `default` workspace from the blueprint — every repo as a
 * bare, first-class managed entry on `branch` — and ensure the catalog has
 * clone URLs (`<org>/<repo>`, only filled where missing). Returns the seeded repos.
 */
export function seedDefaultWorkspace(): string[] {
  const repos = defaultWorkspaceRepos();
  const branch = defaultBranch();
  // Team default for systems a fresh workspace should NOT auto-start (e.g.
  // billing-api's `make up` opens an interactive Stripe tab). Personal after
  // seeding — toggled per system in the web ⋮ menu.
  const autostartOff = new Set(
    readDenConfig().defaults?.workspace?.autostart_off ?? [],
  );
  const services: Record<string, WorkspaceServiceEntry> = {};
  for (const repo of repos) {
    services[repo] = {
      mode: "managed",
      branch,
      ...(autostartOff.has(repo) ? { autostart: false } : {}),
    };
  }

  const file = readWorkspacesFile();
  file.workspaces.default = {
    ...(file.workspaces.default ?? {}),
    services,
    seeded_repos: [...repos],
  };
  if (!file.active?.length) {
    file.active = ["default"];
    file.focus = "default";
  }
  writeWorkspacesFile(file);

  const catalog = readCatalog();
  const o = org();
  for (const repo of repos) {
    if (!catalog[repo]?.gh) catalog[repo] = { gh: `${o}/${repo}` };
  }
  writeCatalog(catalog);

  return repos;
}

/**
 * Converge an EXISTING `default` workspace on the blueprint. Seeding is
 * one-shot, so a workspace seeded before a repo joined
 * `defaults.workspace.repos` (tasks-api, say) would never gain it on its own.
 * Adds each missing blueprint repo exactly as seeding would (bare
 * managed entry on `branch`, team autostart default, catalog clone URL
 * where absent) and returns the added names. No-op — and no file writes —
 * when already converged, or when the `default` workspace is empty/missing:
 * that state belongs to the seeding/declined flow, not top-up.
 */
/**
 * Converge an EXISTING `default` workspace on the blueprint. Seeding is
 * one-shot, so a workspace seeded before a repo joined
 * `defaults.workspace.repos` (tasks-api, say) would never gain it on its own.
 *
 * Converges on blueprint DELTAS, not set difference: only repos that JOINED
 * the blueprint since it was last applied (`seeded_repos`) are candidates, so
 * a standard repo the user removed from the workspace stays removed. Presence
 * is checked at REPO level (workspace keys may be `repo/subsystem`
 * addresses), so a repo held as subsystem entries never gains a duplicate
 * bare entry. Added repos get exactly what seeding writes: bare
 * managed entry on `branch`, team autostart default, catalog clone
 * URL where absent. Returns the added names.
 *
 * No-op — and no file writes once converged — when the blueprint is empty or
 * the `default` workspace is empty/missing (that state belongs to the
 * seeding/declined flow). Workspaces from before `seeded_repos` existed
 * treat the whole blueprint as new once — the migration cannot distinguish
 * "removed" from "seeded before the repo joined"; afterwards removals stick.
 */
export function topUpDefaultWorkspace(): string[] {
  const repos = defaultWorkspaceRepos();
  if (repos.length === 0) return [];

  const file = readWorkspacesFile();
  const def = file.workspaces["default"];
  if (!def || Object.keys(def.services ?? {}).length === 0) return [];

  const applied = new Set(def.seeded_repos ?? []);
  const catalog = readCatalog();
  const present = new Set(
    Object.keys(def.services).map((k) => parseAddress(k, catalog).repoName),
  );
  const branch = defaultBranch();
  const autostartOff = new Set(
    readDenConfig().defaults?.workspace?.autostart_off ?? [],
  );

  const added: string[] = [];
  for (const repo of repos) {
    if (applied.has(repo) || present.has(repo)) continue;
    def.services[repo] = {
      mode: "managed",
      branch,
      ...(autostartOff.has(repo) ? { autostart: false } : {}),
    };
    added.push(repo);
  }

  const blueprintChanged =
    def.seeded_repos?.length !== repos.length ||
    repos.some((r, i) => def.seeded_repos?.[i] !== r);
  if (added.length === 0 && !blueprintChanged) return [];

  def.seeded_repos = [...repos];
  writeWorkspacesFile(file);

  if (added.length > 0) {
    const o = org();
    for (const repo of added) {
      if (!catalog[repo]?.gh) catalog[repo] = { gh: `${o}/${repo}` };
    }
    writeCatalog(catalog);
  }

  return added;
}

/**
 * Persist an empty `default` workspace so the one-time auto-seed prompt isn't
 * asked again after the user declines it.
 */
export function markDefaultWorkspaceDeclined(): void {
  const file = readWorkspacesFile();
  file.workspaces.default = file.workspaces.default ?? { services: {} };
  if (!file.active?.length) {
    file.active = ["default"];
    file.focus = "default";
  }
  writeWorkspacesFile(file);
}
