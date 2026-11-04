/**
 * `den graph` — derived system dependency analysis.
 *
 * Builds the dependency graph by deriving real signals from each repo (SDK
 * imports, service URLs, IaC stack refs, EventBridge rules) rather than trusting
 * each repo's `.den.yml` `depends_on`, and renders / diffs / annotates it.
 *
 * Usage:
 *   den graph [repo]            graph for repo's dependency closure (defaults to cwd repo, else --all)
 *   den graph --all            the full known-systems graph
 *   den graph --format=json|dot|text
 *   den graph --source=derived|declared|union
 *   den graph --kind=all|hard|infra|http|event
 *   den graph --diff           compare derived deps vs .den.yml depends_on
 *   den graph --refresh        ignore the per-repo cache
 */

import chalk from "chalk";
import {
  parseAddress,
  getActiveWorkspace,
  noAutostartRepos,
} from "../../shared/environment-manager/workspaces.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import { readManifest } from "../../shared/manifest/read-manifest.js";
import {
  repoPlacement,
  type RollupPlacement,
} from "../../shared/manifest/placement.js";
import type { AliasResolver } from "../../shared/environment-manager/derivation/alias.js";
import { loadAliasResolver } from "../../shared/environment-manager/derivation/load-alias.js";
import {
  deriveGraph,
  resolveRepoPath,
  repoSource,
  buildContext,
} from "../../shared/environment-manager/derivation/derive-graph.js";
import { listMakeTargets } from "../../shared/environment-manager/make-targets.js";
import {
  orderForUp,
  orderForDown,
} from "../../shared/environment-manager/derivation/derived-up.js";
import type {
  DerivedEdge,
  DerivedGraph,
} from "../../shared/environment-manager/derivation/types.js";
import { findInvocationRepoRoot, resolveCwdRepo } from "./invocation-target.js";
import { getDistRoot } from "../../shared/paths.js";
import * as path from "path";
import * as os from "os";

import { product } from "../../shared/product.js";
type Source = "derived" | "declared" | "union";
type KindFilter = "all" | "hard" | "infra" | "http" | "event";
type Format = "text" | "json" | "dot";
type Order = "up" | "down";

export interface GraphFlags {
  repo?: string;
  all: boolean;
  source: Source;
  kind: KindFilter;
  format: Format;
  diff: boolean;
  refresh: boolean;
  order: Order;
}

const REQUIRED_TARGETS = ["setup", "up", "down"];

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

export function edgeMatchesKind(edge: DerivedEdge, kind: KindFilter): boolean {
  switch (kind) {
    case "all":
      return true;
    case "hard":
      return edge.blocking === "hard";
    case "infra":
      return edge.kind === "infra";
    case "http":
      return edge.kind === "http" || edge.kind === "jwks";
    case "event":
      return edge.kind === "event";
  }
}

/** Cross-service `depends_on` edges declared in each node's `.den.yml`. */
export function collectDeclaredEdges(
  nodes: string[],
  alias: AliasResolver,
): DerivedEdge[] {
  const catalog = readCatalog();
  const out: DerivedEdge[] = [];
  for (const node of nodes) {
    const repoPath = resolveRepoPath(node);
    if (!repoPath) continue;
    const manifest = readManifest(repoPath);
    for (const svc of Object.values(manifest?.services ?? {})) {
      for (const dep of svc.depends_on ?? []) {
        const service = typeof dep === "string" ? dep : dep.service;
        const wait = typeof dep === "string" ? false : dep.wait === true;
        const repoName = parseAddress(service, catalog).repoName;
        const to = alias.resolve(repoName);
        if (!to || to === node || !nodes.includes(to)) continue;
        out.push({
          from: node,
          to,
          kind: "http",
          blocking: wait ? "hard" : "soft",
          signal: "declared:depends_on",
          evidence: `${product().manifestYml} depends_on: ${service}`,
          confidence: "high",
        });
      }
    }
  }
  return out;
}

const edgeKey = (e: DerivedEdge): string => `${e.from}->${e.to}`;

