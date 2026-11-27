/**
 * Workspace API route handlers.
 *
 * Extracted from server/index.ts. Owns all /api/workspaces/* endpoints
 * including workspace CRUD, service management, available repos,
 * dependency checks, workspace-level commands, and sync.
 */

import { repoHasRuntime } from "../../shared/repo-kind.js";
import { reservedWorkspaceError } from "../../shared/agents/server-agent.js";
import { loadApplicationTree } from "../../shared/environment-manager/load-applications.js";
import { localCommandsFor } from "../../shared/stacks/manifest-commands.js";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { execFile, execSync } from "child_process";
import { singleFlight } from "./single-flight.js";
import {
  encodeCursor,
  isPageError,
  readPageAsk,
  sendPageError,
  type PageError,
} from "./paging.js";
import {
  AgentError,
  disposeWorkspaceAgents,
  workspaceAgents,
  type AgentsResolved,
} from "../cli/agent-ops.js";
import { webDeps } from "./agent-routes.js";
import { readBody, readMethodOnly, sendJson, send400 } from "./http-helpers.js";
import type {
  ResolvedService,
  WorkspaceConfig,
} from "../../shared/types/index.js";
import { projectCapValueError } from "../../shared/agents/project-cap.js";
import type { EditorManager } from "./editor-manager.js";
import type { GitHubService } from "./github-service.js";
import { JETBRAINS_EDITORS } from "./editor-manager.js";
import { stackNamespaceRows } from "../../shared/stacks/namespace.js";
import {
  readWorkspacesFile,
  writeWorkspacesFile,
  setActiveWorkspace,
  activateWorkspace,
  deactivateWorkspace,
  setFocusedWorkspace,
  getActiveWorkspace,
  getWorkspaceByName,
  isWorkspaceActive,
  createWorkspace,
  deleteWorkspaceConfig,
  renameWorkspace,
  resolveWorkspaceInput,
  listWorkspaceServices,
  resolveServiceSource,
  parseAddress,
  noAutostartRepos,
  computeMissingDeps,
  generateVSCodeWorkspace,
  syncJetBrainsWorkspaceSymlinks,
  DEN_SERVICES_DIR,
  DEN_WORKSPACES_DIR,
  resolveWorkspaceDir,
} from "../../shared/environment-manager/workspaces.js";
import {
  checkServiceHealth,
  claimHealthyService,
  settledDaemonRecord,
  runServiceCommand,
  prepareServiceSecretEnv,
  resolveService,
  hasRunningOpctlContainers,
  releaseWorkspaceDaemons,
} from "../../shared/environment-manager/service-runner.js";
import {
  ensureManagedServiceClone,
  ensureManagedServiceCloneNewBranch,
  ensureDevManagedClone,
  deleteWorkspaceDirectory,
  checkManagedCloneBehind,
  pullManagedClone,
  runSetupHidden,
} from "../../shared/environment-manager/workspace-manager.js";
import {
  expandSameRepoWaitDeps,
  getWaitDeps,
} from "../../shared/environment-manager/dag.js";
import { deriveGraph } from "../../shared/environment-manager/derivation/derive-graph.js";
import { githubOrgFor } from "../../shared/environment-manager/workspace-org.js";
import {
  deriveStartTargets,
  filterClosureForStart,
  orderForUp,
} from "../../shared/environment-manager/derivation/derived-up.js";
import { readManifest } from "../../shared/manifest/read-manifest.js";
import {
  placementRefusal,
  servicePlacement,
} from "../../shared/manifest/placement.js";
import {
  checkRepoSecrets,
  describeSecretsCheck,
  seedSecretsFromSibling,
} from "../../shared/environment-manager/secrets-check.js";
import { serviceEnvProviderRepos } from "../../shared/environment-manager/service-env.js";
import { depService } from "../../shared/manifest/deps.js";
import { waitForReady } from "../../shared/environment-manager/readiness.js";
import {
  readCatalog,
  needsGhRepair,
  resolveRepoCloneSource,
  upsertCatalogEntry,
} from "../../shared/environment-manager/catalog.js";
import { getReposRoot, readUserConfig } from "../../shared/den-config.js";
import {
  workspaceNameRefusal,
  workspaceSlug,
} from "../../shared/workspace-name.js";
import { redactRemote } from "../../shared/environment-manager/git-remote.js";
import { getDistRoot } from "../../shared/paths.js";
import {
  isMultiBlueprint,
  recordRemovedFromWorkspace,
  seedBlueprintWorkspaces,
  seedDefaultWorkspace,
} from "../../shared/environment-manager/default-workspace.js";
import { getSudoEnv, prewarmSudo, watchSudo } from "./sudo-store.js";
import {
  devManagedPaths,
  selectSyncTargets,
} from "../../shared/environment-manager/sync-targets.js";
import { recordAction } from "./audit.js";
import {
  fixtureProjectRefusal,
  fixtureTestInstall,
  type FixtureProjectAsk,
  type FixtureProjectOp,
} from "./fixture-projects.js";
import { FIXTURE_PRINCIPAL } from "../../shared/fixture-person.js";
import {
  agentFocusRefusal,
  agentFocusedReadRefusal,
  agentPrincipalOf,
  agentRowFilter,
  auditActorOf,
  fixturePersonOf,
  principalOf,
} from "./request-guard.js";
import { narrowByWorkspace } from "../../shared/agents/scope-rule.js";
import { approvalsView, patchApprovals } from "../../shared/approval-policy.js";

/** Issue 160: a project's approval policy rows (null policy: the install's). */
function projectApprovals(raw: unknown): {
  approvals_policy: string | null;
  approvals_watch: string[];
  approvals_critical: string[];
} {
  const v = approvalsView(raw);
  return {
    approvals_policy: v.policy,
    approvals_watch: v.watch,
    approvals_critical: v.critical,
  };
}
import {
  GIT_REMOTE_TIMEOUT_MS,
  DETACH_WINDOW_MS,
} from "../../shared/constants.js";

import { product } from "../../shared/product.js";
import {
  patchProjectHubLoop,
  projectHubLoop,
} from "../../shared/hub/hub-loop.js";
import { isRepoName } from "../../shared/repo-name.js";

/** Issue 158: a project's Hub delivery loop setting, as the API says it. */
const hubLoopFields = (ws: unknown) => {
  const l = projectHubLoop(ws);
  return { hub_delivery_loop: l.on, hub_delivery_loop_extra: l.extra };
};

const ownAgentCap = (ws: WorkspaceConfig | undefined): number | null => {
  const v = ws?.agents?.max_per_project;
  return typeof v === "number" ? v : null;
};
// Anchored to the den root, NOT process.cwd(): ws.directory values are
// stored relative to this and written back via path.relative below — a
// cwd-started-elsewhere server would resolve and persist garbage paths.
const ROOT = getDistRoot();

/** `git <args>` in `cwd`, trimmed stdout; null on any failure. Never blocks. */
function gitOut(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: GIT_REMOTE_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout.trim()),
    );
  });
}

/**
 * The repos Local Dev's "add" picker offers: local checkouts under
 * repos_root with a manifest, managed clones, and catalog-only entries.
 */
type RepoPageAsk = {
  limit: number;
  after: [number, string, string] | null;
  q: string;
};

export const REPOS_LIST = "workspaces.available-repos";

const segmentsBefore = (a: string, b: string): number => {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
};

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

