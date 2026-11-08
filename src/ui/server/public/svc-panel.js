/**
 * The service panel (0.4.18, QA-0.4.14 §C): one quick panel for a service,
 * opened from its pinned row in the rail (its name, or the collapsed rail's
 * dot), the Graph card's ⋯ and the Services card's name. It never
 * navigates: it opens beside its opener in the top layer (the shell's
 * topLayer), and at phone width (under 640 px) it is a bottom sheet. Esc
 * or a click outside closes it, and focus goes back to the opener.
 *
 * What it shows, top to bottom: the name, workspace, health dot, state
 * ("up 2h", "down: …", "starting…") and URL; Visit ↗ (primary), Start or
 * Stop, Restart and Logs; the repo's last test run with Run tests; the
 * agents working in the repo, each with Open, and Start agent here; then
 * Open in Services, Open in Graph and Unpin (Pin when it isn't pinned).
 *
 * Every action calls what the pages call: Start, Stop and Restart are
 * /api/service/exec (up, down, restart), as the Services page's buttons,
 * and Logs reads where the Logs page reads (log-source.js: taillog for a
 * local service), each a tab in the runs dock; Run tests is
 * /api/run (the repo's suites), as the Tests page. It stays live from the
 * same feeds the pages use: the header's health broadcast, the daemons
 * list, the run history (GET /api/runs/last) and the sessions list (GET
 * /api/sessions), asked again every few seconds while it is open.
 *
 * A pin is a repo ("shop", its primary service) or a service's address
 * ("shop/db"). The rail's Visit ↗ reads each pin's URL from here
 * (denShell state `pinUrls`).
 */
import { sudoRun } from "./topbar.js";
import { logStreamUrl } from "./log-source.js";

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const REFRESH_MS = 5_000;
/**
 * "starting…" gives up after this long, as the server's own ready watch
 * does (lifecycle-exec.ts, readyTimeoutMs).
 */
const START_TIMEOUT_MS = 120_000;
/** A down check this soon after Start is the service still coming up. */
const START_GRACE_MS = 10_000;
/** Restart: an up check counts after a down one, or after this long. */
const RESTART_MIN_MS = 5_000;
/** Phone width: the panel is a bottom sheet. */
const SHEET = "(max-width: 639px)";

const S = {
  deps: {},
  /** The header's last health results, by `repo/service`. */
  results: new Map(),
  /** When each repo's service started (the daemons list). */
  upSince: new Map(),
  lastRuns: {},
  sessions: [],
  /**
   * Pin ids starting from here (Start or Restart): id → { at, cmd, sawDown,
   * timer }. "starting…" follows the health feed, not the exec stream: a
   * dev server's `up` never ends.
   */
  busy: new Map(),
  /** Pin ids with tests in flight from here. */
  testing: new Set(),
  /** The open panel: { id, el, opener, scrim, timer }. */
  open: null,
};

/** Start or Restart from here: "starting…" until health says, or the timeout. */
function startBusy(id, cmd) {
  endBusy(id);
  S.busy.set(id, {
    at: Date.now(),
    cmd,
    sawDown: false,
    timer: setTimeout(() => {
      endBusy(id);
      sync();
    }, START_TIMEOUT_MS),
  });
}
function endBusy(id) {
  const b = S.busy.get(id);
  if (!b) return;
  clearTimeout(b.timer);
  S.busy.delete(id);
}
/**
 * A health update for the pins starting from here: up ends "starting…"
 * (after Restart, once the old instance went down or after a moment);
 * down ends it once the service has had a moment to come up.
 */
function settleBusy() {
  for (const [id, b] of [...S.busy]) {
    const s = serviceOf(id);
    const age = Date.now() - b.at;
    if (s.ok === false) {
      b.sawDown = true;
      if (age >= START_GRACE_MS) endBusy(id);
    } else if (
      s.ok === true &&
      (b.cmd !== "restart" || b.sawDown || age >= RESTART_MIN_MS)
    )
      endBusy(id);
  }
}

