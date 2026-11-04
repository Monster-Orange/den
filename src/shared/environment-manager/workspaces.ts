/**
 * Workspace Manager
 *
 * Manages config/local/workspaces.yml and resolves which repo path / branch
 * to use for a given service address in the active workspace.
 *
 * Addressing conventions:
 *   Single-service repo:   "tasks-runner"  → repoName="tasks-runner", subsystem="tasks-runner"
 *   Mono-repo subsystem:   "shop/api"             → repoName="shop", subsystem="api"
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import type {
  WorkspacesFile,
  WorkspaceConfig,
  ServiceCatalog,
  ResolvedService,
  WorkspaceServiceEntry,
  RawManifest,
} from "../types/index.js";
import { readManifest } from "../manifest/read-manifest.js";
import { depService } from "../manifest/deps.js";
import { getDistRoot } from "../paths.js";
import { readCatalog } from "./catalog.js";

import { product } from "../product.js";
const ROOT = getDistRoot();
const WORKSPACES_PATH = path.join(ROOT, "config", "local", "workspaces.yml");
/** Sibling directory where den stores feature-workspace clones. */
export const DEN_WORKSPACES_DIR = path.join(
  ROOT,
  "..",
  `${product().workspacesDir}`,
);
export const DEN_SERVICES_DIR = path.join(ROOT, `${product().servicesDir}`);

/**
 * Read a manifest for `repoName`, trying `primaryPath` first, then falling back
 * to any other available clone of the same repo.
 *
 * This handles the case where the workspace branch doesn't have a .den.yml
 * (e.g. the file was added after the feature branch was cut). We still want
 * dependency information, so we look in:
 *  1. Other branch clones under .den-services/<repoName>/
 *  2. The default sibling-repo location (<ROOT>/../<repoName>)
 */
export function readManifestAnyBranch(
  repoName: string,
  primaryPath: string,
): RawManifest | null {
  const primary = readManifest(primaryPath);
  if (primary) return primary;

  // Try other branch clones for this repo
  const managedDir = path.join(DEN_SERVICES_DIR, repoName);
  try {
    const branches = fs.readdirSync(managedDir, { withFileTypes: true });
    for (const b of branches) {
      if (!b.isDirectory()) continue;
      const m = readManifest(path.join(managedDir, b.name));
      if (m) return m;
    }
  } catch {
    /* no managed clones */
  }

  // Try the default sibling location (repos_root defaults to parent of ROOT)
  const sibling = readManifest(path.join(ROOT, "..", repoName));
  if (sibling) return sibling;

  return null;
}

const DEFAULT_FILE: WorkspacesFile = {
  active: ["default"],
  focus: "default",
  workspaces: {
    default: { services: {} },
  },
};

/** Migrate persisted mode values from old names to current names. */
/**
 * Mode values on disk → current names. "linked" is the old dev-managed;
 * "<product>-managed" (written before 0.1.0, named after the distribution)
 * is "managed".
 */
export function normalizeMode(mode: unknown): "dev-managed" | "managed" {
  if (mode === "linked" || mode === "dev-managed") return "dev-managed";
  if (typeof mode === "string" && /^([a-z][a-z0-9-]*-)?managed$/.test(mode))
    return "managed";
  return (mode ?? "dev-managed") as "dev-managed" | "managed";
}

/**
 * Coerce legacy `active: string` → `active: string[]`, ensure a valid focus,
 * and drop active names that no longer exist. Returns whether the on-disk
 * shape changed (caller may persist).
 */
export function normalizeWorkspacesFileShape(parsed: {
  active?: string | string[];
  focus?: string;
  workspaces?: Record<string, WorkspaceConfig>;
}): { file: WorkspacesFile; changed: boolean } {
  let changed = false;
  const workspaces =
    parsed.workspaces && typeof parsed.workspaces === "object"
      ? parsed.workspaces
      : {};

  let active: string[];
  if (typeof parsed.active === "string") {
    active = parsed.active ? [parsed.active] : [];
    changed = true;
  } else if (Array.isArray(parsed.active)) {
    active = parsed.active.filter((n): n is string => typeof n === "string");
    if (active.length !== parsed.active.length) changed = true;
  } else {
    active = [];
    changed = true;
  }

  const existing = active.filter((n) => Boolean(workspaces[n]));
  if (existing.length !== active.length) changed = true;
  active = existing;

  if (active.length === 0) {
    if (workspaces.default) {
      active = ["default"];
    } else {
      const first = Object.keys(workspaces)[0];
      if (first) active = [first];
    }
    changed = true;
  }

  let focus = typeof parsed.focus === "string" ? parsed.focus : undefined;
  if (!focus || !active.includes(focus)) {
    focus = active[0];
    changed = true;
  }

  return {
    file: { active, focus, workspaces },
    changed,
  };
}

