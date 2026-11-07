/**
 * MCP-2: what an agent reads, shaped so it gets a whole, honest picture.
 *
 *   - Scoped answers say so (MCP-2.2): a `scope` block naming the workspace
 *     shown and how much is left out (`hidden: { repos: 6 }`), pointing at
 *     `org_summary` for the rest.
 *   - Health is honest (MCP-2.4): every row has a `state` (up, down,
 *     redirect, pending, unknown, not-checked), and a row with no verdict
 *     says why.
 *   - `org_summary` (MCP-2.1): every workspace and repo with status counts,
 *     the graph, the edge and the environments, for every agent. It never
 *     carries logs, env values, commands, URLs, paths or check output from
 *     outside the agent's own workspace: only names and counts.
 *
 * Pure: the tools fetch, these shape.
 */
import { rollupRepo } from "../../shared/health/rollup.js";
import { notCheckedReason } from "../../shared/health/not-checked.js";
import type { McpScope } from "./scope.js";

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

// ── Workspaces and their repos ──────────────────────────────────────────────

/** Workspace names in an /api/workspaces body. */
export function workspaceNames(body: unknown): string[] {
  return Object.keys(asRecord(asRecord(body).workspaces));
}

/**
 * The repos a workspace's config names: its service addresses' repos
 * ("shop/api" → shop) and its managed clones.
 */
export function workspaceRepos(body: unknown, ws: string): string[] {
  const cfg = asRecord(asRecord(asRecord(body).workspaces)[ws]);
  const repos = new Set<string>();
  for (const address of Object.keys(asRecord(cfg.services)))
    repos.add(address.split("/")[0]);
  for (const repo of Object.keys(asRecord(cfg.repos))) repos.add(repo);
  return [...repos].sort();
}

/** Every repo any workspace names. */
function orgRepos(body: unknown): Set<string> {
  const all = new Set<string>();
  for (const ws of workspaceNames(body))
    for (const r of workspaceRepos(body, ws)) all.add(r);
  return all;
}

// ── The scope block (MCP-2.2) ───────────────────────────────────────────────

export interface ScopeBlock {
  workspace: string;
  actor: string;
  /** Set when `workspace` is a granted one, not the agent's own. */
  grantedFrom?: string;
  grants?: string[];
  otherWorkspaces: number;
  hidden: Record<string, number>;
  note: string;
}

/**
 * The `scope` of a scoped answer about workspace `shown`: what it shows
 * ("3 services in north (your scope)"), and what it leaves out: the other
 * workspaces and their repos (`hidden.repos`: repos only they name), plus
 * any count the tool adds (`extraHidden`, e.g. stacks).
 */
export function scopeBlock(
  scope: McpScope,
  workspacesBody: unknown,
  shown: string,
  shows: { count: number; noun: string },
  extraHidden: Record<string, number> = {},
): ScopeBlock {
  const mine = new Set(workspaceRepos(workspacesBody, shown));
  const hiddenRepos = [...orgRepos(workspacesBody)].filter(
    (r) => !mine.has(r),
  ).length;
  const others = workspaceNames(workspacesBody).filter(
    (w) => w !== shown,
  ).length;
  const hidden = { repos: hiddenRepos, ...extraHidden };
  const what = `${shows.count} ${shows.noun}${shows.count === 1 ? "" : "s"}`;
  const yours =
    shown === scope.workspace ? "your scope" : `granted to ${scope.actor}`;
  return {
    workspace: shown,
    actor: scope.actor,
    ...(shown !== scope.workspace ? { grantedFrom: scope.workspace } : {}),
    ...(scope.grants?.length ? { grants: scope.grants } : {}),
    otherWorkspaces: others,
    hidden,
    note:
      `${what} in ${shown} (${yours}); ` +
      `${others} other workspace${others === 1 ? "" : "s"}` +
      (hiddenRepos
        ? ` with ${hiddenRepos} more repo${hiddenRepos === 1 ? "" : "s"}`
        : "") +
      ": summary only, see org_summary",
  };
}

// ── Honest health (MCP-2.4) ─────────────────────────────────────────────────

export type RowState =
  | "up"
  | "down"
  | "redirect"
  | "pending"
  | "unknown"
  | "not-checked";

/** One /api/health row's state. */
export function rowState(row: Rec): RowState {
  if (row.ok === true) return "up";
  if (row.ok === false) return "down";
  if (str(row.redirect) !== undefined) return "redirect";
  if (row.pending === true) return "pending";
  if (str(row.url) !== undefined || str(row.check) !== undefined)
    return "unknown";
  return "not-checked";
}

/** Why a row has the state it has, when that is not obvious from it. */
function rowWhy(row: Rec, state: RowState, env: string): string | undefined {
  if (state === "redirect")
    return `redirect: ${row.status ?? "3xx"} → ${String(row.redirect)} (answering; not counted as down)`;
  if (state === "pending")
    return `checked, no answer yet${str(row.error) ? ` (${String(row.error)})` : ""}`;
  if (state === "unknown")
    return `checked, but the check could not tell${str(row.error) ? `: ${String(row.error)}` : ""}`;
  if (state === "not-checked")
    return (
      str(row.why) ??
      notCheckedReason({
        env,
        runs: row.runs as never,
        target: asRecord(row.target) as { env?: string },
      })
    );
  return undefined;
}

