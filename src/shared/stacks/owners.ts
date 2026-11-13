/**
 * Who holds a stack's Compose project: the refcount a shared stack
 * namespace needs (namespace.ts).
 *
 * Without `stack_namespace` each workspace's projects are its own
 * (`<stack>-<workspace>`), so one workspace holds each. Two workspaces with
 * the same namespace that bring up the same stack share one project, and
 * one of them stopping it must not stop it for the other. This mirrors the
 * owner refcount of Den's own services (a daemon's `workspaces[]`,
 * releaseWorkspaceDaemons):
 *
 *  - `stack up` from workspace W records W as an owner, with the checkout
 *    (repo path and branch) the project runs from;
 *  - a later `up` from another workspace on the same checkout joins; from a
 *    different checkout or branch it is refused (`identity_mismatch`), never
 *    a silent swap of containers;
 *  - `stack down` from W stops the project only when no other live owner
 *    remains; otherwise it detaches W and leaves the project running.
 *
 * A live owner is a workspace that is still active, still resolves to this
 * namespace and still holds the stack: re-derived on every decision, so a
 * deactivated or moved workspace never wedges a project. A record whose
 * project has verifiably stopped counts no one.
 *
 * The record is `owners.json` in the project's own state directory, next
 * to its generated.env and override.yml. DEN_STACK_WORKSPACE (a
 * per-command override) bypasses it: such a command neither records nor
 * counts owners, as before.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getReposRoot } from "../den-config.js";
import { readCatalog } from "../environment-manager/catalog.js";
import {
  getActiveWorkspaces,
  getWorkspaceByName,
  listWorkspaceServices,
} from "../environment-manager/workspaces.js";
import { ServiceConflictError } from "../environment-manager/service-runner.js";
import { readManifest } from "../manifest/read-manifest.js";
import { manifestStackName, readStacks } from "./config.js";
import { isPrimary } from "./manifest-commands.js";
import { resolveStackNamespace } from "./namespace.js";
import { projectName } from "./render.js";
import { stackDir, type StackContext } from "./runtime.js";
import { loadStackContext } from "./status.js";
import type { StackConfig } from "./types.js";

/** A checkout: what a shared project must run from for every owner. */
export interface StackCheckout {
  repoPath: string;
  branch: string | null;
}

interface OwnersRecord extends StackCheckout {
  project: string;
  workspaces: string[];
}

/** Lookups the refcount needs; injectable for tests. */
export interface StackOwnerDeps {
  active?: () => string[];
  /** A workspace's stack namespace; null when it cannot be resolved. */
  namespaceOf?: (workspace: string) => string | null;
  /** Whether a workspace still holds the stack. */
  holds?: (workspace: string, stack: string) => boolean;
  /** Whether the project has running containers; null: docker can't tell. */
  running?: (project: string) => boolean | null;
}

/** Whether a context takes part in the refcount (not under the override). */
export function stackRefcounted(
  ctx: StackContext,
): ctx is StackContext & { denWorkspace: string } {
  return !!ctx.denWorkspace && ctx.namespaceSource !== "env";
}

function ownersFile(ctx: StackContext, s: StackConfig): string {
  return path.join(stackDir(ctx, s), "owners.json");
}

function readRecord(ctx: StackContext, s: StackConfig): OwnersRecord | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(ownersFile(ctx, s), "utf-8"),
    ) as Partial<OwnersRecord>;
    if (typeof raw.repoPath !== "string" || !Array.isArray(raw.workspaces))
      return null;
    return {
      project: projectName(s.name, ctx.workspace),
      repoPath: raw.repoPath,
      branch: typeof raw.branch === "string" ? raw.branch : null,
      workspaces: raw.workspaces.filter(
        (w): w is string => typeof w === "string",
      ),
    };
  } catch {
    return null;
  }
}