/**
 * Set once the migration rewrite has failed, so a read-only or otherwise
 * unwritable config dir costs one failed write per process instead of one per
 * `readWorkspacesFile` call. Normalization is in-memory anyway — callers always
 * get the coerced shape whether or not it reaches disk.
 */
let migrationWriteFailed = false;

function persistNormalizedIfNeeded(
  file: WorkspacesFile,
  changed: boolean,
): void {
  if (!changed || migrationWriteFailed) return;
  try {
    // The write is idempotent and lands via an atomic rename, so a concurrent
    // CLI/web-server pair racing the same migration converges rather than
    // corrupting the file.
    writeWorkspacesFile(file);
  } catch {
    migrationWriteFailed = true;
  }
}

export function readWorkspacesFile(): WorkspacesFile {
  try {
    const raw = fs.readFileSync(WORKSPACES_PATH, "utf-8");
    const parsedRaw = yaml.parse(raw) as unknown;
    // A scalar/array (or empty) document would crash getActiveWorkspace's
    // `file.workspaces[name]` later — fall back to a well-formed default.
    if (!parsedRaw || typeof parsedRaw !== "object") {
      return structuredClone(DEFAULT_FILE);
    }
    const parsed = parsedRaw as {
      active?: string | string[];
      focus?: string;
      workspaces?: Record<string, WorkspaceConfig>;
    };
    if (!parsed.workspaces || typeof parsed.workspaces !== "object") {
      parsed.workspaces = {};
    }
    // Normalize old mode values ("linked"/"managed") to current names.
    for (const ws of Object.values(parsed.workspaces ?? {})) {
      for (const entry of Object.values(
        ws.services ?? {},
      ) as WorkspaceServiceEntry[]) {
        (entry as { mode: string }).mode = normalizeMode(entry.mode);
      }
    }
    const { file, changed } = normalizeWorkspacesFileShape(parsed);
    persistNormalizedIfNeeded(file, changed);
    return file;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return structuredClone(DEFAULT_FILE);
    throw err;
  }
}

/**
 * First-class multi-service repos: collapse per-subsystem sibling entries
 * (`shop/db` + `shop/api`) into a single bare repo entry (`shop`). Den already
 * treats a repo as the unit (derived-graph nodes, up/down ordering) and
 * `expandMonoRepoEntry` re-expands a bare entry to its manifest subsystems, so the
 * two shapes are functionally equivalent — this converges the *persisted* config
 * to the first-class shape (the "lazy self-heal"). Catalog-aware so a nested-repo
 * catalog key ("a/b") is never mistaken for a subsystem of "a". Idempotent; only
 * collapses siblings that share identical mode/path/branch.
 */