/** A health row with its `state`, and `why` when it has no plain verdict. */
export function annotateRow(row: unknown, env: string): Rec {
  const r = asRecord(row);
  const state = rowState(r);
  const why = rowWhy(r, state, env);
  return { ...r, state, ...(why ? { why } : {}) };
}

export interface StateCounts {
  services: number;
  up: number;
  down: number;
  redirect: number;
  pending: number;
  unknown: number;
  notChecked: number;
}

function countStates(states: RowState[]): StateCounts {
  const c: StateCounts = {
    services: states.length,
    up: 0,
    down: 0,
    redirect: 0,
    pending: 0,
    unknown: 0,
    notChecked: 0,
  };
  for (const s of states) {
    if (s === "not-checked") c.notChecked++;
    else c[s]++;
  }
  return c;
}

/** The `status` answer: counts, then every row with its state. */
export function statusView(rows: unknown, env: string): Rec {
  const services = asArray(rows).map((r) => annotateRow(r, env));
  return {
    env,
    counts: countStates(services.map((s) => s.state as RowState)),
    services,
  };
}

// ── The graph ───────────────────────────────────────────────────────────────

/**
 * A scoped `graph` (MCP-2.2): the workspace's own repos and the edges out
 * of them. A repo they depend on outside the workspace is named in
 * `outside`; the org-wide map is `org_summary.graph`.
 */
export function graphInScope(graph: unknown, repos: readonly string[]): Rec {
  const g = asRecord(graph);
  const mine = new Set(repos);
  const nodes = asArray(g.nodes).filter((n) => mine.has(String(n)));
  const edges = asArray(g.edges).filter((e) =>
    mine.has(String(asRecord(e).from)),
  );
  const outside = [
    ...new Set(
      edges.map((e) => String(asRecord(e).to)).filter((to) => !mine.has(to)),
    ),
  ].sort();
  return {
    map: "workspace",
    nodes,
    edges,
    ...(Array.isArray(g.order)
      ? { order: g.order.filter((n) => mine.has(String(n))) }
      : {}),
    outside,
    hiddenNodes: asArray(g.nodes).length - nodes.length,
  };
}

/**
 * The org-wide map from each active workspace's /api/graph (the web server
 * derives a graph for one workspace: its repos, as that workspace checks
 * them out). Nodes are the union; an edge two workspaces both derive is
 * listed once (the first's). `order` is a startup order within one
 * workspace, so it is kept only when there is one. A workspace whose graph
 * failed is named in `unavailable`; when every one failed, the first error.
 */
