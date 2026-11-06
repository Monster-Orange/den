/**
 * The Local Dev graph's model: pure and DOM-free (like workspace-picker.js),
 * so it is unit-testable under Jest; graph.js and panel.js own the DOM.
 *
 * Input is what the page already loads for a workspace:
 *   services  /api/services rows      health  /api/health rows
 *   graph     /api/graph (repo edges)  apps    /api/applications .applications
 *   orgs      /api/orgs?repos=1        depsMap /api/workspaces/deps-check
 *
 * Placement (R13): each row may carry `runs` ("local" | "remote" | "none")
 * and `target` ({ env, account?, url? }, remote only). A row without them is
 * local with no target, so the graph works before the API sends them.
 */

/** Real card sizes; there is no shrink-to-fit. */
import { describeRollup, rollupRepo } from "./health-rollup.js";

export const SIZE = {
  detailed: { w: 236, h: 104 },
  compact: { w: 176, h: 52 },
};

const RUNS = ["local", "remote", "none"];

/** `runs`/`target` for a row, with the contract's fallbacks. */
export function placementOf(r) {
  const runs = RUNS.includes(r?.runs) ? r.runs : "local";
  const t = r?.target;
  const target =
    runs === "remote" && t && typeof t === "object" && typeof t.env === "string"
      ? t
      : null;
  return { runs, target };
}

// An org's color when the org config names none. Org labels are text, so
// only text tokens (each 4.5:1 on every ground) and mixes of two of them.
const PALETTE = [
  "var(--accent-text)",
  "var(--ok)",
  "color-mix(in oklab, var(--remote) 50%, var(--bad))",
  "var(--warn)",
  "var(--remote)",
  "color-mix(in oklab, var(--warn) 50%, var(--bad))",
  "color-mix(in oklab, var(--accent-text) 50%, var(--remote))",
  "var(--muted)",
];
function colorFor(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++)
    h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Build the model the graph and panel render from. */
export function buildModel({
  services = [],
  health = null,
  graph = {},
  apps = [],
  orgs = null,
  depsMap = {},
  workspace = "",
} = {}) {
  const appOfRepo = new Map();
  // Declared applications first, then a repo that is its own application.
  for (const a of apps || [])
    if (a.source === "declared")
      for (const r of a.repos || []) if (!appOfRepo.has(r)) appOfRepo.set(r, a);
  for (const a of apps || [])
    for (const r of a.repos || []) if (!appOfRepo.has(r)) appOfRepo.set(r, a);
  const list = services.map((r) => {
    const a = appOfRepo.get(r.repo);
    return {
      id: r.address,
      name: r.service,
      repo: r.repo,
      org: orgs?.repos?.[r.repo] || "",
      app: a ? a.title || a.name : r.repo,
      ...placementOf(r),
      // No health round has reached it yet (0.3.0-dev.40): "checking…".
      health: { ok: null, checked: false },
      open: null,
      entry: !!r.isEntrypoint,
      infra: !!r.infra,
      commands: r.commands || [],
      deps: (r.deps || []).filter((d) => d !== r.address),
      branch: r.branch || null,
      autostart: r.autostart !== false,
      mode: r.mode,
      path: r.repoPath || "",
      logs: r.logs ?? null,
      cloned: r.cloned !== false,
      manifestLayers: r.manifestLayers || [],
      owners: r.owners || [],
      inWorkspaces: r.inWorkspaces || [],
      missing: depsMap[r.address] || [],
      hasPlacement: "runs" in r,
    };
  });
  const byId = new Map(list.map((s) => [s.id, s]));
  // A dep is an address, or a bare service name inside the same repo.
  for (const s of list)
    s.deps = s.deps
      .map((d) =>
        byId.has(d) ? d : byId.has(`${s.repo}/${d}`) ? `${s.repo}/${d}` : d,
      )
      .filter((d) => d !== s.id);
  const byRepo = new Map();
  for (const s of list) {
    if (!byRepo.has(s.repo)) byRepo.set(s.repo, []);
    byRepo.get(s.repo).push(s);
  }
  const orgList = new Map();
  for (const o of orgs?.orgs || [])
    orgList.set(o.id, {
      id: o.id,
      label: o.label || o.id,
      color: o.color || colorFor(o.id),
    });
  const m = {
    workspace,
    services: list,
    byId,
    byRepo,
    edges: (graph?.edges || []).filter(
      (e) => byRepo.has(e.from) && byRepo.has(e.to) && e.from !== e.to,
    ),
    orgs: orgList,
    apps: apps || [],
    mixed: false,
  };
  // null: no health round yet, so every card says "checking…".
  if (health) applyHealth(m, health);
  return m;
}