export interface GraphDiff {
  repo: string;
  /** Derived (real) but not declared in `.den.yml`. */
  undeclared: string[];
  /** Declared in `.den.yml` but no derived signal found. */
  stale: string[];
}

export function diffEdges(
  derived: DerivedEdge[],
  declared: DerivedEdge[],
  nodes: string[],
): GraphDiff[] {
  // Compare on synchronous edges only (events are never declared as depends_on).
  const sync = (e: DerivedEdge) => e.kind !== "event";
  const derivedByRepo = new Map<string, Set<string>>();
  const declaredByRepo = new Map<string, Set<string>>();
  for (const e of derived.filter(sync))
    (
      derivedByRepo.get(e.from) ??
      derivedByRepo.set(e.from, new Set()).get(e.from)!
    ).add(e.to);
  for (const e of declared)
    (
      declaredByRepo.get(e.from) ??
      declaredByRepo.set(e.from, new Set()).get(e.from)!
    ).add(e.to);

  const out: GraphDiff[] = [];
  for (const repo of nodes) {
    const d = derivedByRepo.get(repo) ?? new Set();
    const c = declaredByRepo.get(repo) ?? new Set();
    const undeclared = [...d].filter((t) => !c.has(t)).sort();
    const stale = [...c].filter((t) => !d.has(t)).sort();
    if (undeclared.length || stale.length)
      out.push({ repo, undeclared, stale });
  }
  return out;
}

const ARROW: Record<DerivedEdge["kind"], string> = {
  infra: "→",
  http: "→",
  jwks: "→",
  event: "⇢",
};

export function renderText(
  graph: DerivedGraph,
  opts: {
    showEvidence?: boolean;
    annotations?: Map<string, string>;
    /** Node for the repo the command was run from — marked with a leading `*`. */
    currentRepo?: string;
    /** repo → placement (R13): remote and hybrid nodes are marked. */
    placements?: Map<string, NodePlacement>;
  } = {},
): string {
  const showEvidence = opts.showEvidence ?? true;
  const byFrom = new Map<string, DerivedEdge[]>();
  for (const e of graph.edges)
    (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from)!).push(e);

  // Pad node names to the longest so the annotations (den managed / sibling
  // repo …) line up in a single column. Pad the PLAIN name then colorize, so the
  // ANSI codes don't throw off the width.
  const nameWidth = graph.nodes.reduce((m, n) => Math.max(m, n.length), 0);
  // Pad the `[kind/blocking]` tag to the widest so the evidence ("reason")
  // column lines up across all bullets.
  const tagText = (e: DerivedEdge): string =>
    e.kind === "event" ? "[event]" : `[${e.kind}/${e.blocking}]`;
  const tagWidth = graph.edges.reduce(
    (m, e) => Math.max(m, tagText(e).length),
    0,
  );

  const lines: string[] = [];
  for (const node of graph.nodes) {
    const ann = opts.annotations?.get(node);
    // System (node) rows: auto-start-off ones in yellow, the rest in light
    // green — both bold so they stand out from the plain-white edge bullets.
    const isOff = !!ann && ann.includes("auto-start off");
    const paint = isOff ? chalk.yellow : chalk.greenBright;
    const placed = placementMark(opts.placements?.get(node));
    const styledAnn =
      (placed ? "  " + chalk.cyan(placed) : "") +
      (ann ? "  " + paint(ann) : "");
    // The repo the command was run from gets a leading `▸`; others a 2-space
    // gutter so node names stay aligned. A single-width glyph (not an emoji,
    // which is double-width + terminal-dependent) keeps the column stable.
    const gutter =
      node === opts.currentRepo ? chalk.bold.yellow.bgBlue("▸ ") : "  ";
    const pad = " ".repeat(nameWidth - node.length);
    lines.push(`${gutter}${paint.bold(node)}${pad}${styledAnn}`);
    for (const e of byFrom.get(node) ?? []) {
      const tagPlain = tagText(e);
      const tagColored =
        e.kind === "event"
          ? chalk.magenta(tagPlain)
          : e.blocking === "hard"
            ? chalk.red(tagPlain)
            : chalk.white(tagPlain);
      const tagPad = " ".repeat(tagWidth - tagPlain.length);
      const ev = showEvidence ? `   ${e.evidence}` : "";
      // Bullet rows use plain white (not dim/gray) so they stay readable — they
      // recede from the bold colored system headers by weight, not by dimming.
      // Tag is padded (plain, then colorized) so the evidence column aligns.
      lines.push(
        chalk.white(`    ${ARROW[e.kind]} ${e.to.padEnd(18)} `) +
          tagColored +
          tagPad +
          chalk.white(ev),
      );
    }
  }
  return lines.join("\n");
}