/** The primary service of a repo from the health results (entrypoint first). */
function primaryOf(repo) {
  let best = null;
  let rank = -1;
  for (const r of S.results.values()) {
    if (r.repo !== repo) continue;
    const k = r.isEntrypoint ? 2 : r.service === r.repo ? 1 : 0;
    if (k > rank) {
      best = r;
      rank = k;
    }
  }
  return best;
}

/** A pin's service: its health result, or what its id says. */
export function serviceOf(id) {
  const [repo, sub] = String(id).split("/");
  const r = sub ? S.results.get(`${repo}/${sub}`) : primaryOf(repo);
  return {
    id: String(id),
    repo,
    service: sub || r?.service || repo,
    url: r?.openUrl || null,
    ok: r ? r.ok : null,
    error: r?.error || (r?.status ? `HTTP ${r.status}` : ""),
    workspaces: r?.workspaces ?? [],
    repoPath: r?.repoPath || "",
    known: !!r,
    ms:
      typeof r?.ms === "number"
        ? r.ms
        : typeof r?.durationMs === "number"
          ? r.durationMs
          : null,
    upSince: S.upSince.get(repo),
  };
}

/** Its state: { cls, text } ("up 2h", "down: …", "starting…", "stopped"). */
export function stateOf(s) {
  if (S.busy.has(s.id)) return { cls: "run", text: t("svp.starting") };
  if (s.ok === false)
    return {
      cls: "bad",
      text: s.error ? t("svp.down", { c: s.error }) : t("svp.downNone"),
    };
  if (s.ok === true || s.upSince !== undefined)
    return { cls: s.ok === true ? "" : "off", text: upText(s.upSince) };
  return { cls: "off", text: t("svp.stopped") };
}
function upText(at) {
  if (at === undefined) return t("svp.upNow");
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  const d =
    sec < 60
      ? `${sec}s`
      : sec < 3600
        ? `${Math.floor(sec / 60)}m`
        : sec < 86400
          ? `${Math.floor(sec / 3600)}h`
          : `${Math.floor(sec / 86400)}d`;
  return t("svp.up", { d });
}
/** Visit works unless the service is down (or isn't running). */
export function visitable(s) {
  return !!s.url && s.ok !== false && !S.busy.has(s.id);
}
const running = (s) =>
  S.busy.has(s.id) || s.ok === true || s.upSince !== undefined;

/** The agents working in its repo: in its workspace, or in a folder inside the repo. */
function agentsOf(s) {
  return S.sessions.filter(
    (a) =>
      a.kind === "agent" &&
      ((s.repoPath &&
        a.cwd &&
        (a.cwd === s.repoPath || a.cwd.startsWith(`${s.repoPath}/`))) ||
        (s.workspaces.includes(a.workspace) &&
          a.cwd &&
          a.cwd.split("/").includes(s.repo))),
  );
}
const agentName = (a) => a.displayName || a.agent || a.label || a.id;
const agentTone = (a) =>
  a.waiting
    ? "warn"
    : a.state === "running"
      ? ""
      : a.state === "stopping"
        ? "run"
        : "off";

function testsHtml(s) {
  const r = S.lastRuns[s.repo];
  if (S.testing.has(s.id) || r?.running)
    return `<span class="den-dot run" aria-hidden="true"></span><span>${esc(t("svp.testsRun"))}</span>`;
  if (!r) return `<span class="den-svp-none">${esc(t("svp.testsNone"))}</span>`;
  const at = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(r.endedAt ?? r.startedAt));
  const ok = r.exitCode === 0;
  return `<span class="den-svp-${ok ? "ok" : "bad"}">${esc(t(ok ? "svp.testsOk" : "svp.testsBad", { t: at }))}</span>`;
}

/** A Visit button (the rail row's ↗, or the panel's primary). */
export function visitHtml(s, cls, label) {
  if (!s.url) return "";
  const on = visitable(s);
  return (
    `<button type="button" class="${cls}" data-visit="${esc(s.id)}" data-url="${esc(s.url)}"` +
    ` aria-label="${esc(t("act.visitX", { s: s.id }))}" title="${esc(on ? s.url : t("svp.notRunning"))}"` +
    `${on ? "" : ' aria-disabled="true"'}>${label}</button>`
  );
}

