/**
 * Service Runner
 *
 * Resolves a service address → repo path → reads .den.yml →
 * executes commands (up / down / restart / any named command) with
 * streaming output.
 */

import { hasRuntime, repoKind } from "../repo-kind.js";
import { effectiveLocalCommands } from "../stacks/manifest-commands.js";
import { manifestStackName } from "../stacks/config.js";
import fs from "fs";
import path from "path";
import { readManifest } from "../manifest/read-manifest.js";
import {
  spawnStreaming,
  spawnInteractive,
  getServiceLogPath,
} from "../process/spawn-streaming.js";
import { isProductionEnv, readUserConfig } from "../den-config.js";
import { placementRefusal, servicePlacement } from "../manifest/placement.js";
import { lookupTab, recordTab, forgetTab } from "../cli-tabs.js";
import {
  closeTab,
  openTab,
  resolveTerminalApp,
  shellQuote,
} from "../terminal/tabs.js";
import { readCatalog } from "./catalog.js";
import { buildServiceEnv } from "./service-env.js";
import {
  devOpContainerNames,
  diffSpawnedContainers,
  forceStopOpctlContainers,
  inspectOpctlContainer,
  isOpctlAvailable,
  listRunningOpctlContainers,
} from "./opctl.js";
import {
  getActiveWorkspace,
  getActiveWorkspaces,
  getFocusedWorkspaceName,
  getWorkspaceByName,
  parseAddress,
  resolveServiceSource,
  listWorkspaceServices,
} from "./workspaces.js";
import {
  checkServiceHealth,
  checkCatalogHealth,
  type ServiceHealthResult,
} from "./health.js";
import { EventEmitter } from "events";
import type {
  CommandDef,
  ResolvedService,
  ServiceCatalog,
  WorkspaceConfig,
} from "../types/index.js";
import type { ChildProcess } from "child_process";
import { getStateDir } from "../paths.js";

import { product } from "../product.js";
// Re-export so existing callers don't need to change their import path.
export type { ServiceHealthResult };
export { checkServiceHealth, checkCatalogHealth };

// ── Daemon registry ───────────────────────────────────────────────────────────

export interface DaemonRecord {
  address: string;
  repoName: string;
  subsystem: string;
  repoPath: string;
  logPath: string;
  startedAt: Date;
  /**
   * Branch identity for share/conflict checks. Null/undefined means
   * "unspecified" (typical for dev-managed checkouts).
   */
  branch?: string | null;
  /**
   * Active workspaces that currently own this running instance (refcount).
   * Empty/missing on legacy records — filled on first attach/up.
   */
  workspaces?: string[];
  /**
   * opctl container names this service spawned, captured at `up` time. Used to
   * shut the service down via `opctl container down` without a declared down
   * command. Optional for backward-compat with records written before this.
   */
  containers?: string[];
}

export type ServiceConflictReason = "identity_mismatch" | "orphan_containers";

export class ServiceConflictError extends Error {
  readonly reason: ServiceConflictReason;
  readonly address: string;
  readonly owners: string[];
  readonly running: { repoPath: string; branch: string | null };
  readonly requested: { repoPath: string; branch: string | null };
  readonly orphanContainers?: string[];

  constructor(opts: {
    reason: ServiceConflictReason;
    address: string;
    owners: string[];
    running: { repoPath: string; branch: string | null };
    requested: { repoPath: string; branch: string | null };
    orphanContainers?: string[];
    message?: string;
  }) {
    const msg =
      opts.message ??
      (opts.reason === "orphan_containers"
        ? `Service "${opts.address}" has running opctl containers (${(opts.orphanContainers ?? []).join(", ")}) not tracked by ${product().cli} — refuse to start a second instance`
        : `Service "${opts.address}" is already running for workspace(s) [${opts.owners.join(", ")}] at ${opts.running.repoPath}` +
          ` (branch: ${opts.running.branch ?? "n/a"}), which differs from requested ${opts.requested.repoPath}` +
          ` (branch: ${opts.requested.branch ?? "n/a"})`);
    super(msg);
    this.name = "ServiceConflictError";
    this.reason = opts.reason;
    this.address = opts.address;
    this.owners = opts.owners;
    this.running = opts.running;
    this.requested = opts.requested;
    this.orphanContainers = opts.orphanContainers;
  }
}

// JSON representation — startedAt serialises as an ISO string.
type DaemonRecordJSON = Omit<DaemonRecord, "startedAt"> & { startedAt: string };

interface DaemonsFile {
  denPid: number;
  daemons: DaemonRecordJSON[];
}

const _daemonRegistry = new Map<string, DaemonRecord>();
let daemonRegistryLoadedFrom: string | null = null;

function getDaemonsFile(): string {
  return (
    process.env.DEN_DAEMONS_FILE ?? path.join(getStateDir(), "daemons.json")
  );
}

function normalizeBranch(branch: string | null | undefined): string | null {
  return branch ?? null;
}

export function sameDaemonIdentity(
  record: Pick<DaemonRecord, "repoPath" | "branch">,
  repoPath: string,
  branch: string | null | undefined,
): boolean {
  return (
    record.repoPath === repoPath &&
    normalizeBranch(record.branch) === normalizeBranch(branch)
  );
}

function toDaemonRecord(json: DaemonRecordJSON): DaemonRecord {
  return {
    ...json,
    workspaces: Array.isArray(json.workspaces) ? [...json.workspaces] : [],
    branch: normalizeBranch(json.branch),
    startedAt: new Date(json.startedAt),
  };
}

function readDaemonsFile(filePath: string): Map<string, DaemonRecord> {
  const map = new Map<string, DaemonRecord>();
  try {
    if (!fs.existsSync(filePath)) return map;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as
      | DaemonsFile
      | DaemonRecordJSON[];
    const records = Array.isArray(parsed) ? parsed : (parsed.daemons ?? []);
    for (const record of records) {
      if (!record.address) continue;
      map.set(record.address, toDaemonRecord(record));
    }
  } catch {
    // Corrupt or missing file: keep registry empty.
  }
  return map;
}

function replaceDaemonRegistry(records: Map<string, DaemonRecord>): void {
  _daemonRegistry.clear();
  for (const [address, record] of records.entries()) {
    _daemonRegistry.set(address, record);
  }
}

function saveDaemonsFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const records: DaemonRecordJSON[] = Array.from(_daemonRegistry.values()).map(
    (d) => ({ ...d, startedAt: d.startedAt.toISOString() }),
  );
  const file: DaemonsFile = { denPid: process.pid, daemons: records };
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
  }
}

/**
 * Populate the in-memory registry from the persisted daemons file.
 * Call once at server startup so daemons started in a previous session
 * are visible to the shutdown prompt.
 *
 * The persisted `denPid` is retained for file compatibility only. It is not
 * a whole-file validity gate: short-lived CLI processes start daemons and exit,
 * while those daemons can still be valid and should remain visible to later CLI
 * calls and the web UI.
 */
export function loadDaemonsFromFile(): void {
  const filePath = getDaemonsFile();
  replaceDaemonRegistry(readDaemonsFile(filePath));
  daemonRegistryLoadedFrom = filePath;
}

export function ensureDaemonRegistryLoaded(): void {
  const filePath = getDaemonsFile();
  if (daemonRegistryLoadedFrom === filePath) return;
  loadDaemonsFromFile();
}