export function normalizeWorkspaceServices(
  config: WorkspaceConfig,
  catalog: ServiceCatalog,
): WorkspaceConfig {
  const services = config.services ?? {};
  const bareRepos = new Set<string>();
  const subsystemsByRepo = new Map<string, string[]>();
  for (const key of Object.keys(services)) {
    const { repoName } = parseAddress(key, catalog);
    if (key === repoName) {
      bareRepos.add(repoName);
    } else if (key.startsWith(`${repoName}/`)) {
      const list = subsystemsByRepo.get(repoName) ?? [];
      list.push(key);
      subsystemsByRepo.set(repoName, list);
    }
  }

  let changed = false;
  const next: Record<string, WorkspaceServiceEntry> = { ...services };
  for (const [repo, keys] of subsystemsByRepo) {
    const hasBare = bareRepos.has(repo);
    // Collapse when ≥2 subsystem entries exist, OR a bare entry already coexists
    // with subsystem entries (drop the redundant subsystem rows).
    if (keys.length < 2 && !hasBare) continue;
    const ref = hasBare ? services[repo] : services[keys[0]];
    const sameConfig = keys.every(
      (k) =>
        services[k].mode === ref.mode &&
        (services[k].path ?? "") === (ref.path ?? "") &&
        (services[k].branch ?? "") === (ref.branch ?? ""),
    );
    if (!sameConfig) continue; // heterogeneous — leave as-is, don't guess
    // Preserve an auto-start-off toggle from any collapsed sibling.
    const autostartOff =
      (hasBare && services[repo].autostart === false) ||
      keys.some((k) => services[k].autostart === false);
    for (const k of keys) delete next[k];
    next[repo] = {
      mode: ref.mode,
      ...(ref.path ? { path: ref.path } : {}),
      ...(ref.branch ? { branch: ref.branch } : {}),
      ...(autostartOff ? { autostart: false } : {}),
    };
    changed = true;
  }

  return changed ? { ...config, services: next } : config;
}

/**
 * Repos the user toggled to auto-start OFF in this workspace
 * (`autostart: false` on the service entry — set from the web ⋮ menu).
 * These are skipped by the STARTING half of workspace-wide ops (up/restart);
 * workspace down still stops them, and explicit targeting always wins.
 * Entry keys may be bare repo names or "repo/subsystem" — resolved to repo
 * level, since the toggle is a per-system concept.
 */
export function noAutostartRepos(
  config: WorkspaceConfig,
  catalog: ServiceCatalog,
): Set<string> {
  const off = new Set<string>();
  for (const [key, entry] of Object.entries(config.services ?? {})) {
    if (entry.autostart === false) {
      off.add(parseAddress(key, catalog).repoName);
    }
  }
  return off;
}

export function writeWorkspacesFile(file: WorkspacesFile): void {
  const dir = path.dirname(WORKSPACES_PATH);
  fs.mkdirSync(dir, { recursive: true });
  // Self-heal to first-class repo entries on persist. Best-effort catalog read —
  // if it fails (e.g. none yet), normalize without it (still correct for the
  // common single-slash subsystem case).
  let catalog: ServiceCatalog = {};
  try {
    catalog = readCatalog();
  } catch {
    catalog = {};
  }
  const out: WorkspacesFile = {
    ...file,
    workspaces: Object.fromEntries(
      Object.entries(file.workspaces ?? {}).map(([name, ws]) => [
        name,
        normalizeWorkspaceServices(ws, catalog),
      ]),
    ),
  };
  // Write to a temp file then atomically rename, so a crash or a concurrent
  // den process can never observe a half-written workspaces.yml.
  const tmp = path.join(dir, `.workspaces.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, yaml.stringify(out), "utf-8");
    fs.renameSync(tmp, WORKSPACES_PATH);
  } catch (err) {
    // Don't leave an orphaned temp file behind when the write/rename fails.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

export function getWorkspaceByName(name: string): {
  name: string;
  config: WorkspaceConfig;
} | null {
  const file = readWorkspacesFile();
  const config = file.workspaces[name];
  if (!config) return null;
  return { name, config };
}

/**
 * Require `name` to be in the active set. Throws a clear activate-first error.
 */
export function requireActiveWorkspace(name: string): {
  name: string;
  config: WorkspaceConfig;
} {
  const ws = getWorkspaceByName(name);
  if (!ws) {
    throw new Error(`Workspace "${name}" does not exist`);
  }
  if (!isWorkspaceActive(name)) {
    throw new Error(
      `Workspace "${name}" is not active — run \`${product().cli} workspace activate ${name}\` first`,
    );
  }
  return ws;
}

/** Names of all currently active workspaces. */
export function getActiveWorkspaces(): string[] {
  return [...readWorkspacesFile().active];
}

export function isWorkspaceActive(name: string): boolean {
  return getActiveWorkspaces().includes(name);
}

/**
 * Focused workspace name: DEN_WORKSPACE_OVERRIDE → focus → active[0].
 * Returns null when the resolved name is missing from the file.
 */
