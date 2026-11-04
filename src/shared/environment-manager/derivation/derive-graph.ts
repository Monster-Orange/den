/**
 * Derived dependency graph engine — the single entrypoint shared by
 * `den graph` and (Phase 2) derived `den up`.
 *
 * Discovery runs on every invocation (never a stale hand-maintained graph) but
 * stays fast: closure-scoped BFS from the seed, targeted in-process parsing, a
 * per-repo `mtime` cache, and parallel-friendly per-repo derivation. Edge
 * hard/soft is finalized from the central `config/den.yml` `edges:` override
 * (the source of truth for functional-hard edges code doesn't expose).
 */

import * as path from "path";
import { readCatalog } from "../catalog.js";
import { getReposRoot, readDenConfig } from "../../den-config.js";
import type { GraphConfig } from "../../den-config.js";
import type {
  ResolvedService,
  ServiceCatalog,
  WorkspaceConfig,
} from "../../types/index.js";
import {
  getActiveWorkspace,
  getWorkspaceByName,
  resolveServiceSource,
} from "../workspaces.js";
import { buildAliasResolver, type AliasResolver } from "./alias.js";
import {
  emptyCache,
  readGraphCache,
  repoFingerprint,
  writeGraphCache,
} from "./cache.js";
import { deriveComposeEdges } from "./rules-compose.js";
import { deriveEventEdges } from "./rules-events.js";
import { deriveHttpEdges } from "./rules-http.js";
import { deriveInfraEdges } from "./rules-infra.js";
import { deriveReadinessEdges } from "./rules-readiness.js";
import { hasRepoMarker, scanRepo } from "./scan.js";
import type { DerivedEdge, DerivedGraph } from "./types.js";

import { product } from "../../product.js";
export interface DeriveOptions {
  /** "all" derives every known repo; "closure" BFS-derives the seed's deps. */
  scope: "all" | "closure";
  /** Required for scope "closure": the repo-system to start from. */
  seed?: string;
  /** Ignore cached per-repo results and re-derive from disk. */
  refresh?: boolean;
  /**
   * Derive against this workspace's checkouts instead of the focused one. With
   * several workspaces active, a repo name can point at a different checkout
   * per workspace (or be absent), so the graph is only meaningful relative to
   * one workspace.
   */
  workspace?: string;
}

type EdgeOverride = Record<string, "hard" | "soft" | "ignore">;

interface DeriveContext {
  alias: AliasResolver;
  edgesOverride: EdgeOverride;
  catalog: ServiceCatalog;
  workspace: WorkspaceConfig | null;
  workspaceName: string;
  reposRoot: string;
}

/**
 * @param workspaceName Workspace whose checkouts repos resolve against. Falls
 * back to the focused workspace, and to it again when the name is unknown.
 */
export function buildContext(workspaceName?: string): DeriveContext {
  const config = readDenConfig();
  const graph: GraphConfig | undefined = config.graph;
  const active =
    (workspaceName ? getWorkspaceByName(workspaceName) : null) ??
    getActiveWorkspace();
  const catalog = readCatalog();
  return {
    alias: buildAliasResolver(graph, Object.keys(catalog)),
    edgesOverride: graph?.edges ?? {},
    catalog,
    workspace: active?.config ?? null,
    workspaceName: active?.name ?? "default",
    reposRoot: getReposRoot(),
  };
}

/** Where den will boot a repo from: a managed clone or the dev sibling. */
export interface RepoSource {
  /** True = managed clone (`.den-services/...`); false = dev sibling. */
  managed: boolean;
  /** Absolute path of the configured location (clone or dev checkout). */
  path: string;
  /** Whether that path is present on disk (a managed repo may not be cloned yet). */
  exists: boolean;
}

/**
 * The active workspace's entry for a repo-system. Tries the bare repo name, then
 * the first "repo/subsystem" address (multi-service repos are addressed per
 * subsystem). Returns null when the repo isn't in the workspace/catalog.
 */
function configuredService(
  repoName: string,
  ctx: DeriveContext,
): ResolvedService | null {
  if (!ctx.workspace || !ctx.catalog[repoName]) return null;
  const direct = resolveServiceSource(
    repoName,
    ctx.workspaceName,
    ctx.workspace,
    ctx.catalog,
  );
  if (direct) return direct;
  const subAddr = Object.keys(ctx.workspace.services).find((a) =>
    a.startsWith(`${repoName}/`),
  );
  return subAddr
    ? resolveServiceSource(
        subAddr,
        ctx.workspaceName,
        ctx.workspace,
        ctx.catalog,
      )
    : null;
}

/**
 * The CONFIGURED boot location for a repo-system (for `den graph` annotation):
 * the workspace entry's mode/path if present (with `exists` flagging an
 * un-cloned managed repo), else the sibling under repos_root.
 */