export function registerDaemon(record: DaemonRecord): void {
  loadDaemonsFromFile();
  const existing = _daemonRegistry.get(record.address);
  // Owners are only inherited from a record describing the SAME checkout — a
  // registration for a different path/branch replaces the instance, so keeping
  // the old owners would refcount workspaces against something they never
  // started. (`up` blocks on identity mismatch before reaching here; adoption
  // after a lost record is the path that can legitimately differ.)
  const inherited = sameDaemonIdentity(
    existing ?? { repoPath: record.repoPath, branch: record.branch },
    record.repoPath,
    record.branch,
  )
    ? (existing?.workspaces ?? [])
    : [];
  const workspaces = [...new Set([...inherited, ...(record.workspaces ?? [])])];
  _daemonRegistry.set(record.address, {
    ...record,
    workspaces,
    branch: normalizeBranch(record.branch),
  });
  saveDaemonsFile(getDaemonsFile());
}

export function unregisterDaemon(address: string): void {
  loadDaemonsFromFile();
  _daemonRegistry.delete(address);
  saveDaemonsFile(getDaemonsFile());
}

/**
 * Merge observed container base-names into a daemon's record — used to refine
 * the spawn-time seed with the containers a run ACTUALLY created (union, so a
 * partial observation never loses declared candidates). No-op when the daemon
 * has since been unregistered.
 */
export function updateDaemonContainers(
  address: string,
  containers: string[],
): void {
  if (containers.length === 0) return;
  loadDaemonsFromFile();
  const existing = _daemonRegistry.get(address);
  if (!existing) return;
  const merged = [...new Set([...(existing.containers ?? []), ...containers])];
  _daemonRegistry.set(address, { ...existing, containers: merged });
  saveDaemonsFile(getDaemonsFile());
}

export function listDaemons(): DaemonRecord[] {
  loadDaemonsFromFile();
  return Array.from(_daemonRegistry.values());
}

export function findDaemonByAddress(address: string): DaemonRecord | undefined {
  loadDaemonsFromFile();
  return _daemonRegistry.get(address);
}

/** Add a workspace owner to a running daemon (share / attach). */
export function attachDaemonOwner(address: string, workspace: string): void {
  loadDaemonsFromFile();
  const existing = _daemonRegistry.get(address);
  if (!existing) return;
  const workspaces = existing.workspaces ?? [];
  if (!workspaces.includes(workspace)) {
    existing.workspaces = [...workspaces, workspace];
    _daemonRegistry.set(address, existing);
    saveDaemonsFile(getDaemonsFile());
  }
}

/**
 * Remove a workspace owner. Returns true when the daemon was fully
 * unregistered (no owners left); false when other owners remain.
 */
export function detachDaemonOwner(
  address: string,
  workspace: string,
): { removed: boolean; remaining: string[] } {
  loadDaemonsFromFile();
  const existing = _daemonRegistry.get(address);
  if (!existing) return { removed: true, remaining: [] };
  const remaining = (existing.workspaces ?? []).filter((w) => w !== workspace);
  if (remaining.length === 0) {
    _daemonRegistry.delete(address);
    saveDaemonsFile(getDaemonsFile());
    return { removed: true, remaining: [] };
  }
  existing.workspaces = remaining;
  _daemonRegistry.set(address, existing);
  saveDaemonsFile(getDaemonsFile());
  return { removed: false, remaining };
}

/**
 * A daemon's owners that are still in the active set.
 *
 * Refcount decisions must never count a workspace that has since been
 * deactivated or deleted: an inactive "owner" can't run `down` for itself
 * (`-w` requires activation), so counting it makes the last real owner detach
 * instead of stop and leaves the service unstoppable without `--force`.
 * `releaseWorkspaceDaemons` keeps the registry honest going forward; this
 * filter also self-heals records written before it existed.
 */
export function activeDaemonOwners(
  record: Pick<DaemonRecord, "workspaces"> | undefined,
  active: Set<string> = new Set(getActiveWorkspaces()),
): string[] {
  return (record?.workspaces ?? []).filter((w) => active.has(w));
}

/** Outcome of releasing one daemon during a workspace deactivation. */
export interface DaemonRelease {
  address: string;
  /** "detached" when other active owners remain, "stopped" when it was downed. */
  outcome: "detached" | "stopped" | "stop-failed";
  /** Active owners still holding the service after a detach. */
  remaining: string[];
}

/**
 * Release every daemon `workspace` owns (design decision 5: "deactivate
 * detaches ownership and stops only if last owner").
 *
 * Call AFTER the workspace has left `active[]` so the remaining-owner test
 * sees the post-deactivation world. Sole-owner instances are stopped through
 * the normal `down` path with `force` — the refcount question is already
 * settled here, and forcing skips a redundant second ownership check.
 */
export async function releaseWorkspaceDaemons(
  workspace: string,
  onLine: (line: string) => void = () => {},
): Promise<DaemonRelease[]> {
  const owned = listDaemons().filter((d) =>
    (d.workspaces ?? []).includes(workspace),
  );
  const active = new Set(getActiveWorkspaces());
  const releases: DaemonRelease[] = [];

  for (const daemon of owned) {
    const remaining = activeDaemonOwners(daemon, active).filter(
      (w) => w !== workspace,
    );
    if (remaining.length > 0) {
      detachDaemonOwner(daemon.address, workspace);
      onLine(
        `detached "${workspace}" from ${daemon.address} — still running for [${remaining.join(", ")}]`,
      );
      releases.push({
        address: daemon.address,
        outcome: "detached",
        remaining,
      });
      continue;
    }
    const exitCode = await new Promise<number>((resolve) => {
      runServiceCommand({
        address: daemon.address,
        command: "down",
        workspace,
        force: true,
        onLine,
        onClose: resolve,
      });
    });
    releases.push({
      address: daemon.address,
      outcome: exitCode === 0 ? "stopped" : "stop-failed",
      remaining: [],
    });
  }

  return releases;
}

type ServiceIdentity = Pick<
  ResolvedService,
  "address" | "repoPath" | "branch" | "repoName"
>;

/** Running opctl containers a service declares but den has no record of. */
function findOrphanContainers(resolved: ServiceIdentity): string[] {
  if (!isOpctlAvailable()) return [];
  const declared = [
    ...devOpContainerNames(resolved.repoPath),
    resolved.repoName,
  ].filter(Boolean);
  if (declared.length === 0) return [];
  const running = new Set(listRunningOpctlContainers().map((c) => c.base));
  return [...new Set(declared.filter((n) => running.has(n)))];
}

function mountsRepo(mountSources: string[], repoPath: string): boolean {
  return mountSources.some(
    (source) =>
      source === repoPath || source.startsWith(`${repoPath}${path.sep}`),
  );
}

/**
 * Untracked containers that verifiably run `resolved`'s own checkout, decided
 * by bind mounts (see `inspectOpctlContainer`).
 *
 * Den can lose a daemon record while the containers keep running — a web
 * server restart, a crash, a reaper sweep. Without a way back, every later `up`
 * hits the orphan-container block and the only exit is a manual teardown, so
 * these containers are adopted into the registry instead. Containers whose
 * mounts point at a different checkout are NOT adoptable: those are a genuine
 * conflict and must stay blocked.
 */