async function buildAvailableRepos(
  wsOverride: string | null,
  page: RepoPageAsk | null = null,
) {
  const reposRoot = getReposRoot();
  const wsFile = wsOverride ? readWorkspacesFile() : null;
  const ws =
    wsOverride && wsFile?.workspaces[wsOverride]
      ? { config: wsFile.workspaces[wsOverride] }
      : getActiveWorkspace();
  const catalog = readCatalog();
  const existingAddresses = new Set(Object.keys(ws?.config.services ?? {}));

  // Build a set of gh slugs already represented in the workspace, so that
  // alternate local paths for the same repo (e.g. TestWorkspace/shop) are
  // correctly flagged as already-added.
  const existingGhSlugs = new Set<string>();
  for (const addr of existingAddresses) {
    const { repoName } = parseAddress(addr, catalog);
    const gh = catalog[repoName]?.gh;
    if (gh) existingGhSlugs.add(gh.toLowerCase());
  }

  // Git remote origin for a local path, as "owner/repo" (null on failure).
  // Async and in parallel: one execSync per repo here used to hold the
  // event loop for the whole walk.
  const getRemoteGh = async (absPath: string): Promise<string | null> => {
    const remote = await gitOut(absPath, ["remote", "get-url", "origin"]);
    // Normalise SSH and HTTPS GitHub URLs → "owner/repo"
    const m =
      remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/) ?? null;
    return m ? m[1].toLowerCase() : null;
  };
  /** Lookups still in flight; each fills in its entry when it lands. */
  const pending: Promise<void>[] = [];
  const lookups = new Map<object, () => Promise<void>>();
  const later = (entry: object, run: () => Promise<void>) => {
    if (page) lookups.set(entry, run);
    else pending.push(run());
  };
  const keys = new Map<object, [number, string, string]>();
  const needle = page?.q.toLowerCase() ?? "";
  const wanted = (...xs: (string | null | undefined)[]) =>
    !needle || xs.some((x) => !!x && x.toLowerCase().includes(needle));
  const full = () => !!page && entries.length > page.limit;
  const afterCursor = (rank: number, key: string, sub = "") => {
    if (!page?.after) return true;
    const [r, k, b] = page.after;
    if (rank !== r) return rank > r;
    const c =
      rank === 0 || rank === 2
        ? segmentsBefore(key, k)
        : key < k
          ? -1
          : key > k
            ? 1
            : 0;
    return c > 0 || (c === 0 && sub > b);
  };
  const keep = (entry: object, rank: number, key: string, sub = "") => {
    keys.set(entry, [rank, key, sub]);
  };
  const isAdded = (relPath: string, gh: string | null): boolean =>
    existingAddresses.has(relPath) ||
    (!!gh && existingGhSlugs.has(gh.toLowerCase()));

  type RepoEntry = {
    name: string;
    relPath: string;
    absPath: string | null;
    hasManifest: boolean;
    alreadyAdded: boolean;
    source: "local" | "catalog" | "managed";
    gh: string | null;
    currentBranch?: string | null;
  };
  const entries: RepoEntry[] = [];
  const seenRelPaths = new Set<string>();

  // Walk repos_root for checkouts with their own manifest. A git checkout is
  // never descended into, manifest or not: the walk used to recurse into
  // every directory without the manifest file, so a distribution whose
  // repos use held manifests (manifests/<repo>.yml) had each repo's whole
  // tree walked to depth 4 — seconds of readdirSync on every call. All of it
  // is async now: the event loop serves other requests meanwhile.
  const exists = (p: string): Promise<boolean> =>
    fs.promises.access(p).then(
      () => true,
      () => false,
    );
  const walkDir = async (
    dir: string,
    relPrefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 4) return; // safety limit
    if (full()) return;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const children = dirents
      .filter(
        (d) =>
          (d.isDirectory() || d.isSymbolicLink()) &&
          !d.name.startsWith(".") && // .git, .github, .DS_Store, …
          d.name !== "node_modules" &&
          path.join(dir, d.name) !== ROOT, // den itself
      )
      .sort(byName)
      .filter((d) => {
        const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
        return (
          afterCursor(0, rel) ||
          (page?.after?.[0] === 0 && page.after[1].startsWith(`${rel}/`))
        );
      });
    // One directory's children are checked together; the descent stays
    // depth-first in readdir order, so the list keeps its old order.
    const checked = await Promise.all(
      children.map(async (d) => {
        const absPath = path.join(dir, d.name);
        const [hasManifest, isCheckout] = await Promise.all([
          exists(path.join(absPath, `${product().manifestYml}`)),
          exists(path.join(absPath, ".git")),
        ]);
        return { d, absPath, hasManifest, isCheckout };
      }),
    );
    for (const { d, absPath, hasManifest, isCheckout } of checked) {
      if (full()) return;
      const relPath = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      if (
        hasManifest &&
        afterCursor(0, relPath) &&
        wanted(d.name, relPath, catalog[relPath]?.gh)
      ) {
        const known = catalog[relPath]?.gh ?? null;
        // Already added if the exact address is in the workspace, OR if
        // a repo with the same GitHub remote is already present.
        const entry: RepoEntry = {
          name: d.name,
          relPath,
          absPath,
          hasManifest: true,
          alreadyAdded: isAdded(relPath, known),
          source: "local",
          gh: known,
        };
        entries.push(entry);
        keep(entry, 0, relPath);
        if (!known)
          later(entry, () =>
            getRemoteGh(absPath).then((gh) => {
              entry.gh = gh;
              entry.alreadyAdded = isAdded(relPath, gh);
            }),
          );
        seenRelPaths.add(relPath);
      } else if (!hasManifest && !isCheckout) {
        // Not a repo: look for repos in its subdirectories.
        await walkDir(absPath, relPath, depth + 1);
      }
    }
  };
  if (!page?.after || page.after[0] === 0) await walkDir(reposRoot, "", 0);

  // Managed clones live at .den-services/<repo>/<branch>/
  // Walk two levels: repo dir → branch dir (each branch dir is a full clone).
  // Multiple workspaces pointing to the same repo+branch share the same clone.
  const readDirs = async (dir: string): Promise<string[]> => {
    try {
      return (await fs.promises.readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return []; // the managed-clones dir does not exist yet
    }
  };
  for (const repoName of (await readDirs(DEN_SERVICES_DIR)).sort()) {
    if (full()) break;
    const repoDirPath = path.join(DEN_SERVICES_DIR, repoName);
    const clones = await Promise.all(
      (await readDirs(repoDirPath)).map(async (branchName) => {
        const absPath = path.join(repoDirPath, branchName);
        const [isGit, hasManifest] = await Promise.all([
          exists(path.join(absPath, ".git")),
          exists(path.join(absPath, `${product().manifestYml}`)),
        ]);
        return { branchName, absPath, isGit, hasManifest };
      }),
    );
    clones.sort((a, b) =>
      a.branchName < b.branchName ? -1 : a.branchName > b.branchName ? 1 : 0,
    );
    for (const { branchName, absPath, isGit, hasManifest } of clones) {
      // Only treat as a branch clone if it's actually a git repo
      if (!isGit) continue;
      const key = `${repoName}::${branchName}`; // unique per repo+branch
      seenRelPaths.add(repoName);
      if (seenRelPaths.has(key)) continue;
      if (
        full() ||
        !afterCursor(1, repoName, branchName) ||
        !wanted(repoName, branchName, catalog[repoName]?.gh)
      )
        continue;
      const known = catalog[repoName]?.gh ?? null;
      const entry: RepoEntry = {
        name: repoName,
        relPath: repoName, // catalog key used as workspace address
        absPath,
        hasManifest,
        alreadyAdded: isAdded(repoName, known),
        source: "managed",
        gh: known,
        currentBranch: branchName,
      };
      entries.push(entry);
      keep(entry, 1, repoName, branchName);
      later(entry, () =>
        Promise.all([
          known ? known : getRemoteGh(absPath),
          gitOut(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
        ]).then(([gh, branch]) => {
          entry.gh = gh;
          entry.alreadyAdded = isAdded(repoName, gh);
          entry.currentBranch = branch ?? branchName;
        }),
      );
      seenRelPaths.add(key);
      seenRelPaths.add(repoName); // prevent catalog fallback from duplicating
    }
  }

  // Catalog-only entries — repos den knows about but not found locally.
  const localManifest = (relPath: string) =>
    exists(path.join(reposRoot, relPath, `${product().manifestYml}`));
  const catalogOrder = Object.entries(catalog);
  if (page) catalogOrder.sort(([a], [b]) => segmentsBefore(a, b));
  for (const [relPath, entry] of catalogOrder) {
    if (seenRelPaths.has(relPath)) continue;
    if (page) {
      if (full()) break;
      if (!afterCursor(2, relPath) || !wanted(relPath, entry.gh)) continue;
      if (await localManifest(relPath)) continue;
    }
    const name = relPath.includes("/")
      ? relPath.slice(relPath.lastIndexOf("/") + 1)
      : relPath;
    const alreadyAdded =
      existingAddresses.has(relPath) ||
      (!!entry.gh && existingGhSlugs.has(entry.gh.toLowerCase()));
    const row: RepoEntry = {
      name,
      relPath,
      absPath: null,
      hasManifest: false,
      alreadyAdded,
      source: "catalog",
      gh: entry.gh ?? null,
    };
    entries.push(row);
    keep(row, 2, relPath);
  }

  await Promise.all(pending);
  if (!page) return entries;
  const items = entries.slice(0, page.limit);
  await Promise.all(items.map((e) => lookups.get(e)?.()));
  const last = items[items.length - 1];
  const at = last ? keys.get(last) : undefined;
  return {
    items,
    next:
      entries.length > page.limit && at
        ? encodeCursor(REPOS_LIST, { key: [...at], id: at[1] })
        : null,
    prev: null,
  };
}

type AvailableRepos = Awaited<ReturnType<typeof buildAvailableRepos>>;
const readRepoPage = (p: URLSearchParams): RepoPageAsk | PageError | null => {
  if (p.get("all") === "1") return null;
  const ask = readPageAsk(p, REPOS_LIST);
  if (isPageError(ask)) return ask;
  if (ask.dir === "prev" || ask.at === "last" || (ask.page ?? 1) > 1)
    return {
      status: 400,
      code: "bad_page",
      error:
        "this list pages forward only: follow next, or start again without a cursor",
    };
  const q = (p.get("q") ?? "").trim().slice(0, 200);
  if (!ask.after) return { limit: ask.limit, after: null, q };
  const k = ask.after.key;
  if (
    !Array.isArray(k) ||
    k.length !== 3 ||
    ![0, 1, 2].includes(k[0] as number) ||
    typeof k[1] !== "string" ||
    typeof k[2] !== "string" ||
    k[1] !== ask.after.id
  )
    return {
      status: 400,
      code: "bad_cursor",
      error: "cursor is not one this list gave: start again without it",
    };
  return { limit: ask.limit, after: [k[0] as number, k[1], k[2]], q };
};
/** Shared by concurrent requests, reused briefly; cleared by any mutation. */
const availableReposCache = singleFlight<AvailableRepos>(2_000, Date.now, 50);

export const WORKSPACES_SHAPE = {
  maps: [
    "workspaces",
    "resolvedDirs",
    "codeWorkspacePaths",
    "stackNamespaces",
    "hubUncovered",
    "hubElsewhere",
    "projectColours",
  ],
  lists: ["active", "projectOrder"],
  names: ["focus"],
} as const;

/**
 * Handle all /api/workspaces/* and /api/workspace/* routes.
 *
 * Same contract as the original inline handlers: uses return sendJson/send400
 * to end the response. Caller checks res.writableEnded to know if handled.
 */

/**
 * Why a workspace can't be created with this name, or null: the Workspaces
 * page's create and ON-3's held workspace_create (approval-routes.ts) both
 * ask this.
 */

export function workspaceCreateRefusal(
  name: string | undefined,
): string | null {
  // D70: the one check every create runs (createWorkspace runs it too).
  const refusal = workspaceNameRefusal(name, readWorkspacesFile().workspaces);
  if (refusal) return refusal;
  const slug = workspaceSlug(name!.trim())!;
  return reservedWorkspaceError(slug) ?? reservedWorkspaceError(name!.trim());
}

/** D71: the agents a workspace delete reads and disposes of (tests: a rig's). */
let wsAgentsOver: (() => AgentsResolved) | null = null;
export function setWorkspaceAgentsDeps(f: (() => AgentsResolved) | null): void {
  wsAgentsOver = f;
}
const wsAgentsDeps = (): AgentsResolved =>
  (wsAgentsOver ?? (() => webDeps()))();

/**
 * Issue 1182: `workspace seed` and `init` with a reset, a person's.
 *
 *   POST /api/workspaces/seed { reset: true }: each project the committed
 *       config's blueprint names is reset to it (its repos managed), as the
 *       CLI's reset does. An agent is refused. Audited.
 *
 * A seed with nothing to reset stays the CLI's: it only creates what the
 * committed config lists.
 */
export interface SeedResetDeps {
  isAgent: (req: http.IncomingMessage) => boolean;
  /** The reset: what was seeded, in blueprint order. */
  seed: () => { name: string; repos: string[] }[];
  audit: (req: http.IncomingMessage, line: string, refused?: boolean) => void;
}

export async function seedResetRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: SeedResetDeps,
): Promise<boolean> {
  if (pathname !== "/api/workspaces/seed") return false;
  if (req.method !== "POST") {
    sendJson(res, { ok: false, error: "POST only" }, 405);
    return true;
  }
  if (d.isAgent(req)) {
    const error = "Only a person can reset projects (this is an agent)";
    d.audit(req, error, true);
    sendJson(res, { ok: false, error }, 403);
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    body = null;
  }
  const keys =
    body && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body)
      : null;
  if (
    !keys ||
    keys.length !== 1 ||
    (body as Record<string, unknown>).reset !== true
  ) {
    sendJson(
      res,
      { ok: false, error: "The body is JSON: { reset: true }." },
      400,
    );
    return true;
  }
  try {
    const seeded = d.seed();
    d.audit(
      req,
      `reset to the blueprint: ${seeded.map((w) => `${w.name} (${w.repos.length} repos)`).join(", ") || "nothing to seed"}`,
    );
    sendJson(res, { ok: true, seeded });
  } catch (e) {
    const error = (e as Error).message;
    d.audit(req, error, true);
    sendJson(res, { ok: false, error }, 400);
  }
  return true;
}

/**
 * Issue 1215: a project act, audited (verb "project") whoever makes it.
 * The fixture person's own projects carry fixture_made on their record
 * (fixture-projects.ts), not here.
 */
function auditProject(
  req: http.IncomingMessage,
  op: FixtureProjectOp,
  slug: string,
  refused?: { code: string },
): void {
  recordAction(
    auditActorOf(req),
    {
      verb: "project",
      detail: `${op} ${slug}`,
      ...(refused ? { outcome: "refused" as const, reason: refused.code } : {}),
    },
    principalOf(req),
  );
}

/**
 * Issue 1215: for the fixture person's session, why this project act is
 * refused (answered and audited here, true), or false to go on. Any other
 * caller goes on: agents' tokens never reach here (AGENT_PERSON_WRITES).
 */
function fixtureProjectRefused(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ask: Omit<FixtureProjectAsk, "testInstall" | "claimed" | "fixtureMade">,
): boolean {
  if (principalOf(req) !== FIXTURE_PRINCIPAL) return false;
  const refusal = fixtureProjectRefusal({
    ...ask,
    testInstall: fixtureTestInstall(),
    claimed: !fixturePersonOf(req),
    fixtureMade:
      readWorkspacesFile().workspaces[ask.slug]?.fixture_made === true,
  });
  if (!refusal) return false;
  auditProject(req, ask.op, ask.slug, refusal);
  sendJson(
    res,
    { ok: false, code: refusal.code, error: refusal.error },
    refusal.status,
  );
  return true;
}