export function getFocusedWorkspaceName(): string | null {
  const file = readWorkspacesFile();
  const name =
    process.env.DEN_WORKSPACE_OVERRIDE ?? file.focus ?? file.active[0] ?? null;
  if (!name || !file.workspaces[name]) return null;
  return name;
}

/**
 * Focused (default-target) workspace. Back-compat name: historically this
 * returned the single active workspace; it now returns the focus.
 */
export function getActiveWorkspace(): {
  name: string;
  config: WorkspaceConfig;
} | null {
  const file = readWorkspacesFile();
  const name = getFocusedWorkspaceName();
  if (!name) return null;
  const config = file.workspaces[name];
  if (!config) return null;
  return { name, config };
}

/** Alias for clarity at call sites that mean focus, not the active set. */
export function getFocusedWorkspace(): {
  name: string;
  config: WorkspaceConfig;
} | null {
  return getActiveWorkspace();
}

export function activateWorkspace(name: string): void {
  const file = readWorkspacesFile();
  if (!file.workspaces[name]) {
    throw new Error(`Workspace "${name}" does not exist`);
  }
  if (!file.active.includes(name)) {
    file.active.push(name);
  }
  writeWorkspacesFile(file);
}

export function deactivateWorkspace(name: string): void {
  const file = readWorkspacesFile();
  if (!file.active.includes(name)) {
    return;
  }
  file.active = file.active.filter((n) => n !== name);
  if (file.active.length === 0) {
    if (file.workspaces.default) {
      file.active = ["default"];
    } else {
      const first = Object.keys(file.workspaces)[0];
      if (first) file.active = [first];
    }
  }
  if (!file.active.includes(file.focus ?? "")) {
    file.focus = file.active[0];
  }
  writeWorkspacesFile(file);
}

export function setFocusedWorkspace(name: string): void {
  const file = readWorkspacesFile();
  if (!file.workspaces[name]) {
    throw new Error(`Workspace "${name}" does not exist`);
  }
  if (!file.active.includes(name)) {
    throw new Error(
      `Workspace "${name}" is not active — run \`${product().cli} workspace activate ${name}\` first`,
    );
  }
  file.focus = name;
  writeWorkspacesFile(file);
}

/** Activate `name` and set it as focus (back-compat for exclusive "use"). */
export function setActiveWorkspace(name: string): void {
  const file = readWorkspacesFile();
  if (!file.workspaces[name]) {
    throw new Error(`Workspace "${name}" does not exist`);
  }
  if (!file.active.includes(name)) {
    file.active.push(name);
  }
  file.focus = name;
  writeWorkspacesFile(file);
}

export function createWorkspace(name: string, config: WorkspaceConfig): void {
  const file = readWorkspacesFile();
  file.workspaces[name] = config;
  writeWorkspacesFile(file);
}

export function deleteWorkspaceConfig(name: string): void {
  const file = readWorkspacesFile();
  delete file.workspaces[name];
  file.active = file.active.filter((n) => n !== name);
  if (file.active.length === 0) {
    if (file.workspaces.default) {
      file.active = ["default"];
    } else {
      const first = Object.keys(file.workspaces)[0];
      if (first) file.active = [first];
    }
  }
  if (!file.focus || !file.active.includes(file.focus)) {
    file.focus = file.active[0];
  }
  writeWorkspacesFile(file);
}

/**
 * Parse a service address into repo name and subsystem.
 *
 * With multi-level repo support, catalog keys may contain slashes
 * (e.g. "projectA/serviceA"). Pass the catalog so that slash-delimited
 * catalog keys are distinguished from mono-repo "repoName/subsystem" addresses.
 *
 * Resolution order:
 *   1. Exact catalog match → bare repo address ("projectA/serviceA" is the repo)
 *   2. Longest catalog-key prefix → mono-repo subsystem ("shop" + "api" → shop/api)
 *   3. Fallback: first slash (no catalog provided, or no match found)
 */