export function findAdoptableContainers(
  resolved: ServiceIdentity,
  orphans: string[] = findOrphanContainers(resolved),
): { containers: string[]; startedAt: Date | null } {
  const containers: string[] = [];
  let startedAt: Date | null = null;
  for (const base of orphans) {
    const info = inspectOpctlContainer(base);
    // No inspect result — can't claim it and can't blame it; leave it alone.
    if (!info || !mountsRepo(info.mountSources, resolved.repoPath)) continue;
    containers.push(base);
    if (info.startedAt && (!startedAt || info.startedAt < startedAt)) {
      startedAt = info.startedAt;
    }
  }
  return { containers, startedAt };
}

/**
 * Re-register already-running containers as a daemon owned by `workspace`.
 * Returns the adopted container names ([] when there is nothing to adopt).
 */
export function adoptRunningContainers(
  resolved: ResolvedService,
  workspace: string,
): string[] {
  const { containers, startedAt } = findAdoptableContainers(resolved);
  if (containers.length === 0) return [];
  registerDaemon({
    address: resolved.address,
    repoName: resolved.repoName,
    subsystem: resolved.subsystem,
    repoPath: resolved.repoPath,
    branch: resolved.branch,
    workspaces: [workspace],
    logPath: getServiceLogPath(resolved.repoName, resolved.subsystem),
    startedAt: startedAt ?? new Date(),
    containers: [
      ...new Set([...containers, ...devOpContainerNames(resolved.repoPath)]),
    ],
  });
  return containers;
}

/**
 * Record `workspace` as an owner of a service a caller is about to skip because
 * it already answers its health check.
 *
 * Skipping is right — nothing needs starting — but skipping SILENTLY loses the
 * refcount: the workspace never appears as an owner, so its `down` reports it
 * doesn't own the service, and another owner's `down` takes it away without
 * warning. Returns how ownership was recorded so callers can say so.
 */
export function claimHealthyService(
  resolved: ResolvedService,
  workspace: string,
): "attached" | "adopted" | "untracked" {
  const existing = findDaemonByAddress(resolved.address);
  if (existing) {
    if (!sameDaemonIdentity(existing, resolved.repoPath, resolved.branch)) {
      // Healthy, but the record describes a different checkout — leave the
      // registry alone rather than claim something we can't vouch for.
      return "untracked";
    }
    attachDaemonOwner(resolved.address, workspace);
    return "attached";
  }
  return adoptRunningContainers(resolved, workspace).length > 0
    ? "adopted"
    : "untracked";
}

/**
 * Check whether starting `resolved` for `workspace` conflicts with a live
 * daemon or orphan opctl containers. Returns null when start/attach is OK;
 * callers should attach when a matching daemon already exists, or adopt when
 * `findAdoptableContainers` reports untracked containers of the same checkout.
 */
export function findDaemonConflict(
  resolved: Pick<
    ResolvedService,
    "address" | "repoPath" | "branch" | "repoName"
  >,
): ServiceConflictError | null {
  loadDaemonsFromFile();
  const existing = _daemonRegistry.get(resolved.address);
  if (existing) {
    if (sameDaemonIdentity(existing, resolved.repoPath, resolved.branch)) {
      return null;
    }
    return new ServiceConflictError({
      reason: "identity_mismatch",
      address: resolved.address,
      owners: existing.workspaces ?? [],
      running: {
        repoPath: existing.repoPath,
        branch: normalizeBranch(existing.branch),
      },
      requested: {
        repoPath: resolved.repoPath,
        branch: normalizeBranch(resolved.branch),
      },
    });
  }

  const orphans = findOrphanContainers(resolved);
  if (orphans.length === 0) return null;
  if (findAdoptableContainers(resolved, orphans).containers.length > 0) {
    return null;
  }
  return new ServiceConflictError({
    reason: "orphan_containers",
    address: resolved.address,
    owners: [],
    running: {
      repoPath: resolved.repoPath,
      branch: normalizeBranch(resolved.branch),
    },
    requested: {
      repoPath: resolved.repoPath,
      branch: normalizeBranch(resolved.branch),
    },
    orphanContainers: orphans,
  });
}

function canResolveDaemonAddress(d: DaemonRecord): boolean {
  if (resolveService(d.address)) return true;
  for (const w of d.workspaces ?? []) {
    if (resolveService(d.address, w)) return true;
  }
  for (const w of getActiveWorkspaces()) {
    if (resolveService(d.address, w)) return true;
  }
  return false;
}

/**
 * True when a registered daemon is opctl-based (has candidate container names)
 * and NONE of its candidates are currently running — i.e. its containers died
 * or were killed out from under it.
 *
 * Non-opctl daemons (no discoverable containers) can't be verified this way and
 * are treated as alive, same contract as `pruneDeadDaemons`. Pass `running`
 * when checking many daemons to avoid one `docker ps` per record.
 */
export function isDaemonVerifiablyDead(
  d: DaemonRecord,
  running: Set<string> | null = isOpctlAvailable()
    ? new Set(listRunningOpctlContainers().map((c) => c.base))
    : null,
): boolean {
  if (!running) return false; // opctl unavailable — can't verify liveness
  const opctlCandidates = [
    ...(d.containers ?? []),
    ...devOpContainerNames(d.repoPath),
  ].filter(Boolean);
  if (opctlCandidates.length === 0) return false; // non-opctl — trust it
  return ![...opctlCandidates, d.repoName].some((c) => running.has(c));
}

/**
 * Remove persisted daemons that are no longer running — called at startup to
 * clear stale entries from previous sessions. Otherwise they reopen as tabs in
 * the web UI and clutter the shutdown prompt.
 *
 * A daemon is dropped when:
 *  - its address no longer resolves to a workspace/catalog service, OR
 *  - it is opctl-based (has captured containers or a discoverable dev-op) and
 *    NONE of its candidate containers are currently running.
 *
 * Daemons with no discoverable opctl containers are KEPT — we can't verify them
 * via `opctl container ls`, so we err toward keeping a possibly-live process
 * (e.g. a non-opctl dev server). Health is deliberately NOT used: a service's
 * shared-infra health check (Postgres/Redis/LocalStack from infra-stack) stays
 * green whether or not the service itself is running. Returns pruned addresses.
 */
export function pruneDeadDaemons(): string[] {
  const daemons = listDaemons();
  if (daemons.length === 0) return [];
  const running = isOpctlAvailable()
    ? new Set(listRunningOpctlContainers().map((c) => c.base))
    : null;
  const pruned: string[] = [];
  for (const d of daemons) {
    try {
      if (!canResolveDaemonAddress(d)) {
        unregisterDaemon(d.address);
        pruned.push(d.address);
        continue;
      }
      if (isDaemonVerifiablyDead(d, running)) {
        unregisterDaemon(d.address);
        pruned.push(d.address);
      }
    } catch {
      /* keep the entry on any error */
    }
  }
  return pruned;
}

// ── Service resolution ────────────────────────────────────────────────────────

/**
 * Resolve a service address against a workspace + catalog.
 * When `workspaceName` is omitted, uses the focused workspace.
 * Returns null if the service is not found.
 */
export function resolveService(
  address: string,
  workspaceName?: string,
): ResolvedService | null {
  const ws = workspaceName
    ? getWorkspaceByName(workspaceName)
    : getActiveWorkspace();
  if (!ws) return null;
  const catalog = readCatalog();
  const listed = resolveListedService(address, ws, catalog);
  if (listed || address.includes("/")) return listed;
  // Not a repo or a listed address: a service key or a stack name, when it
  // names exactly one service in the workspace.
  const candidates = aliasCandidates(address, ws, catalog);
  return candidates.length === 1
    ? resolveListedService(candidates[0], ws, catalog)
    : null;
}