/** Fold /api/health rows into the model (health, open link, placement). */
export function applyHealth(m, results) {
  const byKey = new Map(
    (results || []).map((h) => [`${h.repo}/${h.service}`, h]),
  );
  for (const s of m.services) {
    // Health rows name repo + service; a single-service repo's address is the bare repo.
    const h = byKey.get(`${s.repo}/${s.name}`) || byKey.get(s.id);
    // A round without a row for it still counts as its first check.
    if (!h) {
      s.health = { ...s.health, checked: true };
      continue;
    }
    s.health = {
      checked: true,
      ok: h.ok === true ? true : h.ok === false ? false : null,
      label: h.label,
      url: h.url ?? null,
      check: h.check ?? null,
      error: h.error ?? null,
      status: h.status ?? null,
      ms:
        typeof h.ms === "number"
          ? h.ms
          : typeof h.durationMs === "number"
            ? h.durationMs
            : null,
    };
    s.open = h.openUrl && /^https?:/.test(h.openUrl) ? h.openUrl : s.open;
    if (!s.hasPlacement && "runs" in h) Object.assign(s, placementOf(h));
  }
  m.mixed = new Set(m.services.map((s) => s.runs)).size > 1;
  return m;
}

export const orgOf = (m, id) =>
  m.orgs.get(id) || {
    id,
    label: id || m.workspace || "Workspace",
    color: "var(--muted)",
  };
export const isLocal = (s) => s.runs !== "remote";
export const status = (s) =>
  s.health.ok === true ? "ok" : s.health.ok === false ? "bad" : "unk";
export const statusWord = (s) =>
  s.health.ok === true ? "healthy" : s.health.ok === false ? "down" : "unknown";

/** local | remote | hybrid | none for a repo's services. */
export function repoPlacement(m, repo) {
  const p = new Set((m.byRepo.get(repo) || []).map((s) => s.runs));
  return p.size > 1 ? "hybrid" : [...p][0] || "local";
}

export function placementText(s) {
  if (s.runs === "remote")
    return `☁ ${s.target?.env || "remote"}${s.target?.account ? " · " + s.target.account : ""}`;
  if (s.runs === "none") return "no runtime";
  return "⌂ local";
}

export const placeGlyph = (p) =>
  p === "remote" ? "☁" : p === "hybrid" ? "⇄" : p === "local" ? "⌂" : "";

export const remoteWhy = (s) =>
  `runs in ${s.target?.env || "a remote env"}${s.target?.account ? " (" + s.target.account + ")" : ""}; nothing to start here`;

export const fmtMs = (ms) =>
  ms == null ? "" : ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : ms + " ms";

export function healthLine(s) {
  // Before the first health round, as the Workspaces table says (dev.37).
  if (s.health.checked === false) return "checking…";
  const ms = s.health.ms != null ? " · " + fmtMs(s.health.ms) : "";
  if (s.runs === "remote")
    return (
      (s.health.ok === false
        ? "unreachable"
        : s.health.ok
          ? "reachable"
          : "not checked") + ms
    );
  if (s.health.ok == null) return "no health check";
  return (s.health.ok ? "healthy" : "down") + ms;
}

/**
 * A repo's health from its services: health-rollup.js's rule, the one the
 * header row and `<cli> status` use, so a repo card never disagrees with
 * them. Unchecked services don't count.
 */
export function repoRollup(m, repo) {
  return rollupRepo(
    repo,
    (m.byRepo.get(repo) || []).map((s) => ({
      service: s.name,
      ok: s.health.ok,
      isEntrypoint: s.entry,
    })),
  );
}

/** The rollup as a .dg-dot class, and in words. */
export const repoStatus = (r) =>
  ({ down: "bad", degraded: "warn", ok: "ok", unknown: "unk" })[r.state];
