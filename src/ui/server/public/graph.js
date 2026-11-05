/**
 * The Local Dev graph: an ELK layered layout (elkjs, vendored and served by
 * Den at /vendor/elk.bundled.js) of HTML cards over an SVG edge layer, with
 * org/app › repo › service frames, pan and zoom, focus, find, and the
 * details panel (panel.js).
 *
 *   mountGraph(host, data, hooks)   draw into `host` (#dep-graph-wrap)
 *   graphHealth(results)            fold a /api/health update in place
 *
 * `data` is what local-dev.html loads for the viewed workspace (see
 * graph-model.js buildModel). `hooks` are the page's existing actions
 * (runCmd, upWithDeps, openEditor, …) so the graph reuses the same calls.
 *
 * View state (selection, collapsed repos, pan/zoom) lives at module level so
 * a re-render after an action keeps it. Layout preferences are remembered in
 * the user config through /api/settings and mirrored to localStorage.
 */
import {
  applyHealth,
  buildElkGraph,
  buildModel,
  edgeModel,
  entryOf,
  healthLine,
  isCollapsed,
  neighbours,
  nodeFor,
  orgOf,
  placementText,
  repoPlacement,
  repoRollup,
  repoStatus,
  repoStatusWord,
  status,
  statusWord,
} from "/graph-model.js";
import {
  actBtn,
  actionsFor,
  bindPanel,
  disposePanel,
  esc,
  renderPanel,
  runAction,
} from "/panel.js";

const LS = "__DEN_CLI__-graph:";
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(LS + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(LS + k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};
const DEFAULTS = {
  direction: "down",
  group: "org",
  density: "detailed",
  panelWidth: 440,
};
const saved = store.get("prefs", DEFAULTS);

const st = {
  dir: saved.direction || "down",
  group: saved.group || "org",
  density: saved.density || "detailed",
  panelW: saved.panelWidth || 440,
  popped: false,
  tab: null,
  collapsed: new Set(store.get("collapsed", [])),
  sel: null,
  q: "",
  z: 1,
  tx: 24,
  ty: 24,
  fitted: false,
};
let M = null;
let hooks = {};
let host = null;
let layoutAbs = {};
let edges = [];
let elk = null;
let renderSeq = 0;
let prefsLoaded = false;
// The floor of the last fit while the view is still the automatic one; null
// once the user pans or zooms. A viewport that changes size (Local Dev's
// output panel opening below it) re-fits an automatic view, so cards never
// sit under the panel; a view the user moved is left where they put it.
let autoFit = null;
let vpObserver = null;

const $ = (s, el = host) => el?.querySelector(s);
const zoomFloor = 0.35;

bindPanel({
  model: () => M,
  st,
  get hooks() {
    return hooks;
  },
  toast,
  selectTab: (id) => {
    st.tab = id;
    if (st.sel) openDetail(st.sel, true);
  },
  focusOn: (sel) => focusOn(sel),
  recheck,
});

// ── prefs ────────────────────────────────────────────────────────────────
function prefs() {
  return {
    direction: st.dir,
    group: st.group,
    density: st.density,
    panelWidth: st.panelW,
  };
}
function savePrefs() {
  store.set("prefs", prefs());
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph: prefs() }),
  }).catch(() => {});
}
function loadServerPrefs() {
  if (prefsLoaded) return;
  prefsLoaded = true;
  fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const g = d?.graph;
      if (!g) return;
      const before = JSON.stringify(prefs());
      st.dir = g.direction;
      st.group = g.group;
      st.density = g.density;
      st.panelW = g.panelWidth;
      store.set("prefs", prefs());
      if (JSON.stringify(prefs()) !== before && host?.isConnected) {
        syncControls();
        render().then(() => fit(0.6));
      }
    })
    .catch(() => {});
}

// ── ELK (vendored; loaded once, on first draw) ───────────────────────────
let elkLoading = null;
function loadElk() {
  if (window.ELK) return Promise.resolve();
  elkLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/elk.bundled.js";
    s.onload = () => resolve();
    s.onerror = () => {
      elkLoading = null;
      reject(new Error("layout library did not load"));
    };
    document.head.appendChild(s);
  });
  return elkLoading;
}