export function parseAddress(
  address: string,
  catalog?: ServiceCatalog,
): { repoName: string; subsystem: string } {
  if (!address.includes("/")) return { repoName: address, subsystem: address };

  // Exact match: the full address is itself a catalog key (nested repo path).
  if (catalog?.[address]) return { repoName: address, subsystem: address };

  // Try progressively shorter prefixes (longest first) to find a catalog key.
  if (catalog) {
    let pos = address.lastIndexOf("/");
    while (pos > 0) {
      const prefix = address.slice(0, pos);
      if (catalog[prefix]) {
        return { repoName: prefix, subsystem: address.slice(pos + 1) };
      }
      pos = address.lastIndexOf("/", pos - 1);
    }
  }

  // Fallback: split at first slash (handles shop/api when catalog not provided).
  const slash = address.indexOf("/");
  return {
    repoName: address.slice(0, slash),
    subsystem: address.slice(slash + 1),
  };
}

/**
 * Resolve the filesystem path and branch for a service address given an active
 * workspace and catalog.
 *
 * Path resolution:
 *   feature workspace repos map → .den-workspaces/<ws>/<repo>/
 *   mode=managed         → .den-services/<repo>/<branch>/
 *   mode=dev-managed            → workspace service entry path
 *
 * Managed clones are scoped per workspace so that different workspaces
 * can track the same repo at different branches simultaneously.
 */
export function resolveServiceSource(
  address: string,
  _workspaceName: string,
  workspace: WorkspaceConfig,
  catalog: ServiceCatalog,
): ResolvedService | null {
  const { repoName, subsystem } = parseAddress(address, catalog);
  if (!catalog[repoName]) return null;

  // Try the exact address first; fall back to the bare repo-name key so that
  // expanded addresses like "shop/api" resolve against a bare "shop" entry.
  const wsEntry = workspace.services[address] ?? workspace.services[repoName];
  if (!wsEntry) return null;

  const { mode } = wsEntry;
  let repoPath: string;
  let branch: string | null = null;

  const reposBranch = workspace.repos?.[repoName];
  if (reposBranch && workspace.directory) {
    // Feature workspace clone
    repoPath = path.join(ROOT, workspace.directory, repoName);
    branch = reposBranch;
  } else if (mode === "managed") {
    // Clones live at .den-services/<repo>/<branch>/ so the same repo at
    // different branches can coexist and be shared across workspaces.
    branch = wsEntry.branch ?? "main";
    repoPath = path.join(DEN_SERVICES_DIR, repoName, branch);
  } else {
    repoPath = wsEntry.path ?? "";
    branch = null;
  }

  return { address, repoName, subsystem, repoPath, branch, mode };
}

/**
 * Resolve the concrete subsystem for a bare repo address.
 *
 * Two repo shapes are supported:
 *
 *   Single-service repo — exactly one service in the manifest, regardless of
 *     what that service key is called. The workspace address stays as the repo
 *     name; we just correct the subsystem to the manifest key so command lookup
 *     works. e.g. repo "tasks-runner", manifest key "tool-runner"
 *     → address stays "tasks-runner", subsystem becomes "tool-runner".
 *
 *   Mono-repo — multiple services. The workspace entry must use an explicit
 *     "repo/subsystem" address for each service it wants to include.
 *     As a convenience, a bare "repo" entry auto-expands to ALL subsystems
 *     when none of the service keys matches the repo name.
 *
 * If the address already contains a slash it is an explicit subsystem address
 * and is returned unchanged.
 */
function expandMonoRepoEntry(resolved: ResolvedService): ResolvedService[] {
  if (resolved.subsystem !== resolved.repoName) {
    // Already an explicit "repo/subsystem" address — nothing to do.
    return [resolved];
  }

  const manifest = readManifestAnyBranch(resolved.repoName, resolved.repoPath);
  const serviceKeys = Object.keys(manifest?.services ?? {});

  if (serviceKeys.length === 0) {
    // No manifest services defined — pass through as-is.
    return [resolved];
  }

  if (serviceKeys.length === 1) {
    // Single-service repo. The service key may differ from the repo name
    // (e.g. repo "tasks-runner", key "tool-runner"). Correct
    // the subsystem so command lookup hits the right manifest entry while
    // keeping the clean repo-name address visible everywhere.
    return [{ ...resolved, subsystem: serviceKeys[0] }];
  }

  if (serviceKeys.includes(resolved.repoName)) {
    const rootService = {
      ...resolved,
      address: resolved.repoName,
      subsystem: resolved.repoName,
    };
    const subsystemServices = serviceKeys
      .filter((subsystem) => subsystem !== resolved.repoName)
      .map((subsystem) => ({
        ...resolved,
        address: `${resolved.repoName}/${subsystem}`,
        subsystem,
      }));
    return [rootService, ...subsystemServices];
  }

  // Bare mono-repo entry: expand to one resolved entry per subsystem.
  // (If the user wants only a specific subsystem they use "shop/shop" explicitly.)
  return serviceKeys.map((subsystem) => ({
    ...resolved,
    address: `${resolved.repoName}/${subsystem}`,
    subsystem,
  }));
}