export const repoStatusWord = (r) => describeRollup(r);

/** A repo's representative service: entrypoint, root-named, else first. */
export function entryOf(m, repo) {
  const l = m.byRepo.get(repo) || [];
  return l.find((s) => s.entry) || l.find((s) => s.name === repo) || l[0];
}

/**
 * Find (the Graph page's, and the Workspaces table's, R24d): does `key` (a
 * service address, "repo:<name>", or a repo name) match the query? Case
 * apart, a substring; an empty query matches nothing (nothing is a hit).
 */
export function findHit(key, query) {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  return !!q && String(key).toLowerCase().includes(q);
}

export const isCollapsed = (m, collapsed, repo) =>
  collapsed.has(repo) && (m.byRepo.get(repo)?.length || 0) > 1;
export const nodeFor = (m, collapsed, id) => {
  const s = m.byId.get(id);
  return s && isCollapsed(m, collapsed, s.repo) ? "repo:" + s.repo : id;
};

const KIND = { hard: "hard", soft: "soft", event: "event" };

/** Display edges: repo edges between entry services, plus intra-repo deps. */
export function edgeModel(m, collapsed) {
  const out = new Map();
  const add = (a, b, kind) => {
    const from = nodeFor(m, collapsed, a.id),
      to = nodeFor(m, collapsed, b.id);
    if (from === to) return;
    const k = from + ">" + to;
    if (!out.has(k)) out.set(k, { from, to, kind, cross: a.runs !== b.runs });
  };
  for (const e of m.edges)
    add(entryOf(m, e.from), entryOf(m, e.to), KIND[e.blocking] || "soft");
  for (const s of m.services)
    for (const d of s.deps) {
      const t = m.byId.get(d);
      if (t && t.repo === s.repo) add(s, t, "intra");
    }
  return [...out.values()];
}

/** The ELK graph: outer group (org or application) › repo › service. */
/**
 * A compound node's minimum size, as elk.nodeSize.minimum. ELK's layered
 * layout with INCLUDE_CHILDREN reads a compound node's minimum in its own
 * layout axes: top-down, the first value bounds the height and the second
 * the width. Passed as (width, height) there, a repo box's minimum width
 * (386px) became its height, and a box with one row of cards drew about
 * twice the height it needs (a consumer's dev.32 finding). So top-down
 * swaps the pair; left-right it is (width, height) as written.
 */
export function groupMinimum(w, h, direction = "down") {
  return direction === "right" ? `(${w},${h})` : `(${h},${w})`;
}

export function buildElkGraph(
  m,
  {
    direction = "down",
    group = "org",
    density = "detailed",
    collapsed = new Set(),
  } = {},
) {
  const sz = SIZE[density] || SIZE.detailed;
  const outer = new Map();
  for (const s of m.services) {
    const key = group === "app" ? s.app : s.org || "";
    if (!outer.has(key)) outer.set(key, new Set());
    outer.get(key).add(s.repo);
  }
  const parent = {};
  const children = [];
  for (const [key, repos] of outer) {
    const gid = "grp:" + key;
    const kids = [];
    for (const r of repos) {
      const svcs = m.byRepo.get(r);
      if (svcs.length === 1) {
        kids.push({ id: svcs[0].id, width: sz.w, height: sz.h });
        parent[svcs[0].id] = gid;
      } else if (isCollapsed(m, collapsed, r)) {
        kids.push({ id: "repo:" + r, width: sz.w, height: sz.h });
        parent["repo:" + r] = gid;
      } else {
        const rid = "rg:" + r;
        parent[rid] = gid;
        kids.push({
          id: rid,
          layoutOptions: {
            "elk.padding": "[top=40,left=14,bottom=14,right=14]",
            "elk.nodeSize.constraints": "MINIMUM_SIZE",
            "elk.nodeSize.minimum": groupMinimum(sz.w + 150, 40, direction),
          },
          children: svcs.map((s) => {
            parent[s.id] = rid;
            return { id: s.id, width: sz.w, height: sz.h };
          }),
        });
      }
    }
    children.push({
      id: gid,
      layoutOptions: { "elk.padding": "[top=46,left=18,bottom=18,right=18]" },
      children: kids,
    });
    parent[gid] = "root";
  }
  const root = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "right" ? "RIGHT" : "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "54",
      "elk.spacing.nodeNode": "26",
      "elk.spacing.componentComponent": "48",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.padding": "[top=10,left=10,bottom=10,right=10]",
      "elk.spacing.edgeNode": "18",
      "elk.layered.spacing.edgeNodeBetweenLayers": "18",
    },
    children,
    edges: [],
  };
  // Each edge lives on its endpoints' lowest common ancestor.
  const anc = (id) => {
    const a = [];
    let c = id;
    while (c && c !== "root") {
      c = parent[c];
      a.push(c || "root");
    }
    return a;
  };
  const lca = (a, b) => {
    const B = new Set(anc(b));
    return anc(a).find((x) => B.has(x)) || "root";
  };
  const find = (n, id) => {
    if (n.id === id) return n;
    for (const c of n.children || []) {
      const f = find(c, id);
      if (f) return f;
    }
    return null;
  };
  edgeModel(m, collapsed).forEach((e, i) => {
    const c = lca(e.from, e.to);
    const host = c === "root" ? root : find(root, c);
    (host.edges ||= []).push({
      id: "e" + i,
      sources: [e.from],
      targets: [e.to],
      _m: e,
    });
  });
  return root;
}