export function panelHtml(s) {
  const st = stateOf(s);
  const ags = agentsOf(s);
  const pinned = window.denShell?.isPinned?.(s.id);
  const testing = S.testing.has(s.id) || S.lastRuns[s.repo]?.running;
  return (
    `<div class="den-svp-h"><div class="den-svp-t"><span class="den-dot ${st.cls}" aria-hidden="true"></span>` +
    `<b title="${esc(s.id)}">${esc(s.id)}</b>` +
    `<button type="button" class="den-ib den-svp-x" data-svx="close" aria-label="${esc(t("svp.close"))}" title="${esc(t("svp.close"))}">✕</button></div>` +
    `<div class="den-svp-meta"><span class="den-wsp">${esc(s.workspaces.join(", ") || "—")}</span>` +
    `<span class="den-svp-st ${st.cls}">${esc(st.text)}</span>` +
    (s.ok === true && s.ms != null
      ? `<span class="den-svp-ms">${esc(window.denShell?.formatNumber?.(s.ms) ?? s.ms)} ms</span>`
      : "") +
    `</div>` +
    `<div class="den-svp-url">${esc(s.url || t("svp.noUrl"))}</div></div>` +
    `<div class="den-svp-acts">${visitHtml(s, "den-btn primary", `${esc(t("act.visit"))} ↗`)}` +
    (running(s)
      ? `<button type="button" class="den-btn" data-svx="stop">${esc(t("svp.stop"))}</button>`
      : `<button type="button" class="den-btn" data-svx="start">${esc(t("svp.start"))}</button>`) +
    `<button type="button" class="den-btn" data-svx="restart"${S.busy.has(s.id) ? " disabled" : ""}>${esc(t("svp.restart"))}</button>` +
    `<button type="button" class="den-btn" data-svx="logs">${esc(t("svp.logs"))}</button></div>` +
    `<div class="den-svp-sec"><div class="den-svp-k">${esc(t("svp.tests"))}</div>` +
    `<div class="den-svp-line">${testsHtml(s)}<button type="button" class="den-btn sm den-svp-sp" data-svx="tests"${testing ? " disabled" : ""}>${esc(t("svp.runTests"))}</button></div></div>` +
    `<div class="den-svp-sec"><div class="den-svp-k">${esc(t("svp.agents"))}${ags.length ? ` · ${ags.length}` : ""}</div>` +
    (ags.length
      ? ags
          .map(
            (a) =>
              `<div class="den-svp-ag"><span class="den-dot ${agentTone(a)}" aria-hidden="true"></span>` +
              `<span class="den-svp-nm" title="${esc(a.persona || "")}">${esc(agentName(a))}</span>` +
              `<span class="den-svp-as">${a.waiting ? `<span class="den-wbdg">${esc(t("ag.waiting"))}</span>` : esc(a.state || "")}</span>` +
              `<button type="button" class="den-btn sm" data-svx="ag" data-id="${esc(a.id)}" aria-label="${esc(t("svp.openAg", { s: agentName(a) }))}">${esc(t("svp.open"))}</button></div>`,
          )
          .join("")
      : `<div class="den-svp-help">${esc(t("svp.noAgents"))}</div>`) +
    `<div><button type="button" class="den-btn sm" data-svx="startag">+ ${esc(t("svp.startHere"))}</button></div></div>` +
    `<div class="den-svp-foot"><button type="button" class="den-lnk" data-svx="services">${esc(t("svp.openSvc"))}</button>` +
    `<button type="button" class="den-lnk" data-svx="graph">${esc(t("svp.openGraph"))}</button><span class="den-svp-grow"></span>` +
    `<button type="button" class="den-lnk" data-svx="${pinned ? "unpin" : "pin"}">${esc(t(pinned ? "act.unpin" : "act.pin"))}</button></div>`
  );
}

// ── open, place, keep live, close ─────────────────────────────────────────

/** The rail row a pin opens from, when it is in the rail. */
function railRow(id) {
  return document.querySelector(
    `.den-rail [data-svpanel="${CSS.escape(String(id))}"]`,
  );
}