/**
 * Compute missing dependencies for every service in a workspace.
 *
 * Returns one entry per service that has at least one `depends_on` entry not
 * covered by the workspace.  Services whose manifest cannot be read (e.g. the
 * repo hasn't been cloned yet) are silently skipped.
 */
export function computeMissingDeps(
  workspace: WorkspaceConfig,
  catalog: ServiceCatalog,
  workspaceName: string,
): Array<{ address: string; missingDeps: string[] }> {
  const expandedServices = listWorkspaceServices(
    workspace,
    catalog,
    workspaceName,
  );

  // Build the full set of present addresses — both expanded "shop/api" forms
  // and the bare repo name "shop" so either form matches in the filter below.
  const existingAddresses = new Set<string>();
  for (const s of expandedServices) {
    existingAddresses.add(s.address);
    existingAddresses.add(s.repoName);
  }

  const result: Array<{ address: string; missingDeps: string[] }> = [];

  for (const resolved of expandedServices) {
    try {
      const manifest = readManifestAnyBranch(
        resolved.repoName,
        resolved.repoPath,
      );
      const deps = manifest?.services?.[resolved.subsystem]?.depends_on ?? [];
      const missingDeps = deps.map(depService).filter((d) => {
        const resolvedDep = resolveDepAddress(
          d,
          catalog,
          workspace,
          workspaceName,
        );
        const { repoName: depRepo } = parseAddress(resolvedDep, catalog);
        return (
          !existingAddresses.has(resolvedDep) && !existingAddresses.has(depRepo)
        );
      });
      if (missingDeps.length > 0)
        result.push({ address: resolved.address, missingDeps });
    } catch {
      /* manifest not readable — skip */
    }
  }

  return result;
}

/**
 * Normalize a bare `depends_on` entry to its canonical service address.
 *
 * If `dep` already contains "/", it is returned as-is (explicit subsystem).
 * Otherwise it's a bare repo name and resolves as follows:
 *   - Multi-service repo with `entrypoint:` declared → "repoName/entrypoint"
 *   - All other cases (single-service repo with or without entrypoint,
 *     multi-service repo with no entrypoint, repo not in workspace, repo
 *     not in catalog) → returned as-is (bare repo name).
 *
 * Single-service repos are addressed by bare repo name regardless of an
 * `entrypoint:` declaration in their manifest — `expandMonoRepoEntry` keeps
 * the display address bare for them, and the init CLI only emits entrypoint
 * for multi-service repos. Appending the entrypoint subsystem here for a
 * single-service repo would produce an address that doesn't match the
 * display node, turning dep edges into orphan ghosts in the workspace graph.
 */
export function resolveDepAddress(
  dep: string,
  catalog: ServiceCatalog,
  workspace: WorkspaceConfig,
  workspaceName: string,
): string {
  if (dep.includes("/")) return dep; // already explicit — pass through
  if (!catalog[dep]) return dep; // not in catalog — leave as-is

  const resolved = resolveServiceSource(dep, workspaceName, workspace, catalog);
  if (!resolved) return dep;

  // Use readManifestAnyBranch (not readManifest) so we stay consistent with
  // expandMonoRepoEntry / computeMissingDeps. If the workspace branch lacks
  // .den.yml (e.g. file was added after the feature branch was cut), a
  // direct readManifest returns null here and the dep falls back to bare —
  // but expansion would still produce a `repo/entrypoint` display node from
  // an alt-branch manifest, leaving the edge dangling.
  const manifest = readManifestAnyBranch(resolved.repoName, resolved.repoPath);
  if (!manifest?.entrypoint) return dep;

  // Single-service repos: bare name is canonical (see expandMonoRepoEntry).
  // The entrypoint declaration is off-convention here but is tolerated so a
  // hand-authored manifest doesn't silently break the dep graph.
  const serviceKeys = Object.keys(manifest.services ?? {});
  if (serviceKeys.length <= 1) return dep;

  return `${dep}/${manifest.entrypoint}`;
}