// ── Wrapping the top-level groups (0.3.0-dev.34) ─────────────────────────
// A consumer's distribution with 31 services in 10 org groups: one layered
// layout put every top-level group in one row (top-down), so the whole
// graph fitted only at 15–24%, where cards are hard to read. ELK's own
// options did not help: with INCLUDE_CHILDREN the root is one layered
// graph, and elk.aspectRatio (its component packing) left the row as it
// was. So each top-level group is laid out on its own, by the same layered
// layout with the same options (a group's inside is as before), the groups
// are wrapped into rows (top-down) or columns (left-right) sized for the
// stage, and the few edges between groups are routed here, orthogonally,
// through the gaps between rows (or columns).

/** Gap between wrapped groups: elk.spacing.componentComponent. */
export const GROUP_GAP = 48;

/**
 * Split buildElkGraph's root into one ELK graph per top-level group (the
 * root's options, the group, the edges inside it) and the edges between
 * groups (the root's own). Groups are ordered so that an edge's source
 * comes first where the edges allow (stable otherwise): in reading order
 * a dependency then sits after, below or to the right of, its user, as the
 * layered layout puts it.
 */
export function splitTopLevel(root) {
  const groups = root.children || [];
  const cross = root.edges || [];
  const groupOf = new Map();
  (function index(n, top) {
    for (const c of n.children || []) {
      const t = top ?? c.id;
      groupOf.set(c.id, t);
      index(c, t);
    }
  })(root, null);
  const idx = new Map(groups.map((g, i) => [g.id, i]));
  const after = groups.map(() => new Set());
  const indeg = groups.map(() => 0);
  for (const e of cross) {
    const a = idx.get(groupOf.get(e.sources[0]));
    const b = idx.get(groupOf.get(e.targets[0]));
    if (a == null || b == null || a === b || after[a].has(b)) continue;
    after[a].add(b);
    indeg[b]++;
  }
  const order = [];
  const done = new Set();
  while (order.length < groups.length) {
    // The first group with nothing before it; on a cycle, the first left.
    let i = groups.findIndex((_, k) => !done.has(k) && indeg[k] === 0);
    if (i < 0) i = groups.findIndex((_, k) => !done.has(k));
    done.add(i);
    order.push(i);
    for (const b of after[i]) indeg[b]--;
  }
  return {
    parts: order.map((i) => ({
      id: "root",
      layoutOptions: root.layoutOptions,
      children: [groups[i]],
      edges: [],
    })),
    cross,
    groupOf,
  };
}

/**
 * Wrap groups of the given sizes, in order, into rows (direction "down")
 * or columns ("right"), choosing the wrap that lets the whole fit the
 * area (width × height) at the highest zoom. Returns each group's place
 * ({ x, y, band }) and the size of the whole ({ w, h }), from 0,0.
 * Without an area, a 16:10 one.
 */
