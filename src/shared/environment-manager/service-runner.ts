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
import { claimHealthyStack } from "../stacks/owners.js";
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
import { getSecretsProvider } from "../secrets/index.js";
import {
  assertSecretEnvSpec,
  resolveSecretEnv,
  secretEnvKeys,
  type SecretEnvSpec,
} from "../secrets/secret-env.js";
import type { SecretsProvider } from "../secrets/types.js";
import { composeCommands } from "../stacks/manifest-commands.js";
import { buildServiceEnv } from "./service-env.js";
import {
  devOpContainerNames,
  diffSpawnedContainers,
  forceStopOpctlContainers,
  inspectOpctlContainer,
  isOpctlAvailable,
  listRunningOpctlContainers,
  listRunningOpctlContainersAsync,
  isOpctlAvailableAsync,
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
import { getDistRoot, getStateDir } from "../paths.js";

import { product } from "../product.js";
import {
  adoptLegacyProcess,
  busyListenerText,
  servicePort,
} from "../process/legacy-adopt.js";
import {
  processGroupStateSync,
  recordProcessGroup,
  stopProcessGroup,
  type RecordedProcessGroup,
} from "../process/process-group.js";
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
  /**
   * The distribution root (realpath) whose server or CLI registered this
   * daemon. Every root of a product shares one daemons file, so startup
   * pruning skips records stamped by another root. Missing on records
   * written before 0.2.7.
   */
  root?: string;
  /**
   * The process group a detached `up` started (its leader's pid), so `down`
   * can stop a service that has no down command and no container
   * (0.3.0-dev.37). Missing on records written before that.
   */
  pgid?: number;
  /**
   * The group leader's start time (`ps -o lstart=`). `down` signals the
   * group only while the process holding `pgid` started at this time, so a
   * reused pid is never signalled.
   */
  pgidStartedAt?: string;
  /**
   * A pid some writers before 0.3.0-dev.37 kept. Only a hint for adopting
   * such a record (legacy-adopt.ts); never signalled on its own.
   */
  pid?: number;
}

/** This process's distribution root, as stamped on its daemon records. */
function daemonRoot(): string | null {
  try {
    return fs.realpathSync(getDistRoot());
  } catch {
    return null;
  }
}

/**
 * Whose a daemon record is: this root's, another root's (all roots of a
 * product share one daemons file), or unstamped (written before 0.2.7).
 */