function place() {
  const o = S.open;
  if (!o) return;
  const sheet = window.matchMedia?.(SHEET).matches;
  o.el.classList.toggle("den-sheet", !!sheet);
  if (sheet && !o.scrim) {
    o.scrim = document.createElement("div");
    o.scrim.className = "den-scrim den-svp-scrim";
    o.scrim.addEventListener("click", () => closePanel(false));
    document.body.append(o.scrim);
  } else if (!sheet && o.scrim) {
    o.scrim.remove();
    o.scrim = null;
  }
  const top = window.denShell?.topLayer;
  if (!top) return;
  // The page drew its opener again (a Graph or Services re-render).
  if (!o.opener.isConnected)
    o.opener =
      document.querySelector(
        `[data-svpanel-open="${CSS.escape(String(o.id))}"]`,
      ) || o.opener;
  const rail = document.querySelector(".den-rail");
  const fromRail = o.fromRail && rail;
  if (sheet) top.show(o.el, document.body, { sheet: true });
  else if (fromRail)
    // Beside the rail, level with its row (the mock: rail's right + 8, row's top − 6).
    top.show(o.el, rail, {
      side: "right",
      gap: 8,
      dy: -6,
      row: () => railRow(o.id)?.closest(".den-pin-row") || null,
    });
  else
    top.show(o.el, o.opener.isConnected ? o.opener : document.body, {
      gap: 6,
    });
}

/** Repaint the open panel from the feeds, keeping focus and scroll. */
function sync() {
  publishUrls();
  const o = S.open;
  if (!o) return;
  const a = document.activeElement;
  const mine = a && o.el.contains(a) && a !== o.el;
  const key = mine
    ? a.dataset.svx
      ? `[data-svx="${a.dataset.svx}"]${a.dataset.id ? `[data-id="${CSS.escape(a.dataset.id)}"]` : ""}`
      : a.dataset.visit
        ? "[data-visit]"
        : null
    : null;
  const html = panelHtml(serviceOf(o.id));
  if (html !== o.html) {
    const sc = o.el.scrollTop;
    o.el.innerHTML = html;
    o.html = html;
    o.el.scrollTop = sc;
    if (mine) {
      const swap = {
        '[data-svx="start"]': '[data-svx="stop"]',
        '[data-svx="stop"]': '[data-svx="start"]',
      };
      const f =
        key &&
        (o.el.querySelector(key) || o.el.querySelector(swap[key] || "x"));
      (f && !f.disabled ? f : o.el).focus();
    }
  }
  place();
}

async function refresh() {
  const get = (u, d) =>
    fetch(u, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : d))
      .catch(() => d);
  const [last, daemons, sess] = await Promise.all([
    get("/api/runs/last", null),
    get("/api/service/daemons", []),
    get("/api/sessions", null),
  ]);
  S.lastRuns = last?.repos ?? S.lastRuns;
  if (Array.isArray(daemons)) {
    S.upSince = new Map();
    for (const d of daemons) {
      const at = Date.parse(d.startedAt);
      if (!d.repoName || !Number.isFinite(at)) continue;
      const cur = S.upSince.get(d.repoName);
      if (cur === undefined || at < cur) S.upSince.set(d.repoName, at);
    }
  }
  if (Array.isArray(sess?.sessions)) S.sessions = sess.sessions;
  sync();
}

/**
 * Open the panel for a pin id (or a service's address) beside `opener`.
 * The same panel whoever opens it; opening it again from the same opener
 * closes it.
 */
export function openPanel(id, opener, opts = {}) {
  if (!id || !opener) return;
  // Again from the same opener (a rail row is drawn again often): closes.
  if (
    S.open?.id === id &&
    (S.open.opener === opener || (opts.fromRail && S.open.fromRail))
  ) {
    closePanel(false);
    return;
  }
  closePanel(false);
  const el = document.createElement("div");
  el.className = "den-pop den-svp";
  el.tabIndex = -1;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("svp.label", { s: id }));
  el.dataset.svp = id;
  document.body.append(el);
  S.open = {
    id,
    el,
    opener,
    fromRail: !!opts.fromRail,
    scrim: null,
    html: "",
    timer: setInterval(() => void refresh(), REFRESH_MS),
  };
  opener.setAttribute?.("aria-expanded", "true");
  window.denShell?.setState?.({ svpOpen: id });
  sync();
  (el.querySelector(".den-svp-acts .den-btn:not([disabled])") || el).focus();
  void refresh();
}