export function packGroups(
  sizes,
  { direction = "down", width = 1600, height = 1000, gap = GROUP_GAP } = {},
) {
  const down = direction !== "right";
  // Along: the axis a row runs along (x top-down); across: the other.
  const along = sizes.map((s) => (down ? s.w : s.h));
  const across = sizes.map((s) => (down ? s.h : s.w));
  const lay = (limit) => {
    const pos = [];
    let a = 0,
      c = 0,
      band = 0,
      depth = 0,
      maxA = 0;
    along.forEach((len, i) => {
      if (a > 0 && a + gap + len > limit) {
        c += depth + gap;
        a = 0;
        depth = 0;
        band++;
      }
      const at = a > 0 ? a + gap : 0;
      pos.push({ a: at, c, band });
      a = at + len;
      depth = Math.max(depth, across[i]);
      maxA = Math.max(maxA, a);
    });
    return { pos, A: maxA, C: c + depth };
  };
  // Every row width a greedy wrap can end on: a run of consecutive groups.
  const limits = new Set();
  for (let i = 0; i < along.length; i++) {
    let w = 0;
    for (let j = i; j < along.length; j++) {
      w += (j > i ? gap : 0) + along[j];
      limits.add(w);
    }
  }
  // Widest first, so a tie keeps fewer rows.
  let best = null;
  for (const limit of [...limits].sort((x, y) => y - x)) {
    const l = lay(limit);
    const W = down ? l.A : l.C,
      H = down ? l.C : l.A;
    const z = Math.min(width / Math.max(W, 1), height / Math.max(H, 1));
    if (!best || z > best.z + 1e-9) best = { z, l, W, H };
  }
  if (!best) return { pos: [], w: 0, h: 0 };
  return {
    pos: best.l.pos.map((p) => ({
      x: down ? p.a : p.c,
      y: down ? p.c : p.a,
      band: p.band,
    })),
    w: best.W,
    h: best.H,
  };
}

/**
 * An edge between two wrapped groups, as orthogonal points. s and t are
 * the endpoint cards' boxes ({ x, y, w, h }); sBand and tBand their
 * groups' row (or column) spans across the wrap ({ from, to, band }).
 * A target in a later row: down out of the source, along the gap above
 * the target's row, down into the target. In an earlier row: up, along
 * the gap above the source's row, up into the target's foot. In the same
 * row: out of the facing side, across the gap between them. Left-right
 * is the same with the axes swapped.
 */
export function routeCross(
  s,
  t,
  sBand,
  tBand,
  direction = "down",
  gap = GROUP_GAP,
) {
  const down = direction !== "right";
  // Work top-down; swap axes for left-right and swap back at the end.
  const sw = (b) => (down ? b : { x: b.y, y: b.x, w: b.h, h: b.w });
  const S = sw(s),
    T = sw(t);
  const scx = S.x + S.w / 2,
    tcx = T.x + T.w / 2;
  let pts;
  if (tBand.band > sBand.band) {
    const mid = tBand.from - gap / 2;
    pts = [
      [scx, S.y + S.h],
      [scx, mid],
      [tcx, mid],
      [tcx, T.y],
    ];
  } else if (tBand.band < sBand.band) {
    const mid = sBand.from - gap / 2;
    pts = [
      [scx, S.y],
      [scx, mid],
      [tcx, mid],
      [tcx, T.y + T.h],
    ];
  } else {
    const right = T.x >= S.x + S.w;
    const sx = right ? S.x + S.w : S.x,
      tx = right ? T.x : T.x + T.w;
    const sy = S.y + S.h / 2,
      ty = T.y + T.h / 2;
    const mid = (sx + tx) / 2;
    pts = [
      [sx, sy],
      [mid, sy],
      [mid, ty],
      [tx, ty],
    ];
  }
  return down ? pts : pts.map(([x, y]) => [y, x]);
}

/** Manifest commands that destroy state confirm inline, in Careful. */
export const DANGER_CMD = /reset|drop|wipe|clean|destroy|purge/;
export const commandTier = (cmd) =>
  DANGER_CMD.test(cmd) ? "danger" : "commands";

export const TIERS = ["common", "commands", "tools", "danger"];

/**
 * Tiering: the primary is the first action whose primaryWhen holds (and is
 * enabled); up to two common actions sit beside it; everything else goes in
 * More, grouped by tier.
 */