/** A repo's placement on the graph: local, remote (with envs), or hybrid. */
export interface NodePlacement {
  placement: RollupPlacement;
  envs: string[];
}

/** "☁ remote (dev)", "⇄ hybrid", or "" for a local (or runtime-less) node. */
export function placementMark(p: NodePlacement | undefined): string {
  if (!p) return "";
  if (p.placement === "remote") return `☁ remote (${p.envs.join(", ")})`;
  if (p.placement === "hybrid") return "⇄ hybrid";
  return "";
}

/** Each node's placement from its manifest, viewed locally. */
export function nodePlacements(nodes: string[]): Map<string, NodePlacement> {
  const ctx = buildContext();
  const out = new Map<string, NodePlacement>();
  for (const node of nodes) {
    const src = repoSource(node, ctx);
    if (!src?.exists) continue;
    out.set(node, repoPlacement(readManifest(src.path), "local"));
  }
  return out;
}

export function renderDot(
  graph: DerivedGraph,
  placements?: Map<string, NodePlacement>,
): string {
  const lines = [`digraph ${product().cli} {`, "  rankdir=LR;"];
  for (const node of graph.nodes) {
    const p = placements?.get(node);
    lines.push(
      p?.placement === "remote"
        ? `  "${node}" [style=dashed, label="${node} ☁ ${p.envs.join(", ")}"];`
        : `  "${node}";`,
    );
  }
  for (const e of graph.edges) {
    const style = e.kind === "event" ? "dashed" : "solid";
    const color = e.blocking === "hard" ? "red" : "black";
    lines.push(
      `  "${e.from}" -> "${e.to}" [style=${style}, color=${color}, label="${e.kind}"];`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

export function renderDiff(diffs: GraphDiff[]): string {
  if (diffs.length === 0) {
    return `✓ Derived graph matches declared ${product().manifestYml} depends_on.`;
  }
  const lines: string[] = [];
  for (const d of diffs) {
    lines.push(d.repo);
    for (const t of d.undeclared)
      lines.push(`  + ${t}   (derived, not declared)`);
    for (const t of d.stale)
      lines.push(`  - ${t}   (declared, no derived signal)`);
  }
  return lines.join("\n");
}

// ── flag parsing ─────────────────────────────────────────────────────────────

const SOURCES: readonly Source[] = ["derived", "declared", "union"];
const KINDS: readonly KindFilter[] = ["all", "hard", "infra", "http", "event"];
const FORMATS: readonly Format[] = ["text", "json", "dot"];

/** Value of `--<flag>=<value>` validated against its allowed set — a typo must
 * error out loudly, not silently degrade to the default rendering. */
function parseChoice<T extends string>(
  flag: string,
  value: string,
  allowed: readonly T[],
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid value for ${flag}: "${value}" (valid: ${allowed.join(" | ")})`,
    );
  }
  return value as T;
}

export function parseGraphFlags(args: string[]): GraphFlags {
  const flags: GraphFlags = {
    all: false,
    source: "derived",
    kind: "all",
    format: "text",
    diff: false,
    refresh: false,
    order: "up",
  };
  for (const arg of args) {
    if (arg === "--all") flags.all = true;
    else if (arg === "--diff") flags.diff = true;
    else if (arg === "--refresh" || arg === "--no-cache") flags.refresh = true;
    else if (arg === "-u" || arg === "--up") flags.order = "up";
    else if (arg === "-d" || arg === "--down") flags.order = "down";
    else if (arg.startsWith("--source="))
      flags.source = parseChoice("--source", arg.slice(9), SOURCES);
    else if (arg.startsWith("--kind="))
      flags.kind = parseChoice("--kind", arg.slice(7), KINDS);
    else if (arg.startsWith("--format="))
      flags.format = parseChoice("--format", arg.slice(9), FORMATS);
    else if (!arg.startsWith("-")) flags.repo = arg;
  }
  return flags;
}

/** Resolve the seed repo from an explicit arg, else the cwd repo. */
function resolveSeed(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const root = findInvocationRepoRoot();
  return root ? path.basename(root) : undefined;
}

/**
 * The connected component containing `seed`, traversed UNDIRECTED over ALL edge
 * kinds (including events). Unlike the startup closure (`den up`, sync + outgoing
 * only), this surfaces the full neighborhood — event producers/consumers like
 * control-plane and jobs-runtime included — which is what you want when reading
 * the graph.
 */
export function connectedComponent(
  graph: DerivedGraph,
  seed: string,
): DerivedGraph {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) =>
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  for (const e of graph.edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const seen = new Set([seed]);
  const queue = [seed];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of adj.get(cur) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return {
    nodes: graph.nodes.filter((n) => seen.has(n)),
    edges: graph.edges.filter((e) => seen.has(e.from) && seen.has(e.to)),
  };
}

/** Per-node "start: den|sibling (path)" annotations showing the boot location. */
export function bootAnnotations(nodes: string[]): Map<string, string> {
  const distRoot = getDistRoot();
  const home = os.homedir();
  // Systems with auto-start toggled OFF in the active workspace — workspace-wide
  // up won't start these; toggle in the web ⋮ menu or start explicitly.
  const ws = getActiveWorkspace();
  const noAutostart = ws
    ? noAutostartRepos(ws.config, readCatalog())
    : new Set<string>();
  // Build the derive context once and reuse it for every node — repoSource()
  // otherwise rebuilds it per call, re-reading/parsing den.yml + catalog +
  // workspaces from disk N times for an N-node graph.
  const ctx = buildContext();
  const ann = new Map<string, string>();
  for (const node of nodes) {
    const opt = noAutostart.has(node) ? "  ⏸ auto-start off" : "";
    const src = repoSource(node, ctx);
    if (!src) {
      ann.set(node, `(not found on disk)${opt}`);
      continue;
    }
    // Managed clones live under the den repo → home-relative (~/…); sibling
    // repos → relative to the den dir (../…). Full path otherwise.
    const rel = src.managed
      ? src.path.startsWith(home + path.sep)
        ? `~${src.path.slice(home.length)}`
        : src.path
      : path.relative(distRoot, src.path) || src.path;
    // A managed repo may be configured but not cloned yet — flag it so the
    // annotation reflects the configured mode, not a silent sibling fallback.
    const note = !src.exists
      ? src.managed
        ? " — not cloned"
        : " — missing"
      : "";
    ann.set(
      node,
      `${src.managed ? `${product().cli} managed` : "sibling repo"} (${rel}${note})${opt}`,
    );
  }
  return ann;
}

// ── command ──────────────────────────────────────────────────────────────────

export async function cmdGraph(args: string[]): Promise<void> {
  const flags = parseGraphFlags(args);
  const alias = loadAliasResolver();

  const seed = flags.all ? undefined : resolveSeed(flags.repo);
  const scoped = seed !== undefined && alias.knownRepos.has(seed);

  // Always derive the full graph; for a seed, narrow to its connected component
  // (full neighborhood, both directions, incl. events) — NOT the strict startup
  // closure that `den up` uses.
  const full = deriveGraph({ scope: "all", refresh: flags.refresh });

  // The repo the command is run from (independent of --all / explicit arg) —
  // marked with a leading `*`. Identified by repo IDENTITY (manifest name /
  // folder name), so it resolves from a sibling checkout or a managed clone.
  const cwd = resolveCwdRepo(alias);
  const currentRepo = cwd?.repo;
  const graph = scoped ? connectedComponent(full, seed) : full;

  if (flags.diff) {
    const declared = collectDeclaredEdges(graph.nodes, alias);
    const diffs = diffEdges(graph.edges, declared, graph.nodes);
    console.log(renderDiff(diffs));
    return;
  }

  // Choose the edge set per --source, then filter by --kind.
  let edges = graph.edges;
  if (flags.source !== "derived") {
    const declared = collectDeclaredEdges(graph.nodes, alias);
    edges =
      flags.source === "declared"
        ? declared
        : dedupeUnion(graph.edges, declared);
  }
  // Render nodes in the order `den up` (deps-first) or `down` (reverse) runs.
  const orderedNodes =
    flags.order === "down" ? orderForDown(graph) : orderForUp(graph);
  const filtered: DerivedGraph = {
    nodes: orderedNodes,
    edges: edges.filter((e) => edgeMatchesKind(e, flags.kind)),
  };

  if (flags.format === "json") {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  if (flags.format === "dot") {
    console.log(renderDot(filtered, nodePlacements(filtered.nodes)));
    return;
  }

  const scopeLabel = scoped ? `neighborhood: ${seed}` : "all";
  const cwdNote =
    currentRepo && filtered.nodes.includes(currentRepo)
      ? `  ·  ${chalk.bold.yellow.bgBlue("▸")} = current repo`
      : "";
  console.log(
    `${product().cli} dependency graph  (source: ${flags.source} · ${scopeLabel} · order: ${flags.order})${cwdNote}\n`,
  );
  console.log(
    renderText(filtered, {
      annotations: bootAnnotations(graph.nodes),
      currentRepo,
      placements: nodePlacements(graph.nodes),
    }),
  );
  console.log("\n" + renderTargetWarnings(graph.nodes));

  // Non-intrusive hint (stderr, pipe-safe): you're in a sibling checkout of a
  // managed repo, so den boots a different clone than the code you're
  // editing. Suggest switching — don't prompt or mutate from a read-only command.
  if (currentRepo && cwd) {
    const src = repoSource(currentRepo);
    if (src?.managed && path.resolve(src.path) !== path.resolve(cwd.root)) {
      console.error(
        chalk.gray(
          `\nℹ ${chalk.bold(currentRepo)} is managed (boots from ${src.path}),\n` +
            `  but you're in a sibling checkout (${cwd.root}).\n` +
            `  Run ${chalk.cyan(`${product().cli} use-local`)} to point ${product().cli} at this checkout` +
            ` (or ${chalk.cyan(`${product().cli} use-managed`)} to keep the managed clone).`,
        ),
      );
    }
  }
}