// ── mount ────────────────────────────────────────────────────────────────
export function mountGraph(el, data, pageHooks) {
  hooks = pageHooks || {};
  host = el;
  M = buildModel(data);
  // Drop view state for things that left the workspace.
  for (const r of [...st.collapsed])
    if (!M.byRepo.has(r)) st.collapsed.delete(r);
  if (
    st.sel &&
    !(st.sel.repo ? M.byRepo.has(st.sel.repo) : M.byId.has(st.sel.id))
  )
    st.sel = null;
  el.innerHTML = `<div class="dg">
    <div class="dg-bar" role="toolbar" aria-label="Graph view options">
      <div class="dg-ctl"><span>Layout</span><div class="dg-seg" data-seg="dir"><button data-v="down">Top-down</button><button data-v="right">Left-right</button></div></div>
      <div class="dg-ctl"><span>Group</span><div class="dg-seg" data-seg="group"><button data-v="org">Org</button><button data-v="app">Application</button></div></div>
      <div class="dg-ctl"><span>Cards</span><div class="dg-seg" data-seg="density"><button data-v="detailed">Detailed</button><button data-v="compact">Compact</button></div></div>
      <div class="dg-ctl"><div class="dg-seg" data-expand><button data-v="all">Expand all</button><button data-v="none">Collapse all</button></div></div>
      <div class="dg-spacer"></div>
      <label class="dg-ctl"><span>Find</span><input type="search" data-find placeholder="service, repo…" autocomplete="off" value="${esc(st.q)}"></label>
    </div>
    <div class="dg-stage">
      <div class="dg-vp" tabindex="0" aria-label="Service graph. Drag to pan, scroll to move, Ctrl or Cmd + scroll to zoom.">
        <div class="dg-world"><svg aria-hidden="true"></svg></div>
        <div class="dg-legend"></div>
        <div class="dg-zoom" role="group" aria-label="Zoom"><button data-z="out" aria-label="Zoom out">−</button><button data-z="100" aria-label="Reset zoom to 100%">100%</button><button data-z="in" aria-label="Zoom in">+</button><button data-z="fit">Fit</button></div>
      </div>
      <aside class="dg-panel" hidden aria-label="Details"></aside>
    </div>
  </div>`;
  wire();
  syncControls();
  loadServerPrefs();
  render().then(() => {
    if (!st.fitted) {
      fit(0.6);
      st.fitted = true;
    } else applyView();
    if (st.sel) openDetail(st.sel, true);
  });
}

/** A /api/health update: refresh dots, health lines and the open panel in place. */
export function graphHealth(results) {
  if (!M || !host?.isConnected) return;
  applyHealth(M, results);
  for (const c of host.querySelectorAll(".dg-card")) {
    if (c.dataset.id && M.byId.has(c.dataset.id))
      c.innerHTML = cardInner(M.byId.get(c.dataset.id));
    else if (c.dataset.repo && M.byRepo.has(c.dataset.repo)) {
      c.innerHTML = repoCardInner(c.dataset.repo);
      const s = repoRollup(M, c.dataset.repo).state;
      c.classList.toggle("down", s === "down");
      c.classList.toggle("degraded", s === "degraded");
    }
  }
  for (const g of host.querySelectorAll(".dg-grp.dg-org"))
    g.querySelector(".roll").textContent = rollup(groupServices(g.dataset.key));
  legend();
  applyFocus();
  // The Logs tab holds a live stream; leave it alone.
  if (st.sel && st.tab !== "logs" && !openMenus().length)
    openDetail(st.sel, true);
}

