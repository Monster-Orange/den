/**
 * Startup ordering for derived `den up`/`down`.
 *
 * We want a dependencies-first order: for every edge `A → B` (A depends on /
 * publishes to B), B starts before A. The infra-stack foundation lands first,
 * leaf services next, and entrypoints/aggregators (shop, shop-web) last.
 *
 * The catch: soft edges form cycles (e.g. shop → notes-api for calls, and
 * notes-api → shop for JWKS; control-plane → shop for its reconciler). A strict
 * topo-sort can't linearize those. So we treat ordering as a feedback-arc-set
 * problem: accept HARD edges first (they're acyclic), then add soft + event
 * edges greedily — processing higher-fan-out sources first so an aggregator's
 * "my deps first" constraints win and the weak back-edges into it (JWKS,
 * reconciler) get dropped. The accepted edges form a DAG we topo-sort.
 *
 * `hardDepsOf` (hard, non-event edges) is used separately by `den up` for
 * readiness gating — only hard deps are *waited on*; this ordering is the launch
 * sequence.
 */

import type { DerivedEdge, DerivedGraph } from "./types.js";

/** Hard, non-event edges — the only ones `den up` blocks (waits) on. */
function isHardOrderingEdge(e: DerivedEdge): boolean {
  return e.kind !== "event" && e.blocking === "hard";
}

/** Hard dependency targets of a single repo (used for readiness blocking). */
export function hardDepsOf(graph: DerivedGraph, repo: string): string[] {
  return graph.edges
    .filter((e) => e.from === repo && isHardOrderingEdge(e))
    .map((e) => e.to);
}

export interface OrderOptions {
  /** The repo `den up` was invoked for. */
  seed?: string;
  /** Include the seed itself in the result (`--include`/`-i`). */
  include?: boolean;
}