export function repoSource(
  repoName: string,
  ctx: DeriveContext = buildContext(),
): RepoSource | null {
  const svc = configuredService(repoName, ctx);
  if (svc?.repoPath) {
    return {
      managed: svc.mode === "managed",
      path: svc.repoPath,
      exists: hasRepoMarker(svc.repoPath),
    };
  }
  const sibling = path.join(ctx.reposRoot, repoName);
  return hasRepoMarker(sibling)
    ? { managed: false, path: sibling, exists: true }
    : null;
}

/**
 * Absolute path den READS a repo-system from. Prefers the configured location
 * when it exists on disk; if a managed clone isn't present yet, falls back
 * to the dev sibling so discovery still has something to scan.
 */
export function resolveRepoPath(
  repoName: string,
  ctx: DeriveContext = buildContext(),
): string | null {
  const svc = configuredService(repoName, ctx);
  if (svc?.repoPath && hasRepoMarker(svc.repoPath)) return svc.repoPath;
  const sibling = path.join(ctx.reposRoot, repoName);
  return hasRepoMarker(sibling) ? sibling : null;
}

/** Edges produced by scanning one repo (cached by input-file fingerprint). */
function deriveRepoEdges(
  repoName: string,
  repoPath: string,
  ctx: DeriveContext,
  cache: ReturnType<typeof readGraphCache>,
  refresh: boolean,
): DerivedEdge[] {
  const fingerprint = repoFingerprint(repoPath);
  // Keyed by checkout, not just repo name: active workspaces can point the same
  // repo name at different checkouts, which would otherwise evict each other.
  const key = `${repoName}@${repoPath}`;
  const cached = cache.repos[key];
  if (!refresh && cached && cached.fingerprint === fingerprint) {
    return cached.edges;
  }
  const repo = scanRepo(repoName, repoPath);
  const edges = [
    ...deriveInfraEdges(repo, ctx.alias),
    ...deriveHttpEdges(repo, ctx.alias),
    ...deriveReadinessEdges(repo, ctx.alias),
    ...deriveEventEdges(repo, ctx.alias),
    ...deriveComposeEdges(repo, ctx.alias),
  ];
  cache.repos[key] = { fingerprint, edges };
  return edges;
}

const KIND_ORDER: Record<DerivedEdge["kind"], number> = {
  infra: 0,
  http: 1,
  jwks: 2,
  event: 3,
};
const CONF_RANK: Record<DerivedEdge["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};
const BLOCKING_RANK: Record<DerivedEdge["blocking"], number> = {
  hard: 2,
  soft: 1,
};

/**
 * Collapse duplicates of (from,to,kind). Hard beats soft (a startup gate must
 * never be silently dropped in favor of a soft signal to the same peer), then
 * higher confidence wins; ties keep the first-inserted edge.
 */
function dedupe(edges: DerivedEdge[]): DerivedEdge[] {
  const best = new Map<string, DerivedEdge>();
  for (const e of edges) {
    const key = `${e.from}->${e.to}:${e.kind}`;
    const prev = best.get(key);
    if (
      !prev ||
      BLOCKING_RANK[e.blocking] > BLOCKING_RANK[prev.blocking] ||
      (e.blocking === prev.blocking &&
        CONF_RANK[e.confidence] > CONF_RANK[prev.confidence])
    ) {
      best.set(key, e);
    }
  }
  // A JWKS URL also matches as plain http via its value host — when a pair has a
  // jwks edge, drop the redundant http one so the dep is purely jwks (auth).
  const jwksPairs = new Set<string>();
  for (const e of best.values())
    if (e.kind === "jwks") jwksPairs.add(`${e.from}->${e.to}`);
  return [...best.values()]
    .filter((e) => !(e.kind === "http" && jwksPairs.has(`${e.from}->${e.to}`)))
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
    );
}

/** Apply the central per-edge override: hard/soft reclassify; ignore = non-ordering. */
function applyOverrideTo(
  edge: DerivedEdge,
  override: EdgeOverride,
): DerivedEdge {
  const o = override[`${edge.from}->${edge.to}`];
  if (!o) return edge;
  if (o === "ignore") return { ...edge, ordering: false };
  if (edge.kind === "event") return edge; // events aren't reclassified hard/soft
  return { ...edge, blocking: o };
}

/**
 * Pure graph assembly — separated from filesystem/config so it can be unit
 * tested. Callers inject `deriveEdges` (per-repo discovery) and `repoExists`.
 */
export interface AssembleOptions {
  scope: "all" | "closure";
  seed?: string;
  knownRepos: Set<string>;
  edgesOverride: EdgeOverride;
  /** Edges produced by scanning one repo (may include incoming event edges). */
  deriveEdges: (repoName: string) => DerivedEdge[];
  /** Whether a repo is present on disk. */
  repoExists: (repoName: string) => boolean;
  /**
   * Whether a repo is configured in the workspace even if not on disk (e.g. a
   * managed entry whose clone hasn't been created yet). Such repos stay
   * graph NODES — with config-override edges only — so a fresh install renders
   * the full workspace instead of an empty graph. Edge scanning still requires
   * `repoExists`.
   */
  isConfigured?: (repoName: string) => boolean;
  /** Repos that are event sinks — edges INTO these are reclassified to `event`. */
  eventSinks?: Set<string>;
}