// ── render ───────────────────────────────────────────────────────────────
async function render() {
  const seq = ++renderSeq;
  const world = $(".dg-world");
  try {
    await loadElk();
  } catch {
    world
      .querySelectorAll(".dg-grp,.dg-card,.dg-msg")
      .forEach((n) => n.remove());
    world.insertAdjacentHTML(
      "beforeend",
      '<div class="dg-msg">The graph layout library did not load. Reload the page; if it persists, reinstall __DEN_CLI__.</div>',
    );
    return;
  }
  elk ||= new window.ELK();
  const root = buildElkGraph(M, {
    direction: st.dir,
    group: st.group,
    density: st.density,
    collapsed: st.collapsed,
  });
  const meta = new Map();
  (function walk(n) {
    for (const e of n.edges || []) meta.set(e.id, e._m);
    (n.children || []).forEach(walk);
  })(root);
  const res = await elk.layout(root);
  if (seq !== renderSeq || !world.isConnected) return; // a newer render won
  world.querySelectorAll(".dg-grp,.dg-card,.dg-msg").forEach((n) => n.remove());
  edges = edgeModel(M, st.collapsed);
  layoutAbs = {};
  const frag = document.createDocumentFragment();
  const paths = [];
  let maxX = 0,
    maxY = 0;
  (function walk(n, ox, oy) {
    const x = ox + (n.x || 0),
      y = oy + (n.y || 0);
    if (n.id !== "root") {
      layoutAbs[n.id] = { x, y, w: n.width, h: n.height };
      maxX = Math.max(maxX, x + n.width);
      maxY = Math.max(maxY, y + n.height);
    }
    if (n.id.startsWith("grp:"))
      frag.appendChild(groupEl(n.id.slice(4), x, y, n.width, n.height));
    else if (n.id.startsWith("rg:"))
      frag.appendChild(repoGroupEl(n.id.slice(3), x, y, n.width, n.height));
    else if (n.id.startsWith("repo:"))
      frag.appendChild(repoCard(n.id.slice(5), x, y, n.width, n.height));
    else if (M.byId.has(n.id))
      frag.appendChild(card(M.byId.get(n.id), x, y, n.width, n.height));
    for (const e of n.edges || []) {
      const m = meta.get(e.id);
      // ELK gives edge coordinates relative to the edge's container.
      const cont =
        e.container && e.container !== n.id && layoutAbs[e.container]
          ? layoutAbs[e.container]
          : { x: n.id === "root" ? 0 : x, y: n.id === "root" ? 0 : y };
      for (const sct of e.sections || []) {
        const pts = [
          sct.startPoint,
          ...(sct.bendPoints || []),
          sct.endPoint,
        ].map((p) => [p.x + cont.x, p.y + cont.y]);
        paths.push({ d: roundPath(pts), m });
      }
    }
    for (const c of n.children || []) walk(c, x, y);
  })(res, 0, 0);
  world.appendChild(frag);
  const svg = $(".dg-world > svg");
  svg.setAttribute("width", maxX + 20);
  svg.setAttribute("height", maxY + 20);
  const MK = {
    intra: "var(--muted)",
    hard: "var(--accent)",
    soft: "var(--muted)",
    event: "var(--dg-event)",
    cross: "var(--remote)",
  };
  svg.innerHTML =
    `<defs>${Object.entries(MK)
      .map(
        ([k, c]) =>
          `<marker id="dg-ah-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:${c}"/></marker>`,
      )
      .join("")}</defs>` +
    paths
      .map(({ d, m }) => {
        const k = m.cross ? "cross" : m.kind;
        return `<path class="dg-e ${k}" data-f="${esc(m.from)}" data-t="${esc(m.to)}" d="${d}" marker-end="url(#dg-ah-${k})"/>`;
      })
      .join("");
  world.style.width = maxX + 20 + "px";
  world.style.height = maxY + 20 + "px";
  legend();
  applyFocus();
}

function roundPath(pts) {
  if (pts.length < 3) return "M" + pts.map((p) => p.join(",")).join(" L");
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1],
      [x, y] = pts[i],
      [nx, ny] = pts[i + 1];
    const r = Math.min(
      8,
      Math.hypot(x - px, y - py) / 2,
      Math.hypot(nx - x, ny - y) / 2,
    );
    const a = [x - Math.sign(x - px) * r, y - Math.sign(y - py) * r],
      b = [x + Math.sign(nx - x) * r, y + Math.sign(ny - y) * r];
    d += ` L${a[0]},${a[1]} Q${x},${y} ${b[0]},${b[1]}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l[0]},${l[1]}`;
}
function place(el, x, y, w, h) {
  Object.assign(el.style, {
    left: x + "px",
    top: y + "px",
    width: w + "px",
    height: h + "px",
  });
  return el;
}

const groupServices = (key) =>
  M.services.filter((s) =>
    st.group === "org" ? (s.org || "") === key : s.app === key,
  );
const rollup = (svcs) =>
  `${svcs.filter((s) => s.health.ok).length}/${svcs.length} healthy`;