/** Out-degree (distinct dep targets) per node — higher = more of an aggregator. */
function outDegrees(graph: DerivedGraph): Map<string, number> {
  const deg = new Map<string, number>(graph.nodes.map((n) => [n, 0]));
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    const k = `${e.from}->${e.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
  }
  return deg;
}

interface Constraint {
  before: string; // must start before `after`
  after: string;
  hard: boolean;
  srcDeg: number; // out-degree of the dependent (`after`) node
}

/**
 * Dependencies-first launch order. Each edge `A → B` asks for B before A; cycles
 * are broken by dropping soft edges (hard kept). Excludes the seed unless
 * `include` is set.
 */
export function orderForUp(
  graph: DerivedGraph,
  opts: OrderOptions = {},
): string[] {
  const nodes = graph.nodes;
  const deg = outDegrees(graph);

  // Event reachability: which nodes a producer's events flow to (transitively).
  // A non-event edge B→A where A's events reach B is a tolerant *back-call*
  // (B consumes A's events and calls A back during processing, e.g.
  // jobs-runtime → shop) — it must not gate order, so the consumer can start
  // before the producer it listens to.
  const eventOut = new Map<string, string[]>();
  for (const e of graph.edges)
    if (e.kind === "event")
      (eventOut.get(e.from) ?? eventOut.set(e.from, []).get(e.from)!).push(
        e.to,
      );
  const eventReaches = (a: string, b: string): boolean => {
    const stack = [...(eventOut.get(a) ?? [])];
    const visited = new Set(stack);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === b) return true;
      for (const n of eventOut.get(cur) ?? [])
        if (!visited.has(n)) {
          visited.add(n);
          stack.push(n);
        }
    }
    return false;
  };

  // One constraint per distinct edge: edge A→B ⇒ "B before A". Tolerant edges
  // (JWKS auth, `ignore` overrides, event back-calls) are excluded from ordering
  // — they still start the target, just don't gate sequence. Event edges DO
  // order (consumer before producer).
  const seen = new Set<string>();
  const constraints: Constraint[] = [];
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    if (e.kind === "jwks" || e.ordering === false) continue;
    if (e.kind !== "event" && eventReaches(e.to, e.from)) continue;
    const key = `${e.to}<${e.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    constraints.push({
      before: e.to,
      after: e.from,
      hard: isHardOrderingEdge(e),
      srcDeg: deg.get(e.from) ?? 0,
    });
  }

  // Hard constraints first; then soft by dependent out-degree desc (aggregators
  // win, so their back-edges get dropped), then by name for determinism.
  constraints.sort(
    (a, b) =>
      Number(b.hard) - Number(a.hard) ||
      b.srcDeg - a.srcDeg ||
      a.after.localeCompare(b.after) ||
      a.before.localeCompare(b.before),
  );

  // Greedily accept "before → after" edges that don't introduce a cycle.
  const adj = new Map<string, Set<string>>(nodes.map((n) => [n, new Set()]));
  const reaches = (src: string, dst: string): boolean => {
    const stack = [src];
    const visited = new Set([src]);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === dst) return true;
      for (const n of adj.get(cur) ?? [])
        if (!visited.has(n)) {
          visited.add(n);
          stack.push(n);
        }
    }
    return false;
  };
  for (const c of constraints) {
    if (c.before === c.after || !adj.has(c.before) || !adj.has(c.after))
      continue;
    if (reaches(c.after, c.before)) continue; // accepting would cycle → drop
    adj.get(c.before)!.add(c.after);
  }

  // Kahn topo-sort (before-first); name-sorted ready queue for determinism.
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const [, outs] of adj)
    for (const t of outs) indeg.set(t, (indeg.get(t) ?? 0) + 1);

  // Layer = longest accepted-dependency chain below a node (its deepest dep
  // is layer+? no — deps are BEFORE it, so layer(n) = 1 + max(layer(dep))).
  // The ready queue orders by (layer, name) rather than name alone: a pure
  // name sort exiles nodes to a position their dependencies don't justify —
  // tasks-api (deps: only infra-stack) sorted dead last in up-order purely
  // because "t" loses to every other repo name, which put it FIRST in the
  // display order, parked next to shop-web instead of beside the one thing it
  // depends on. Layer-first keeps every node in the band its dependency depth
  // earns; name only breaks ties within a band.
  const layer = new Map<string, number>(nodes.map((n) => [n, 0]));
  {
    // Relaxation over the accepted DAG (adj: dep → dependent). Bounded by
    // node count; the graph is small and acyclic by construction.
    let changed = true;
    let guard = 0;
    while (changed && guard++ <= nodes.length + 1) {
      changed = false;
      for (const [dep, outs] of adj) {
        for (const t of outs) {
          const need = (layer.get(dep) ?? 0) + 1;
          if ((layer.get(t) ?? 0) < need) {
            layer.set(t, need);
            changed = true;
          }
        }
      }
    }
  }
  const byLayerThenName = (a: string, b: string): number =>
    (layer.get(a) ?? 0) - (layer.get(b) ?? 0) || a.localeCompare(b);

  const ready = nodes
    .filter((n) => (indeg.get(n) ?? 0) === 0)
    .sort(byLayerThenName);
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const m of [...(adj.get(n) ?? [])].sort()) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if (indeg.get(m) === 0) {
        ready.push(m);
        ready.sort(byLayerThenName);
      }
    }
  }
  for (const n of nodes) if (!order.includes(n)) order.push(n); // safety

  return opts.seed && !opts.include
    ? order.filter((n) => n !== opts.seed)
    : order;
}

/** Teardown order: reverse of the full startup order (always includes the seed). */
export function orderForDown(graph: DerivedGraph): string[] {
  return orderForUp(graph, { include: true }).reverse();
}

/**
 * The set `den up` should start: the seed's DEPENDENCIES — what it needs to
 * run — not what consumes it. From the seed we follow every dependency edge
 * (infra/http — hard AND soft, since those are the seed's own declared deps);
 * BEYOND the seed we follow only HARD edges, so a single soft/tolerant dep
 * doesn't drag its entire subtree into the bring-up. Two edge kinds are NEVER
 * followed:
 *  - event — points at DOWNSTREAM consumers of the seed, which depend on it
 *    and must not start ahead of it.
 *  - jwks — a tolerant auth-key lookup, not a runtime dependency. Following
 *    it is how `den up notes-api` once booted shop's entire neighborhood
 *    (files-api, control-plane, jobs-runtime, shop-web) off the single
 *    scribe→shop JWKS edge.
 *
 * (`den down <seed>` tears down this same set in reverse.)
 */
/**
 * Everything `den up <seed>` operates on: the kept subgraph plus the
 * dependencies-first launch order. Always the seed's DEPENDENCY closure —
 * what it needs to run — never the downstream consumers/JWKS-provider world
 * it feeds (`up notes-api` once booted shop + control-plane + jobs-runtime
 * + shop-web through the tolerant scribe→shop JWKS edge). `include` controls
 * whether the seed itself is started (`-x` starts only the dependencies).
 */