export function closePanel(refocus) {
  const o = S.open;
  if (!o) return;
  S.open = null;
  clearInterval(o.timer);
  window.denShell?.topLayer?.hide(o.el);
  o.el.remove();
  o.scrim?.remove();
  window.denShell?.setState?.({ svpOpen: null });
  o.opener.setAttribute?.("aria-expanded", "false");
  if (!refocus) return;
  const back = o.fromRail ? railRow(o.id) : o.opener;
  (back && back.isConnected ? back : railRow(o.id))?.focus();
}

export function panelOpen() {
  return S.open ? S.open.id : null;
}

// ── actions ───────────────────────────────────────────────────────────────

const env = () => S.deps.currentEnv?.() ?? "local";
const runs = () => window.denShell?.runs;

/** Visit: the service's URL in a new tab, or why not. */
export function visit(btn) {
  if (btn.getAttribute("aria-disabled") === "true") {
    window.denShell?.toast?.(t("svp.notRunning"));
    return;
  }
  const url = btn.dataset.url;
  if (!url || !/^https?:\/\//i.test(url)) return;
  window.open(url, "_blank", "noopener");
}

/** A stream into a runs-dock tab: Start, Stop, Restart (exec), Logs, tests. */
function stream(url, key, label, opts, done) {
  const r = runs();
  const id = r?.start(key, label, { doneLine: false, ...opts }) ?? null;
  const out = (text, cls) => (id ? r.append(id, text, cls) : undefined);
  const es = new EventSource(url);
  const sudo = sudoRun();
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    sudo?.see(msg);
    if (msg.type === "cmd") out(msg.text, "cmd");
    else if (msg.type === "line") out(msg.text, "");
    else if (msg.type === "error") out(msg.text, "err");
    // A detached start is up (the server's ready watch); its stream stays
    // open for the log.
    else if (msg.type === "ready") opts.ready?.();
    else if (msg.type === "done") {
      const ok = msg.exitCode === 0;
      es.close();
      if (opts.running === false) r?.set(id, { running: false });
      else r?.finish(id, { ok });
      done?.(ok);
      if (opts.again) void sudo?.done(opts.again);
    }
  };
  es.onerror = () => {
    out("Connection closed", "err");
    es.close();
    if (opts.running === false) r?.set(id, { running: false });
    else r?.finish(id, { ok: false });
    done?.(false);
  };
  return es;
}

function exec(s, cmd) {
  const params = new URLSearchParams({
    repo: s.repo,
    service: s.service,
    cmd,
    env: env(),
  });
  if (s.workspaces[0]) params.set("workspace", s.workspaces[0]);
  if (cmd !== "down") startBusy(s.id, cmd);
  if (cmd === "down") window.denShell?.toast?.(t("svp.stopping", { s: s.id }));
  sync();
  const settled = () => {
    endBusy(s.id);
    S.deps.refreshHealth?.(env(), { force: true });
    void refresh();
  };
  stream(
    `/api/service/exec?${params}`,
    `${s.repo}/${s.service}`,
    `${cmd} ${s.repo}/${s.service}`,
    { again: () => exec(s, cmd), ready: settled },
    settled,
  );
}

function logs(s) {
  stream(
    logStreamUrl(s.repo, s.service, env()),
    `${s.repo}/${s.service}`,
    `logs ${s.repo}/${s.service}`,
    { running: false, open: true },
  );
}

function runTests(s) {
  const params = new URLSearchParams({
    pillar: "suites",
    module: s.repo,
    env: env(),
  });
  S.testing.add(s.id);
  sync();
  stream(
    `/api/run?${params}`,
    `tests ${s.repo}`,
    `tests ${s.repo}`,
    {},
    (ok) => {
      S.testing.delete(s.id);
      window.denShell?.toast?.(
        t(ok ? "svp.testsDone" : "svp.testsFailed", { s: s.repo }),
      );
      void refresh();
    },
  );
}

function go(href) {
  closePanel(false);
  window.location.assign(href);
}