function dedupeUnion(
  derived: DerivedEdge[],
  declared: DerivedEdge[],
): DerivedEdge[] {
  const seen = new Set(derived.map((e) => `${edgeKey(e)}:${e.kind}`));
  const extra = declared.filter((e) => !seen.has(`${edgeKey(e)}:${e.kind}`));
  return [...derived, ...extra];
}

/** Commands a repo exposes: Makefile targets ∪ `.den.yml` commands.local keys. */
function availableCommands(repoPath: string): Set<string> {
  const cmds = new Set(listMakeTargets(repoPath).targets);
  const manifest = readManifest(repoPath);
  for (const svc of Object.values(manifest?.services ?? {})) {
    for (const env of Object.values(svc.commands ?? {})) {
      for (const name of Object.keys(env ?? {})) cmds.add(name);
    }
  }
  return cmds;
}

/**
 * Flag any node missing a den-driven command. A command counts as available
 * if it's a Makefile target OR declared in `.den.yml` commands.local (so
 * `down: opctl kill` satisfies "down" without a `make down` target).
 */
export function renderTargetWarnings(nodes: string[]): string {
  const warnings: string[] = [];
  for (const node of nodes) {
    const repoPath = resolveRepoPath(node);
    if (!repoPath) continue;
    const have = availableCommands(repoPath);
    const missing = REQUIRED_TARGETS.filter((t) => !have.has(t));
    if (missing.length)
      warnings.push(
        `  ${node}: missing ${missing.join(", ")} (no make target or ${product().manifestYml} command)`,
      );
  }
  return warnings.length
    ? `command gaps:\n${warnings.join("\n")}`
    : "commands: all nodes expose setup/up/down ✓";
}