/**
 * Return all service addresses defined in the active workspace that have
 * a corresponding catalog entry. Mono-repo root entries are expanded to
 * per-subsystem addresses using the repo's .den.yml.
 */
export function listWorkspaceServices(
  workspace: WorkspaceConfig,
  catalog: ServiceCatalog,
  workspaceName: string,
): ResolvedService[] {
  const results: ResolvedService[] = [];
  for (const address of Object.keys(workspace.services)) {
    const resolved = resolveServiceSource(
      address,
      workspaceName,
      workspace,
      catalog,
    );
    if (resolved) {
      results.push(...expandMonoRepoEntry(resolved));
    }
  }
  return results;
}

/**
 * Sync symlinks for JetBrains: each dev-managed repo outside the workspace
 * folder gets a symlink inside it so JetBrains detects the .git roots.
 * Only dev-managed repos are linked. Idempotent.
 */
export function syncJetBrainsWorkspaceSymlinks(wsFile: WorkspacesFile): void {
  for (const [name, ws] of Object.entries(wsFile.workspaces)) {
    const wsDir = path.join(DEN_WORKSPACES_DIR, name);
    try {
      fs.mkdirSync(wsDir, { recursive: true });
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const svc of Object.values(
      ws.services ?? {},
    ) as WorkspaceServiceEntry[]) {
      if (svc.mode !== "dev-managed" || !svc.path) continue;
      const target = svc.path;
      if (seen.has(target)) continue;
      seen.add(target);
      if (target.startsWith(wsDir + path.sep) || target === wsDir) continue;
      const linkPath = path.join(wsDir, path.basename(target));
      try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          if (fs.readlinkSync(linkPath) === target) continue;
          fs.unlinkSync(linkPath);
        } else {
          continue; // real file/dir — don't overwrite
        }
      } catch {
        // doesn't exist — fall through to create
      }
      try {
        fs.symlinkSync(target, linkPath);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Generate (or update) a VS Code multi-root workspace file for a den workspace.
 *
 * Only dev-managed repos are included — managed clones are excluded.
 * Dev-managed repos inside the workspace directory are listed with a relative
 * path (portable); those outside are listed with their absolute path — no
 * symlinks are created.
 *
 * Returns the absolute path to the generated `.code-workspace` file.
 */
export function generateVSCodeWorkspace(
  workspaceName: string,
  workspace: WorkspaceConfig,
  catalog: ServiceCatalog,
): string {
  const wsDir = workspace.directory
    ? path.join(ROOT, workspace.directory)
    : path.join(DEN_WORKSPACES_DIR, workspaceName);

  fs.mkdirSync(wsDir, { recursive: true });

  // One entry per unique repo path (mono-repos expand to multiple services).
  const services = listWorkspaceServices(workspace, catalog, workspaceName);
  const seen = new Set<string>();
  const folders: Array<{ name: string; path: string }> = [];

  for (const svc of services) {
    if (svc.mode !== "dev-managed") continue;
    if (!svc.repoPath || seen.has(svc.repoPath)) continue;
    seen.add(svc.repoPath);

    // Repos already inside the workspace folder (real clone or symlink) → relative.
    // Repos outside (dev-managed elsewhere) → absolute path.
    const insideWs =
      svc.repoPath === wsDir || svc.repoPath.startsWith(wsDir + path.sep);

    folders.push({
      name: svc.repoName,
      path: insideWs ? path.relative(wsDir, svc.repoPath) : svc.repoPath,
    });
  }

  const outPath = path.join(wsDir, `${workspaceName}.code-workspace`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ folders }, null, 2) + "\n",
    "utf-8",
  );
  return outPath;
}