function act(k, btn) {
  const o = S.open;
  if (!o) return;
  const s = serviceOf(o.id);
  if (k === "close") closePanel(true);
  else if (k === "start") exec(s, "up");
  else if (k === "stop") exec(s, "down");
  else if (k === "restart") exec(s, "restart");
  else if (k === "logs") logs(s);
  else if (k === "tests") runTests(s);
  else if (k === "ag") go(`/agents?open=${encodeURIComponent(btn.dataset.id)}`);
  else if (k === "startag") {
    const q = new URLSearchParams({ start: "1" });
    const ws = s.workspaces[0];
    if (ws) q.set("ws", ws);
    if (s.repoPath) q.set("folder", s.repoPath);
    go(`/agents?${q}`);
  } else if (k === "services")
    go(`/services#repo-${encodeURIComponent(s.repo)}`);
  else if (k === "graph") go(`/graph#focus=${encodeURIComponent(s.id)}`);
  else if (k === "unpin") {
    const fromRail = o.fromRail;
    closePanel(false);
    window.denShell?.unpin?.(s.id);
    if (fromRail) document.querySelector(".den-rail .den-ni")?.focus();
  } else if (k === "pin") {
    window.denShell?.pin?.(s.id);
    sync();
  }
}

// ── wiring ────────────────────────────────────────────────────────────────

/**
 * Every pin's URL, and whether its Visit is off (down, or starting), for
 * the rail's Visit ↗: the live state the panel shows, so the ↗ greys out
 * on the same health update as the panel's dot (whatever the View).
 */
function publishUrls() {
  const sh = window.denShell;
  if (!sh?.setState) return;
  const urls = {};
  const off = {};
  for (const id of sh.getState?.().pins ?? []) {
    const s = serviceOf(id);
    if (!s.url) continue;
    urls[id] = s.url;
    off[id] = !visitable(s);
  }
  const st = sh.getState?.() ?? {};
  if (
    JSON.stringify(st.pinUrls ?? {}) !== JSON.stringify(urls) ||
    JSON.stringify(st.pinOff ?? {}) !== JSON.stringify(off)
  )
    sh.setState({ pinUrls: urls, pinOff: off });
}

let inited = false;
/** Once a page: header.js passes what it owns (env, health refresh, sudo). */
export function initServicePanel(deps = {}) {
  if (inited || typeof document === "undefined") return;
  inited = true;
  S.deps = deps;
  document.addEventListener("__DEN_CLI__:health-update", (e) => {
    for (const r of Array.isArray(e.detail) ? e.detail : [])
      if (r?.repo && r.service) S.results.set(`${r.repo}/${r.service}`, r);
    settleBusy();
    sync();
  });
  window.addEventListener("den:pins", () => sync());
  document.addEventListener(
    "click",
    (e) => {
      const o = S.open;
      const tgt = e.target;
      // The panel's Visit here; the rail's ↗ is shell.js's (the same visit()).
      const v = tgt.closest?.("[data-visit]");
      if (v) {
        if (o?.el.contains(v)) {
          e.preventDefault();
          visit(v);
        }
        return;
      }
      const opener = tgt.closest?.("[data-svpanel-open]");
      if (opener) {
        e.preventDefault();
        e.stopPropagation();
        openPanel(opener.dataset.svpanelOpen, opener);
        return;
      }
      if (!o) return;
      const b = tgt.closest?.("[data-svx]");
      if (b && o.el.contains(b)) {
        if (!b.disabled) act(b.dataset.svx, b);
        return;
      }
      if (o.el.contains(tgt) || o.opener.contains?.(tgt)) return;
      if (o.fromRail && tgt.closest?.("[data-svpanel]")) return;
      closePanel(false);
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.open && !e.defaultPrevented) {
      e.preventDefault();
      closePanel(true);
    }
  });
  window.addEventListener("resize", () => place());
  const sh = window.denShell;
  if (sh?.setServicePanel)
    sh.setServicePanel({ open: openPanel, close: closePanel, visit });
  else
    (window.denShellQueue = window.denShellQueue || []).push((x) =>
      x.setServicePanel?.({ open: openPanel, close: closePanel, visit }),
    );
}