export function resolveActions(actions, x, kind) {
  const all = actions.filter((a) => a.for.includes(kind) && a.when(x));
  const primary =
    all.find((a) => a.primaryWhen?.(x) && !a.disabled?.(x)) || null;
  const common = all
    .filter((a) => a.tier === "common" && a !== primary)
    .slice(0, 2);
  const rest = all.filter((a) => a !== primary && !common.includes(a));
  const groups = TIERS.map((t) => [t, rest.filter((a) => a.tier === t)]).filter(
    ([, l]) => l.length,
  );
  return { primary, common, groups, all };
}

/** Service ids (or repo:<r> node keys) adjacent to a node. */
export function neighbours(edges, id) {
  const set = new Set([id]);
  for (const e of edges) {
    if (e.from === id) set.add(e.to);
    if (e.to === id) set.add(e.from);
  }
  return set;
}

/** Depends on / Used by for a service or a repo ({ repo, services }). */
export function connections(m, x) {
  if (x.services) {
    return {
      deps: m.edges
        .filter((e) => e.from === x.repo)
        .map((e) => ({ repo: e.to })),
      users: m.edges
        .filter((e) => e.to === x.repo)
        .map((e) => ({ repo: e.from })),
    };
  }
  const s = x;
  const isEntry = entryOf(m, s.repo)?.id === s.id;
  const intraDeps = s.deps.filter((d) => m.byId.get(d)?.repo === s.repo);
  const usedBy = m.services
    .filter((o) => o.repo === s.repo && o.deps.includes(s.id))
    .map((o) => o.id);
  const repoOut = isEntry
    ? m.edges.filter((e) => e.from === s.repo).map((e) => entryOf(m, e.to).id)
    : [];
  const repoIn = isEntry
    ? m.edges.filter((e) => e.to === s.repo).map((e) => entryOf(m, e.from).id)
    : [];
  return {
    deps: [...new Set([...intraDeps, ...repoOut])].map((id) => ({ id })),
    users: [...new Set([...usedBy, ...repoIn])].map((id) => ({ id })),
  };
}

/**
 * The Graph page with the top bar's "All active" (0.3.0-dev.33): every
 * workspace in view, as the Services page shows them (one /api/services
 * list, a service several define listed once with `inWorkspaces`). The
 * per-workspace /api/graph, /api/applications and deps-check payloads
 * are merged here, in view order (focus first):
 *
 *   graph    nodes and `order` once each, in first-seen order; an edge
 *            once per from → to and kind (the first workspace's)
 *   apps     one per name, its repos the union
 *   depsMap  an address's missing deps, the union
 */
export function mergeWorkspaceViews({
  graphs = [],
  apps = [],
  deps = [],
} = {}) {
  const nodes = [];
  const order = [];
  const edges = [];
  const seenEdge = new Set();
  const once = (arr, v) => {
    if (!arr.includes(v)) arr.push(v);
  };
  for (const g of graphs) {
    for (const n of g?.nodes || []) once(nodes, n);
    for (const n of g?.order || []) once(order, n);
    for (const e of g?.edges || []) {
      const k = `${e.from}\u0000${e.to}\u0000${e.kind}`;
      if (seenEdge.has(k)) continue;
      seenEdge.add(k);
      edges.push(e);
    }
  }
  const byName = new Map();
  for (const list of apps)
    for (const a of list || []) {
      const had = byName.get(a.name);
      if (!had) {
        byName.set(a.name, { ...a, repos: [...(a.repos || [])] });
        continue;
      }
      for (const r of a.repos || []) once(had.repos, r);
    }
  const depsMap = {};
  for (const list of deps)
    for (const { address, missingDeps } of list || []) {
      const had = (depsMap[address] ||= []);
      for (const d of missingDeps || []) once(had, d);
    }
  return {
    graph: { nodes, edges, ...(order.length ? { order } : {}) },
    apps: [...byName.values()],
    depsMap,
  };
}

/** Each repo's owning workspace (the first in view that defines it). */
export function ownerOfRepos(services = []) {
  const out = new Map();
  for (const s of services)
    if (!out.has(s.repo) && s.inWorkspaces?.length)
      out.set(s.repo, s.inWorkspaces[0]);
  return out;
}