export async function handleWorkspaceRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL,
  editors: EditorManager,
  github: GitHubService,
): Promise<void> {
  const focusWhy = agentFocusedReadRefusal(
    req,
    pathname,
    url.searchParams,
    getActiveWorkspace()?.name,
  );
  if (focusWhy)
    return sendJson(
      res,
      { ok: false, code: "agent_forbidden", error: focusWhy },
      403,
    );
  // A mutation may change what available-repos would list.
  if (
    (req.method !== "GET" && req.method !== "HEAD") ||
    /\/(exec|sync)$/.test(pathname)
  )
    availableReposCache.clear();
  // ── Workspace cleanup helpers ─────────────────────────────────────────────
  /**
   * Compute which clones can be deleted when removing `wsName`.
   *
   * devManaged   — repos den cloned under <reposRoot>/<wsName>/ for this ws
   * denManaged — .den-services clones exclusively owned by this workspace
   */
  function computeCleanupTargets(wsName: string): {
    devManaged: Array<{ address: string; cloneDir: string }>;
    denManaged: Array<{ address: string; cloneDir: string }>;
  } {
    const wsFile = readWorkspacesFile();
    const ws = wsFile.workspaces[wsName];
    if (!ws) return { devManaged: [], denManaged: [] };

    const catalog = readCatalog();
    const reposRoot = getReposRoot();
    const wsDevRoot = path.join(reposRoot, wsName);

    const otherWorkspaces = Object.entries(wsFile.workspaces)
      .filter(([n]) => n !== wsName)
      .map(([, cfg]) => cfg);

    const devManaged: Array<{ address: string; cloneDir: string }> = [];
    const denManaged: Array<{ address: string; cloneDir: string }> = [];

    for (const [address, entry] of Object.entries(ws.services)) {
      if (entry.mode === "dev-managed") {
        // Only include repos den cloned into <reposRoot>/<wsName>/ — not
        // repos the engineer linked from their own existing checkout.
        if (entry.path?.startsWith(wsDevRoot) && fs.existsSync(entry.path)) {
          devManaged.push({ address, cloneDir: entry.path });
        }
      } else if (entry.mode === "managed") {
        const { repoName } = parseAddress(address, catalog);
        const branch = entry.branch ?? "main";
        const cloneDir = path.join(DEN_SERVICES_DIR, repoName, branch);
        if (!fs.existsSync(cloneDir)) continue;
        const usedByOther = otherWorkspaces.some((other) =>
          Object.entries(other.services).some(([addr, e]) => {
            if (e.mode !== "managed") return false;
            const { repoName: r } = parseAddress(addr, catalog);
            return r === repoName && (e.branch ?? "main") === branch;
          }),
        );
        if (!usedByOther) denManaged.push({ address, cloneDir });
      }
    }

    return { devManaged, denManaged };
  }

  // ── Editor capability sets ────────────────────────────────────────────────
  const VSCODE_LIKE_EDITORS = new Set(["vscode", "cursor"]);

  // ── API: workspaces ───────────────────────────────────────────────────────
  if (pathname === "/api/workspaces") {
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as {
          name?: string;
          /** activate | deactivate | focus | use (default: use = activate+focus) | rename */
          action?: "activate" | "deactivate" | "focus" | "use" | "rename";
          /** D70: rename's new name (the slug stays). */
          to?: string;
        };
        if (!parsed.name) return send400(res, "name required");
        // D70: by its name or its slug.
        const name = resolveWorkspaceInput(parsed.name);
        const act = parsed.action ?? "use";
        if (fixtureProjectRefused(req, res, { op: act, slug: name })) return;
        if (act === "rename") {
          if (!readWorkspacesFile().workspaces[name])
            return send400(res, `no project "${parsed.name}"`);
          renameWorkspace(name, String(parsed.to ?? ""));
          const file = readWorkspacesFile();
          return sendJson(res, {
            ok: true,
            slug: name,
            name: file.workspaces[name]?.name ?? name,
          });
        }
        let released: Awaited<ReturnType<typeof releaseWorkspaceDaemons>> = [];
        switch (act) {
          case "activate":
            activateWorkspace(name);
            break;
          case "deactivate":
            deactivateWorkspace(name);
            // Release AFTER the workspace has left active[] so shared services
            // see the post-deactivation owner set (design decision 5).
            released = await releaseWorkspaceDaemons(name);
            break;
          case "focus":
            setFocusedWorkspace(name);
            break;
          case "use":
            setActiveWorkspace(name);
            break;
          default: {
            const _exhaustive: never = act;
            return send400(res, `unknown action: ${String(_exhaustive)}`);
          }
        }
        if (act === "activate" || act === "deactivate")
          auditProject(req, act, name);
        const file = readWorkspacesFile();
        return sendJson(res, {
          ok: true,
          active: file.active,
          focus: file.focus,
          released,
        });
      } catch (e) {
        return send400(res, `Invalid request: ${(e as Error).message}`);
      }
    }
    if (req.method === "DELETE") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as {
          name?: string;
          cleanupDirectory?: boolean;
          cleanupDev?: boolean;
          cleanupDen?: boolean;
          /** D71: what happens to its agents: stop them, or move them. */
          agents?: string;
          agentsTo?: string;
        };
        const { cleanupDirectory, cleanupDev, cleanupDen } = parsed;
        if (!parsed.name) return send400(res, "name required");
        // D70: by its name or its slug.
        const name = resolveWorkspaceInput(parsed.name);
        if (name === "default")
          return send400(res, "cannot delete the default project");
        if (
          fixtureProjectRefused(req, res, {
            op: "delete",
            slug: name,
            flags: { cleanupDirectory, cleanupDev, cleanupDen },
            ...(parsed.agents !== undefined ? { agents: parsed.agents } : {}),
          })
        )
          return;
        if (
          parsed.agents !== undefined &&
          parsed.agents !== "stop" &&
          parsed.agents !== "move"
        )
          return send400(res, "agents must be stop or move");
        // D71: never leaves its agents running with no workspace.
        let agentsDone: Awaited<ReturnType<typeof disposeWorkspaceAgents>>;
        try {
          agentsDone = await disposeWorkspaceAgents(
            wsAgentsDeps(),
            name,
            parsed.agents as "stop" | "move" | undefined,
            parsed.agentsTo
              ? resolveWorkspaceInput(parsed.agentsTo)
              : undefined,
          );
        } catch (e) {
          if (!(e instanceof AgentError)) throw e;
          return sendJson(
            res,
            {
              ok: false,
              error: e.message,
              ...(e.code ? { code: e.code } : {}),
              ...(e.code === "has_agents"
                ? { agents: await workspaceAgents(wsAgentsDeps(), name) }
                : {}),
            },
            e.status,
          );
        }

        // Delete workspace directory (den-workspaces/<name>)
        if (cleanupDirectory) {
          try {
            deleteWorkspaceDirectory(name);
          } catch {
            /* best-effort */
          }
        }

        if (cleanupDev || cleanupDen) {
          const { devManaged, denManaged } = computeCleanupTargets(name);

          if (cleanupDev) {
            // Dev-managed clones
            for (const { cloneDir } of devManaged) {
              try {
                fs.rmSync(cloneDir, { recursive: true, force: true });
              } catch {
                /* best-effort */
              }
            }
          }

          if (cleanupDen) {
            for (const { cloneDir } of denManaged) {
              try {
                fs.rmSync(cloneDir, { recursive: true, force: true });
              } catch {
                /* best-effort */
              }
            }
          }
        }

        deleteWorkspaceConfig(name);
        auditProject(req, "delete", name);
        return sendJson(res, { ok: true, ...agentsDone });
      } catch (e) {
        return send400(res, `Invalid request: ${(e as Error).message}`);
      }
    }
    // Augment with resolved absolute directories so the UI can open them.
    // Priority: ws.directory field → den-workspaces/<name> → legacy reposRoot/<name>
    // → reposRoot itself as last resort.
    const wsFile = readWorkspacesFile();
    const reposRoot = getReposRoot();
    const resolvedDirs: Record<string, string> = {};
    for (const [name, ws] of Object.entries(wsFile.workspaces))
      resolvedDirs[name] = resolveWorkspaceDir(name, ws, reposRoot);
    const editor = readUserConfig().editor ?? "";
    const catalog = readCatalog();
    const codeWorkspacePaths: Record<string, string> = {};

    if (VSCODE_LIKE_EDITORS.has(editor)) {
      for (const [name, ws] of Object.entries(wsFile.workspaces)) {
        try {
          codeWorkspacePaths[name] = generateVSCodeWorkspace(name, ws, catalog);
        } catch {
          // Non-fatal: fall back to directory path in the UI
        }
      }
    } else if (
      JETBRAINS_EDITORS.has(editor) ||
      editors.isTerminalEditor(editor)
    ) {
      // JetBrains and terminal editors both use the symlink-in-workspace-dir
      // approach: open the workspace folder and each editor discovers repos
      // via symlinks (JetBrains scans .git roots; vim/nvim/emacs traverse dirs).
      syncJetBrainsWorkspaceSymlinks(wsFile);
    }

    // Each workspace's stack namespace, resolved, with where it came from
    // (workspace, blueprint or default) and whether it differs from the
    // default suffix: the page's "stacks: <ns>" chip.
    const stackNamespaces = Object.fromEntries(
      stackNamespaceRows(Object.keys(wsFile.workspaces)).map((r) => [
        r.workspace,
        r,
      ]),
    );
    // H5: per project, the repos Den Hub's GitHub App can't see (the last
    // sync's answer; memory only, no call): the header's warning.
    const { projectSync } = await import("./hub-sync-service.js");
    const sync = projectSync();
    const hubUncovered = Object.fromEntries(
      Object.keys(wsFile.workspaces)
        .map((ws) => [ws, sync.uncoveredFor(ws)] as const)
        .filter(([, u]) => u.length),
    );
    // Issue 646: links to another Hub or company count as not linked: the
    // page shows the project's own name and "Another Hub" on its chip.
    const { hubElsewhereMap } =
      await import("../../shared/hub/hub-project-link.js");
    const hubElsewhere = hubElsewhereMap(
      Object.keys(wsFile.workspaces),
      () => wsFile,
    );
    // 0.4.45: this person's project order (Manage projects); the picker
    // lists A to Z without one.
    const { shellPrefs } = await import("./shell-prefs.js");
    const prefs = shellPrefs(readUserConfig().shell);
    const projectOrder = prefs.projectOrder;
    // Issue 168: the colours this person chose (the rest are Automatic).
    const projectColours = prefs.projectColours;
    const body = {
      ...wsFile,
      resolvedDirs,
      codeWorkspacePaths,
      stackNamespaces,
      hubUncovered,
      hubElsewhere,
      projectOrder,
      projectColours,
    };
    const keep = agentRowFilter(req);
    return sendJson(
      res,
      keep ? narrowByWorkspace(body, keep, WORKSPACES_SHAPE) : body,
    );
  }

  // ── API: rename workspace ─────────────────────────────────────────────────
  // D70: a rename changes the name only. The slug (the config key, its
  // folder, its agents' records, URLs) stays, so nothing that points at the
  // workspace breaks.
  if (pathname === "/api/workspaces/rename" && req.method === "POST") {
    try {
      const { oldName, newName } = JSON.parse(await readBody(req)) as {
        oldName?: string;
        newName?: string;
      };
      if (!oldName || !newName)
        return send400(res, "oldName and newName required");
      const slug = resolveWorkspaceInput(oldName);
      if (!readWorkspacesFile().workspaces[slug])
        return send400(res, `Project "${oldName}" not found`);
      renameWorkspace(slug, newName);
      return sendJson(res, { ok: true, slug, name: newName.trim() });
    } catch (e) {
      return send400(res, `Rename failed: ${(e as Error).message}`);
    }
  }

  // ── API: workspace cleanup preview ───────────────────────────────────────
  // Returns which clones would be deleted when removing this workspace.
  if (pathname === "/api/workspaces/cleanup-preview" && req.method === "GET") {
    const wsName = url.searchParams.get("name");
    if (!wsName) return send400(res, "name required");
    const name = resolveWorkspaceInput(wsName);
    // D71: its agents too, so the delete can ask what happens to them.
    let agents: Awaited<ReturnType<typeof workspaceAgents>> = [];
    try {
      agents = await workspaceAgents(wsAgentsDeps(), name);
    } catch {
      /* none readable: the delete itself still checks */
    }
    return sendJson(res, { ...computeCleanupTargets(name), agents });
  }

  // ── API: create workspace ─────────────────────────────────────────────────
  // Issue 1182: a reset to the blueprint, a person's.
  if (
    await seedResetRoute(req, res, pathname, {
      isAgent: (r) => !!(agentPrincipalOf(r) || auditActorOf(r)),
      seed: () =>
        isMultiBlueprint()
          ? seedBlueprintWorkspaces()
          : [{ name: "default", repos: seedDefaultWorkspace() }],
      audit: (r, line, refused) =>
        recordAction(
          auditActorOf(r),
          refused
            ? {
                verb: "workspace-seed-reset",
                detail: "",
                outcome: "refused",
                reason: line,
              }
            : { verb: "workspace-seed-reset", detail: line },
          principalOf(r),
        ),
    })
  )
    return;

  if (pathname === "/api/workspaces/create" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { name } = JSON.parse(body) as { name?: string };
      const refusal = workspaceCreateRefusal(name);
      if (refusal || !name) return send400(res, refusal ?? "name required");
      if (
        fixtureProjectRefused(req, res, {
          op: "create",
          slug: workspaceSlug(name) ?? name.trim(),
        })
      )
        return;
      // Issue 1215: the fixture person's own project carries its marker
      // (only here, and only past fixtureProjectRefused: a test install).
      const slug = createWorkspace(
        name,
        { services: {} },
        { fixtureMade: principalOf(req) === FIXTURE_PRINCIPAL },
      );
      auditProject(req, "create", slug);
      return sendJson(res, { ok: true, name: name.trim(), slug });
    } catch (e) {
      return send400(res, `Invalid request: ${(e as Error).message}`);
    }
  }

  // ── API: GitHub branches ──────────────────────────────────────────────────
  if (pathname === "/api/github/branches" && req.method === "GET") {
    const gh = url.searchParams.get("gh") ?? "";
    return sendJson(res, await github.listBranches(gh));
  }

  // ── API: GitHub repos ─────────────────────────────────────────────────────
  if (pathname === "/api/github/repos" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1";
    return sendJson(res, await github.listOrgRepos(forceRefresh));
  }

  // ── API: available repos (for adding to workspace) ────────────────────────
  // Returns two groups:
  //   local   — repos discovered recursively under repos_root (dev checkouts)
  //   catalog — catalog entries not found locally (den can clone them)
  //
  // Each entry carries:
  //   relPath  — path relative to repos_root (used as catalog key and workspace address)
  //   name     — leaf directory name (display label)
  //   absPath  — absolute filesystem path (stored as linkedPath for dev-managed repos)
  if (pathname === "/api/workspaces/available-repos" && req.method === "GET") {
    const wsOverride = url.searchParams.get("workspace");
    const page = readRepoPage(url.searchParams);
    if (page && "code" in page) return sendPageError(res, page);
    // Local Dev calls this on load: concurrent loads share one walk.
    return sendJson(
      res,
      await availableReposCache.get(
        JSON.stringify([wsOverride ?? "", page]),
        () => buildAvailableRepos(wsOverride, page),
        url.searchParams.get("refresh") === "1",
      ),
    );
  }

  // ── API: per-system auto-start toggle ─────────────────────────────────────
  // POST { workspace, repo, autostart } — sets `autostart: false` on the repo's
  // workspace entry (or removes the field when true, keeping the yaml clean).
  // The entry may be keyed by the bare repo name or by "repo/subsystem" keys.
  if (pathname === "/api/workspaces/services/autostart") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const body = await readBody(req);
      const { workspace, repo, autostart } = JSON.parse(body) as {
        workspace?: string;
        repo?: string;
        autostart?: boolean;
      };
      if (!workspace || !repo)
        return send400(res, "a project and a repo are required");
      if (typeof autostart !== "boolean")
        return send400(res, '"autostart" boolean required');
      const file = readWorkspacesFile();
      const ws = file.workspaces[workspace];
      if (!ws) return send400(res, `Unknown project "${workspace}"`);
      const catalog = readCatalog();
      const keys = Object.keys(ws.services).filter(
        (k) => parseAddress(k, catalog).repoName === repo,
      );
      if (keys.length === 0)
        return send400(res, `"${repo}" is not in project "${workspace}"`);
      for (const k of keys) {
        if (autostart) delete ws.services[k].autostart;
        else ws.services[k].autostart = false;
      }
      writeWorkspacesFile(file);
      return sendJson(res, { ok: true, repo, autostart });
    } catch (e) {
      return send400(res, `Invalid request: ${(e as Error).message}`);
    }
  }

  // ── API: per-system mode switch (use: local / use: den) ────────────────
  // POST { workspace, repo, mode, branch? } — web equivalent of the CLI's
  // use-local / use-managed. Rewrites all of the repo's entries (bare + any
  // "repo/sub" keys) with the new mode, mirroring switchRepoMode: dev-managed
  // requires a checkout at <reposRoot>/<repo>; managed tracks `branch`
  // (default main; the clone is ensured at up time). Preserves `autostart`.
  if (pathname === "/api/workspaces/services/mode") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const body = await readBody(req);
      const { workspace, repo, mode, branch } = JSON.parse(body) as {
        workspace?: string;
        repo?: string;
        mode?: string;
        branch?: string;
      };
      if (!workspace || !repo)
        return send400(res, "a project and a repo are required");
      if (mode !== "dev-managed" && mode !== "managed")
        return send400(res, 'mode must be "dev-managed" or "managed"');
      const file = readWorkspacesFile();
      const wsCfg = file.workspaces[workspace];
      if (!wsCfg) return send400(res, `Unknown project "${workspace}"`);
      const catalog = readCatalog();
      const keys = Object.keys(wsCfg.services).filter(
        (k) => parseAddress(k, catalog).repoName === repo,
      );
      if (keys.length === 0)
        return send400(res, `"${repo}" is not in project "${workspace}"`);

      let localPath: string | undefined;
      if (mode === "dev-managed") {
        localPath = path.join(getReposRoot(), repo);
        if (!fs.existsSync(localPath)) {
          return send400(
            res,
            `No local checkout found at ${localPath} — clone it there first, or use ${product().cli} register for a custom path`,
          );
        }
      }
      const effectiveBranch = branch ?? "main";
      for (const k of keys) {
        const keepOff = wsCfg.services[k]?.autostart === false;
        wsCfg.services[k] = {
          mode,
          ...(mode === "dev-managed" && localPath ? { path: localPath } : {}),
          ...(mode === "managed" ? { branch: effectiveBranch } : {}),
          ...(keepOff ? { autostart: false } : {}),
        };
      }
      writeWorkspacesFile(file);
      return sendJson(res, {
        ok: true,
        repo,
        mode,
        ...(localPath ? { path: localPath } : {}),
        ...(mode === "managed" ? { branch: effectiveBranch } : {}),
      });
    } catch (e) {
      return send400(res, `Invalid request: ${(e as Error).message}`);
    }
  }

  // ── API: workspace services (add / remove) ────────────────────────────────
  if (pathname === "/api/workspaces/services") {
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const {
          workspace,
          address,
          mode,
          linkedPath,
          branch,
          ghSlug,
          subfolder,
          newBranch,
        } = JSON.parse(body) as {
          workspace?: string;
          address?: string;
          mode?: "dev-managed" | "managed";
          /** Absolute path to an existing local checkout (dev-managed from disk). */
          linkedPath?: string;
          branch?: string;
          /** GitHub slug (owner/repo) — present when cloning from GitHub. */
          ghSlug?: string;
          /** Optional subfolder within the workspace clone directory (dev-managed from GitHub). */
          subfolder?: string;
          /**
           * If set, clone at `branch` (base) then create this new local branch on top.
           * The workspace entry tracks `newBranch`, not `branch`.
           */
          newBranch?: string;
        };
        if (!address || !mode) return send400(res, "address and mode required");

        // Validate branch names against injection (used in git commands)
        const SAFE_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;
        if (branch && !SAFE_BRANCH_RE.test(branch))
          return send400(res, "invalid branch name");
        if (newBranch && !SAFE_BRANCH_RE.test(newBranch))
          return send400(res, "invalid newBranch name");
        // ghSlug is interpolated into the git clone URL — reject anything that
        // isn't a strict owner/repo slug to block shell/argument injection.
        if (ghSlug && !isRepoName(ghSlug))
          return send400(res, "invalid ghSlug");
        // subfolder is joined into the clone target path — reject traversal and
        // absolute paths so a clone can't escape the workspace directory.
        if (
          subfolder &&
          (!/^[a-zA-Z0-9._/-]+$/.test(subfolder) ||
            subfolder.split("/").includes("..") ||
            path.isAbsolute(subfolder))
        )
          return send400(res, "invalid subfolder");

        // Prefer explicit workspace name; fall back to focused workspace.
        const file = readWorkspacesFile();
        const wsName = workspace ?? file.focus ?? file.active[0];
        if (!wsName || !file.workspaces[wsName])
          return send400(res, `project "${wsName ?? ""}" not found`);

        let catalog = readCatalog();
        const { repoName } = parseAddress(address, catalog);
        // For new repos, parseAddress may not resolve correctly before the catalog entry
        // exists — fall back to using the address directly as the catalog key.
        const catalogKey = catalog[repoName] ? repoName : address;

        // Resolve where the repo lives on disk (or clone it if requested).
        let resolvedPath = linkedPath;
        if (!resolvedPath && ghSlug) {
          const leafName = address.includes("/")
            ? address.slice(address.lastIndexOf("/") + 1)
            : address;
          if (mode === "dev-managed") {
            // Always clone into den-workspaces/<wsName>/[subfolder/]<leafName>/
            const parts = [DEN_WORKSPACES_DIR, wsName];
            if (subfolder) parts.push(...subfolder.split("/").filter(Boolean));
            parts.push(leafName);
            const targetDir = path.join(...parts);
            resolvedPath = ensureDevManagedClone(
              targetDir,
              ghSlug,
              branch ?? "main",
            );
            // If the user requested a new local branch, create it on top of the clone.
            if (newBranch && resolvedPath) {
              execSync(`git checkout -b "${newBranch}"`, {
                cwd: resolvedPath,
                stdio: "ignore",
              });
            }
            // Setup is handled inside ensureDevManagedClone → runSetupIfDefined,
            // which opens a terminal window for interactive input.
          } else {
            // managed: clone into .den-services/<catalogKey>/
            if (newBranch) {
              // Clone at base branch, then create newBranch; dir is named after newBranch.
              ensureManagedServiceCloneNewBranch(
                catalogKey,
                ghSlug,
                branch ?? "main",
                newBranch,
              );
            } else {
              ensureManagedServiceClone(catalogKey, ghSlug, branch ?? "main");
            }
          }
        }

        if (!catalog[catalogKey]) {
          if (mode === "dev-managed" && (resolvedPath || ghSlug)) {
            upsertCatalogEntry(catalogKey, { gh: ghSlug ?? "" });
            catalog = readCatalog();
          } else if (mode === "managed" && ghSlug) {
            upsertCatalogEntry(catalogKey, { gh: ghSlug });
            catalog = readCatalog();
          } else {
            return send400(
              res,
              `"${catalogKey}" is not in the catalog — register it first`,
            );
          }
        }

        // If a new branch was created on top of the base, the workspace tracks it.
        const effectiveBranch = newBranch ?? branch ?? "main";
        // Preserve per-entry toggles (autostart) when re-adding/rewriting an
        // existing entry — rebuilding the literal from scratch silently drops
        // them otherwise.
        const prevEntry = file.workspaces[wsName].services[address];
        file.workspaces[wsName].services[address] = {
          mode,
          ...(mode === "dev-managed" && resolvedPath
            ? { path: resolvedPath }
            : {}),
          ...(mode === "managed" ? { branch: effectiveBranch } : {}),
          ...(prevEntry?.autostart === false ? { autostart: false } : {}),
        };
        writeWorkspacesFile(file);

        // Check if the newly added service has depends_on not covered by the workspace
        const missingDeps: string[] = [];
        try {
          const wsConfig = file.workspaces[wsName];
          const resolved = resolveServiceSource(
            address,
            wsName,
            wsConfig,
            catalog,
          );
          if (resolved) {
            const manifest = readManifest(resolved.repoPath);
            const { subsystem } = parseAddress(address, catalog);
            const deps = manifest?.services?.[subsystem]?.depends_on ?? [];
            const existingAddresses = new Set(Object.keys(wsConfig.services));
            for (const rawDep of deps) {
              const dep = depService(rawDep);
              const { repoName: depRepo } = parseAddress(dep, catalog);
              if (
                !existingAddresses.has(dep) &&
                !existingAddresses.has(depRepo)
              )
                missingDeps.push(dep);
            }
          }
        } catch {
          /* ignore — manifest may not exist yet for managed repos */
        }

        // Check if a setup command exists for the newly added service
        let setupStarted = false;
        try {
          const addedManifest = resolvedPath
            ? readManifest(resolvedPath)
            : null;
          const { subsystem: addedSubsystem } = parseAddress(address, catalog);
          const setupDef =
            addedManifest?.services?.[addedSubsystem]?.commands?.local?.setup;
          setupStarted = !!setupDef;
        } catch {
          /* ignore */
        }

        return sendJson(res, { ok: true, missingDeps, setupStarted });
      } catch (e) {
        return send400(res, `Invalid request: ${(e as Error).message}`);
      }
    }
    if (req.method === "DELETE") {
      try {
        const body = await readBody(req);
        const { workspace, address } = JSON.parse(body) as {
          workspace?: string;
          address?: string;
        };
        if (!address) return send400(res, "address required");

        // Prefer explicit workspace name; fall back to focused workspace.
        const file = readWorkspacesFile();
        const wsName = workspace ?? file.focus ?? file.active[0];
        if (!wsName || !file.workspaces[wsName])
          return send400(res, `project "${wsName ?? ""}" not found`);

        const services = file.workspaces[wsName].services;
        const catalog = readCatalog();
        // Delete exact match, or all subsystem entries for the repo
        // (handles both bare-key workspaces like "shop" and
        //  explicit-subsystem workspaces like "shop/api", "shop/db").
        // Removal is deliberate: top-up must never bring the repo back.
        recordRemovedFromWorkspace(
          file,
          wsName,
          parseAddress(address, catalog).repoName,
        );
        if (services[address] !== undefined) {
          delete services[address];
        } else {
          for (const key of Object.keys(services)) {
            if (parseAddress(key, catalog).repoName === address) {
              delete services[key];
            }
          }
        }
        writeWorkspacesFile(file);
        return sendJson(res, { ok: true });
      } catch (e) {
        return send400(res, `Invalid request: ${(e as Error).message}`);
      }
    }
  }

  // ── API: workspace settings ──────────────────────────────────────────────
  // GET  /api/workspaces/settings?workspace=<name>  → { editor,
  //        approvals_policy, approvals_watch, approvals_critical,
  //        hub_delivery_loop, hub_delivery_loop_extra }
  // POST /api/workspaces/settings  body: { workspace, editor?,
  //        approvals_policy?, approvals_watch?, approvals_critical?,
  //        hub_delivery_loop?, hub_delivery_loop_extra? }
  // Issue 158: hub_delivery_loop true | false | null (as the install).
  // Issue 160: the approvals_* are the project's approval policy
  // (workspaces.yml <project>.approvals), a person's only.
  if (pathname === "/api/workspaces/settings") {
    if (req.method === "GET") {
      const wsName =
        url.searchParams.get("workspace") ?? getActiveWorkspace()?.name;
      if (!wsName)
        return sendJson(res, {
          editor: null,
          ...projectApprovals(undefined),
          ...hubLoopFields(undefined),
        });
      const file = readWorkspacesFile();
      const ws = file.workspaces[wsName];
      return sendJson(res, {
        editor: ws?.editor ?? null,
        ...projectApprovals(ws?.approvals),
        ...hubLoopFields(ws),
        agents_max_per_project: ownAgentCap(ws),
      });
    }
    if (req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          workspace?: string;
          editor?: string | null;
          approvals_policy?: unknown;
          approvals_watch?: unknown;
          approvals_critical?: unknown;
          hub_delivery_loop?: unknown;
          hub_delivery_loop_extra?: unknown;
          agents_max_per_project?: unknown;
        };
        const wsName = body.workspace ?? getActiveWorkspace()?.name;
        if (!wsName) return send400(res, "a project is required");
        const file = readWorkspacesFile();
        const ws = file.workspaces[wsName];
        if (!ws) return send400(res, `Project "${wsName}" not found`);
        // Issue 158: the Hub delivery loop's setting is a person's too (an
        // agent never drops the loop from its own instructions).
        const policyKeys = (
          [
            "approvals_policy",
            "approvals_watch",
            "approvals_critical",
            "hub_delivery_loop",
            "hub_delivery_loop_extra",
            "agents_max_per_project",
          ] as const
        ).filter((k) => body[k] !== undefined);
        // Issue 160: the approval policy is a person's: an agent (or a
        // command-line token) asks with approval_policy instead. Issue
        // 158: the Hub delivery loop is a person's too, and no tool sets
        // it: a person changes it in Project setup.
        if (policyKeys.length && (agentPrincipalOf(req) || auditActorOf(req))) {
          const loop = policyKeys.some((k) =>
            k.startsWith("hub_delivery_loop"),
          );
          const cap = policyKeys.includes("agents_max_per_project");
          return sendJson(
            res,
            {
              ok: false,
              error: loop
                ? `only a person can change ${policyKeys.join(", ")}, in Project setup`
                : cap
                  ? `only a person can change ${policyKeys.join(", ")}: an agent asks with project_agent_cap`
                  : `only a person can change ${policyKeys.join(", ")}: an agent asks with approval_policy`,
            },
            403,
          );
        }
        if (body.editor === null || body.editor === "") {
          delete ws.editor;
        } else if (body.editor !== undefined) {
          if (!editors.isKnownEditor(body.editor))
            return send400(res, `Unknown editor "${body.editor}"`);
          ws.editor = body.editor;
        }
        if (
          body.hub_delivery_loop !== undefined ||
          body.hub_delivery_loop_extra !== undefined
        ) {
          const h = patchProjectHubLoop(
            ws as unknown as Record<string, unknown>,
            body,
          );
          if (!h.ok) return send400(res, h.error);
        }
        if (
          body.approvals_policy !== undefined ||
          body.approvals_watch !== undefined ||
          body.approvals_critical !== undefined
        ) {
          const a = patchApprovals(
            ws.approvals,
            {
              policy: body.approvals_policy,
              watch: body.approvals_watch,
              critical: body.approvals_critical,
            },
            `workspaces.${wsName}.approvals`,
          );
          if (!a.ok) return send400(res, a.error);
          if (a.value) ws.approvals = a.value;
          else delete ws.approvals;
        }
        if (body.agents_max_per_project !== undefined) {
          const v = body.agents_max_per_project;
          const bad = projectCapValueError(wsName, v);
          if (bad) return send400(res, bad);
          const agents = { ...(ws.agents ?? {}) };
          if (v === null || v === 0) delete agents.max_per_project;
          else agents.max_per_project = v;
          if (Object.keys(agents).length) ws.agents = agents;
          else delete ws.agents;
        }
        writeWorkspacesFile(file);
        return sendJson(res, {
          ok: true,
          editor: ws.editor ?? null,
          ...projectApprovals(ws.approvals),
          ...hubLoopFields(ws),
          agents_max_per_project: ownAgentCap(ws),
        });
      } catch (e) {
        return send400(res, `Invalid request: ${(e as Error).message}`);
      }
    }
  }

  // ── API: workspace dependency check ──────────────────────────────────────
  // Returns missing deps for each service in the specified (or active) workspace.
  if (pathname === "/api/workspaces/deps-check" && req.method === "GET") {
    const wsOverride = url.searchParams.get("workspace");
    const wsFile = wsOverride ? readWorkspacesFile() : null;
    const ws =
      wsOverride && wsFile?.workspaces[wsOverride]
        ? { name: wsOverride, config: wsFile!.workspaces[wsOverride] }
        : getActiveWorkspace();
    if (!ws) return sendJson(res, []);
    const catalog = readCatalog();
    return sendJson(res, computeMissingDeps(ws.config, catalog, ws.name));
  }

  // ── API: derived dependency graph ─────────────────────────────────────────
  // Returns the derived system dependency graph as JSON (same engine the CLI
  // `den graph` and derived `up`/`down` use). Optional ?seed=<repo> returns
  // that repo's closure; otherwise the full known-systems graph.
  if (pathname === "/api/graph" && req.method === "GET") {
    const seed = url.searchParams.get("seed") ?? undefined;
    // A repo name resolves to a different checkout (or to nothing) per
    // workspace, so the caller says which workspace it is rendering. Any
    // workspace may be graphed — reading a graph doesn't require activation.
    const wsParam = url.searchParams.get("workspace") ?? undefined;
    if (wsParam && !getWorkspaceByName(wsParam))
      return send400(res, `unknown project "${wsParam}"`);
    try {
      const graph = seed
        ? deriveGraph({ scope: "closure", seed, workspace: wsParam })
        : deriveGraph({ scope: "all", workspace: wsParam });
      // Include the canonical startup order (infra-stack first … entry repo
      // last) so the web can lay the graph out along the real dependency flow,
      // breaking soft/event back-call cycles the same way `den up` does.
      return sendJson(res, { ...graph, order: orderForUp(graph) });
    } catch (e) {
      return send400(res, `graph derivation failed: ${(e as Error).message}`);
    }
  }

  // ── API: applications ─────────────────────────────────────────────────────
  // Org > Application > Repo > Services for a workspace — same as
  // `den apps --json` — with each application's service addresses for
  // the UI's per-application up/down/restart. No `workspace` = the focused one.
  if (pathname === "/api/applications" && req.method === "GET") {
    const wsParam = url.searchParams.get("workspace") ?? undefined;
    if (wsParam && !getWorkspaceByName(wsParam))
      return send400(res, `unknown project "${wsParam}"`);
    try {
      return sendJson(res, loadApplicationTree(wsParam));
    } catch (e) {
      return send400(res, `applications failed: ${(e as Error).message}`);
    }
  }

  // ── API: workspace-level command (SSE) ───────────────────────────────────
  // Runs a command (up/down/restart/setup) on all services in the active
  // workspace in DERIVED dependency order, streaming labeled output as SSE events.
  if (pathname === "/api/workspace/exec") {
    if (!readMethodOnly(req, res)) return;
    const cmd = url.searchParams.get("cmd");
    if (!cmd) return send400(res, "cmd required");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Client disconnect cleanup — set when the browser closes the SSE stream
    // (tab close, navigation, refresh mid-operation). The flag is polled by
    // the sequential runner and the readiness poller so in-flight work bails
    // out instead of writing to a dead socket and leaking descriptors.
    let cancelled = false;
    let activeProc: ReturnType<typeof runServiceCommand>["proc"] | null = null;
    let activeDetachTimer: ReturnType<typeof setTimeout> | null = null;
    req.on("close", () => {
      cancelled = true;
      if (activeDetachTimer !== null) {
        clearTimeout(activeDetachTimer);
        activeDetachTimer = null;
      }
      if (activeProc) {
        try {
          activeProc.kill();
        } catch {
          /* already exited */
        }
        activeProc = null;
      }
    });

    // LK-0: a service's sudo without the password is a needs-sudo event,
    // naming the command and the service (the last label).
    const emit = watchSudo((obj: unknown): void => {
      if (cancelled) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        // Socket closed mid-write — mark cancelled so subsequent loops bail.
        cancelled = true;
      }
    });

    const wsParam = url.searchParams.get("workspace");
    if (wsParam && !isWorkspaceActive(wsParam)) {
      emit({
        type: "error",
        text: `Project "${wsParam}" is not active — activate it first`,
      });
      emit({ type: "done", exitCode: 1, duration: 0 });
      res.end();
      return;
    }
    const ws = wsParam ? getWorkspaceByName(wsParam) : getActiveWorkspace();
    if (!ws) {
      emit({ type: "error", text: "No active project" });
      emit({ type: "done", exitCode: 1, duration: 0 });
      res.end();
      return;
    }

    const catalog = readCatalog();
    // Modules and libraries have no runtime: never started or stopped.
    const inProject = listWorkspaceServices(ws.config, catalog, ws.name);
    const allServices = inProject.filter((s) => repoHasRuntime(s.repoPath));
    if (allServices.length === 0) {
      // Issue 277: a project whose repos all run nothing (config, docs,
      // shared CI) has nothing to run, and that is not an error.
      if (inProject.length > 0) {
        emit({
          type: "line",
          text: `Nothing to run: no repo in this project has a runtime of its own (${[...new Set(inProject.map((s) => s.repoName))].join(", ")})`,
        });
        emit({ type: "done", exitCode: 0, duration: 0 });
      } else {
        emit({ type: "error", text: "No services in active project" });
        emit({ type: "done", exitCode: 1, duration: 0 });
      }
      res.end();
      return;
    }

    // Optional comma-separated address filter — used by workspace switching
    // to target only the services that differ between workspaces.
    const addressFilter = url.searchParams.get("addresses");
    const addressSet = addressFilter
      ? new Set(addressFilter.split(",").map((a) => a.trim()))
      : null;
    // For a workspace-wide STARTING command (up/restart, no explicit address
    // filter) exclude systems whose auto-start is toggled off (`autostart:
    // false` on the workspace entry). Down still stops them — the toggle only
    // governs starting. An explicit address filter is a deliberate target, so
    // the toggle is bypassed there.
    const startingCmd = cmd === "up" || cmd === "restart";
    const noAutostart = startingCmd
      ? noAutostartRepos(ws.config, catalog)
      : new Set<string>();

    // `seed=<repo>` — "up with deps": start that system AND its dependency
    // closure. Derived HERE rather than by the client sending an address list,
    // for two reasons: startClosure's positional rule (everything strictly
    // below the seed in the start order, never above) is load-bearing, and the
    // two behaviours this mode needs — "already healthy → skip" and the
    // auto-start-off toggle — are both gated on there being no explicit
    // address filter, so no amount of client-side expansion could reach them.
    const seedRepo =
      startingCmd || cmd === "down" ? url.searchParams.get("seed") : null;
    let closureRepos: Set<string> | null = null;
    if (seedRepo && cmd === "down") {
      // Symmetric with "up with deps": the SAME closure, torn down in reverse.
      // What you started together you stop together — the alternative (walking
      // to dependents instead) means the two menu items operate on different
      // sets, which is not what the pairing promises.
      //
      // The exec route already reverses the rank sort for `down`, so the seed
      // stops first and its foundations last.
      const graph = deriveGraph({ scope: "all", workspace: ws.name });
      const { order } = deriveStartTargets(graph, seedRepo);
      closureRepos = new Set(order);
      emit({
        type: "line",
        text: `${seedRepo}: stopping with dependencies — ${[...order].reverse().join(" → ")}`,
      });

      // Stopping shared foundations can break systems OUTSIDE this closure that
      // are still running on them (infra-stack underpins most of the fleet).
      // Name them rather than letting them fall over silently.
      const atRisk = new Set<string>();
      for (const e of graph.edges) {
        if (e.kind === "jwks" || e.ordering === false) continue;
        if (!closureRepos.has(e.to) || closureRepos.has(e.from)) continue;
        if (allServices.some((s) => s.repoName === e.from)) atRisk.add(e.from);
      }
      if (atRisk.size > 0) {
        emit({
          type: "line",
          text: `⚠ also depends on what this stops: ${[...atRisk].sort().join(", ")} — stop or restart them if they misbehave`,
        });
      }

      const missing = order.filter(
        (r) => !allServices.some((s) => s.repoName === r),
      );
      if (missing.length > 0) {
        emit({
          type: "line",
          text: `Not in this project, skipping: ${missing.join(", ")}`,
        });
      }
    } else if (seedRepo) {
      // Positional closure: everything the seed sits ON TOP OF, never anything
      // above it. Includes tolerant deps that rank below (an event consumer the
      // graph already draws underneath) and excludes tolerant deps that rank
      // above (a soft http call up the stack). See startClosure.
      const { order } = deriveStartTargets(
        deriveGraph({ scope: "all", workspace: ws.name }),
        seedRepo,
      );
      if (order.length === 0) {
        emit({
          type: "error",
          text: `${seedRepo} has no derived dependency closure — is it in this project?`,
        });
        emit({ type: "done", exitCode: 1, duration: 0 });
        res.end();
        return;
      }
      // A system the user switched auto-start OFF is still skipped here — but
      // never the seed, which is what they just clicked. Mirrors `den up
      // <repo>` (cli/index.ts).
      const policy = filterClosureForStart(order, seedRepo, noAutostart);
      closureRepos = new Set(policy.start);
      const offInClosure = policy.skippedOff;
      emit({
        type: "line",
        text: `${seedRepo}: starting with dependencies — ${[...closureRepos].join(" → ")}`,
      });
      if (offInClosure.length > 0) {
        emit({
          type: "line",
          text: `Skipping (auto-start off): ${offInClosure.join(", ")} (toggle in the card ⋮ menu)`,
        });
      }
      const missing = [...closureRepos].filter(
        (r) => !allServices.some((s) => s.repoName === r),
      );
      if (missing.length > 0) {
        emit({
          type: "line",
          text: `Not in this project, skipping: ${missing.join(", ")}`,
        });
      }
    }

    const skippedOff: string[] = [];
    const addresses = allServices
      .map((s) => s.address)
      .filter((a) => {
        if (addressSet) return addressSet.has(a);
        const repoName = parseAddress(a, catalog).repoName;
        // Closure membership already applied the auto-start rule above, with
        // the seed exempted — don't re-apply it and drop the seed.
        if (closureRepos) return closureRepos.has(repoName);
        if (noAutostart.has(repoName)) {
          skippedOff.push(a);
          return false;
        }
        return true;
      });

    if (skippedOff.length > 0) {
      emit({
        type: "line",
        text: `Skipping (auto-start off): ${skippedOff.join(", ")} (toggle in the card ⋮ menu, or start from its tab)`,
      });
    }

    if (addresses.length === 0) {
      emit({ type: "done", exitCode: 0, duration: 0 });
      res.end();
      return;
    }

    let ordered: string[];
    try {
      // Order by the DERIVED dependency graph (hard edges first) instead of
      // hand-written .den.yml depends_on — manifests are unreliable. We rank
      // each workspace address by its repo's position in the derived order.
      const rank = new Map(
        orderForUp(deriveGraph({ scope: "all", workspace: ws.name })).map(
          (repo, i) => [repo, i],
        ),
      );
      const rankOf = (addr: string): number =>
        rank.get(parseAddress(addr, catalog).repoName) ??
        Number.MAX_SAFE_INTEGER;
      const sorted = [...addresses].sort((a, b) => rankOf(a) - rankOf(b));
      ordered = cmd === "down" ? sorted.reverse() : sorted;
    } catch (e) {
      emit({ type: "error", text: (e as Error).message });
      emit({ type: "done", exitCode: 1, duration: 0 });
      res.end();
      return;
    }

    // waitThenStart below blocks on a service's `wait: true` deps' health
    // before running its command — but for a SAME-REPO dep, the only thing
    // that makes it healthy is its own `up`. Prepend failing same-repo
    // wait-deps so the wait has something to wait FOR.
    //
    // This runs for whole-workspace starts too, not just explicit addresses
    // (#68): ranking is per REPO, so every subsystem of a repo ties and falls
    // back to manifest order — a manifest that lists a dependent before its
    // dependency deadlocked a plain `up` exactly the same way. Being correct
    // here rather than relying on file order costs nothing when the manifest
    // already reads deps-first: such deps are already queued and are filtered
    // out before any probe runs.
    if (startingCmd) {
      // Resolve/probe lazily and memoize — this now runs on every workspace
      // up, and the naive version re-read each repo's manifest once per
      // subsystem.
      const resolvedCache = new Map<string, ResolvedService | null>();
      const resolveCached = (addr: string): ResolvedService | null => {
        if (!resolvedCache.has(addr))
          resolvedCache.set(addr, resolveService(addr, ws.name));
        return resolvedCache.get(addr) ?? null;
      };
      const waitDepsCache = new Map<string, string[]>();
      let announced = false;
      try {
        const expansion = await expandSameRepoWaitDeps(ordered, {
          repoOf: (addr) => parseAddress(addr, catalog).repoName,
          waitDepsOf: (addr) => {
            if (!waitDepsCache.has(addr))
              waitDepsCache.set(
                addr,
                getWaitDeps(addr, catalog, ws.config, ws.name),
              );
            return waitDepsCache.get(addr) ?? [];
          },
          // Two address spellings can name ONE service (a bare repo name and
          // `repo/entrypoint`, or a `repo/repo` dep). Collapsing them on repo +
          // subsystem is what stops such a dep being treated as missing and
          // started a second time.
          identityOf: (addr) => {
            const r = resolveCached(addr);
            return r ? `${r.repoName}/${r.subsystem}` : addr;
          },
          isFailing: async (addr) => {
            if (cancelled) return false; // client gone — stop probing
            const depResolved = resolveCached(addr);
            if (!depResolved) return false;
            // Announce on the FIRST real probe only: when every manifest
            // already reads deps-first nothing is probed, and an unconditional
            // line would print on every workspace up for nothing.
            if (!announced) {
              announced = true;
              emit({ type: "line", text: "checking dependency health…" });
            }
            const h = await checkServiceHealth(depResolved, "local");
            return h.health === "error";
          },
        });
        // ALWAYS take the expansion's order. It both ADDS deps and REORDERS
        // deps-first, and those are independent: when every failing dep was
        // already in the explicit list, `added` is empty while the reorder is
        // exactly what prevents the deadlock. Gating this on `added` would
        // keep the fix for one path and drop it for the other.
        ordered = expansion.ordered;
        if (expansion.added.length > 0) {
          // `cmd` is global to the run, so an added dep inherits it — on
          // `restart` it is taken DOWN and re-upped, not merely started. Say so.
          const verb = cmd === "restart" ? "Restarting" : "Starting";
          emit({
            type: "line",
            text: `${verb} required same-system dependencies first: ${expansion.added.join(", ")}`,
          });
        }
      } catch (e) {
        // Degrade to the unexpanded order rather than killing a start the user
        // asked for: this block awaits manifest reads and health probes, and an
        // uncaught throw here would unwind past the SSE `done` event, hanging
        // the run pane instead of failing it.
        emit({
          type: "line",
          text: `⚠ could not expand dependencies (${(e as Error).message}) — starting as requested`,
        });
      }
    }

    // Setup runs once per repo, on its entrypoint — not once per subsystem.
    // Several manifests declare `setup` on multiple services (e.g. shop/db AND
    // shop/api), so the fan-out ran `make setup` repeatedly per repo; each run
    // also dirties the managed clone (codegen), which blocks `git pull` on sync.
    // Workspace-wide (no address filter) setup also targets MANAGED
    // clones only — setup mutates a checkout with codegen/installs, which is
    // uninvited in an engineer's own dev-managed repo. An explicit address
    // (card ⋮ setup) still runs regardless of mode.
    if (cmd === "setup") {
      const chosenByRepo = new Map<string, string>();
      const skippedDev: string[] = [];
      for (const addr of ordered) {
        // In this route's project, not the focused one (issue 235).
        const r = resolveService(addr, ws.name);
        if (!r) continue;
        if (!addressSet && r.mode === "dev-managed") {
          const repoName = parseAddress(addr, catalog).repoName;
          if (!skippedDev.includes(repoName)) skippedDev.push(repoName);
          continue;
        }
        const m = readManifest(r.repoPath);
        const hasSetup =
          "setup" in (m?.services?.[r.subsystem]?.commands?.local ?? {});
        if (!hasSetup) continue;
        const repoName = parseAddress(addr, catalog).repoName;
        const isEntry = m?.entrypoint ? r.subsystem === m.entrypoint : false;
        if (isEntry || !chosenByRepo.has(repoName))
          chosenByRepo.set(repoName, addr);
      }
      const keep = new Set(chosenByRepo.values());
      ordered = ordered.filter((addr) => keep.has(addr));
      if (skippedDev.length > 0) {
        emit({
          type: "line",
          text: `Skipping dev-managed (your own checkouts): ${skippedDev.join(", ")} — run setup from each card's ⋮ menu to include one`,
        });
      }
    }

    const startTime = Date.now();
    let overallExit = 0;
    let ranCount = 0;
    // R16: each started service's resolved secret_env, by position in
    // `ordered`. Resolved before a restart's down, so a missing key leaves
    // the service running; the values only go into the runner's spawn env.
    const preparedSecrets = new Map<number, Record<string, string>>();

    // Run services sequentially in dependency order
    const runNext = (i: number): void => {
      if (cancelled) {
        // Client disconnected — drop further work silently. res.end() on a
        // dead socket is a no-op; don't emit anything that could retrigger
        // the try/catch guard in `emit`.
        try {
          res.end();
        } catch {
          /* already closed */
        }
        return;
      }
      if (i >= ordered.length) {
        if (ranCount === 0) {
          emit({
            type: "line",
            text: `No services in this project have a "${cmd}" command.`,
          });
        }
        emit({
          type: "done",
          exitCode: overallExit,
          duration: Date.now() - startTime,
        });
        res.end();
        return;
      }

      const address = ordered[i];

      // Resolve service once — reused for both the skip check and the run.
      const resolved = resolveService(address, ws.name);
      const svcRepoName = resolved?.repoName ?? address;
      const svcSubsystem = resolved?.subsystem ?? address;

      // Pre-check: skip services that don't have the requested command.
      // `down` is always attempted — it's opctl-conventional (stops running
      // containers with no declared command) and no-ops gracefully otherwise.
      // `restart` is orchestrated as down → verify → up, so it only needs `up`.
      if (resolved) {
        // A managed repo that was never cloned has no manifest, so it
        // fails the has-command check below and used to be dropped silently —
        // leaving "no services have an up command" as the only feedback on a
        // fresh install. Call it out and point at the control that fixes it.
        if (resolved.mode === "managed" && !fs.existsSync(resolved.repoPath)) {
          emit({
            type: "line",
            text: `  ${address}: not cloned yet — run Sync to clone it, then retry ${cmd}`,
          });
          runNext(i + 1);
          return;
        }
        // Same gate as the sync chain: never START a service whose declared
        // local secrets are still unset — placeholders bake themselves into
        // database volumes at first init. `down` is always allowed.
        if (cmd === "up" || cmd === "restart") {
          const secrets = checkRepoSecrets(resolved.repoPath);
          if (secrets && !secrets.ok) {
            for (const line of describeSecretsCheck(
              resolved.repoName,
              secrets,
            )) {
              emit({ type: "line", text: `  ${line}` });
            }
            runNext(i + 1);
            return;
          }
        }
        // R13: a remote service is part of the app but never run from here.
        const remote = placementRefusal(
          address,
          servicePlacement(
            readManifest(resolved.repoPath),
            resolved.subsystem,
            "local",
          ),
          () => false,
          cmd,
        );
        if (remote) {
          emit({ type: "line", text: `  ${remote}` });
          runNext(i + 1);
          return;
        }
        const svcCmds = localCommandsFor(resolved, ws.name);
        const hasCmd =
          cmd === "down" ||
          Object.prototype.hasOwnProperty.call(svcCmds, cmd) ||
          (cmd === "restart" &&
            Object.prototype.hasOwnProperty.call(svcCmds, "up"));
        if (!hasCmd) {
          runNext(i + 1);
          return;
        }
      }

      if ((cmd === "up" || cmd === "restart") && !preparedSecrets.has(i)) {
        void (async () => {
          // Phase 2 of a restart is a true `up`, so resolve for that.
          const r = await prepareServiceSecretEnv(address, "up", ws.name);
          if (cancelled) return;
          if (!r.ok) {
            ranCount++;
            overallExit = 1;
            emit({ type: "label", text: address });
            emit({ type: "error", text: r.message });
            emit({
              type: "svc-done",
              address,
              exitCode: 1,
              repoName: svcRepoName,
              subsystem: svcSubsystem,
            });
            runNext(i + 1);
            return;
          }
          preparedSecrets.set(i, r.secretEnv);
          runNext(i);
        })();
        return;
      }

      ranCount++;

      emit({ type: "label", text: address });

      // detachFired: true once the detach timer fires so onClose can return early
      // and not emit a duplicate svc-done after the timer kills the tail proc.
      let detachFired = false;
      let detachTimer: ReturnType<typeof setTimeout> | null = null;
      let didRunNext = false;
      const safeRunNext = (n: number) => {
        if (!didRunNext) {
          didRunNext = true;
          runNext(n);
        }
      };

      const doStart = (): void => {
        prewarmSudo();
        const startCmd = cmd === "restart" ? "up" : cmd;
        const { proc, detachable, interactive } = runServiceCommand({
          address,
          // restart is orchestrated: phase 1 (down + verify) already ran, so
          // phase 2 is a TRUE `up` — full detach/tail/readiness semantics —
          // instead of the old single-shell "down && up" synthesis.
          command: startCmd,
          workspace: ws.name,
          // Web-triggered ups always daemonize so output streams into the
          // browser log pane. `cli_tabs` only affects the CLI (`den up
          // --tabs`); opening Terminal.app from a button the user clicked in
          // the UI just hides the command they came here to watch.
          runtime: "daemon",
          env: getSudoEnv(),
          secretEnv: preparedSecrets.get(i),
          onLine: (line) => emit({ type: "line", text: line }),
          onClose: (exitCode) => {
            // Release outer-scope refs so the disconnect handler no longer
            // tries to kill a process/timer that's already gone.
            if (activeProc === proc) activeProc = null;
            if (detachFired) return; // detach timer already emitted svc-done for this service
            // Command finished before the detach window — cancel the timer and complete normally.
            if (detachTimer !== null) {
              clearTimeout(detachTimer);
              // Clear the shared ref BEFORE nulling the local, otherwise the
              // comparison is always false and activeDetachTimer stays stale.
              if (activeDetachTimer === detachTimer) activeDetachTimer = null;
              detachTimer = null;
            }
            if (exitCode !== 0) overallExit = exitCode;
            emit({
              type: "svc-done",
              address,
              exitCode,
              repoName: svcRepoName,
              subsystem: svcSubsystem,
            });
            safeRunNext(i + 1);
          },
        });

        // Track current proc so req.on('close') can kill it on disconnect.
        activeProc = proc;

        if (interactive) {
          // Can't run interactive commands over HTTP — skip with guidance
          emit({
            type: "error",
            text: `${address}: requires interactive terminal — run: ${product().cli} setup ${address}`,
          });
          safeRunNext(i + 1);
          return;
        }

        if (detachable && (cmd === "up" || cmd === "restart")) {
          detachTimer = setTimeout(() => {
            detachFired = true;
            detachTimer = null;
            activeDetachTimer = null;
            try {
              proc.kill();
            } catch {
              /* tail may have already exited */
            }
            emit({
              type: "svc-done",
              address,
              exitCode: 0,
              detached: true,
              repoName: svcRepoName,
              subsystem: svcSubsystem,
            });
            safeRunNext(i + 1);
          }, DETACH_WINDOW_MS);
          activeDetachTimer = detachTimer;
        }
      };

      const waitThenStart = (): void => {
        // Before starting an up/restart, block on any `wait: true` deps until
        // their health check is green. Default (no flagged deps) → doStart() now.
        if (cmd === "up" || cmd === "restart") {
          const waitDeps = getWaitDeps(address, catalog, ws.config, ws.name);
          if (waitDeps.length > 0) {
            void (async () => {
              for (const depAddr of waitDeps) {
                if (cancelled) return;
                // In this route's project, not the focused one (issue 235).
                const depResolved = resolveService(depAddr, ws.name);
                if (!depResolved) {
                  emit({
                    type: "line",
                    text: `⚠ wait dep ${depAddr} not resolvable — skipping readiness check`,
                  });
                  continue;
                }
                emit({
                  type: "line",
                  text: `waiting for ${depAddr} to be ready…`,
                });
                const result = await waitForReady(depResolved, "local", {
                  onTick: (detail) =>
                    emit({ type: "line", text: `  ${depAddr}: ${detail}` }),
                  isCancelled: () => cancelled,
                });
                if (cancelled) return;
                if (!result.ok) {
                  emit({
                    type: "error",
                    text: `timed out waiting for ${depAddr} after ${Math.round(result.elapsedMs / 1000)}s: ${result.detail ?? "not ready"}`,
                  });
                  overallExit = 1;
                  emit({
                    type: "svc-done",
                    address,
                    exitCode: 1,
                    repoName: svcRepoName,
                    subsystem: svcSubsystem,
                  });
                  safeRunNext(i + 1);
                  return;
                }
                emit({
                  type: "line",
                  text: result.skipped
                    ? `${depAddr}: no health check configured — proceeding`
                    : `${depAddr} ready (${Math.round(result.elapsedMs / 1000)}s)`,
                });
              }
              if (cancelled) return;
              doStart();
            })();
            return;
          }
        }

        doStart();
      };

      // Workspace-wide runs consult LIVE state before acting (matches the
      // CLI's derived-up `skipHealthyAll` behavior). An explicit address
      // filter is a deliberate target and bypasses these checks:
      //  - up: a service that already answers its health check is left alone
      //  - down: a service with no running containers and no healthy probe
      //    is already stopped — running its down script is pointless noise
      if (!addressSet && resolved && (cmd === "up" || cmd === "down")) {
        void (async () => {
          if (cmd === "up") {
            const health = await checkServiceHealth(resolved, "local");
            if (cancelled) return;
            // `conflict`: a shared stack namespace runs another checkout's
            // project; the real up refuses it, naming both.
            const claim =
              health.health === "ok"
                ? claimHealthyService(resolved, ws.name, (text) =>
                    emit({ type: "line", text }),
                  )
                : "untracked";
            // Another process answers on its port (said above): nothing is
            // claimed and nothing started on top of it (0.3.0-dev.39).
            if (health.health === "ok" && claim === "busy") {
              overallExit = 1;
              emit({
                type: "svc-done",
                address,
                exitCode: 1,
                repoName: svcRepoName,
                subsystem: svcSubsystem,
              });
              safeRunNext(i + 1);
              return;
            }
            if (health.health === "ok" && claim !== "conflict") {
              // Skipping must not lose the refcount — this workspace is an
              // owner of what's running, whether den tracked it or not.
              emit({
                type: "line",
                text:
                  `${address} already healthy — skipping up` +
                  (claim === "adopted"
                    ? " (adopted its running containers)"
                    : claim === "attached"
                      ? ` (owned by "${ws.name}" too)`
                      : ""),
              });
              emit({
                type: "svc-done",
                address,
                exitCode: 0,
                skipped: true,
                repoName: svcRepoName,
                subsystem: svcSubsystem,
              });
              safeRunNext(i + 1);
              return;
            }
          } else {
            // A pre-dev.37 record is settled before the skip decides
            // (0.3.0-dev.39): adopted, it is running; stale, it is dropped.
            settledDaemonRecord(resolved, ws.name, (text) =>
              emit({ type: "line", text }),
            );
            let running = hasRunningOpctlContainers(resolved);
            if (!running) {
              // Not opctl-visible but still responding (host-run process)?
              // Then it IS running — proceed with the down.
              const h = await checkServiceHealth(resolved, "local");
              running = h.health === "ok";
            }
            if (cancelled) return;
            if (!running) {
              emit({
                type: "line",
                text: `${address} already stopped — skipping down`,
              });
              emit({
                type: "svc-done",
                address,
                exitCode: 0,
                skipped: true,
                repoName: svcRepoName,
                subsystem: svcSubsystem,
              });
              safeRunNext(i + 1);
              return;
            }
          }
          waitThenStart();
        })();
        return;
      }

      // Restart = orchestrated down → VERIFY → up. Phase 1 stops the service
      // (opctl-aware; "nothing to stop" counts as success) and only proceeds to
      // the up when the down actually succeeded — the old single-shell
      // "down && up" synthesis required both commands declared in the manifest
      // and gave no verification point. An already-stopped service skips the
      // down phase entirely (running its manifest `down` while stopped is
      // pointless and often exits non-zero).
      if (cmd === "restart") {
        void (async () => {
          let alreadyDown = resolved
            ? !hasRunningOpctlContainers(resolved)
            : false;
          if (alreadyDown && resolved) {
            // Not opctl-visible but still responding (non-opctl process)?
            // Then it IS running — go through the down phase.
            const h = await checkServiceHealth(resolved, "local");
            if (h.health === "ok") alreadyDown = false;
          }
          if (cancelled) return;
          if (alreadyDown) {
            emit({
              type: "line",
              text: "── already stopped — starting up ──",
            });
            waitThenStart();
            return;
          }

          emit({ type: "line", text: "── restart: stopping ──" });
          prewarmSudo();
          const { proc: downProc } = runServiceCommand({
            address,
            command: "down",
            workspace: ws.name,
            env: getSudoEnv(),
            onLine: (line) => emit({ type: "line", text: line }),
            onClose: (downExit) => {
              if (activeProc === downProc) activeProc = null;
              if (cancelled) {
                try {
                  res.end();
                } catch {
                  /* already closed */
                }
                return;
              }
              if (downExit !== 0) {
                overallExit = downExit;
                emit({
                  type: "error",
                  text: `${address}: down failed (exit ${downExit}) — aborting restart`,
                });
                emit({
                  type: "svc-done",
                  address,
                  exitCode: downExit,
                  repoName: svcRepoName,
                  subsystem: svcSubsystem,
                });
                safeRunNext(i + 1);
                return;
              }
              emit({ type: "line", text: "── down ✓ — starting up ──" });
              waitThenStart();
            },
          });
          activeProc = downProc;
        })();
        return;
      }

      waitThenStart();
    };

    runNext(0);
    return;
  }

  // ── API: workspace sync (SSE) ─────────────────────────────────────────────
  /**
   * Run one command for a managed service, streaming its output into
   * the sync SSE. Resolves true on exit 0. No manifest pre-gating: the runner
   * itself owns command semantics (conventional `down` works with nothing
   * declared; a genuinely missing command surfaces as its error output).
   *
   * Detachable commands report on tail-detach rather than on health, so their
   * success line says "started" and the health dot carries the truth from
   * there. Sync itself only uses this for `down` — it never starts anything.
   */
  async function runManagedStep(
    address: string,
    repoName: string,
    command: string,
    emit: (o: unknown) => void,
    isCancelled: () => boolean,
  ): Promise<boolean> {
    // LK-0: this step's sudo without the password is a needs-sudo event.
    emit = watchSudo(emit, `${repoName} ${command}`);
    emit({ type: "line", text: `  ${repoName}: ${command}…` });
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let detached = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const result = runServiceCommand({
          address,
          command,
          // The sudo shim (LK-0): the password when one is held, else a
          // needs-sudo line instead of a prompt nobody can answer.
          env: getSudoEnv(),
          onLine: (line) => {
            if (!isCancelled()) emit({ type: "line", text: `    ${line}` });
          },
          onClose: (code) => {
            // For a detachable command the tail was likely killed by the
            // detach timer below — that close is bookkeeping, not a verdict.
            if (settled) return;
            if (code === 0) {
              emit({
                type: "line",
                text: detached
                  ? `  ${repoName}: ${command} started (running in background)`
                  : `  ${repoName}: ${command} ✓`,
              });
            } else {
              emit({
                type: "line",
                text: `  ${repoName}: ${command} failed (exit ${code})`,
              });
            }
            done(code === 0);
          },
        });
        // onClose is never invoked synchronously (see runServiceCommand), so
        // this assignment always lands before the wording above is needed.
        detached = result.detachable;
        if (result.detachable) {
          // Daemon tails stream INDEFINITELY — that's the live-log feature the
          // card exec route is built on, so onClose never fires on success and
          // this promise would never resolve (the first live run held the sync
          // stream open forever). Give the tail a detach window to surface
          // early crash output, then declare the service started, stop the
          // tail, and let the health dot carry the truth from here.
          setTimeout(() => {
            if (settled) return;
            try {
              result.proc.kill();
            } catch {
              /* tail may already be gone */
            }
            emit({
              type: "line",
              text: `  ${repoName}: ${command} started (detached — output continues in the service log)`,
            });
            done(true);
          }, DETACH_WINDOW_MS);
        }
      } catch (e) {
        emit({
          type: "line",
          text: `  ${repoName}: ${command} error — ${(e as Error).message}`,
        });
        done(false);
      }
    });
  }

  if (pathname === "/api/workspace/sync") {
    // The page streams it with GET; the MCP sync tool calls it with POST.
    if (!readMethodOnly(req, res, ["POST"])) return;
    const syncWhy = agentFocusRefusal(
      req,
      getActiveWorkspace()?.name,
      "this syncs",
    );
    if (syncWhy)
      return sendJson(
        res,
        { ok: false, code: "agent_forbidden", error: syncWhy },
        403,
      );
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let cancelled = false;
    req.on("close", () => {
      cancelled = true;
    });

    const emit = (obj: unknown): void => {
      if (cancelled) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        cancelled = true;
      }
    };

    const ws = getActiveWorkspace();
    if (!ws) {
      emit({ type: "error", text: "No active project" });
      emit({ type: "done" });
      res.end();
      return;
    }

    const catalog = readCatalog();
    const services = listWorkspaceServices(ws.config, catalog, ws.name);
    // Optional ?repo=<name> syncs a single system (the card's ⟳ sync action);
    // omitted syncs the whole workspace (the master ⟳ Sync button).
    const onlyRepo = url.searchParams.get("repo");
    // Only managed clones, deduplicated by path; never a dev-managed checkout
    // (see sync-targets.ts), and a refusal is said out loud.
    const { targets, refused } = selectSyncTargets(services, {
      onlyRepo,
      devManaged: devManagedPaths(readWorkspacesFile()),
    });
    for (const r of refused)
      emit({
        type: "line",
        text: `  ${r.repoName}: not synced — ${r.reason}`,
      });
    recordAction(
      auditActorOf(req),
      {
        verb: "sync",
        detail: `${ws.name}${onlyRepo ? ` · repo=${onlyRepo}` : ""} · ${targets.length} managed repo(s)`,
      },
      principalOf(req),
    );

    if (targets.length === 0) {
      // Distinguish "you asked for a repo we can't sync" from "nothing to do",
      // so a stale card or a dev-managed repo doesn't look like a silent no-op.
      emit({
        type: "line",
        text: onlyRepo
          ? `No managed repo named "${onlyRepo}" in this project — nothing to sync.`
          : "No managed services to sync.",
      });
      emit({ type: "done" });
      res.end();
      return;
    }

    emit({
      type: "line",
      text: onlyRepo
        ? `Checking ${onlyRepo} for updates…\n`
        : `Checking ${targets.length} managed repo(s) for updates…\n`,
    });

    // Repos other repos read shared config from — a failure in one of these
    // must stop the chain, not just skip it (see the gates below).
    const providerRepos = serviceEnvProviderRepos();

    for (const svc of targets) {
      if (cancelled) break;
      emit({ type: "line", text: `  ${svc.repoName}  checking…` });
      // A sync chain that started (pull landed) but didn't finish (setup or up
      // failed / was interrupted) leaves the clone new and its environment or
      // run-state old. Without a marker the next sync sees behind=0, says
      // "up to date", and the service stays broken with no way back from this
      // button — which is exactly what happened the first time this ran. The
      // marker spans the WHOLE chain: written when we commit to it, cleared
      // only after `up` succeeds.
      const pendingMarker = path.join(
        svc.repoPath,
        `.${product().name}-setup-pending`,
      );
      const chainPending = fs.existsSync(pendingMarker);
      // A managed repo that was never cloned can't be checked, let
      // alone pulled — and syncing it IS the intent, so it bootstraps below
      // (down → clone → setup) instead of reporting "no upstream".
      const cloneExists = fs.existsSync(svc.repoPath);
      let behind = 0;
      if (cloneExists) {
        // Async spawn-based git so the event loop stays responsive — inline
        // execSync here previously froze the whole server for the duration of
        // each `git fetch` (5-30s per repo over VPN).
        const chk = await checkManagedCloneBehind(
          svc.repoPath,
          () => cancelled,
        );
        if (cancelled || chk.cancelled) break;
        if (chk.behind === -1) {
          emit({
            type: "line",
            text: `  ${svc.repoName}: no upstream — skipping`,
          });
          continue;
        }
        behind = chk.behind;
        if (behind === 0 && !chainPending) {
          emit({ type: "line", text: `  ${svc.repoName}: up to date ✓` });
          continue;
        }
      }

      // Something to do: explicit down → (clone|pull) → setup. Down FIRST
      // is the point of the ordering — the service must never observe mixed
      // state (new code under an old venv is how files-api died: uvicorn
      // hot-reloaded mid-pull into an import its environment couldn't satisfy).
      // Down runs against the BARE repo name: it is conventional and needs no
      // manifest, which matters when the clone doesn't exist yet but the
      // containers do (started from another checkout).
      emit({
        type: "line",
        text: !cloneExists
          ? `  ${svc.repoName}: not cloned yet — bootstrapping (down → clone → setup)`
          : behind > 0
            ? `  ${svc.repoName}: ${behind} commit(s) behind — down → pull → setup`
            : `  ${svc.repoName}: up to date, but a previous sync did not finish — resuming setup`,
      });
      if (cloneExists) {
        try {
          fs.writeFileSync(pendingMarker, `${new Date().toISOString()}\n`);
        } catch {
          /* best-effort — worst case we just don't retry next time */
        }
      }
      prewarmSudo();

      const downOk = await runManagedStep(
        svc.repoName,
        svc.repoName,
        "down",
        emit,
        () => cancelled,
      );
      if (cancelled) break;
      if (!downOk) {
        emit({
          type: "line",
          text: `  ${svc.repoName}: down failed — leaving this repo untouched (sync again to retry)`,
        });
        continue;
      }

      if (!cloneExists) {
        // A catalog entry can exist with an empty `gh` (the dev-managed add
        // flow writes one), which used to read as "not in the catalog" and
        // skip the clone entirely. Derive the conventional slug instead, and
        // persist it so every other flow (CLI up/setup) stops hitting this.
        // ORG-1d: a repo with no source and a `remote:` clones from it.
        const ghSlug = resolveRepoCloneSource(svc.repoName, readCatalog(), () =>
          githubOrgFor(ws.name),
        );
        const entry = readCatalog()[svc.repoName];
        if (needsGhRepair(entry, ghSlug)) {
          upsertCatalogEntry(svc.repoName, { ...entry, gh: ghSlug });
        }
        const branch = (svc as { branch?: string | null }).branch ?? "main";
        emit({
          type: "line",
          text: `  ${svc.repoName}: cloning ${redactRemote(ghSlug)} (${branch})…`,
        });
        try {
          // Synchronous (same helper the workspace-add flow uses) — the server
          // is busy for the duration of the clone. runSetup=false: setup runs
          // below with prompt auto-answering and the retry marker.
          ensureManagedServiceClone(svc.repoName, ghSlug, branch, false);
        } catch (e) {
          emit({
            type: "line",
            text: `  ${svc.repoName}: clone failed — ${(e as Error).message}`,
          });
          continue;
        }
        emit({ type: "line", text: `  ${svc.repoName}: clone ✓` });

        // A fresh clone carries stack's placeholder secrets, which blocks its
        // own `make setup`. When another checkout of this same repo already
        // holds real values, copy them across BEFORE setup runs — that is what
        // the engineer would do by hand, and it makes the common case
        // (a sibling checkout already configured) need no prompting at all.
        const seeded = seedSecretsFromSibling(svc.repoName, svc.repoPath);
        if (seeded) {
          emit({
            type: "line",
            text: `  ${svc.repoName}: filled ${seeded.filled.length} local secret(s) from ${seeded.donorPath} — ${seeded.filled.join(", ")}`,
          });
        }
        try {
          fs.writeFileSync(pendingMarker, `${new Date().toISOString()}\n`);
        } catch {
          /* best-effort */
        }
      }

      if (cloneExists && behind > 0) {
        const result = await pullManagedClone(
          svc.repoPath,
          behind,
          () => cancelled,
        );
        if (cancelled || result.cancelled) break;
        if (!result.pulled) {
          emit({
            type: "line",
            text: `  ${svc.repoName}: pull failed — ${result.error ?? "unknown"}; left stopped and unchanged`,
          });
          // Marker stays: the next sync retries the whole chain.
          continue;
        }
        emit({
          type: "line",
          text: `  ${svc.repoName}: pulled ${result.behind} commit(s) ✓`,
        });
      }

      // Single non-interactive setup authority, shared with the CLI's clone
      // bootstrap (runSetupHidden): env-hardened, tty-less, stdin auto-answers
      // "n", stall detector kills anything that still blocks. Resolves the
      // setup command itself (manifest first, else `make setup`) and no-ops
      // cleanly when there is nothing to run — so no pre-gating here. The
      // prompt text streams below; whatever was declined is visible.
      emit({
        type: "line",
        text: `  ${svc.repoName}: running setup (non-interactive — prompts auto-answered "n"; use \`${product().cli} setup ${svc.repoName}\` for interactive control)`,
      });
      const setupRes = await runSetupHidden(svc.repoPath, (line) => {
        if (!cancelled) emit({ type: "line", text: `    ${line}` });
      });
      if (cancelled) break;
      if (setupRes.stalledPrompt) {
        emit({
          type: "line",
          text: `  ${svc.repoName}: setup stalled on a prompt (${setupRes.stalledPrompt}) and was killed — run \`${product().cli} setup ${svc.repoName}\` interactively`,
        });
      }
      if (setupRes.code !== 0) {
        // Starting a service whose environment no longer matches its code is
        // the crash-loop this chain exists to prevent — stay down, honestly.
        emit({
          type: "line",
          text: `  ${svc.repoName}: setup failed (exit ${setupRes.code}) — leaving stopped; sync again to retry`,
        });
        if (providerRepos.has(svc.repoName)) {
          emit({
            type: "line",
            text: `  ${svc.repoName}: other services read shared config from this repo — stopping the sync here rather than starting them against a half-configured dependency`,
          });
          break;
        }
        continue;
      }
      emit({ type: "line", text: `  ${svc.repoName}: setup ✓` });

      // Sync deliberately ENDS here. It brings the checkout up to date; it does
      // not change run state. Starting a service is an explicit action the
      // engineer takes from the card (▶ up), so a sync can never surprise them
      // by booting something — least of all against config they haven't looked
      // at yet. The marker spans clone/pull → setup, so clear it now that the
      // chain has finished.
      try {
        fs.unlinkSync(pendingMarker);
      } catch {
        /* best-effort */
      }
      emit({
        type: "line",
        text: `  ${svc.repoName}: synced ✓ — not started (use ▶ up on the card when you're ready)`,
      });
    }

    emit({ type: "done" });
    res.end();
    return;
  }
}