type NamedWorkspace = { name: string; config: WorkspaceConfig };

/**
 * The addresses `alias` could mean in `ws`: every service whose manifest key
 * is `alias`, and the repo of every compose stack named `alias` (a stack
 * stands for its repo; when that repo also has a service named `alias`, the
 * service is the one match). Sorted; empty for a `repo/service` address and
 * for a catalog repo's name.
 */
function aliasCandidates(
  alias: string,
  ws: NamedWorkspace,
  catalog: ServiceCatalog,
): string[] {
  // A repo name is never an alias, in the workspace or not.
  if (alias.includes("/") || catalog[alias]) return [];
  const services = new Set<string>();
  const stackRepos = new Set<string>();
  for (const s of listWorkspaceServices(ws.config, catalog, ws.name)) {
    if (s.subsystem === alias) services.add(s.address);
    const manifest = readManifest(s.repoPath);
    if (manifest?.compose && manifestStackName(manifest, s.repoName) === alias)
      stackRepos.add(s.repoName);
  }
  const withService = new Set(
    [...services].map((a) => parseAddress(a, catalog).repoName),
  );
  return [
    ...services,
    ...[...stackRepos].filter((r) => !withService.has(r)),
  ].sort();
}

function namedWorkspace(workspaceName?: string): NamedWorkspace | null {
  return workspaceName
    ? getWorkspaceByName(workspaceName)
    : getActiveWorkspace();
}

/**
 * What `alias` could address in the workspace (the focused one by default)
 * when it is not a repo or a listed address: see resolveService.
 */
export function serviceAliasCandidates(
  alias: string,
  workspaceName?: string,
): string[] {
  const ws = namedWorkspace(workspaceName);
  if (!ws) return [];
  const catalog = readCatalog();
  if (resolveListedService(alias, ws, catalog)) return [];
  return aliasCandidates(alias, ws, catalog);
}

/**
 * The address to use for what someone typed: an unambiguous alias becomes
 * the service's own address; anything else is returned as is. An ambiguous
 * alias throws, naming the candidates.
 */
export function canonicalServiceAddress(
  address: string,
  workspaceName?: string,
): string {
  const candidates = serviceAliasCandidates(address, workspaceName);
  if (candidates.length > 1) {
    const ws = namedWorkspace(workspaceName)?.name ?? "default";
    throw new Error(
      `"${address}" is ambiguous in workspace "${ws}": ${candidates.join(", ")}; name one of them`,
    );
  }
  return candidates[0] ?? address;
}

/** resolveService for a repo name or a listed address (no aliases). */
function resolveListedService(
  address: string,
  ws: NamedWorkspace,
  catalog: ServiceCatalog,
): ResolvedService | null {
  let resolved = resolveServiceSource(address, ws.name, ws.config, catalog);

  // Bare multi-service repo registered ONLY by subsystem (e.g. "shop/db" +
  // "shop/api" with no bare "shop" entry): resolve via a "repo/subsystem" entry,
  // preferring the manifest entrypoint, so the bare repo name is still runnable
  // (the derived graph + `den up` address repos by bare name).
  if (!resolved && !address.includes("/")) {
    const subAddrs = Object.keys(ws.config.services).filter((a) =>
      a.startsWith(`${address}/`),
    );
    if (subAddrs.length > 0) {
      const first = resolveServiceSource(
        subAddrs[0],
        ws.name,
        ws.config,
        catalog,
      );
      const entry = first
        ? readManifest(first.repoPath)?.entrypoint
        : undefined;
      const chosen =
        entry && subAddrs.includes(`${address}/${entry}`)
          ? `${address}/${entry}`
          : subAddrs[0];
      resolved = resolveServiceSource(chosen, ws.name, ws.config, catalog);
    }
  }
  if (!resolved) return null;

  // Bare repo address correction: when the address is just the repo name, the
  // subsystem defaults to the repo name, which usually isn't a manifest service
  // key. Map it to a runnable subsystem so command lookup
  // (`manifest.services[subsystem]`) hits a real entry:
  //   - single-service repo  → that one service
  //   - multi-service repo   → the declared `entrypoint` (e.g. links-api's
  //                            services are pg/redis/localstack/api, entrypoint
  //                            api → `make _api-up`). Without this the derived
  //                            `up` fails with "command up not found".
  // (The listing path, expandMonoRepoEntry, instead fans a bare multi-service
  // entry out to ALL subsystems; here we run the single entrypoint node.)
  if (resolved.subsystem === resolved.repoName) {
    const manifest = readManifest(resolved.repoPath);
    const serviceKeys = Object.keys(manifest?.services ?? {});
    if (!serviceKeys.includes(resolved.subsystem)) {
      if (serviceKeys.length === 1) {
        return { ...resolved, subsystem: serviceKeys[0] };
      }
      if (manifest?.entrypoint && serviceKeys.includes(manifest.entrypoint)) {
        return { ...resolved, subsystem: manifest.entrypoint };
      }
    }
  }

  return resolved;
}

/** Return all services in the focused (or named) workspace. */
export function getWorkspaceServices(
  workspaceName?: string,
): ResolvedService[] {
  const ws = workspaceName
    ? getWorkspaceByName(workspaceName)
    : getActiveWorkspace();
  if (!ws) return [];
  const catalog = readCatalog();
  return listWorkspaceServices(ws.config, catalog, ws.name);
}

// ── Command execution ─────────────────────────────────────────────────────────

function commandDefToString(cmdDef: CommandDef): string {
  return typeof cmdDef === "string" ? cmdDef : cmdDef.cmd;
}

function isLegacyOpctlKillCommand(cmdString: string): boolean {
  return /^opctl\s+kill\s*$/.test(cmdString.trim());
}

function inferOpctlContainerName(resolved: ResolvedService): string {
  return resolved.repoName || path.basename(resolved.repoPath);
}

/**
 * Whether `resolved` speaks for the repo's MAIN container for teardown
 * purposes: a bare repo address, a single-service repo, a repo with no
 * declared entrypoint, or the entrypoint subsystem itself.
 *
 * Auxiliary subsystems (files-api/s3, links-api/pg, …) are thin
 * wrappers around shared infra or one-shot bootstrap ops. By opctl convention
 * the container named exactly for the repo ("files-api") belongs to the
 * entrypoint, so an auxiliary down must never claim it — that is how downing
 * `files-api/s3` from one workspace SIGKILLed the files-api API that
 * another workspace was running.
 */
function ownsRepoContainers(
  resolved: Pick<ResolvedService, "address" | "repoPath" | "subsystem">,
): boolean {
  if (!resolved.address.includes("/")) return true;
  const manifest = readManifest(resolved.repoPath);
  const serviceKeys = Object.keys(manifest?.services ?? {});
  if (serviceKeys.length <= 1) return true;
  const entry = manifest?.entrypoint;
  if (!entry) return true; // no declared entrypoint — keep repo-wide behavior
  return resolved.subsystem === entry;
}

/**
 * The container base-names to seed a daemon record with at spawn time.
 *
 * Repo-owning addresses get the full manifest declaration; auxiliary
 * subsystems only get names with affinity to themselves, so an s3/pg/redis
 * record never claims the repo's main container and can never arm a
 * repo-wide kill through the registry candidate set.
 */