export function mergeGraphs(
  graphs: readonly { workspace: string; graph: unknown }[],
): Rec {
  const ok = graphs.filter((x) => !str(asRecord(x.graph).error));
  const unavailable = graphs
    .filter((x) => str(asRecord(x.graph).error))
    .map((x) => ({ workspace: x.workspace, error: asRecord(x.graph).error }));
  if (!ok.length && unavailable.length) return { error: unavailable[0].error };
  const nodes = new Set<string>();
  const edges: unknown[] = [];
  const seen = new Set<string>();
  for (const { graph } of ok) {
    const g = asRecord(graph);
    for (const n of asArray(g.nodes)) nodes.add(String(n));
    for (const e of asArray(g.edges)) {
      const x = asRecord(e);
      const key = `${String(x.from)}\0${String(x.to)}\0${String(x.kind)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(e);
    }
  }
  const only = ok.length === 1 ? asRecord(ok[0].graph) : null;
  return {
    map: "org-wide",
    workspaces: ok.map((x) => x.workspace),
    nodes: [...nodes].sort(),
    edges,
    ...(only && Array.isArray(only.order) ? { order: only.order } : {}),
    ...(unavailable.length ? { unavailable } : {}),
  };
}

/** The org-wide graph with names and edge kinds only (no evidence). */
function graphSummary(graph: unknown): Rec {
  const g = asRecord(graph);
  if (str(g.error)) return { error: g.error };
  return {
    map: "org-wide",
    ...(Array.isArray(g.workspaces)
      ? { workspaces: g.workspaces.map(String) }
      : {}),
    nodes: asArray(g.nodes).map(String),
    edges: asArray(g.edges).map((e) => {
      const x = asRecord(e);
      return {
        from: String(x.from),
        to: String(x.to),
        kind: x.kind,
        blocking: x.blocking,
      };
    }),
    ...(Array.isArray(g.order) ? { order: g.order.map(String) } : {}),
    ...(Array.isArray(g.unavailable)
      ? {
          unavailable: g.unavailable.map((u) => ({
            workspace: String(asRecord(u).workspace),
            error: String(asRecord(u).error),
          })),
        }
      : {}),
  };
}

// ── The org summary (MCP-2.1) ───────────────────────────────────────────────

export type WorkspaceState =
  | "running"
  | "partial"
  | "stopped"
  | "unknown"
  | "inactive";

function workspaceState(active: boolean, c: StateCounts): WorkspaceState {
  if (!active) return "inactive";
  const answering = c.up + c.redirect;
  if (answering > 0 && c.down === 0) return "running";
  if (answering > 0) return "partial";
  if (c.down > 0) return "stopped";
  return "unknown";
}

/** Rows that belong to workspace `ws`: named in `workspaces`, else by repo. */
function rowsOf(rows: Rec[], ws: string, repos: Set<string>): Rec[] {
  return rows.filter((r) =>
    Array.isArray(r.workspaces)
      ? r.workspaces.includes(ws)
      : repos.has(String(r.repo)),
  );
}

function repoSummary(repo: string, rows: Rec[], active: boolean): Rec {
  if (!active) return { repo, state: "inactive" };
  const states = rows.map((r) => rowState(r));
  const counts = countStates(states);
  const rolled = rollupRepo(
    repo,
    rows.map((r, i) => ({
      service: String(r.service),
      ok: states[i] === "up" ? true : states[i] === "down" ? false : null,
      isEntrypoint: r.isEntrypoint === true,
      awaiting: states[i] === "pending",
    })),
  );
  const state =
    rolled.state === "unknown" && counts.redirect > 0
      ? "redirect"
      : rolled.state;
  return {
    repo,
    state,
    services: counts.services,
    up: counts.up,
    down: counts.down,
    ...(counts.redirect ? { redirect: counts.redirect } : {}),
    ...(counts.notChecked ? { notChecked: counts.notChecked } : {}),
  };
}

/** The edge in a few fields: up, domains, TLS and whether HTTPS serves. */
function edgeSummary(edge: unknown): Rec {
  const e = asRecord(edge);
  if (e.configured === false) return { configured: false };
  if (str(e.error) && e.configured === undefined) return { error: e.error };
  const tls = asRecord(e.tls);
  const https = asRecord(e.https);
  return {
    configured: true,
    up: e.up === true,
    state: e.state,
    domains: asArray(e.domains),
    routes: asArray(e.routes).length,
    https: {
      strategy: https.strategy ?? tls.strategy ?? null,
      ...(https.certs !== undefined ? { certs: https.certs } : {}),
      serving: typeof https.serving === "boolean" ? https.serving : null,
      ...(str(https.detail)
        ? { detail: https.detail }
        : { detail: "the web server did not say (it predates 0.4.4)" }),
    },
  };
}

export interface OrgSummaryInput {
  workspaces: unknown;
  /** /api/health for every active workspace (local). */
  health: unknown;
  graph: unknown;
  edge: unknown;
  environments: unknown;
  /** Scoped: the agent's own workspace's /api/health rows (local). */
  own?: unknown;
}

/**
 * The org summary. For workspaces outside the scope only names and counts
 * are copied: never a row's url, check, error, path or links, and never
 * the graph's evidence.
 */
export function orgSummary(input: OrgSummaryInput, scope?: McpScope): Rec {
  const body = asRecord(input.workspaces);
  const active = new Set(asArray(body.active).map(String));
  const focus = str(body.focus);
  const rows = asArray(input.health).map(asRecord);
  const names = workspaceNames(body);
  const workspaces = names.map((ws) => {
    const repos = workspaceRepos(body, ws);
    const isActive = active.has(ws);
    const mine = isActive ? rowsOf(rows, ws, new Set(repos)) : [];
    const counts = countStates(mine.map((r) => rowState(r)));
    return {
      name: ws,
      active: isActive,
      ...(focus === ws ? { focused: true } : {}),
      ...(scope?.workspace === ws ? { yours: true } : {}),
      state: workspaceState(isActive, counts),
      ...(isActive ? { counts } : {}),
      repos: repos.map((repo) =>
        repoSummary(
          repo,
          mine.filter((r) => String(r.repo) === repo),
          isActive,
        ),
      ),
    };
  });
  const repoCount = orgRepos(body).size;
  const activeCount = workspaces.filter((w) => w.active).length;
  const out: Rec = {
    summary:
      `${names.length} workspace${names.length === 1 ? "" : "s"} ` +
      `(${activeCount} active), ${repoCount} repo${repoCount === 1 ? "" : "s"}. ` +
      "Counts are local health; an inactive workspace is not checked." +
      (scope
        ? ` Your scope: ${scope.workspace} (its services are in "yours"); ` +
          "other workspaces are names and counts only."
        : ""),
    workspaces,
    graph: graphSummary(input.graph),
    edge: edgeSummary(input.edge),
    environments: asArray(input.environments).map(String),
  };
  if (scope) {
    out.scope = {
      workspace: scope.workspace,
      actor: scope.actor,
      ...(scope.grants?.length ? { grants: scope.grants } : {}),
    };
    out.yours = {
      workspace: scope.workspace,
      ...statusView(input.own, "local"),
    };
  }
  return out;
}