/**
 * An edge into an event-sink (e.g. notes-api, an EventBridge consumer) is a
 * producer→sink EVENT flow — its SDK publishes events, it isn't a sync call. So
 * reclassify it as `event` (soft, non-gating) rather than http/jwks.
 */
function reclassifyEventSink(
  edge: DerivedEdge,
  eventSinks: Set<string>,
): DerivedEdge {
  if (edge.kind === "event" || !eventSinks.has(edge.to)) return edge;
  return {
    ...edge,
    kind: "event",
    blocking: "soft",
    signal: "event:sdk-publish",
  };
}

/**
 * Synthetic edges from the central `edges:` override that discovery did not
 * already produce for `repoName`. This makes the override the source of truth:
 * a hard edge the code doesn't expose (or that a managed clone lacks) is still
 * present, participates in closure BFS, and orders startup.
 */
function overrideEdgesFor(
  repoName: string,
  existing: DerivedEdge[],
  override: EdgeOverride,
  knownRepos: Set<string>,
): DerivedEdge[] {
  const out: DerivedEdge[] = [];
  const prefix = `${repoName}->`;
  for (const [key, blocking] of Object.entries(override)) {
    if (blocking === "ignore") continue; // ignore only annotates existing edges
    if (!key.startsWith(prefix)) continue;
    const to = key.slice(prefix.length);
    if (to === repoName || !knownRepos.has(to)) continue;
    const already = existing.some(
      (e) => e.from === repoName && e.to === to && e.kind !== "event",
    );
    if (already) continue;
    out.push({
      from: repoName,
      to,
      kind: "http",
      blocking,
      signal: "override:config",
      evidence: `${product().configFile} graph.edges`,
      confidence: "high",
    });
  }
  return out;
}

export function assembleGraph(opts: AssembleOptions): DerivedGraph {
  const derived = new Map<string, DerivedEdge[]>();
  const derive = (repoName: string): DerivedEdge[] => {
    let edges = derived.get(repoName);
    if (edges) return edges;
    const base = opts.repoExists(repoName) ? opts.deriveEdges(repoName) : [];
    edges = [
      ...base,
      ...overrideEdgesFor(repoName, base, opts.edgesOverride, opts.knownRepos),
    ];
    derived.set(repoName, edges);
    return edges;
  };

  let nodes: Set<string>;
  if (opts.scope === "closure") {
    if (!opts.seed)
      throw new Error("assembleGraph: scope 'closure' requires a seed");
    nodes = new Set([opts.seed]);
    const queue = [opts.seed];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const e of derive(current)) {
        // Follow only outgoing, non-event edges to expand the start set.
        if (e.from !== current || e.kind === "event") continue;
        if (!nodes.has(e.to)) {
          nodes.add(e.to);
          queue.push(e.to);
        }
      }
    }
  } else {
    nodes = new Set(
      [...opts.knownRepos].filter(
        (repo) => opts.repoExists(repo) || (opts.isConfigured?.(repo) ?? false),
      ),
    );
    for (const repo of nodes) derive(repo);
  }

  // Aggregate every derived edge whose endpoints are both in the node set.
  const eventSinks = opts.eventSinks ?? new Set<string>();
  const all: DerivedEdge[] = [];
  for (const edges of derived.values()) {
    for (const e of edges) {
      if (nodes.has(e.from) && nodes.has(e.to)) {
        // An explicit hard/soft config override is authoritative — don't let
        // event-sink reclassification downgrade it back to event/soft.
        const o = opts.edgesOverride[`${e.from}->${e.to}`];
        const withOverride = applyOverrideTo(e, opts.edgesOverride);
        all.push(
          o === "hard" || o === "soft"
            ? withOverride
            : reclassifyEventSink(withOverride, eventSinks),
        );
      }
    }
  }
  return { nodes: [...nodes].sort(), edges: dedupe(all) };
}

export function deriveGraph(opts: DeriveOptions): DerivedGraph {
  const ctx = buildContext(opts.workspace);
  const cache = opts.refresh ? emptyCache() : readGraphCache();
  const refresh = opts.refresh ?? false;

  const graph = assembleGraph({
    scope: opts.scope,
    seed: opts.seed,
    knownRepos: ctx.alias.knownRepos,
    edgesOverride: ctx.edgesOverride,
    eventSinks: ctx.alias.eventSinks,
    repoExists: (repo) => resolveRepoPath(repo, ctx) !== null,
    isConfigured: (repo) => configuredService(repo, ctx) !== null,
    deriveEdges: (repo) => {
      const repoPath = resolveRepoPath(repo, ctx);
      return repoPath
        ? deriveRepoEdges(repo, repoPath, ctx, cache, refresh)
        : [];
    },
  });

  writeGraphCache(cache);
  return graph;
}