function spawnContainerCandidates(
  resolved: Pick<
    ResolvedService,
    "address" | "repoPath" | "subsystem" | "repoName"
  >,
): string[] {
  const declared = devOpContainerNames(resolved.repoPath);
  if (ownsRepoContainers(resolved)) return declared;
  return declared.filter(
    (n) =>
      n === resolved.subsystem ||
      n === `${resolved.repoName}-${resolved.subsystem}` ||
      n.endsWith(`-${resolved.subsystem}`),
  );
}

/**
 * The opctl container base-names to take down for a service: candidate names
 * (captured at spawn, declared in the repo's dev/up op, or the repo name)
 * intersected with what is actually running now (`opctl container ls`).
 *
 * Matching live state means no spawn-time timing guesswork and a natural no-op
 * when nothing is running. Returns [] when opctl is unavailable or nothing
 * matches (so the caller falls back to the declared `down` command — e.g.
 * infra-stack's nested-op containers, or a non-opctl service).
 *
 * Auxiliary subsystems (see `ownsRepoContainers`) never target the repo's main
 * container: their down must not take out the entrypoint daemon that other
 * addresses/workspaces own.
 */
function resolveOpctlDownTargets(resolved: ResolvedService): string[] {
  if (!isOpctlAvailable()) return [];
  ensureDaemonRegistryLoaded();
  const repoWide = ownsRepoContainers(resolved);
  const candidates = new Set<string>(
    [
      ...(_daemonRegistry.get(resolved.address)?.containers ?? []),
      ...devOpContainerNames(resolved.repoPath),
      resolved.repoName,
    ].filter(Boolean),
  );
  // A manifest-less resolve keeps the BARE address ("shop"), while daemons are
  // registered under subsystem addresses ("shop/api") — so also take any
  // registry entry whose repo matches. Without this, a fresh checkout (clone
  // not yet created) can never down a service the previous checkout started.
  // Only repo-wide addresses may sweep in sibling records: an auxiliary
  // subsystem must not inherit the entrypoint's containers.
  if (repoWide) {
    for (const [addr, rec] of _daemonRegistry) {
      if (
        addr === resolved.repoName ||
        addr.startsWith(`${resolved.repoName}/`)
      ) {
        for (const c of rec.containers ?? []) candidates.add(c);
      }
    }
  }
  const targets = new Set<string>();
  // Conventional container naming: a repo's opctl containers are named either
  // exactly for the repo ("files-api") or repo-prefixed
  // ("shop-api" for shop, "jobs-runtime-small"). The prefix rule only
  // claims a base no OTHER catalog repo claims more precisely, so `down shop`
  // can never take shop-web's container. This is what makes `down` work with
  // no manifest and no clone on disk — down is conventional by contract.
  const otherRepos = Object.keys(readCatalog()).filter(
    (r) => r !== resolved.repoName,
  );
  const claimedByOther = (base: string): boolean =>
    otherRepos.some((o) => base === o || base.startsWith(`${o}-`));
  // An auxiliary subsystem only claims bases with NAME AFFINITY to itself
  // ("pg", "shop-postgres", "stack-local-localstack"), never the repo-named or
  // other entrypoint containers its repo-wide candidate set (manifest names,
  // legacy registry records) would otherwise sweep in.
  const subsystemAffine = (base: string): boolean =>
    base === resolved.subsystem ||
    base === `${resolved.repoName}-${resolved.subsystem}` ||
    base.endsWith(`-${resolved.subsystem}`);
  for (const c of listRunningOpctlContainers()) {
    const matched =
      candidates.has(c.base) ||
      c.base === resolved.repoName ||
      (c.base.startsWith(`${resolved.repoName}-`) && !claimedByOther(c.base));
    if (!matched) continue;
    if (!repoWide && !subsystemAffine(c.base)) continue;
    targets.add(c.base);
  }
  return [...targets];
}

/**
 * True when any of the service's opctl containers are currently running —
 * the run-state signal `restart` uses to skip a pointless (and possibly
 * error-prone) down phase on an already-stopped service.
 */
export function hasRunningOpctlContainers(resolved: ResolvedService): boolean {
  return resolveOpctlDownTargets(resolved).length > 0;
}

export function rewriteLegacyOpctlKillCommandForContainer(
  command: string,
  cmdString: string,
  containerName: string,
  onLine?: (line: string) => void,
): string {
  if (command !== "down" || !isLegacyOpctlKillCommand(cmdString)) {
    return cmdString;
  }

  const rewritten = `opctl container delete --label container-name=${shellQuote(containerName)}`;
  onLine?.(
    `legacy "opctl kill" mapped to opctl container delete for ${containerName}`,
  );
  return rewritten;
}

function rewriteLegacyOpctlKillCommand(
  command: string,
  cmdString: string,
  resolved: ResolvedService,
  onLine?: (line: string) => void,
): string {
  return rewriteLegacyOpctlKillCommandForContainer(
    command,
    cmdString,
    inferOpctlContainerName(resolved),
    onLine,
  );
}

function isOpctlContainerDownCommand(cmd: string): boolean {
  return /\bopctl\s+container\s+down\b/i.test(cmd);
}