function groupEl(key, x, y, w, h) {
  const el = document.createElement("div");
  el.className = "dg-grp dg-org";
  el.dataset.key = key;
  const svcs = groupServices(key);
  const o =
    st.group === "org"
      ? orgOf(M, key)
      : { label: key, color: orgOf(M, svcs[0]?.org).color };
  el.style.setProperty("--oc", o.color);
  const repos = [...new Set(svcs.map((s) => s.repo))];
  const where = new Set(svcs.map((s) => s.runs));
  const glyph = (r) =>
    ({ remote: " ☁", hybrid: " ⇄" })[repoPlacement(M, r)] || "";
  const sub =
    st.group === "app"
      ? repos.map((r) => r + (M.mixed ? glyph(r) || " ⌂" : "")).join(" · ")
      : `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
  el.innerHTML = `<div class="dg-ghead"><b>${esc(o.label)}</b><span class="meta">${esc(sub)}</span>${where.size > 1 ? '<span class="dg-badge hybrid">⇄ hybrid</span>' : ""}<span class="roll">${rollup(svcs)}</span></div>`;
  return place(el, x, y, w, h);
}
function repoGroupEl(r, x, y, w, h) {
  const el = document.createElement("div");
  const svcs = M.byRepo.get(r);
  el.className =
    "dg-grp dg-repo" +
    (svcs.some((s) => s.runs === "remote") ? " has-remote" : "");
  el.dataset.repo = r;
  const branch = svcs[0].branch ? `⎇ ${svcs[0].branch} · ` : "";
  el.innerHTML = `<div class="dg-ghead"><button class="dg-gname" data-goto-repo-panel="${esc(r)}" title="Repo details">${esc(r)}</button><span class="meta">${esc(branch)}${svcs.length} services</span><button class="dg-lnk" data-collapse="${esc(r)}">Collapse</button></div>`;
  return place(el, x, y, w, h);
}
function cardInner(s) {
  const showPlace = s.runs === "remote" || M.mixed;
  const acts = actionsFor(s);
  return `<div class="r1"><span class="dg-dot ${status(s)}" title="${statusWord(s)}"></span><span class="nm" title="${esc(s.name)}">${esc(s.name)}</span>${showPlace ? `<span class="dg-badge ${s.runs}">${esc(placementText(s))}</span>` : ""}</div>
    <div class="r2" title="${esc(s.id)}">${esc(s.repo)}</div>
    <div class="r3">${s.entry ? '<span class="dg-tag entry">entry</span>' : ""}${s.infra ? '<span class="dg-tag">infra</span>' : ""}${s.missing.length ? `<span class="dg-tag warn" title="Missing: ${esc(s.missing.join(", "))}">⚠ missing</span>` : ""}${!s.cloned ? '<span class="dg-tag warn">not cloned</span>' : ""}<span class="h ${status(s)}">${esc(healthLine(s))}</span></div>
    <div class="dg-acts">${[acts.primary, ...acts.common]
      .filter(Boolean)
      .slice(0, 3)
      .map((a) => actBtn(a, s, "sm"))
      .join("")}</div>`;
}
function card(s, x, y, w, h) {
  const el = document.createElement("div");
  el.className = `dg-card ${st.density === "compact" ? "compact" : ""} ${s.runs === "remote" ? "remote" : ""} ${s.health.ok === false ? "down" : ""}`;
  el.dataset.id = s.id;
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute(
    "aria-label",
    `${s.name} in ${s.repo}, ${statusWord(s)}${s.runs === "remote" ? ", runs remotely" : ""}. Open details.`,
  );
  el.innerHTML = cardInner(s);
  return place(el, x, y, w, h);
}
function repoCardInner(r) {
  const svcs = M.byRepo.get(r),
    ok = svcs.filter((s) => s.health.ok).length,
    pl = repoPlacement(M, r),
    roll = repoRollup(M, r);
  return `<div class="r1"><span class="dg-dot ${repoStatus(roll)}" title="${esc(repoStatusWord(roll))}"></span><span class="nm">${esc(r)}</span>${pl !== "local" || M.mixed ? `<span class="dg-badge ${pl}">${pl === "hybrid" ? "⇄ hybrid" : pl === "remote" ? "☁ remote" : "⌂ local"}</span>` : ""}</div>
    <div class="r2">${svcs.length} services · ${ok}/${svcs.length} healthy</div>
    <div class="r3 sum">${svcs.map((s) => `<span class="dg-dot ${status(s)}" title="${esc(s.name)}: ${statusWord(s)}"></span>`).join("")}</div>
    <div class="dg-acts"><button class="dg-btn sm" data-expand="${esc(r)}">Expand</button></div>`;
}
function repoCard(r, x, y, w, h) {
  const svcs = M.byRepo.get(r);
  const el = document.createElement("div");
  const roll = repoRollup(M, r);
  el.className = `dg-card ${st.density === "compact" ? "compact" : ""} ${repoPlacement(M, r) === "remote" ? "remote" : ""} ${roll.state === "down" ? "down" : roll.state === "degraded" ? "degraded" : ""}`;
  el.dataset.repo = r;
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute(
    "aria-label",
    `${r}, ${repoStatusWord(roll)}, ${svcs.length} services, ${svcs.filter((s) => s.health.ok).length} healthy. Open details.`,
  );
  el.innerHTML = repoCardInner(r);
  return place(el, x, y, w, h);
}

function legend() {
  const kinds = new Set(edges.map((e) => (e.cross ? "cross" : e.kind)));
  const items = [
    ["hard", "var(--accent)", "solid", "hard dependency"],
    ["soft", "var(--muted)", "dashed", "soft"],
    ["event", "var(--dg-event)", "dotted", "event"],
    ["intra", "var(--muted)", "solid", "within a repo"],
    ["cross", "var(--dg-remote)", "dashed", "local → remote"],
  ].filter(([k]) => kinds.has(k));
  $(".dg-legend").innerHTML =
    items
      .map(
        ([, c, s, l]) =>
          `<span><i style="border-top-color:${c};border-top-style:${s}"></i>${l}</span>`,
      )
      .join("") +
    (M.mixed ? "<span>⌂ local · ☁ remote · ⇄ hybrid</span>" : "") +
    "<span>click a card for details</span>";
}

// ── focus, find ──────────────────────────────────────────────────────────
const nodeKey = (sel) => {
  if (!sel.repo) return nodeFor(M, st.collapsed, sel.id);
  const l = M.byRepo.get(sel.repo) || [];
  return isCollapsed(M, st.collapsed, sel.repo) || l.length === 1
    ? nodeFor(M, st.collapsed, l[0]?.id)
    : "rg:" + sel.repo;
};
function applyFocus() {
  if (!host) return;
  const key = st.sel ? nodeKey(st.sel) : null;
  const repoSel = key?.startsWith("rg:") ? st.sel.repo : null;
  let focus = st.sel ? neighbours(edges, key) : null;
  if (repoSel) {
    focus = new Set();
    for (const s of M.byRepo.get(repoSel))
      neighbours(edges, s.id).forEach((k) => focus.add(k));
  }
  host
    .querySelectorAll(".dg-grp.dg-repo")
    .forEach((g) => g.classList.toggle("sel", g.dataset.repo === repoSel));
  const q = st.q.trim().toLowerCase();
  host.querySelectorAll(".dg-card").forEach((c) => {
    const k = c.dataset.id || "repo:" + c.dataset.repo;
    const hit = !!q && k.toLowerCase().includes(q);
    c.classList.toggle("sel", key != null && k === key);
    c.classList.toggle("hit", hit);
    c.classList.toggle("dim", (focus && !focus.has(k)) || (!!q && !hit));
  });
  host.querySelectorAll("path.dg-e").forEach((p) => {
    const on =
      !!focus &&
      (repoSel
        ? M.byId.get(p.dataset.f)?.repo === repoSel ||
          M.byId.get(p.dataset.t)?.repo === repoSel
        : p.dataset.f === key || p.dataset.t === key);
    p.classList.toggle("hl", on);
    p.classList.toggle("dim", (!!focus && !on) || !!q);
  });
}
function focusOn(sel) {
  if (sel.viaRepo) {
    const l = M.byRepo.get(sel.repo) || [];
    sel =
      l.length === 1
        ? { id: l[0].id }
        : isCollapsed(M, st.collapsed, sel.repo)
          ? { repo: sel.repo }
          : { id: entryOf(M, sel.repo).id };
  }
  if (sel.tab) st.tab = sel.tab;
  openDetail(
    { ...(sel.repo ? { repo: sel.repo } : { id: sel.id }) },
    !!sel.tab,
  );
  const a = layoutAbs[nodeKey(sel)];
  if (a) {
    const vp = $(".dg-vp").getBoundingClientRect();
    st.tx = vp.width / 2 - (a.x + a.w / 2) * st.z;
    st.ty = vp.height / 2 - (a.y + a.h / 2) * st.z;
    applyView();
  }
}

// ── panel ────────────────────────────────────────────────────────────────
function openDetail(sel, keepTab) {
  closeMenus(); // the panel re-renders: its menu's button goes away
  if (!keepTab && (!st.sel || nodeKey(st.sel) !== nodeKey(sel))) st.tab = null;
  st.sel = sel;
  applyFocus();
  const side = $(".dg-panel");
  let target = side;
  if (st.popped) {
    side.hidden = true;
    let back = document.querySelector(".dg-modal-back");
    if (!back) {
      back = document.createElement("div");
      back.className = "dg dg-modal-back";
      back.innerHTML =
        '<aside class="dg-panel" role="dialog" aria-modal="true" aria-label="Details"></aside>';
      document.body.appendChild(back);
      back.addEventListener("click", (e) => {
        if (e.target === back) closeDetail();
        else onClick(e);
      });
    }
    target = back.querySelector(".dg-panel");
  } else {
    document.querySelector(".dg-modal-back")?.remove();
  }
  if (!renderPanel(target, sel)) {
    closeDetail();
    return;
  }
  if (!st.popped) {
    side.hidden = false;
    side.style.width = st.panelW + "px";
    requestAnimationFrame(() => keepVisible(sel));
  }
}
function keepVisible(sel) {
  const a = layoutAbs[nodeKey(sel)];
  if (!a) return;
  const vp = $(".dg-vp").getBoundingClientRect();
  // On a phone the panel is a bottom sheet over the canvas.
  const sheet = window.matchMedia("(max-width: 760px)").matches
    ? $(".dg-panel").getBoundingClientRect().height
    : 0;
  const x = a.x * st.z + st.tx,
    y = a.y * st.z + st.ty,
    w = a.w * st.z,
    h = a.h * st.z;
  const bottom = vp.height - 12 - sheet;
  if (x < 12) st.tx += 12 - x;
  else if (x + w > vp.width - 12) st.tx -= x + w - vp.width + 12;
  if (y < 12) st.ty += 12 - y;
  else if (y + h > bottom) st.ty -= y + h - bottom;
  applyView();
}
function closeDetail() {
  closeMenus();
  disposePanel();
  st.sel = null;
  const side = $(".dg-panel");
  if (side) side.hidden = true;
  document.querySelector(".dg-modal-back")?.remove();
  applyFocus();
}

// ── pan & zoom ───────────────────────────────────────────────────────────
function applyView() {
  const w = $(".dg-world");
  if (!w) return;
  w.style.transform = `translate(${st.tx}px,${st.ty}px) scale(${st.z})`;
  $('[data-z="100"]').textContent = Math.round(st.z * 100) + "%";
}
function zoomAt(f, cx, cy) {
  const vp = $(".dg-vp").getBoundingClientRect();
  cx ??= vp.width / 2;
  cy ??= vp.height / 2;
  autoFit = null;
  const nz = Math.min(2, Math.max(zoomFloor, st.z * f));
  st.tx = cx - ((cx - st.tx) * nz) / st.z;
  st.ty = cy - ((cy - st.ty) * nz) / st.z;
  st.z = nz;
  applyView();
}
/** Fit the graph; automatic fits pass floor 0.6, the Fit button 0.35. */
function fit(floor = zoomFloor) {
  const vp = $(".dg-vp")?.getBoundingClientRect();
  if (!vp) return;
  const w = parseFloat($(".dg-world").style.width) || 1,
    h = parseFloat($(".dg-world").style.height) || 1;
  st.z = Math.max(
    floor,
    Math.min(1, (vp.width - 32) / w, (vp.height - 70) / h),
  );
  st.tx = Math.max(16, (vp.width - w * st.z) / 2);
  st.ty = 16;
  autoFit = floor;
  applyView();
}

// ── events ───────────────────────────────────────────────────────────────
function toast(msg) {
  document.querySelector(".dg-toast")?.remove();
  const t = document.createElement("div");
  t.className = "dg-toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
async function recheck(services) {
  const env = hooks.env?.() || "local";
  const rows = await Promise.all(
    services.map((s) =>
      fetch(
        `/api/health?env=${encodeURIComponent(env)}&address=${encodeURIComponent(s.id)}`,
      )
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    ),
  );
  graphHealth(rows.flat());
  toast(
    `Checked ${services.length === 1 ? services[0].id : services.length + " services"}`,
  );
}
// An open More menu moves to a layer on <body>: inside the panel, WebKit
// clips even a fixed menu to the panel's scroll box once the panel scrolls
// (the Logs tab). It goes back beside its button when it closes.
const menuOwner = new WeakMap(); // menu -> its More button
const ownMenu = new WeakMap(); // More button -> its menu, while in the layer
function menuLayer() {
  let l = document.querySelector("body > .dg-layer");
  if (!l) {
    l = document.createElement("div");
    l.className = "dg-layer";
    l.addEventListener("click", onClick);
    document.body.appendChild(l);
  }
  return l;
}
function menuOf(more) {
  return ownMenu.get(more) ?? more.nextElementSibling;
}
function openMenus() {
  return [...document.querySelectorAll(".dg-menu")].filter((m) => !m.hidden);
}
function closeMenus(except) {
  for (const m of document.querySelectorAll(".dg-menu")) {
    if (m === except) continue;
    m.hidden = true;
    const more = menuOwner.get(m) ?? m.previousElementSibling;
    more?.setAttribute("aria-expanded", "false");
    if (m.parentElement?.classList.contains("dg-layer")) {
      menuOwner.delete(m);
      if (more) ownMenu.delete(more);
      if (more?.isConnected) more.after(m);
      else m.remove();
    }
  }
}
function placeMenu(more, m) {
  menuOwner.set(m, more);
  ownMenu.set(more, m);
  menuLayer().appendChild(m);
  const r = more.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 12,
    above = r.top - 12;
  const up = below < 260 && above > below;
  Object.assign(m.style, {
    right: Math.max(8, window.innerWidth - r.right) + "px",
    left: "auto",
    top: up ? "auto" : r.bottom + 4 + "px",
    bottom: up ? window.innerHeight - r.top + 4 + "px" : "auto",
    maxHeight: (up ? above : below) + "px",
  });
}
function arm(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = "1";
  btn.textContent = "Confirm: " + btn.textContent;
  btn.classList.add("armed");
  return false;
}

function onClick(e) {
  const t = e.target;
  const more = t.closest("[data-more]");
  if (more) {
    const m = menuOf(more);
    if (!m.hidden) {
      closeMenus();
      return;
    }
    closeMenus();
    m.hidden = false;
    more.setAttribute("aria-expanded", "true");
    placeMenu(more, m);
    m.querySelector("button:not(:disabled)")?.focus();
    return;
  }
  if (!t.closest(".dg-more, .dg-layer")) closeMenus();
  const act = t.closest("[data-action]");
  if (act) {
    if (act.disabled) return;
    if (act.hasAttribute("data-confirm") && !arm(act)) return;
    const c = t.closest(".dg-card");
    if (c && act.dataset.action === "logs") {
      st.tab = "logs";
      openDetail({ id: c.dataset.id }, true);
      return;
    }
    runAction(act.dataset.action, act.dataset.key);
    if (act.closest(".dg-menu")) closeMenus();
    return;
  }
  const runb = t.closest("[data-run]");
  if (runb) {
    if (runb.hasAttribute("data-confirm") && !arm(runb)) return;
    const s = M.byId.get(runb.dataset.key);
    if (s) hooks.runCmd(s, runb.dataset.run);
    return;
  }
  const add = t.closest("[data-add-dep]");
  if (add) {
    hooks.addMissing?.(add.dataset.addDep);
    return;
  }
  const tab = t.closest("[data-tab]");
  if (tab) {
    st.tab = tab.dataset.tab;
    openDetail(st.sel, true);
    return;
  }
  const pinT = t.closest("[data-pin-toggle]");
  if (pinT && window.denShell) {
    const id = pinT.dataset.pinToggle;
    if (window.denShell.isPinned(id)) window.denShell.unpin(id);
    else window.denShell.pin(id);
    openDetail(st.sel, true);
    return;
  }
  if (t.closest("[data-popout]")) {
    st.popped = !st.popped;
    openDetail(st.sel, true);
    return;
  }
  if (t.closest("[data-close]")) {
    closeDetail();
    return;
  }
  const gp = t.closest("[data-goto-repo-panel]");
  if (gp) {
    focusOn({ repo: gp.dataset.gotoRepoPanel });
    return;
  }
  const ex = t.closest("[data-expand]");
  if (ex) {
    st.collapsed.delete(ex.dataset.expand);
    store.set("collapsed", [...st.collapsed]);
    render();
    return;
  }
  const co = t.closest("[data-collapse]");
  if (co) {
    st.collapsed.add(co.dataset.collapse);
    store.set("collapsed", [...st.collapsed]);
    render();
    return;
  }
  const go = t.closest("[data-goto]");
  if (go) {
    focusOn({ id: go.dataset.goto });
    return;
  }
  const gr = t.closest("[data-goto-repo]");
  if (gr) {
    focusOn({ repo: gr.dataset.gotoRepo, viaRepo: true });
    return;
  }
  const c = t.closest(".dg-card");
  if (c)
    openDetail(
      c.dataset.repo ? { repo: c.dataset.repo } : { id: c.dataset.id },
    );
}

function syncControls() {
  const map = { dir: st.dir, group: st.group, density: st.density };
  host
    .querySelectorAll("[data-seg]")
    .forEach((el) =>
      el
        .querySelectorAll("button")
        .forEach((b) =>
          b.setAttribute(
            "aria-pressed",
            String(b.dataset.v === map[el.dataset.seg]),
          ),
        ),
    );
}

function wire() {
  const root = $(".dg");
  root.addEventListener("click", onClick);
  host.querySelectorAll("[data-seg]").forEach((el) =>
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      st[el.dataset.seg] = b.dataset.v;
      syncControls();
      savePrefs();
      render().then(() => {
        if (el.dataset.seg !== "density") fit(0.6);
        if (st.sel) keepVisible(st.sel);
      });
    }),
  );
  $("[data-expand]").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    st.collapsed =
      b.dataset.v === "all"
        ? new Set()
        : new Set(
            [...M.byRepo.keys()].filter((r) => M.byRepo.get(r).length > 1),
          );
    store.set("collapsed", [...st.collapsed]);
    render().then(() => fit(0.6));
  });
  const find = $("[data-find]");
  find.addEventListener("input", () => {
    st.q = find.value;
    applyFocus();
  });
  find.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = st.q.trim().toLowerCase();
    if (!q) return;
    const s = M.services.find((x) => x.id.toLowerCase().includes(q));
    if (s)
      focusOn(
        isCollapsed(M, st.collapsed, s.repo) ? { repo: s.repo } : { id: s.id },
      );
  });
  // pan: drag the background; scroll moves; Ctrl/⌘ + scroll zooms
  const vp = $(".dg-vp");
  vpObserver?.disconnect();
  if (typeof ResizeObserver === "function") {
    let size = null;
    vpObserver = new ResizeObserver(([e]) => {
      const next = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
      if (size && next !== size && autoFit != null) fit(autoFit);
      size = next;
    });
    vpObserver.observe(vp);
  }
  let drag = null;
  vp.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".dg-card,button,.dg-zoom")) return;
    drag = { x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty, moved: false };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add("dragging");
  });
  vp.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
      autoFit = null;
    }
    st.tx = drag.tx + dx;
    st.ty = drag.ty + dy;
    applyView();
  });
  const end = (e) => {
    if (drag && !drag.moved && !e.target.closest(".dg-card,button"))
      closeDetail();
    drag = null;
    vp.classList.remove("dragging");
  };
  vp.addEventListener("pointerup", end);
  vp.addEventListener("pointercancel", () => {
    drag = null;
    vp.classList.remove("dragging");
  });
  vp.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        zoomAt(
          Math.exp(-e.deltaY * 0.0022),
          e.clientX - r.left,
          e.clientY - r.top,
        );
      else {
        autoFit = null;
        st.tx -= e.deltaX;
        st.ty -= e.deltaY;
        applyView();
      }
    },
    { passive: false },
  );
  host.querySelector(".dg-zoom").addEventListener("click", (e) => {
    const z = e.target.closest("[data-z]")?.dataset.z;
    if (z === "in") zoomAt(1.2);
    if (z === "out") zoomAt(1 / 1.2);
    if (z === "100") {
      autoFit = null;
      st.z = 1;
      st.tx = 24;
      st.ty = 24;
      applyView();
    }
    if (z === "fit") fit(zoomFloor);
  });
  // panel resize (360–760px, remembered)
  let rs = null;
  root.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("[data-resize]")) return;
    rs = { x: e.clientX, w: st.panelW };
    e.target.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  root.addEventListener("pointermove", (e) => {
    if (!rs) return;
    st.panelW = Math.round(
      Math.max(360, Math.min(760, rs.w + (rs.x - e.clientX))),
    );
    $(".dg-panel").style.width = st.panelW + "px";
  });
  root.addEventListener("pointerup", () => {
    if (rs) {
      rs = null;
      savePrefs();
    }
  });
}

// Esc closes the menu first, then the panel. Enter/Space opens a card.
document.addEventListener("keydown", (e) => {
  if (!host?.isConnected) return;
  if (e.key === "Escape") {
    const m = openMenus()[0];
    if (m) {
      const more = menuOwner.get(m) ?? m.previousElementSibling;
      closeMenus();
      more?.focus();
      return;
    }
    if (st.sel) closeDetail();
    return;
  }
  if (
    (e.key === "Enter" || e.key === " ") &&
    e.target.classList?.contains("dg-card")
  ) {
    e.preventDefault();
    e.target.click();
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest?.(".dg-more, .dg-layer")) closeMenus();
});
// The menu is placed once, against its button: a scroll that moves the
// button (not the log view following new lines) or a resize closes it.
document.addEventListener(
  "scroll",
  (e) => {
    const t = e.target === document ? document.documentElement : e.target;
    if (openMenus().some((m) => t.contains?.(menuOwner.get(m) ?? m)))
      closeMenus();
  },
  true,
);
window.addEventListener("resize", () => openMenus().length && closeMenus());