/**
 * The set "up with deps" should start: everything the seed sits ON TOP OF.
 *
 * Walks dependency edges outward from the seed and keeps only systems that are
 * strictly LOWER than the seed in the global start order — never climbing. That
 * positional rule is the whole idea, and it is what an engineer reads off the
 * graph: start what is underneath me, not what is above me.
 *
 * Why positional rather than by edge kind (the rule this replaced):
 *
 *  - It INCLUDES tolerant deps that sit below. `files-api --event-->
 *    notes-api` was skipped purely for being an event edge, yet `orderForUp`
 *    already ranks notes-api below files-api and
 *    the graph draws it there — so refusing to start it contradicted both the
 *    picture and the order.
 *  - It EXCLUDES tolerant deps that sit above, which kind-based rules let
 *    through: `links-api --http(soft)--> shop-web` dragged in shop-web,
 *    ten places higher up the stack.
 *  - It subsumes the Jul 14 incident — the scribe→shop JWKS edge that once
 *    booted shop's whole neighborhood — because shop is
 *    above notes-api and is refused on position, not on a special case.
 *
 * `jwks` and edges explicitly marked non-ordering are still skipped: they are
 * not runtime dependencies at all, whichever direction they point.
 */
export function startClosure(graph: DerivedGraph, seed: string): Set<string> {
  const rank = new Map(orderForUp(graph).map((repo, i) => [repo, i]));
  const seedRank = rank.get(seed);
  const seen = new Set([seed]);
  if (seedRank === undefined) return seen; // seed not in the graph — nothing to add

  const outgoing = new Map<string, DerivedEdge[]>();
  for (const e of graph.edges) {
    (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from)!).push(e);
  }

  const queue = [seed];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of outgoing.get(cur) ?? []) {
      if (e.kind === "jwks" || e.ordering === false) continue;
      const toRank = rank.get(e.to);
      // Strictly below the SEED (not below `cur`): a transitive dep may rank
      // above an intermediate node while still sitting under the seed.
      if (toRank === undefined || toRank >= seedRank) continue;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

/**
 * Everything "up with deps" operates on: the downward closure plus its
 * dependencies-first launch order.
 */
export function deriveStartTargets(
  full: DerivedGraph,
  seed: string,
  include = true,
): { graph: DerivedGraph; order: string[] } {
  const graph = restrictGraph(full, startClosure(full, seed));
  return { graph, order: orderForUp(graph, { seed, include }) };
}

/**
 * Apply the workspace auto-start policy to a derived up order.
 *
 * A system the engineer toggled auto-start OFF stays off when it is pulled in
 * as somebody else's dependency — but never when it IS the seed, because that
 * is the system they just asked to start. Same rule `den up <repo>` uses,
 * kept here so the CLI and the web card action cannot drift.
 */
export function filterClosureForStart(
  order: string[],
  seed: string,
  noAutostart: ReadonlySet<string>,
): { start: string[]; skippedOff: string[] } {
  const start: string[] = [];
  const skippedOff: string[] = [];
  for (const repo of order) {
    if (repo === seed || !noAutostart.has(repo)) start.push(repo);
    else skippedOff.push(repo);
  }
  return { start, skippedOff };
}

/**
 * The set `den down` should stop: the seed plus its DEPENDENTS — the
 * services that would BREAK without it (hard, non-event edges into the seed,
 * transitively). Its own dependencies and shared infra stay up: other running
 * services use them, and tolerant edges (soft http, event, jwks) degrade
 * gracefully rather than break. (`den down notes-api` once derived an
 * 11-system teardown — infra-stack included — by spanning full directed
 * reachability through the tolerant scribe→shop JWKS edge.)
 */
/**
 * Everything `den down <seed>` operates on: the kept subgraph plus the
 * dependents-first stop order (reverse of startup — dependents stop before
 * the seed they need).
 */
/** Restrict a graph to a node set (keeping edges with both endpoints inside). */
export function restrictGraph(
  graph: DerivedGraph,
  keep: Set<string>,
): DerivedGraph {
  return {
    nodes: graph.nodes.filter((n) => keep.has(n)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}