export function daemonRootOf(
  d: Pick<DaemonRecord, "root">,
): "here" | "other" | "unstamped" {
  if (!d.root) return "unstamped";
  return d.root === daemonRoot() ? "here" : "other";
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
        : `Service "${opts.address}" is already running for project(s) [${opts.owners.join(", ")}] at ${opts.running.repoPath}` +
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
  const root = daemonRoot() ?? record.root;
  _daemonRegistry.set(record.address, {
    ...record,
    ...(root ? { root } : {}),
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

/** Record the process group a detached `up` just spawned. */
export function updateDaemonProcessGroup(
  address: string,
  group: RecordedProcessGroup,
): void {
  loadDaemonsFromFile();
  const existing = _daemonRegistry.get(address);
  if (!existing) return;
  _daemonRegistry.set(address, {
    ...existing,
    pgid: group.pgid,
    pgidStartedAt: group.startedAt,
  });
  saveDaemonsFile(getDaemonsFile());
}

/** Forget a record's process group (it is gone; nothing of it to stop). */
function clearDaemonProcessGroup(address: string): void {
  loadDaemonsFromFile();
  const existing = _daemonRegistry.get(address);
  if (!existing) return;
  const rest = { ...existing };
  delete rest.pgid;
  delete rest.pgidStartedAt;
  _daemonRegistry.set(address, rest);
  saveDaemonsFile(getDaemonsFile());
}

/**
 * This root's daemons (and unstamped legacy ones). Every root of a product
 * shares one daemons file; another root's records stay in it untouched but
 * are not listed, so this server never shows, stops, releases or sweeps
 * them. Lookups by address (findDaemonByAddress) still see every record.
 */
export function listDaemons(): DaemonRecord[] {
  loadDaemonsFromFile();
  return Array.from(_daemonRegistry.values()).filter(
    (d) => daemonRootOf(d) !== "other",
  );
}

export function findDaemonByAddress(address: string): DaemonRecord | undefined {
  loadDaemonsFromFile();
  return _daemonRegistry.get(address);
}

/**
 * The other spelling of a single-service repo's daemon: "<repo>" and
 * "<repo>/<svc>" name the same process (0.4.1-dev.5, a consumer's dev.4
 * finding: `up <repo>` recorded "<repo>", `restart <repo>/<svc>` found no
 * record, adopted the running process instead of restarting it, and left
 * two records on one process group). Null for a repo with several
 * services: each of its services is its own daemon.
 */
function singleServiceAlias(
  resolved: Pick<ResolvedService, "address" | "repoName" | "subsystem"> & {
    repoPath: string;
  },
): string | null {
  const keys = Object.keys(readManifest(resolved.repoPath)?.services ?? {});
  if (keys.length !== 1 || keys[0] !== resolved.subsystem) return null;
  const full = `${resolved.repoName}/${resolved.subsystem}`;
  if (resolved.address === resolved.repoName) return full;
  if (resolved.address === full) return resolved.repoName;
  return null;
}

/**
 * Bring a single-service repo's record to the address this command uses,
 * so every lookup by `resolved.address` finds it whichever spelling wrote
 * it. A record only under the other spelling moves; a duplicate (two
 * records on one process group, the dev.4 bug's leftover, or one of them
 * dead or without a group) is merged into one, owners and containers
 * unioned. Two records on two different live groups are left alone.
 */
export function reconcileDaemonAddress(resolved: ResolvedService): void {
  const alias = singleServiceAlias(resolved);
  if (!alias) return;
  loadDaemonsFromFile();
  const other = _daemonRegistry.get(alias);
  if (!other || other.repoPath !== resolved.repoPath) return;
  const own = _daemonRegistry.get(resolved.address);
  if (own) {
    const sameGroup =
      own.pgid === undefined ||
      other.pgid === undefined ||
      own.pgid === other.pgid ||
      isDaemonVerifiablyDead(other);
    if (!sameGroup) return;
  }
  // The record carrying a process group is the one `down` can stop.
  const keep =
    own && (own.pgid !== undefined || other.pgid === undefined) ? own : other;
  const drop = keep === own ? other : own;
  const merged: DaemonRecord = {
    ...keep,
    address: resolved.address,
    workspaces: [
      ...new Set([...(keep.workspaces ?? []), ...(drop?.workspaces ?? [])]),
    ],
  };
  const containers = [
    ...new Set([...(keep.containers ?? []), ...(drop?.containers ?? [])]),
  ];
  if (containers.length > 0) merged.containers = containers;
  _daemonRegistry.delete(alias);
  _daemonRegistry.set(resolved.address, merged);
  saveDaemonsFile(getDaemonsFile());
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

/** Whether workspace `name`'s current config lists `daemon`'s service. */
function workspaceContainsDaemon(
  name: string,
  daemon: Pick<DaemonRecord, "address" | "repoName">,
): boolean {
  const services = getWorkspaceByName(name)?.config.services ?? {};
  return daemon.address in services || daemon.repoName in services;
}

/** Replace a running daemon's owners (re-derived from membership). */
function setDaemonOwners(address: string, workspaces: string[]): void {
  loadDaemonsFromFile();
  const existing = _daemonRegistry.get(address);
  if (!existing) return;
  _daemonRegistry.set(address, { ...existing, workspaces });
  saveDaemonsFile(getDaemonsFile());
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
  const active = getActiveWorkspaces();
  const releases: DaemonRelease[] = [];

  for (const daemon of owned) {
    // Owners re-derived from the CURRENT membership, not the ones recorded at
    // start: a repo moved into another workspace while its daemon ran belongs
    // to that workspace now, and one moved out no longer belongs to this one.
    // Stopped only when no active workspace still contains it.
    const remaining = active.filter(
      (w) => w !== workspace && workspaceContainsDaemon(w, daemon),
    );
    if (remaining.length > 0) {
      setDaemonOwners(daemon.address, remaining);
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
  onLine: (line: string) => void = () => {},
): "attached" | "adopted" | "untracked" | "conflict" | "busy" {
  // A compose stack's primary service: its owner is recorded with the
  // stack's project (a shared stack namespace's refcount, stacks/owners.ts).
  // `conflict`: the running project is another checkout's; the caller runs
  // the real up, which refuses it.
  const stack = claimHealthyStack(resolved, workspace);
  if (stack) return stack;
  // A record from before 0.3.0-dev.37 is settled (adopted or dropped)
  // before anything is decided on it (0.3.0-dev.39, a consumer's dev.38
  // finding: the healthy-skip attached to it and it never gained a group).
  const settled = settleDaemonRecord(resolved, workspace, onLine);
  // Dropped with its port held from outside the repo: said by the settle.
  if (settled.outcome === "busy") return "busy";
  const existing = settled.record;
  if (existing) {
    if (!sameDaemonIdentity(existing, resolved.repoPath, resolved.branch)) {
      // Healthy, but the record describes a different checkout — leave the
      // registry alone rather than claim something we can't vouch for.
      return "untracked";
    }
    attachDaemonOwner(resolved.address, workspace);
    return "attached";
  }
  if (adoptRunningContainers(resolved, workspace).length > 0) return "adopted";
  // Healthy with no record: whose process answers on the service's port?
  // One in the repo is the service (adopted, so `down` can stop it); one
  // from elsewhere is not, and is said, never claimed or touched.
  const holder = settleUntrackedListener(
    resolved,
    workspace,
    onLine,
    `${resolved.address} not started`,
  );
  return holder ?? "untracked";
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
  return resolvedRepoPathsOf(d).length > 0;
}

/**
 * This root's records whose address resolves in no active workspace: what
 * `down -a` (every workspace) cannot reach, and so warns about and leaves
 * alone (0.3.0-dev.39).
 */
export function daemonsOutsideWorkspaces(): DaemonRecord[] {
  return listDaemons().filter((d) => !canResolveDaemonAddress(d));
}

/**
 * Every checkout a daemon's address resolves to now: through the focus,
 * each workspace that owns it, then every other active workspace (the
 * same order canResolveDaemonAddress and the reaper use). Empty when the
 * address no longer resolves anywhere.
 */
function resolvedRepoPathsOf(d: DaemonRecord): string[] {
  const paths = new Set<string>();
  const add = (r: ResolvedService | null) => {
    if (r) paths.add(r.repoPath);
  };
  add(resolveService(d.address));
  for (const w of new Set([...(d.workspaces ?? []), ...getActiveWorkspaces()]))
    add(resolveService(d.address, w));
  return [...paths];
}

/** Why a daemon record is stale whatever its address resolves to, or null. */
export type DaemonStaleReason = "repo-path-missing" | "relocated";

/**
 * A record that describes nothing that can be running (0.3.0-dev.33, a
 * consumer's dogfood finding): a record whose repo was relocated kept its
 * Runs tab forever, because its address still resolved and, with no
 * containers captured, nothing could prove it dead.
 *
 *  - "repo-path-missing": its repoPath is not on disk. Nothing of it can
 *    run from a checkout that does not exist, whichever root wrote it.
 *  - "relocated": the address resolves now, but never to its repoPath, and
 *    nothing of it is live: none of its candidate containers (captured, or
 *    the dev-op's at its old path) is running. The repo name is not a
 *    candidate here: the relocated checkout's own container carries it.
 *    Records carry no pid, so there is no process to check. Needs the
 *    container listing when it has candidates (null: unverifiable, kept).
 *
 * Another root's record is never this root's call (null). A record that
 * resolves to its own repoPath is never stale here: it may be a live
 * non-opctl process, and isDaemonVerifiablyDead keeps that rule.
 */
export function daemonStaleReason(
  d: DaemonRecord,
  running: Set<string> | null,
  deps: {
    exists?: (p: string) => boolean;
    resolvedPaths?: (d: DaemonRecord) => string[];
    devOpNames?: (repoPath: string) => string[];
  } = {},
): DaemonStaleReason | null {
  if (daemonRootOf(d) === "other") return null;
  const exists = deps.exists ?? fs.existsSync;
  if (!d.repoPath || !exists(d.repoPath)) return "repo-path-missing";
  const now = (deps.resolvedPaths ?? resolvedRepoPathsOf)(d);
  if (now.length === 0 || now.includes(d.repoPath)) return null;
  const candidates = [
    ...(d.containers ?? []),
    ...(deps.devOpNames ?? devOpContainerNames)(d.repoPath),
  ].filter(Boolean);
  if (candidates.length === 0) return "relocated";
  if (!running) return null;
  return candidates.some((c) => running.has(c)) ? null : "relocated";
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
 * A daemon stamped by another root (all roots of a product share the file)
 * is never touched. Otherwise it is dropped when:
 *  - it was stamped by this root and its address no longer resolves to a
 *    workspace/catalog service (an unstamped legacy record might belong to
 *    another root, so this alone never drops one), OR
 *  - it is opctl-based (has captured containers or a discoverable dev-op) and
 *    NONE of its candidate containers are currently running.
 *
 *  - its checkout is gone, or the service now resolves to another checkout
 *    and nothing of the record's is running (daemonStaleReason).
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
  return pruneAgainst(daemons, running);
}

/**
 * pruneDeadDaemons without blocking: the container listing runs as async
 * child processes (the web server's startup, which used to hold the event
 * loop for the `docker ps`).
 */
export async function pruneDeadDaemonsAsync(): Promise<string[]> {
  const daemons = listDaemons();
  if (daemons.length === 0) return [];
  return pruneAgainst(daemons, await runningContainerBasesAsync());
}

/** The running opctl containers' base names, or null without opctl. */
export async function runningContainerBasesAsync(): Promise<Set<string> | null> {
  return (await isOpctlAvailableAsync())
    ? new Set((await listRunningOpctlContainersAsync()).map((c) => c.base))
    : null;
}

function pruneAgainst(
  daemons: DaemonRecord[],
  running: Set<string> | null,
): string[] {
  const pruned: string[] = [];
  for (const d of daemons) {
    try {
      const root = daemonRootOf(d);
      // Another root's daemon: its services resolve in its workspaces, not
      // ours, and its liveness is its own server's call.
      if (root === "other") continue;
      // An unresolvable address is only proof of staleness for a record
      // this root wrote; an unstamped one may belong to another root.
      if (root === "here" && !canResolveDaemonAddress(d)) {
        unregisterDaemon(d.address);
        pruned.push(d.address);
        continue;
      }
      // A checkout that is gone, or one the service has moved away from
      // with nothing of it still running (here or unstamped).
      if (daemonStaleReason(d, running)) {
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
      `"${address}" is ambiguous in project "${ws}": ${candidates.join(", ")}; name one of them`,
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

/**
 * Whether a service command runs detached (a daemon whose log is tailed)
 * or to completion. Only the commands that start a service, up and restart
 * (which ends with a long-running up), detach by default; a restart that
 * finishes on its own says `detachable: false`. Every other command is
 * one-shot unless it says `detachable: true` (0.3.0-dev.40, DOC-1: every
 * string command but down and setup detached, so a preflight run from the
 * Services page never finished). down and setup never detach.
 */
export function shouldDetachServiceCommand(
  command: string,
  cmdDef: CommandDef,
): boolean {
  if (command === "down" || command === "setup") return false;
  const starts = command === "up" || command === "restart";
  return typeof cmdDef === "string" ? starts : (cmdDef.detachable ?? starts);
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
  /**
   * R16: the service's resolved `secret_env` (see prepareServiceSecretEnv),
   * set only in the spawned process's env. An up/restart of a service that
   * declares secret_env is refused unless every key is here.
   */
  secretEnv?: Record<string, string>;
  /**
   * For `down`: whether the caller named this service (default true). When
   * down cannot stop a service it knows is running it warns; an explicit
   * down then exits non-zero, a workspace-wide one does not.
   */
  explicit?: boolean;
  /** For `down`: what it found to stop (see DownOutcome). */
  onDownOutcome?: (outcome: DownOutcome) => void;
  /**
   * Internal: this `up` is a restart's up step ("up"), or the up step of
   * the restart a restart ran after adopting a process ("after-adopt").
   * A restart never ends on an adoption: what it adopts it restarts.
   */
  restartStep?: "up" | "after-adopt";
}

/**
 * What a `down` of a service with no down command and no container did, for
 * callers that report it: it "stopped" the process group `up` recorded,
 * found it "already-exited", had "nothing-recorded" to stop, or could not
 * stop what it knows is running ("unstoppable").
 */
export type DownOutcome =
  | "stopped"
  | "already-exited"
  | "nothing-recorded"
  | "unstoppable";

/** SIGTERM-to-SIGKILL grace for a recorded process group. */
function downGraceMs(): number {
  const raw = process.env.DEN_DOWN_GRACE_MS;
  const ms = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : 3000;
}

type GroupRecord = DaemonRecord & { pgid: number; pgidStartedAt: string };

/** Whether a record carries a process group `down` can verify and signal. */
function hasProcessGroup(d: DaemonRecord | undefined): d is GroupRecord {
  return !!d && typeof d.pgid === "number" && !!d.pgidStartedAt;
}

/**
 * Stop the process group a detached `up` recorded for this daemon (SIGTERM,
 * grace, SIGKILL; see process-group.ts), say what happened on `onLine`, and
 * unregister the record once nothing of it runs.
 */
async function stopDaemonProcessGroup(
  record: GroupRecord,
  onLine: (line: string) => void,
): Promise<DownOutcome> {
  const result = await stopProcessGroup(
    { pgid: record.pgid, startedAt: record.pgidStartedAt },
    downGraceMs(),
  );
  switch (result.outcome) {
    case "stopped":
      onLine(
        `stopped ${record.address}: process group ${record.pgid} (${result.signal})`,
      );
      unregisterDaemon(record.address);
      return "stopped";
    case "gone":
      onLine(
        `${record.address} had already exited (process group ${record.pgid})`,
      );
      unregisterDaemon(record.address);
      return "already-exited";
    case "reused":
      // The recorded process exited; whatever holds its pid now is not ours.
      onLine(
        `${record.address} had already exited: ${result.detail}; left it alone`,
      );
      unregisterDaemon(record.address);
      return "already-exited";
    case "survived":
      onLine(
        `Warning: could not stop ${record.address}: process group ${record.pgid} survived SIGKILL (pids ${result.members.join(", ")})`,
      );
      return "unstoppable";
    case "error":
      onLine(`Warning: could not stop ${record.address}: ${result.detail}`);
      return "unstoppable";
  }
}

/**
 * The daemon records of `repo`'s own services (`<repo>/<svc>`), this root's
 * or unstamped, other than `except`: what a repo-level down stops.
 */
function repoServiceRecords(repo: string, except: string): DaemonRecord[] {
  return listDaemons().filter(
    (d) =>
      d.address !== except &&
      d.address.startsWith(`${repo}/`) &&
      daemonRootOf(d) !== "other",
  );
}

/** Which of two down outcomes says more: what a fanned-out down reports. */
const DOWN_RANK: Record<DownOutcome, number> = {
  "nothing-recorded": 0,
  "already-exited": 1,
  stopped: 2,
  unstoppable: 3,
};

/**
 * Down each address in turn (each through runServiceCommand's own path:
 * its refcount, its down command or its recorded process group), lines to
 * the caller's onLine. Resolves the outcome that says most and the worst
 * exit code.
 */
async function downEach(
  addresses: string[],
  options: RunCommandOptions,
): Promise<{ outcome: DownOutcome; exitCode: number }> {
  let outcome: DownOutcome = "nothing-recorded";
  let exitCode = 0;
  for (const address of addresses) {
    let own: DownOutcome | null = null;
    const code = await new Promise<number>((resolve) => {
      runServiceCommand({
        ...options,
        address,
        command: "down",
        onDownOutcome: (o) => {
          own = o;
        },
        onClose: resolve,
      });
    });
    // A service with a down command of its own reports no outcome: a
    // success is a stop.
    const o: DownOutcome = own ?? (code === 0 ? "stopped" : "unstoppable");
    if (DOWN_RANK[o] > DOWN_RANK[outcome]) outcome = o;
    exitCode = Math.max(exitCode, code);
  }
  return { outcome, exitCode };
}

/**
 * A record `up` and `down` can't verify by its process group: none was
 * recorded (before 0.3.0-dev.37) and it names no container of its own.
 */
function isLegacyRecord(d: DaemonRecord): boolean {
  return (
    !hasProcessGroup(d) &&
    !(d.containers?.length ?? 0) &&
    devOpContainerNames(d.repoPath).length === 0
  );
}

/**
 * The daemon record for `resolved`, settled: a record from before
 * 0.3.0-dev.37 (no process group, nothing of its own to verify) is adopted
 * or dropped here, before any caller decides on it (0.3.0-dev.39). Every
 * up, restart, down and healthy-skip reads its record through this.
 */
export function settledDaemonRecord(
  resolved: ResolvedService,
  workspace: string,
  onLine: (line: string) => void,
): DaemonRecord | undefined {
  return settleDaemonRecord(resolved, workspace, onLine).record;
}

/** settledDaemonRecord, with what the settle did (null: nothing to settle). */
function settleDaemonRecord(
  resolved: ResolvedService,
  workspace: string,
  onLine: (line: string) => void,
): {
  record: DaemonRecord | undefined;
  outcome: "adopted" | "dropped" | "busy" | null;
} {
  reconcileDaemonAddress(resolved);
  const record = findDaemonByAddress(resolved.address);
  if (!record || !isLegacyRecord(record)) return { record, outcome: null };
  const outcome = settleLegacyRecord(record, resolved, workspace, onLine);
  return { record: findDaemonByAddress(resolved.address), outcome };
}

/** The service's known port and configured up command (legacy-adopt.ts). */
function serviceProcessFacts(
  resolved: ResolvedService,
  workspace: string,
): { port: number | null; upCommand: string | null; plain: boolean } {
  const manifest = readManifest(resolved.repoPath);
  const svc = manifest?.services?.[resolved.subsystem] as
    | { port?: unknown; health?: { local?: { url?: string } } }
    | undefined;
  const upDef = manifest
    ? effectiveLocalCommands(
        manifest,
        resolved.subsystem,
        resolved.repoName,
        workspace,
      )["up"]
    : undefined;
  const upCommand = upDef ? commandDefToString(upDef) : null;
  const port = servicePort({
    port: svc?.port,
    healthUrl: svc?.health?.local?.url ?? null,
    upCommand,
  });
  // A plain process: an up of its own, no compose stack and no dev op. A
  // container's port is held by the container runtime, never by the repo.
  const plain =
    !!upCommand &&
    !manifest?.compose &&
    devOpContainerNames(resolved.repoPath).length === 0;
  return { port, upCommand, plain };
}

/**
 * A service with no record whose port is already taken (a plain process
 * service only): a listener whose cwd is in the repo is the service,
 * adopted with its process group ("adopted"); one from elsewhere is
 * reported and left alone ("busy"). Null when the port is free or unknown.
 */
function settleUntrackedListener(
  resolved: ResolvedService,
  workspace: string,
  onLine: (line: string) => void,
  /** What the caller does about a busy port, said after the warning. */
  then: string,
): "adopted" | "busy" | null {
  const facts = serviceProcessFacts(resolved, workspace);
  if (!facts.plain || !facts.port) return null;
  const verdict = adoptLegacyProcess({
    repoPath: resolved.repoPath,
    port: facts.port,
    upCommand: null,
  });
  if (verdict.kind === "adopted") {
    registerDaemon({
      address: resolved.address,
      repoName: resolved.repoName,
      subsystem: resolved.subsystem,
      repoPath: resolved.repoPath,
      branch: resolved.branch,
      workspaces: [workspace],
      logPath: getServiceLogPath(resolved.repoName, resolved.subsystem),
      startedAt: new Date(),
      containers: [],
    });
    updateDaemonProcessGroup(resolved.address, verdict.group);
    onLine(
      `adopted the running process (pid ${verdict.pid}, port ${facts.port}) for ${resolved.address}: it runs in ${resolved.repoPath}`,
    );
    return "adopted";
  }
  if (!verdict.busy) return null;
  onLine(
    `Warning: ${busyListenerText(verdict.busy, resolved.repoPath, resolved.address)}; ${then}`,
  );
  return "busy";
}

/**
 * What a record from before 0.3.0-dev.37 means now (legacy-adopt.ts), for
 * `up` and `down` alike: "adopted" (the running process is the service; its
 * group is written into the record, so it is `down`'s to stop) or "dropped"
 * (stale: warned, the record removed, nothing signalled). The port is the
 * service's known one (servicePort: `port`, its health URL, `--port` in its
 * up command); the token match uses its configured up command.
 */
function settleLegacyRecord(
  record: DaemonRecord,
  resolved: ResolvedService,
  workspace: string,
  onLine: (line: string) => void,
): "adopted" | "dropped" | "busy" {
  const { port, upCommand } = serviceProcessFacts(resolved, workspace);
  const verdict = adoptLegacyProcess({
    repoPath: record.repoPath,
    pid: typeof record.pid === "number" ? record.pid : undefined,
    port,
    upCommand,
  });
  if (verdict.kind === "adopted") {
    updateDaemonProcessGroup(record.address, verdict.group);
    onLine(
      `adopted pre-dev.37 process (pid ${verdict.pid}` +
        (verdict.port ? `, port ${verdict.port}` : "") +
        `) for ${record.address}`,
    );
    return "adopted";
  }
  onLine(
    `Warning: ${record.address} was recorded before 0.3.0-dev.37 and ` +
      (verdict.busy
        ? "its port is held by a process that is not its up"
        : `nothing running is it (no process on its port in ${record.repoPath}` +
          (typeof record.pid === "number"
            ? `, pid ${record.pid} not its up`
            : "") +
          ")") +
      "; dropped the record, nothing was signalled",
  );
  if (verdict.busy)
    onLine(
      `Warning: ${busyListenerText(verdict.busy, record.repoPath, record.address)}`,
    );
  unregisterDaemon(record.address);
  return verdict.busy ? "busy" : "dropped";
}

/**
 * A restart with no `restart` of its own: the service's down (its declared
 * down, then the recorded group, as `down` does; forced, since a restart
 * brings it back for every owner), then its up, detached, as `up` does. The
 * returned proc stands for the up's streaming tail: killing it stops the
 * tail (now, or as soon as the up starts), never the service.
 */
function restartAsDownThenUp(
  options: RunCommandOptions,
  logPath: string | undefined,
): RunCommandResult {
  let tail: ChildProcess | null = null;
  let stopTail = false;
  const proxy = new EventEmitter() as unknown as ChildProcess;
  (proxy as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill = (
    signal,
  ) => {
    stopTail = true;
    try {
      tail?.kill?.(signal);
    } catch {
      /* already gone */
    }
    return true;
  };
  runServiceCommand({
    ...options,
    command: "down",
    force: true,
    onDownOutcome: undefined,
    onServiceExit: undefined,
    onClose: (code) => {
      if (code !== 0) {
        options.onClose(code);
        return;
      }
      const up = runServiceCommand({
        ...options,
        command: "up",
        restartStep:
          options.restartStep === "after-adopt" ? "after-adopt" : "up",
      });
      tail = up.proc;
      if (stopTail) {
        try {
          tail?.kill?.("SIGTERM");
        } catch {
          /* already gone */
        }
      }
    },
  });
  return { proc: proxy, detachable: true, interactive: false, logPath };
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
 * A service with no commands of its own is started by its repo's up
 * (placement's repo-level rule). For `up` that is the repo's up (`address`
 * set); any other command would reach the repo's other services too, so it
 * points at the repo instead: a refusal, except that down succeeds (nothing
 * of the service's own runs, and a workspace Down sends every service).
 * Null when the rule does not apply.
 */
function repoStartedFallback(
  resolved: ResolvedService,
  command: string,
  workspace: string | undefined,
): { address?: string; note: string } | null {
  const repoEntry = resolveService(resolved.repoName, workspace);
  if (!repoEntry || repoEntry.subsystem === resolved.subsystem) return null;
  const manifest = readManifest(resolved.repoPath);
  if (!manifest) return null;
  // A service with an up of its own starts itself, so its down is its own
  // too: the process group that up recorded (0.3.0-dev.39, a consumer's
  // dev.38 finding: `down repo/api` pointed at the repo's down instead).
  if (
    effectiveLocalCommands(
      manifest,
      resolved.subsystem,
      resolved.repoName,
      workspace ?? "default",
    )["up"]
  )
    return null;
  const repoCommands = effectiveLocalCommands(
    manifest,
    repoEntry.subsystem,
    resolved.repoName,
    workspace ?? "default",
  );
  if (!repoCommands["up"]) return null;
  if (command === "up")
    return {
      address: resolved.repoName,
      note: `${resolved.address} has no up of its own; running ${resolved.repoName}'s up, which starts it`,
    };
  return command === "down"
    ? {
        note:
          `${resolved.address} has no down of its own; it is stopped by ${resolved.repoName}'s down. ` +
          `Run \`${product().cli} down ${resolved.repoName}\` (that stops every service it starts).`,
      }
    : {
        note:
          `${resolved.address} has no ${command} of its own; it is started by ${resolved.repoName}'s up. ` +
          `Run \`${product().cli} ${command} ${resolved.repoName}\` (that reaches every service it starts).`,
      };
}

// ── secret_env (R16) ─────────────────────────────────────────────────────────

/** Commands that start a service process, and so get its secret_env. */
function startsService(command: string): boolean {
  return command === "up" || command === "restart";
}

/** A service's declared `services.<svc>.secret_env` (validated), or undefined. */
function serviceSecretEnvSpec(
  resolved: ResolvedService,
): SecretEnvSpec | undefined {
  const raw = readManifest(resolved.repoPath)?.services?.[resolved.subsystem]
    ?.secret_env;
  return assertSecretEnvSpec(
    raw,
    `${resolved.address}: services.${resolved.subsystem}.secret_env`,
  );
}

/**
 * The address whose command a run of `command` on `address` actually spawns
 * (a service with no up of its own runs its repo's up), or null when none.
 */
function spawningAddress(
  address: string,
  command: string,
  workspace?: string,
): string | null {
  const p = previewServiceCommand(address, command, workspace);
  return p.kind === "run" || p.kind === "via-repo" ? p.address : null;
}

/**
 * The secret_env key NAMES a run of `command` on `address` would inject,
 * for a dry run or status: never a value, and the provider is never asked.
 * `service` is the service's own secret_env (set in its command's env);
 * `compose` is the repo's compose.secret_env, which Den's synthesized stack
 * command resolves for the docker compose process.
 */
export function previewServiceSecretEnv(
  address: string,
  command: string,
  workspace?: string,
): { address: string; service: string[]; compose: string[] } | null {
  if (!startsService(command)) return null;
  const target = spawningAddress(address, command, workspace);
  const resolved = target ? resolveService(target, workspace) : null;
  if (!resolved) return null;
  const manifest = readManifest(resolved.repoPath);
  const service = Object.keys(
    manifest?.services?.[resolved.subsystem]?.secret_env ?? {},
  ).sort();
  const declared = manifest?.services?.[resolved.subsystem]?.commands?.local;
  const synthesized =
    manifest?.compose && !declared?.[command]
      ? composeCommands(
          manifest,
          resolved.subsystem,
          resolved.repoName,
          workspace ?? "default",
        )[command]
      : undefined;
  const compose = synthesized
    ? Object.keys(manifest?.compose?.secret_env ?? {}).sort()
    : [];
  if (!service.length && !compose.length) return null;
  return { address: resolved.address, service, compose };
}

export type ServiceSecretEnvResult =
  | { ok: true; secretEnv: Record<string, string> }
  | { ok: false; message: string };

/**
 * Resolve the `secret_env` of the service a run of `command` on `address`
 * spawns, for runServiceCommand's `secretEnv`. All or nothing; the provider
 * is only asked when the service declares secret_env, and only for up and
 * restart. Messages name keys, refs and the provider, never values.
 */
export async function prepareServiceSecretEnv(
  address: string,
  command: string,
  workspace?: string,
  provider: () => SecretsProvider = getSecretsProvider,
): Promise<ServiceSecretEnvResult> {
  if (!startsService(command)) return { ok: true, secretEnv: {} };
  const target = spawningAddress(address, command, workspace);
  const resolved = target ? resolveService(target, workspace) : null;
  if (!resolved) return { ok: true, secretEnv: {} };
  let spec: SecretEnvSpec | undefined;
  try {
    spec = serviceSecretEnvSpec(resolved);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!secretEnvKeys(spec).length) return { ok: true, secretEnv: {} };
  const r = await resolveSecretEnv(spec, provider(), resolved.address);
  return r.ok
    ? { ok: true, secretEnv: r.env }
    : { ok: false, message: r.message };
}

/** What a run of `command` on `address` would do, without running it. */
export type ServiceCommandPreview =
  | { kind: "run"; address: string; note?: string }
  | { kind: "via-repo"; address: string; note: string }
  | { kind: "nothing"; address: string; note: string }
  | { kind: "error"; address: string; note: string };

/**
 * What a real `up` of a service with an up of its own does first about its
 * record and port (settleDaemonRecord, settleUntrackedListener), said for a
 * dry run (0.3.0-dev.40, a consumer's dev.39 nit: it said only "Would up").
 * It only looks: nothing is signalled and the record is not written. Null
 * when there is nothing to settle (the up just runs). Only for a dry run's
 * words: up-targets reads previewServiceCommand, which this leaves alone.
 */
export function previewUpSettle(
  address: string,
  workspace?: string,
): ServiceCommandPreview | null {
  const resolved = resolveService(address, workspace);
  if (!resolved) return null;
  const record = findDaemonByAddress(resolved.address);
  const legacy = !!record && isLegacyRecord(record);
  if (record && !legacy) return null;
  const facts = serviceProcessFacts(resolved, workspace ?? "default");
  if (!facts.upCommand) return null;
  if (!legacy && (!facts.plain || !facts.port)) return null;
  const verdict = adoptLegacyProcess({
    repoPath: resolved.repoPath,
    pid: legacy && typeof record.pid === "number" ? record.pid : undefined,
    port: facts.port,
    upCommand: legacy ? facts.upCommand : null,
  });
  const what = legacy ? "a pre-dev.37 record" : "no record";
  if (verdict.kind === "adopted")
    return {
      kind: "nothing",
      address,
      note:
        `${resolved.address} (${what}): would adopt pid ${verdict.pid}` +
        (verdict.port ? ` (port ${verdict.port})` : "") +
        ", nothing started",
    };
  if (verdict.busy)
    return {
      kind: "error",
      address,
      note:
        verdict.busy.reason === "outside"
          ? `${resolved.address} (${what}): port ${verdict.busy.port} held outside the repo: would not start`
          : `${resolved.address} (${what}): port ${verdict.busy.port} held by pid ${verdict.busy.pid} in Den's own process group: would not start`,
    };
  if (!legacy) return null;
  return {
    kind: "run",
    address,
    note: `${resolved.address} (${what}): would drop the record (nothing running), then start it`,
  };
}

/**
 * The dry-run twin of runServiceCommand's command lookup: the same
 * resolution, own-command, restart-synthesis and repo-started rules, so a
 * dry run says what a real run does.
 */
export function previewServiceCommand(
  address: string,
  command: string,
  workspace?: string,
): ServiceCommandPreview {
  const resolved = resolveService(address, workspace);
  if (!resolved) {
    const candidates = serviceAliasCandidates(address, workspace);
    return {
      kind: "error",
      address,
      note:
        `service "${address}" not found in project "${workspace ?? "default"}"` +
        (candidates.length > 1
          ? `; it is ambiguous: ${candidates.join(", ")}`
          : ""),
    };
  }
  const manifest = readManifest(resolved.repoPath);
  const own = manifest
    ? effectiveLocalCommands(
        manifest,
        resolved.subsystem,
        resolved.repoName,
        workspace ?? "default",
      )
    : {};
  if (own[command] || (command === "restart" && own["up"]))
    return { kind: "run", address };
  const viaRepo = repoStartedFallback(resolved, command, workspace);
  if (viaRepo?.address)
    return { kind: "via-repo", address: viaRepo.address, note: viaRepo.note };
  if (viaRepo)
    return command === "down"
      ? { kind: "nothing", address, note: viaRepo.note }
      : { kind: "error", address, note: viaRepo.note };
  if (command === "down") {
    // The real down stops the process group a detached up recorded.
    const record = findDaemonByAddress(resolved.address);
    if (hasProcessGroup(record)) return { kind: "run", address };
    // A repo-level down stops its services' records.
    if (
      !address.includes("/") &&
      repoServiceRecords(resolved.repoName, resolved.address).length > 0
    )
      return { kind: "run", address };
    return {
      kind: "nothing",
      address,
      note: "no down command: nothing to stop",
    };
  }
  return {
    kind: "error",
    address,
    note: `command "${command}" not found for service "${address}"`,
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
      `Error: service "${address}" not found in catalog or project "${workspace}"` +
        (candidates.length > 1
          ? `; it is ambiguous: ${candidates.join(", ")}`
          : ""),
    );
    closeAsync(1);
    return dummy();
  }

  const { repoPath, subsystem } = resolved;
  // A single-service repo's record answers to "<repo>" and "<repo>/<svc>":
  // every decision below reads it under this command's spelling.
  reconcileDaemonAddress(resolved);

  const explicit = options.explicit ?? true;
  const reportDown = (outcome: DownOutcome): void =>
    options.onDownOutcome?.(outcome);
  // A down that could not stop what it knows is running: always a warning,
  // and a failure when the caller named this service.
  const unstoppableExit = (): number => (explicit ? 1 : 0);

  /**
   * Down with no down command and no container to stop (0.3.0-dev.37): stop
   * the process group a detached `up` recorded. With no record there is
   * nothing to stop. A record without a group (written before dev.37, or by
   * an adoption) is running as far as Den knows, and Den cannot stop it:
   * that is said and fails an explicit down instead of reporting a success.
   * Such a record is dropped, since Den can neither stop nor verify it.
   */
  const downWithoutCommand = (why: string): RunCommandResult => {
    // A repo-level down (`down <repo>`, and `down -a`, which downs each
    // repo) with no down of its own stops every service record of the repo
    // through the same per-record path (0.3.0-dev.38): the mirror of `up`
    // starting a repo's services (resolveUpTargets).
    const serviceRecords = address.includes("/")
      ? []
      : repoServiceRecords(resolved.repoName, resolved.address);
    if (serviceRecords.length > 0) {
      void downEach(
        serviceRecords.map((d) => d.address),
        options,
      ).then(({ outcome, exitCode }) => {
        const own = findDaemonByAddress(resolved.address);
        if (own) unregisterDaemon(own.address);
        reportDown(outcome);
        onClose(exitCode);
      });
      return dummy();
    }
    // A record from before 0.3.0-dev.37: adopt what runs, or drop it.
    const record = settledDaemonRecord(resolved, workspace, onLine);
    if (hasProcessGroup(record)) {
      void stopDaemonProcessGroup(record, onLine).then((outcome) => {
        reportDown(outcome);
        onClose(outcome === "unstoppable" ? unstoppableExit() : 0);
      });
      return dummy();
    }
    if (record && !isDaemonVerifiablyDead(record)) {
      onLine(
        `Warning: ${record.address} is recorded as running, but ${product().cli} kept no process for it ` +
          `(started before 0.3.0-dev.37) and it has no down command; ` +
          `stop it yourself (${product().cli} has dropped its record)`,
      );
      unregisterDaemon(record.address);
      reportDown("unstoppable");
      closeAsync(unstoppableExit());
      return dummy();
    }
    if (record) unregisterDaemon(record.address);
    onLine(`nothing to stop (${why})`);
    reportDown("nothing-recorded");
    closeAsync(0);
    return dummy();
  };

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

  // Every up decision below reads the service's record: one from before
  // 0.3.0-dev.37 is settled (adopted or dropped, and said) first
  // (0.3.0-dev.39, a consumer's dev.38 finding). A restart settles in its
  // down step; a down after its ownership gate, which signals nothing.
  const upSettle =
    command === "up" ? settleDaemonRecord(resolved, workspace, onLine) : null;
  // Dropped with its port held by a process Den won't adopt (said by the
  // settle): refused before anything is spawned, as a repo-level up refuses
  // it (0.3.0-dev.40, a consumer's dev.39 finding: the start died on
  // EADDRINUSE first).
  if (upSettle?.outcome === "busy") {
    onLine(`${resolved.address} not started: its port is in use`);
    closeAsync(1);
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
      } else if (command === "up" && !upSettle?.outcome) {
        // Nothing recorded, but the port is taken (0.3.0-dev.39). In the
        // repo: that is the service, adopted, already up. Elsewhere: said
        // and left alone, and refused before anything is spawned
        // (0.3.0-dev.40), as a repo-level up refuses it.
        const holder = settleUntrackedListener(
          resolved,
          workspace,
          onLine,
          `${resolved.address} not started`,
        );
        if (holder === "adopted") {
          // A restart's up step (its down found nothing recorded): the
          // adopted process is the old instance, so it is restarted now,
          // never left running as if restarted (0.4.1-dev.5).
          if (options.restartStep === "up") {
            onLine(`restarting the adopted process for ${resolved.address}`);
            return restartAsDownThenUp(
              { ...options, restartStep: "after-adopt" },
              getServiceLogPath(resolved.repoName, resolved.subsystem),
            );
          }
          closeAsync(0);
          return dummy();
        }
        if (holder === "busy") {
          closeAsync(1);
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
        `project "${workspace}" does not own running "${resolved.address}" (owners: [${owners.join(", ")}]) — use \`--force\` to stop it anyway`,
      );
      closeAsync(0);
      return dummy();
    }
    if (owners.length > 1 && owners.includes(workspace)) {
      detachDaemonOwner(resolved.address, workspace);
      const remaining = owners.filter((w) => w !== workspace);
      onLine(
        `detached project "${workspace}" — still running for [${remaining.join(", ")}]`,
      );
      closeAsync(0);
      return dummy();
    }
  }
  // Past the ownership gate, a down stops what it finds: a pre-dev.37 record
  // is settled first, so its adopted group is stopped (0.3.0-dev.39).
  if (command === "down") settledDaemonRecord(resolved, workspace, onLine);

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
      return downWithoutCommand(
        `no matching opctl containers; no manifest at ${repoPath}`,
      );
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
  // Own properties only (SEC-1 §6b.2): `constructor` is no command.
  let cmdDef = Object.prototype.hasOwnProperty.call(svcCommands, command)
    ? svcCommands[command]
    : undefined;
  const requestedCmdDef = cmdDef;

  // `restart` fallback: synthesise `make down && make up` when no explicit
  // restart command exists but both down and up are defined.
  if (!cmdDef && command === "restart") {
    const downDef = svcCommands["down"];
    const upDef = svcCommands["up"];
    // A daemon restart is a down step, then a detached up step, never one
    // `sh -c "<down> && <up>"`: the up's recorded process group must hold
    // only the up (0.3.0-dev.38). The tab runtime composes its own below.
    // With no down of its own (0.3.0-dev.39, a consumer's dev.38 finding),
    // the down step stops what the detached up recorded, as `down` does.
    if (upDef && (!downDef || runtime !== "tab")) {
      return restartAsDownThenUp(
        options,
        getServiceLogPath(resolved.repoName, resolved.subsystem),
      );
    }
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
    const viaRepo = repoStartedFallback(resolved, command, workspace);
    if (viaRepo?.address) {
      onLine(viaRepo.note);
      return runServiceCommand({ ...options, address: viaRepo.address });
    }
    if (viaRepo) {
      onLine(command === "down" ? viaRepo.note : `Error: ${viaRepo.note}`);
      closeAsync(command === "down" ? 0 : 1);
      return dummy();
    }
    // Down is opctl-conventional: when no container is running AND the manifest
    // declares no down command, there is simply nothing to stop — that's a
    // successful down, not an error (keeps the ⋮ menu / workspace Down safe to
    // offer on every system).
    if (command === "down") {
      return downWithoutCommand("no running opctl containers, no down command");
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

  // R16: a service that declares secret_env never starts without every key
  // (a caller that did not resolve them is refused, not run without them).
  let secretEnv: Record<string, string> = {};
  if (startsService(command)) {
    let declared: string[];
    try {
      declared = secretEnvKeys(serviceSecretEnvSpec(resolved));
    } catch (e) {
      onLine(`Error: ${(e as Error).message}`);
      closeAsync(1);
      return dummy();
    }
    const missing = declared.filter((k) => !options.secretEnv?.[k]);
    if (missing.length) {
      onLine(
        `Error: ${resolved.address} declares secret_env ${missing.join(", ")}, which were not resolved; not starting it`,
      );
      closeAsync(1);
      return dummy();
    }
    secretEnv = Object.fromEntries(
      declared.map((k) => [k, options.secretEnv?.[k] as string]),
    );
  }
  const hasSecrets = Object.keys(secretEnv).length > 0;
  // Secrets go only in the spawned process's env. A tab would need them in
  // its command line (and so its shell history), so such a start runs as a
  // daemon instead.
  const runEnv: NodeJS.ProcessEnv = { ...env, ...secretEnv };
  if (hasSecrets && runtime === "tab" && startsService(command))
    onLine(
      `${resolved.address} has secret_env: running as a daemon, not in a tab, to keep the values out of the tab's shell`,
    );
  const useTab = runtime === "tab" && !hasSecrets;

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
      { ...process.env, ...runEnv },
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

  if (useTab && command === "up") {
    return openCommandInTab(cmdString);
  }

  if (useTab && command === "restart") {
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
      // The down command ran; what the detached up started may still run
      // (the down stopped its containers, not the process that started
      // them). Stop the recorded group too (0.3.0-dev.37).
      const record = findDaemonByAddress(resolved.address);
      if (effective === 0 && hasProcessGroup(record)) {
        void stopDaemonProcessGroup(record, onLine).then((outcome) => {
          closeExistingTab();
          onClose(outcome === "unstoppable" ? unstoppableExit() : 0);
        });
        return;
      }
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

  // A detached up records its process group, so `down` can stop it.
  let recorded: RecordedProcessGroup | null = null;
  const recordGroup =
    detachable && logPath && command !== "down"
      ? (pid: number) => {
          recorded = recordProcessGroup(pid);
          if (recorded) updateDaemonProcessGroup(resolved.address, recorded);
        }
      : null;
  // A detached up whose whole group is gone when its leader exits leaves
  // nothing to stop: never keep its pgid (0.3.0-dev.39, a consumer's dev.38
  // finding: a second server that died on EADDRINUSE was recorded, and a
  // later down signalled the dead group while the real listener ran on).
  // A failed start keeps no record at all.
  const serviceExited = (exitCode: number): void => {
    const rec: RecordedProcessGroup | null = recorded;
    const state = rec ? (processGroupStateSync(rec)?.state ?? null) : null;
    const now = findDaemonByAddress(resolved.address);
    const action = failedStartCleanup(exitCode, rec, state, now);
    if (action === "unregister") unregisterDaemon(resolved.address);
    else if (action === "clear-group")
      clearDaemonProcessGroup(resolved.address);
    onServiceExit?.(exitCode);
  };
  const proc = recordGroup
    ? spawnStreaming(
        cmdString,
        [],
        { ...process.env, ...runEnv },
        onLine,
        wrappedOnClose,
        repoPath,
        detachable,
        logPath,
        serviceExited,
        recordGroup,
      )
    : spawnStreaming(
        cmdString,
        [],
        { ...process.env, ...runEnv },
        onLine,
        wrappedOnClose,
        repoPath,
        detachable,
        logPath,
        onServiceExit,
      );
  return { proc, detachable, interactive: false, logPath };
}

/**
 * What a detached up does with its record when the service process exits.
 * A non-zero exit is a failed start: nothing of it runs, so no record (its
 * containers, if any, still run: then only the group goes). A zero exit
 * handed off (`make up`): its group stays, and down says it already exited.
 * The record goes only if it is this run's: its group is the one this run
 * recorded and that group is gone, or this run could not record a group
 * (the command exited, a zombie, before `ps` saw it) and the record names
 * none.
 */
export function failedStartCleanup(
  exitCode: number,
  rec: RecordedProcessGroup | null,
  groupState: string | null,
  now: { pgid?: number; containers?: unknown[] } | undefined,
): "unregister" | "clear-group" | "keep" {
  if (exitCode === 0 || !now) return "keep";
  const ours = rec
    ? groupState === "gone" && now.pgid === rec.pgid
    : now.pgid === undefined;
  if (!ours) return "keep";
  return (now.containers?.length ?? 0) ? "clear-group" : "unregister";
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
