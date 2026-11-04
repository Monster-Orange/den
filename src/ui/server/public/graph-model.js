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

const PALETTE = [
  "#58a6ff",
  "#3fb950",
  "#a371f7",
  "#d29922",
  "#f0883e",
  "#ff7b72",
  "#79c0ff",
  "#56d364",
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
  health = [],
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
      health: { ok: null },
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
  applyHealth(m, health);
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
    if (!h) continue;
    s.health = {
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
    color: "#8b949e",
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

/** A repo's representative service: entrypoint, root-named, else first. */
export function entryOf(m, repo) {
  const l = m.byRepo.get(repo) || [];
  return l.find((s) => s.entry) || l.find((s) => s.name === repo) || l[0];
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
            "elk.nodeSize.minimum": "(" + (sz.w + 150) + ",40)",
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