function writeRecord(
  ctx: StackContext,
  s: StackConfig,
  rec: OwnersRecord,
): void {
  const file = ownersFile(ctx, s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
}

/** Drop the record once the project is down. */
export function forgetStackOwners(ctx: StackContext, s: StackConfig): void {
  try {
    fs.unlinkSync(ownersFile(ctx, s));
  } catch {
    /* none recorded */
  }
}

/** The checkout `s` runs from in `workspace`: its repo path and branch. */
export function stackCheckout(
  workspace: string,
  s: StackConfig,
): StackCheckout {
  const repoPath = s.repoPath ?? path.join(getReposRoot(), s.repo);
  let branch: string | null = null;
  try {
    const ws = getWorkspaceByName(workspace);
    if (ws)
      branch =
        listWorkspaceServices(ws.config, readCatalog(), ws.name).find(
          (svc) => svc.repoPath === repoPath,
        )?.branch ?? null;
  } catch {
    /* no branch to tell */
  }
  return { repoPath, branch };
}

const same = (a: StackCheckout, b: StackCheckout): boolean =>
  a.repoPath === b.repoPath && (a.branch ?? null) === (b.branch ?? null);

function composeRunning(project: string): boolean | null {
  const r = spawnSync(
    "docker",
    ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`],
    { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").trim().length > 0;
}

const defaultDeps: Required<StackOwnerDeps> = {
  active: getActiveWorkspaces,
  namespaceOf: (w) => {
    try {
      return resolveStackNamespace(w).namespace;
    } catch {
      return null;
    }
  },
  holds: (w, stack) => {
    try {
      if (!getWorkspaceByName(w)) return false;
      return stack in readStacks(undefined, { workspace: w });
    } catch {
      return true; // can't tell: never stop it from under them
    }
  },
  running: composeRunning,
};

/** The record and the live owners other than `workspace`. */
function coOwners(
  ctx: StackContext,
  s: StackConfig,
  workspace: string,
  deps: StackOwnerDeps,
): { record: OwnersRecord | null; others: string[] } {
  const d = { ...defaultDeps, ...deps };
  const record = readRecord(ctx, s);
  if (!record) return { record, others: [] };
  const active = new Set(d.active());
  const others = record.workspaces.filter(
    (w) =>
      w !== workspace &&
      active.has(w) &&
      d.namespaceOf(w) === ctx.workspace &&
      d.holds(w, s.name),
  );
  // A project that has verifiably stopped is held by no one.
  if (others.length && d.running(record.project) === false)
    return { record, others: [] };
  return { record, others };
}

/**
 * Check that `workspace` may bring `s` up: no other live owner runs its
 * project from a different checkout or branch. Returns those other owners
 * (sharing it); throws ServiceConflictError (`identity_mismatch`) when one
 * runs it from elsewhere.
 */
export function assertStackClaim(
  ctx: StackContext,
  s: StackConfig,
  workspace: string,
  deps: StackOwnerDeps = {},
): string[] {
  const { record, others } = coOwners(ctx, s, workspace, deps);
  if (!record || others.length === 0) return [];
  const requested = stackCheckout(workspace, s);
  if (same(record, requested)) return others;
  const project = projectName(s.name, ctx.workspace);
  const n = (b: string | null) => b ?? "n/a";
  throw new ServiceConflictError({
    reason: "identity_mismatch",
    address: s.name,
    owners: others,
    running: { repoPath: record.repoPath, branch: record.branch },
    requested,
    message:
      `stack ${s.name}: Compose project ${project} (stack namespace "${ctx.workspace}") ` +
      `is already running for project(s) [${others.join(", ")}] at ${record.repoPath} ` +
      `(branch: ${n(record.branch)}), which differs from ${requested.repoPath} ` +
      `(branch: ${n(requested.branch)}) for project "${workspace}". ` +
      `Not swapping its containers: stop it there first, or give "${workspace}" its own stack_namespace`,
  });
}

/**
 * Record `workspace` as an owner of `s`'s project after it is up. Joins the
 * record on the same checkout; a different checkout (reached only once no
 * live owner remains, see assertStackClaim) starts a new one.
 */
export function recordStackOwner(
  ctx: StackContext,
  s: StackConfig,
  workspace: string,
): void {
  const checkout = stackCheckout(workspace, s);
  const prev = readRecord(ctx, s);
  const kept = prev && same(prev, checkout) ? prev.workspaces : [];
  writeRecord(ctx, s, {
    project: projectName(s.name, ctx.workspace),
    ...checkout,
    workspaces: [...new Set([...kept, workspace])],
  });
}

/**
 * `workspace` lets go of `s`'s project. `stop: false` with `remaining`
 * when other live owners still hold it (they stay recorded, re-derived);
 * `stop: true` when it was the last (call forgetStackOwners once down).
 */
export function releaseStackOwner(
  ctx: StackContext,
  s: StackConfig,
  workspace: string,
  deps: StackOwnerDeps = {},
): { stop: boolean; remaining: string[] } {
  const { record, others } = coOwners(ctx, s, workspace, deps);
  if (!record || others.length === 0) return { stop: true, remaining: [] };
  writeRecord(ctx, s, { ...record, workspaces: others });
  return { stop: false, remaining: others };
}

/**
 * Record `workspace` as an owner of a compose stack it is about to skip
 * because it already answers its health check (claimHealthyService).
 * `attached` when it now shares the project with another workspace; null
 * when it holds it alone (recorded all the same), when `resolved` is not a
 * stack's primary service, or under the override;
 * `conflict` when the running project is another checkout's (the caller
 * then runs the real `up`, which refuses with the identity mismatch).
 */
export function claimHealthyStack(
  resolved: { repoPath: string; repoName: string; subsystem: string },
  workspace: string,
  deps: StackOwnerDeps = {},
): "attached" | "conflict" | null {
  try {
    const m = readManifest(resolved.repoPath);
    if (!m?.compose || !isPrimary(m, resolved.subsystem)) return null;
    const ctx = loadStackContext(workspace);
    if (!stackRefcounted(ctx)) return null;
    const s = ctx.stacks[manifestStackName(m, resolved.repoName)];
    if (!s) return null;
    let others: string[];
    try {
      others = assertStackClaim(ctx, s, workspace, deps);
    } catch (e) {
      if (e instanceof ServiceConflictError) return "conflict";
      throw e;
    }
    recordStackOwner(ctx, s, workspace);
    // Held by this workspace alone: recorded, and said as before.
    return others.length ? "attached" : null;
  } catch {
    return null; // no edge, an unreadable manifest: not a stack we can tell
  }
}