/** Base names from `opctl container down <base> [--force]` (and `;`-chained forms). */
function opctlDownBasesFromCommand(cmd: string): string[] {
  const bases: string[] = [];
  for (const part of cmd.split(/;|&&/)) {
    const m = part.match(/opctl\s+container\s+down\s+(\S+)/i);
    if (!m) continue;
    bases.push(m[1].replace(/^['"]|['"]$/g, ""));
  }
  return bases;
}

export function shouldDetachServiceCommand(
  command: string,
  cmdDef: CommandDef,
): boolean {
  return command === "down" || command === "setup"
    ? false
    : typeof cmdDef === "string"
      ? true
      : // restart ends with a long-running up, so it detaches unless the
        // command says it finishes on its own (`detachable: false`).
        (cmdDef.detachable ?? true);
}

export function isInteractiveServiceCommand(cmdDef: CommandDef): boolean {
  return typeof cmdDef === "string" ? false : (cmdDef.interactive ?? false);
}

/**
 * Runtime for a service command: a real terminal tab, or a backgrounded daemon
 * whose output is streamed. Only starting commands can run in a tab — a `down`
 * in a tab would close before you could read it.
 *
 * `DEN_FORCE_TABS` (the CLI's `--tabs` / `--no-tabs`) wins over the
 * `cli_tabs` preference. Shared by the CLI and the web exec routes so the
 * preference means the same thing wherever an up is triggered from.
 */
export function resolveServiceRuntime(command: string): "daemon" | "tab" {
  if (command !== "up" && command !== "restart") return "daemon";
  if (process.env.DEN_FORCE_TABS === "1") return "tab";
  if (process.env.DEN_FORCE_TABS === "0") return "daemon";
  return readUserConfig().cli_tabs ? "tab" : "daemon";
}

export interface RunCommandOptions {
  /** Service address: "shop/api" or "tasks-runner" */
  address: string;
  /** Command name from .den.yml services.<subsystem>.commands.local: "up", "down", "restart" */
  command: string;
  onLine: (line: string) => void;
  onClose: (exitCode: number) => void;
  env?: NodeJS.ProcessEnv;
  runtime?: "daemon" | "tab";
  /**
   * Workspace to resolve/own this command against. Defaults to focus.
   * Must be active when provided by CLI/API callers (enforced upstream).
   */
  workspace?: string;
  /**
   * For `down`: stop the instance even when other workspaces still own it.
   */
  force?: boolean;
  /**
   * Fires when the SERVICE process itself exits (daemon mode). onClose only
   * tracks the streaming tail, so without this a `make up` that dies AFTER
   * the detach window is invisible to fail-fast callers.
   */
  onServiceExit?: (exitCode: number) => void;
}

export interface RunCommandResult {
  proc: ChildProcess;
  /** True when the command is expected to run indefinitely (e.g. `up`). */
  detachable: boolean;
  /**
   * True when the command requires interactive terminal access (HITL).
   * The process inherits the parent's stdin/stdout/stderr — no output is
   * streamed via onLine. The caller must suspend any spinner before the
   * command runs.
   */
  interactive: boolean;
  /**
   * For detachable daemon commands: path to the log file the service is
   * writing to. Callers can surface this so the user knows where to look.
   */
  logPath?: string;
  tab?: {
    terminalApp: "iterm2" | "terminal";
    tabId: string;
  };
}

/**
 * Resolve and execute a service command.
 * Returns the spawned child process and whether it is a long-running (detachable) command.
 * Detachable procs have already been unref()'d — the caller should not await their exit.
 */
export function runServiceCommand(
  options: RunCommandOptions,
): RunCommandResult {
  const {
    address,
    command,
    onLine,
    onClose,
    env: optionEnv,
    onServiceExit,
    force = false,
  } = options;
  const runtime = options.runtime ?? "daemon";
  const workspace = options.workspace ?? getFocusedWorkspaceName() ?? "default";

  // Inject den-resolved shared env (the org config's service_env) under any explicit
  // per-call env, so consumer repos get correct locations regardless of where
  // their checkout lives. buildServiceEnv never overrides caller-set values.
  const sharedEnv = buildServiceEnv();
  const env: NodeJS.ProcessEnv = { ...sharedEnv, ...optionEnv };

  // The tab variant carries only the den-RESOLVED values, never the caller's
  // env: `getSudoEnv()`'s PATH points at a private askpass dir that must not
  // leak into a user's shell, and a tab already has the user's own PATH.
  const tabEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(sharedEnv)) {
    if (typeof value === "string" && value) tabEnv[key] = value;
  }

  const dummy = (): RunCommandResult => ({
    proc: new EventEmitter() as unknown as ChildProcess,
    detachable: false,
    interactive: false,
  });

  // NEVER invoke onClose synchronously (zalgo): callers register the callback
  // in the same expression that receives our return value, so a sync call
  // observes their `proc` binding in TDZ — that ReferenceError crashed the
  // whole web server when workspace Down hit a system with nothing to stop.
  const closeAsync = (code: number): void => {
    setImmediate(() => onClose(code));
  };

  const resolved = resolveService(address, workspace);
  if (!resolved) {
    const candidates = serviceAliasCandidates(address, workspace);
    onLine(
      `Error: service "${address}" not found in catalog or workspace "${workspace}"` +
        (candidates.length > 1
          ? `; it is ambiguous: ${candidates.join(", ")}`
          : ""),
    );
    closeAsync(1);
    return dummy();
  }

  const { repoPath, subsystem } = resolved;

  // R13: Den never runs a command on a remote service. A down stops nothing
  // here, which is a success; anything else is refused.
  const refusal = placementRefusal(
    resolved.address,
    servicePlacement(readManifest(repoPath), subsystem, "local"),
    (e) => isProductionEnv(e) === true,
    command,
  );
  if (refusal) {
    onLine(refusal);
    closeAsync(command === "down" ? 0 : 1);
    return dummy();
  }

  // ── Up: share-if-identical / hard-block on conflict ─────────────────────────
  if (command === "up" || command === "restart") {
    let existing = findDaemonByAddress(resolved.address);
    // A registry record whose containers all died (killed, crashed, reaped)
    // must not gate the start: attaching to it would report "already running"
    // while nothing runs, and a mismatched-identity corpse would raise a
    // conflict against a daemon that no longer exists. Drop it and start fresh.
    if (existing && isDaemonVerifiablyDead(existing)) {
      onLine(
        `stale daemon record for ${resolved.address} — no running containers; starting fresh`,
      );
      unregisterDaemon(resolved.address);
      existing = undefined;
    }
    if (
      existing &&
      sameDaemonIdentity(existing, resolved.repoPath, resolved.branch)
    ) {
      attachDaemonOwner(resolved.address, workspace);
      const owners = findDaemonByAddress(resolved.address)?.workspaces ?? [
        workspace,
      ];
      onLine(
        command === "restart"
          ? `restarting the running instance (shared) — owners: [${owners.join(", ")}] at ${resolved.repoPath}`
          : `already running (shared) — owners: [${owners.join(", ")}] at ${resolved.repoPath}`,
      );
      // restart still needs to bounce; only short-circuit pure `up`.
      if (command === "up") {
        closeAsync(0);
        return dummy();
      }
      // A restart interrupts every owner, which is exactly what `down`'s
      // refcount refuses to do silently. Restarting a shared service is still
      // allowed (it comes back), but the other owners must be named.
      const coOwners = activeDaemonOwners({ workspaces: owners }).filter(
        (w) => w !== workspace,
      );
      if (coOwners.length > 0) {
        onLine(
          `Warning: restarting a shared instance — this interrupts [${coOwners.join(", ")}]`,
        );
      }
    } else {
      const conflict = findDaemonConflict(resolved);
      if (conflict) {
        onLine(`Error: ${conflict.message}`);
        closeAsync(1);
        return dummy();
      }
      const adopted = adoptRunningContainers(resolved, workspace);
      if (adopted.length > 0) {
        onLine(
          `adopted already-running containers (${adopted.join(", ")}) — owners: [${workspace}] at ${resolved.repoPath}`,
        );
        // restart still needs to bounce; only short-circuit pure `up`.
        if (command === "up") {
          closeAsync(0);
          return dummy();
        }
      }
    }
  }

  // ── Down: refcount detach unless last owner or --force ──────────────────────
  // Only ACTIVE owners count: a deactivated workspace can't stop the service
  // itself, so letting it hold a reference would wedge the instance.
  if (command === "down" && !force) {
    const existing = findDaemonByAddress(resolved.address);
    const owners = activeDaemonOwners(existing);
    if (owners.length > 0 && !owners.includes(workspace)) {
      onLine(
        `workspace "${workspace}" does not own running "${resolved.address}" (owners: [${owners.join(", ")}]) — use \`--force\` to stop it anyway`,
      );
      closeAsync(0);
      return dummy();
    }
    if (owners.length > 1 && owners.includes(workspace)) {
      detachDaemonOwner(resolved.address, workspace);
      const remaining = owners.filter((w) => w !== workspace);
      onLine(
        `detached workspace "${workspace}" — still running for [${remaining.join(", ")}]`,
      );
      closeAsync(0);
      return dummy();
    }
  }

  // Down via opctl: stop the service's running containers directly, identified
  // from live `opctl container ls` ∪ docker `opctl_<base>_<hash>` names — no
  // declared down command (or even a manifest) required. Falls through to the
  // manifest-defined down only when no opctl container matches (infra-stack's
  // nested-op containers, non-opctl services, or nothing running).
  if (command === "down") {
    const targets = resolveOpctlDownTargets(resolved);
    if (targets.length > 0) {
      const downCmd = targets
        .map((name) => `opctl container down ${shellQuote(name)} --force`)
        .join("; ");
      onLine(`opctl container down: ${targets.join(", ")}`);
      const proc = spawnStreaming(
        downCmd,
        [],
        // spawnStreaming uses this as the COMPLETE child env, so process.env
        // (notably PATH) must be included or `opctl` isn't found and every
        // teardown exits 1 — leaving every container running.
        { ...process.env, ...env },
        onLine,
        (exitCode) => {
          unregisterDaemon(resolved.address);
          const existing = lookupTab(resolved.address);
          if (existing) {
            try {
              closeTab(existing.tabId, existing.terminalApp);
              forgetTab(resolved.address);
            } catch {
              /* best-effort tab cleanup */
            }
          }
          // opctl can exit 1 even when the teardown succeeded — judge the
          // OUTCOME, not the exit code: if none of the service's containers
          // are running anymore, the down worked. (Everything downstream —
          // restart's verify gate, the ✓/✗ in the UI, CLI down — keys off
          // this close code.)
          //
          // When containers ARE still running, fall back to `docker rm -f`:
          // opctl re-elevates with `sudo -E`, which fails on sudoers that grant
          // NOPASSWD for opctl without SETENV ("sorry, you are not allowed to
          // preserve the environment"). Docker socket access needs no sudo.
          if (exitCode !== 0) {
            const remaining = resolveOpctlDownTargets(resolved);
            if (remaining.length === 0) {
              onLine(
                `opctl exited ${exitCode} but the containers are stopped — down succeeded`,
              );
              onClose(0);
              return;
            }
            onLine(
              `opctl container down failed (exit ${exitCode}); falling back to docker for: ${remaining.join(", ")}`,
            );
            const { stopped, failed } = forceStopOpctlContainers(remaining);
            for (const name of stopped) onLine(`docker rm -f ${name}`);
            if (failed.length > 0) {
              onLine(`docker fallback failed for: ${failed.join(", ")}`);
            } else if (resolveOpctlDownTargets(resolved).length === 0) {
              onLine(
                "docker fallback stopped remaining containers — down succeeded",
              );
              onClose(0);
              return;
            }
          }
          onClose(exitCode);
        },
        // The clone may not exist yet (fresh checkout, managed repo
        // never pulled) — a nonexistent cwd makes spawn fail with ENOENT and
        // the teardown "fails" while every container keeps running. opctl
        // doesn't need the repo dir to stop containers by name.
        fs.existsSync(repoPath) ? repoPath : undefined,
        false,
      );
      return { proc, detachable: false, interactive: false };
    }
  }

  const manifest = readManifest(repoPath);
  if (!manifest) {
    // Down stays conventional even with no manifest on disk (fresh checkout,
    // clone not yet created): no matching containers + nothing declared means
    // there is nothing to stop — success, same contract as the declared-down
    // fallthrough below.
    if (command === "down") {
      onLine(
        `nothing to stop (no matching opctl containers; no manifest at ${repoPath})`,
      );
      closeAsync(0);
      return dummy();
    }
    onLine(`Error: could not read ${product().manifestYml} in ${repoPath}`);
    closeAsync(1);
    return dummy();
  }

  const svcCommands = effectiveLocalCommands(
    manifest,
    subsystem,
    resolved.repoName,
    workspace,
  );
  let cmdDef = svcCommands[command];
  const requestedCmdDef = cmdDef;

  // `restart` fallback: synthesise `make down && make up` when no explicit
  // restart command exists but both down and up are defined.
  if (!cmdDef && command === "restart") {
    const downDef = svcCommands["down"];
    const upDef = svcCommands["up"];
    if (downDef && upDef) {
      const downCmd = rewriteLegacyOpctlKillCommand(
        "down",
        commandDefToString(downDef),
        resolved,
      );
      const upCmd = commandDefToString(upDef);
      cmdDef = `${downCmd} && ${upCmd}`;
    }
  }

  if (!cmdDef) {
    // Down is opctl-conventional: when no container is running AND the manifest
    // declares no down command, there is simply nothing to stop — that's a
    // successful down, not an error (keeps the ⋮ menu / workspace Down safe to
    // offer on every system).
    if (command === "down") {
      onLine("nothing to stop (no running opctl containers, no down command)");
      closeAsync(0);
      return dummy();
    }
    // A service with no commands of its own is started by its repo's up
    // (placement's repo-level rule). Up runs that; anything else would
    // reach the repo's other services too, so it says so instead.
    const repoEntry = resolveService(resolved.repoName, workspace);
    const repoCommands =
      repoEntry && repoEntry.subsystem !== subsystem
        ? effectiveLocalCommands(
            manifest,
            repoEntry.subsystem,
            resolved.repoName,
            workspace,
          )
        : {};
    if (repoEntry && repoCommands["up"]) {
      if (command === "up") {
        onLine(
          `${resolved.address} has no up of its own; running ${resolved.repoName}'s up, which starts it`,
        );
        return runServiceCommand({ ...options, address: resolved.repoName });
      }
      onLine(
        `Error: ${resolved.address} has no ${command} of its own; it is started by ${resolved.repoName}'s up. ` +
          `Run \`${product().cli} ${command} ${resolved.repoName}\` (that reaches every service it starts).`,
      );
      closeAsync(1);
      return dummy();
    }
    onLine(
      `Error: command "${command}" not found for service "${address}" (subsystem "${subsystem}") in local environment`,
    );
    closeAsync(1);
    return dummy();
  }

  const cmdString = rewriteLegacyOpctlKillCommand(
    command,
    commandDefToString(cmdDef),
    resolved,
    onLine,
  );

  // Manifest downs that are just `opctl container down <name>` must not be
  // spawned raw: opctl re-elevates with `sudo -E` and fails on sudoers without
  // SETENV even when there is nothing to stop — which is why files-api/api
  // reported ✗ while connections/scribe's shell scripts reported ✓ (and left
  // containers running when discovery only trusted `opctl container ls`).
  // Nothing running → success. Something running → the resilient path above
  // already handles it via docker-aware discovery; if we somehow get here with
  // targets, route through the same docker fallback instead of a naked opctl.
  if (command === "down" && isOpctlContainerDownCommand(cmdString)) {
    // Bases the manifest names explicitly are the repo author's instruction and
    // are always honoured; the implicit repo-name addition only applies to
    // repo-owning addresses — an auxiliary subsystem must not widen its down
    // to the entrypoint's container.
    const bases = [
      ...new Set([
        ...opctlDownBasesFromCommand(cmdString),
        ...(ownsRepoContainers(resolved) ? [resolved.repoName] : []),
      ]),
    ];
    const running = listRunningOpctlContainers()
      .map((c) => c.base)
      .filter((base) => bases.includes(base));
    if (running.length === 0) {
      onLine(
        `nothing to stop (no running opctl containers for ${bases.join(", ")})`,
      );
      unregisterDaemon(resolved.address);
      closeAsync(0);
      return dummy();
    }
    onLine(
      `opctl container down (manifest): ${running.join(", ")} — using docker-resilient path`,
    );
    const { stopped, failed } = forceStopOpctlContainers(running);
    for (const name of stopped) onLine(`docker rm -f ${name}`);
    if (failed.length > 0) {
      onLine(`docker stop failed for: ${failed.join(", ")}`);
      closeAsync(1);
      return dummy();
    }
    unregisterDaemon(resolved.address);
    closeAsync(0);
    return dummy();
  }

  // down/setup always run to completion — never spawn as background daemons.
  // restart detaches unless its command is marked `detachable: false`.
  // All other string commands (typically "up") default to detachable.
  const detachable = shouldDetachServiceCommand(command, cmdDef);
  const interactive = isInteractiveServiceCommand(cmdDef);

  if (interactive) {
    // HITL command — inherit the full TTY; onLine is not called.
    const proc = spawnInteractive(
      cmdString,
      { ...process.env, ...env },
      onClose,
      repoPath,
    );
    return { proc, detachable: false, interactive: true };
  }

  const closeExistingTab = (): void => {
    const existing = lookupTab(resolved.address);
    if (!existing) return;
    try {
      closeTab(existing.tabId, existing.terminalApp);
      forgetTab(resolved.address);
    } catch (error) {
      onLine(`Warning: ${(error as Error).message}`);
    }
  };

  const openCommandInTab = (commandToOpen: string): RunCommandResult => {
    try {
      const terminalApp = resolveTerminalApp(readUserConfig().terminal);
      const tab = openTab({
        cmd: commandToOpen,
        cwd: repoPath,
        label: resolved.address,
        terminalApp,
        env: tabEnv,
      });
      recordTab(resolved.address, {
        ...tab,
        cwd: repoPath,
        command: commandToOpen,
      });
      onLine(
        `-> opened ${tab.terminalApp === "iterm2" ? "iTerm2" : "Terminal"} tab for ${resolved.address}`,
      );
      closeAsync(0);
      return {
        proc: new EventEmitter() as unknown as ChildProcess,
        detachable: false,
        interactive: false,
        tab,
      };
    } catch (error) {
      onLine(`Error: ${(error as Error).message}`);
      closeAsync(1);
      return dummy();
    }
  };

  if (runtime === "tab" && command === "up") {
    return openCommandInTab(cmdString);
  }

  if (runtime === "tab" && command === "restart") {
    closeExistingTab();
    if (requestedCmdDef) return openCommandInTab(cmdString);

    const downDef = svcCommands["down"];
    const upDef = svcCommands["up"];
    if (downDef && upDef) {
      const downCmd = rewriteLegacyOpctlKillCommand(
        "down",
        commandDefToString(downDef),
        resolved,
      );
      const upCmd = commandDefToString(upDef);
      const proc = spawnStreaming(
        downCmd,
        [],
        { ...process.env, ...env },
        onLine,
        (exitCode) => {
          if (exitCode !== 0) {
            onClose(exitCode);
            return;
          }
          const result = openCommandInTab(upCmd);
          void result;
        },
        repoPath,
        false,
      );
      return { proc, detachable: false, interactive: false };
    }
  }

  // Detachable commands (up / restart) run as daemons: output is written to a
  // log file so the service survives den restarts. The returned proc is the
  // `tail` subprocess used for streaming — kill it to stop streaming.
  const logPath = detachable
    ? getServiceLogPath(resolved.repoName, resolved.subsystem)
    : undefined;
  if (detachable && logPath) {
    onLine(`→ log: ${logPath}`);
  }

  // Track long-running services so the shutdown interceptor can offer to stop them.
  // Snapshot running containers first so wrappedOnClose can diff what this run
  // actually spawned and refine the record.
  const preSpawnContainers =
    detachable && logPath && command !== "down" && isOpctlAvailable()
      ? listRunningOpctlContainers()
      : null;
  if (detachable && logPath && command !== "down") {
    registerDaemon({
      address: resolved.address,
      repoName: resolved.repoName,
      subsystem: resolved.subsystem,
      repoPath: resolved.repoPath,
      branch: resolved.branch,
      workspaces: [workspace],
      logPath,
      startedAt: new Date(),
      // Seed with the service's declared opctl container names (affinity-
      // filtered for auxiliary subsystems) so `down` can stop them via
      // `opctl container down` without a declared down command. Refined with
      // the actually-spawned containers when the streaming tail detaches.
      // (Live `opctl container ls` is still the source of truth at down time;
      // this just seeds the candidate set.)
      containers: spawnContainerCandidates(resolved),
    });
  }

  // When a down command completes, remove from the registry. Scripted downs
  // (links-api's down.sh, etc.) can exit 0 while leaving opctl_<repo>_*
  // containers running — sweep those via docker so "✔ down" means stopped.
  const wrappedOnClose = (exitCode: number) => {
    if (command === "down") {
      const remaining = resolveOpctlDownTargets(resolved);
      let sweptClean = false;
      if (remaining.length > 0) {
        onLine(
          `down left running opctl containers — stopping via docker: ${remaining.join(", ")}`,
        );
        const { stopped, failed } = forceStopOpctlContainers(remaining);
        for (const name of stopped) onLine(`docker rm -f ${name}`);
        if (failed.length > 0) {
          onLine(`docker stop failed for: ${failed.join(", ")}`);
          onClose(1);
          return;
        }
        sweptClean = true;
      }
      // A non-zero down that we then verifiably swept clean IS a successful
      // teardown. A non-zero down with nothing to sweep is not: for a service
      // whose containers den can't see (non-opctl, or opctl unavailable),
      // "nothing left to stop" is an absence of evidence, not evidence the
      // teardown worked — reporting ✔ there would hide every real failure.
      const effective = exitCode === 0 || sweptClean ? 0 : exitCode;
      if (effective === 0) {
        unregisterDaemon(resolved.address);
        closeExistingTab();
      }
      onClose(effective);
      return;
    }
    // Ups fire onClose when the streaming tail detaches — by then the run's
    // containers usually exist, so record what actually appeared. Best-effort:
    // slow image builds may not have spawned yet; the declared seed remains.
    if (preSpawnContainers) {
      updateDaemonContainers(
        resolved.address,
        diffSpawnedContainers(preSpawnContainers, listRunningOpctlContainers()),
      );
    }
    onClose(exitCode);
  };

  const proc = spawnStreaming(
    cmdString,
    [],
    { ...process.env, ...env },
    onLine,
    wrappedOnClose,
    repoPath,
    detachable,
    logPath,
    onServiceExit,
  );
  return { proc, detachable, interactive: false, logPath };
}

// ── Health checks ─────────────────────────────────────────────────────────────
// (implementation lives in health.ts — re-exported above)

/**
 * Check health for all services in the active workspace, in parallel.
 * Uses catalog-wide scan so mono-repo subsystems are shown individually.
 */
export async function checkWorkspaceHealth(): Promise<ServiceHealthResult[]> {
  return checkCatalogHealth();
}

// ── Catalog + status listing ──────────────────────────────────────────────────

export interface ServiceListEntry extends ServiceHealthResult {
  commandsAvailable: string[];
}

/**
 * List all services in the active workspace with health and available commands.
 */
export async function listServices(
  workspaceName?: string,
): Promise<ServiceListEntry[]> {
  const ws = workspaceName
    ? getWorkspaceByName(workspaceName)
    : getActiveWorkspace();
  if (!ws) return [];
  const catalog = readCatalog();
  // Modules and libraries have no runtime: no card, no health, no commands.
  const services = listWorkspaceServices(ws.config, catalog, ws.name).filter(
    (s) => hasRuntime(repoKind(s.repoPath)),
  );
  const healthResults = await Promise.all(
    services.map((s) => checkServiceHealth(s)),
  );

  return healthResults.map((h, i) => {
    const resolved = services[i];
    let commandsAvailable: string[] = [];
    try {
      const manifest = readManifest(resolved.repoPath);
      commandsAvailable = manifest
        ? Object.keys(
            effectiveLocalCommands(
              manifest,
              resolved.subsystem,
              resolved.repoName,
              ws.name,
            ),
          )
        : [];
    } catch {
      /* ignore */
    }

    return {
      ...h,
      commandsAvailable,
    };
  });
}
