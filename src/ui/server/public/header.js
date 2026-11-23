/**
 * The shell's behaviour (shell.js draws the frame: top bar and rail):
 * the health poll that feeds the status chip and drawer (topbar.js), the
 * version pill and changelog, the workspace menu, the env picker (one for
 * the whole shell) and the log badge. Every page imports it. It expects
 * a <select id="env-sel"> (shell.js) whose change event triggers a re-ping.
 *
 * Health data is driven entirely by __DEN_CLI__.json manifests — no hardcoded
 * service names. Each registered service that declares a health.url for
 * the current env is counted.
 */

import {
  buildScopeMenuModel,
  PROJECT_COLOURS_KEY,
} from "./workspace-picker.js";
import { initAppearance } from "./appearance.js";
import DenUI from "./den-kit.js";
import { copyText, ensureWhatsNew } from "/kit/whatsnew.js";
import { buildRow, healthCycle, paintGate, shellHealth } from "./health-fit.js";
import { initTopbar, paintChecking, paintStatus } from "./topbar.js";
import { initBell } from "./bell.js";
import { initAlerts } from "./alerts.js";
import { registerDenSettings } from "./settings-registry.js";
import { initServicePanel } from "./svc-panel.js";
import { restartDen } from "./restart-den.js";

/** The shell's message lookup (R19; shell.js MESSAGES). */
const t = (key, vars) =>
  typeof window !== "undefined" && window.denShell?.t
    ? window.denShell.t(key, vars)
    : key;

export {
  askSudo,
  problemCards,
  problemFix,
  setServiceRunner,
  sudoRun,
  takePendingAction,
} from "./topbar.js";
export { buildRow } from "./health-fit.js";

// Every page with this header gets the appearance controls (mode, theme)
// and the top bar's chips, palette and drawer (topbar.js).
void initAppearance();
// Den's SETTINGS rows on every page, not only /settings: each is a ⌘K
// palette row (kind "setting"), so "terminal" finds Default terminal.
if (typeof window !== "undefined")
  (window.denShellQueue = window.denShellQueue || []).push((sh) => {
    if (sh?.registerSetting) registerDenSettings(sh);
  });
// NT-3: the bell.
if (typeof document !== "undefined") initBell();
// Issue 172: an agent's need, also outside the bell (desktop).
if (typeof document !== "undefined") initAlerts();
// Issue 172 S2: the app manifest, so a phone can add this to its home
// screen (an iPhone gets push only from there). Issue 644: the kit's head
// snippet links it on every page Den serves; this is for a page without it.
if (
  typeof document !== "undefined" &&
  document.head &&
  !document.querySelector('link[rel="manifest"]')
) {
  const l = document.createElement("link");
  l.rel = "manifest";
  l.href = "/site.webmanifest";
  document.head.appendChild(l);
}
if (typeof document !== "undefined")
  initTopbar({
    refreshHealth: (env, opts) => refreshHealth(env, opts),
    healthEnv: () => healthEnv(),
    storeOpenLog: (repo, service, env) => storeOpenLog(repo, service, env),
  });
// 0.4.18: the service panel (rail pins, Graph ⋯, Services names).
if (typeof document !== "undefined")
  initServicePanel({
    currentEnv: () => currentEnv(),
    refreshHealth: (env, opts) => refreshHealth(env, opts),
  });

// Between polls — measured from each poll's COMPLETION (schedulePoll
// re-arms after renderHealth resolves), so slow probes can't overlap.
// Issue 1022: fast only while the page is visible; both are Settings
// (user.yml health_poll.*, read from /api/settings once a page).
const _healthPoll = { visible: 5, hidden: 60 };
let _healthPollRead = null;
function _readHealthPoll() {
  // SEC-1b: a refusal page makes no /api call; the defaults stand.
  if (apiOff()) return Promise.resolve();
  _healthPollRead ??= fetch("/api/settings", { headers: { accept: "json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      const hp = s?.health_poll;
      if (Number.isFinite(hp?.visible)) _healthPoll.visible = hp.visible;
      if (Number.isFinite(hp?.hidden)) _healthPoll.hidden = hp.hidden;
      // Issue 1051: the project menu's load wait (web.menu_load_timeout_ms).
      const ml = s?.menu_load?.timeout_ms;
      if (Number.isFinite(ml) && ml > 0) _scopeLoadMs = ml;
    })
    .catch(() => {});
  return _healthPollRead;
}
/** Issue 1022: ms until the next poll, by the page's visibility. */
export function healthPollMs(hidden = document.hidden) {
  return (hidden ? _healthPoll.hidden : _healthPoll.visible) * 1000;
}
/** Issue 1022: a hidden page's poll says so; the server keeps its answer longer. */
function _hiddenQuery() {
  return document.hidden ? "&hidden=1" : "";
}

// Last painted health results, keyed `repo/service`, so a new poll can seed
// from them and update dots in place instead of collapsing the strip and
// regrowing it (see renderHealth).
let _healthAcc = new Map();
let _healthAccGen = -1;
// The poll generation that last painted _healthAcc (healthCycle's `last`).
let _healthPaintGen = -1;
let pollTimer = null;
// Generation token: every (re)start of polling bumps this. A stale tick (an
// env the user already switched away from, or a slow fetch resolving late)
// must neither paint the DOM nor re-arm the loop for its outdated env —
// without this, one in-flight poll during an env switch permanently hijacked
// the dots back to the old env.
let pollGen = 0;

// ── The env picker: one for the whole shell (0.3.0-dev.14) ─────────────────────

const LS_ENV = "__DEN_CLI__-env";
let _envReady = null;

/**
 * Fill the shell's env picker from /api/environments and restore the last
 * choice (one key for every page). Resolves with the env list once the
 * picker holds the right value; pages await it before reading #env-sel.
 * Started as soon as header.js loads.
 */
export function envReady() {
  if (_envReady) return _envReady;
  _envReady = (async () => {
    const sel = document.getElementById("env-sel");
    // A refusal page (SEC-1b, shell.js apiOff): /api answers the refusal.
    const envs = apiOff()
      ? ["local"]
      : await fetch("/api/environments")
          .then((r) => r.json())
          .then((v) => (Array.isArray(v) ? v : ["local"]))
          .catch(() => ["local"]);
    if (!sel) return envs;
    const esc = (s) =>
      String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    sel.innerHTML = envs
      .map((e) => `<option value="${esc(e)}">${esc(e)}</option>`)
      .join("");
    let saved = null;
    try {
      saved = localStorage.getItem(LS_ENV);
    } catch {}
    if (saved && envs.includes(saved)) sel.value = saved;
    // The Env ▾ menu (shell.js) shows and sets this select's value.
    window.denShell?.syncEnv?.();
    sel.addEventListener("change", () => {
      try {
        localStorage.setItem(LS_ENV, sel.value);
      } catch {}
    });
    return envs;
  })();
  return _envReady;
}
if (typeof document !== "undefined" && document.getElementById?.("env-sel"))
  void envReady();

/** The env picker's value: what this page shows. */
export function currentEnv() {
  return document.getElementById("env-sel")?.value ?? "local";
}

/**
 * The env the health row checks: the page's pin (Local Dev and Releases are
 * local by nature: `data-health-env` on #den-shell), else the env picker.
 */
export function healthEnv() {
  return (
    document.getElementById("den-shell")?.dataset?.healthEnv || currentEnv()
  );
}

// ── What's new and the version chip: the kit's (den-ui, issue 95) ──────────
// The kit draws and runs the pop-up (whatsnew.js) and the chip (version.js);
// Den gives it the changelog (den-kit.js's adapter), remembers the newest
// version seen, and opens it on a new version's first visit.

const LS_CHANGELOG_SEEN = "__DEN_CLI__-changelog-seen";

window.openChangelog = function () {
  DenUI.whatsNew.open();
};

window.closeChangelog = function () {
  DenUI.whatsNew.close();
};

/**
 * Text to the clipboard (navigator.clipboard, else execCommand for an
 * http:// origin like http://__DEN_CLI__:7777): the kit's.
 */
export function copyToClipboard(text) {
  return copyText(text);
}

/**
 * Fetch changelog, populate the version pill, and auto-open if unread.
 * Call once per page from each page's init function.
 */
export async function initChangelog() {
  if (apiOff()) return;
  // The overlay is on the page from the start (hidden), as before.
  ensureWhatsNew();
  const entries = await DenUI.whatsNew.load();
  const latest = entries[0];
  let info = null;
  try {
    info = await fetch("/api/server-info").then((r) => r.json());
  } catch {
    /* fall back to the changelog's newest version */
  }
  const label = DenUI.version.label(info?.version ?? null, entries);
  if (label) DenUI.version.set(label);

  let lastSeen = null;
  try {
    lastSeen = localStorage.getItem(LS_CHANGELOG_SEEN);
  } catch {}

  // ON-6: a brand-new Den (no repo yet) opens on its agent and the
  // approvals: no release notes over them. This version counts as seen.
  if (info?.fresh === true) {
    if (latest?.version)
      try {
        localStorage.setItem(LS_CHANGELOG_SEEN, latest.version);
      } catch {}
    return;
  }

  if (latest?.version && lastSeen !== latest.version) {
    DenUI.version.unread(true);
    window.openChangelog();
  }
}

// ── __DEN_TITLE__ config ──────────────────────────────────────────────────────────────

let _cliConfig = null;

/**
 * 0.4.1: true once the shell knows the config fails validation (shell.js
 * configInvalid): the polls and streams below that read it don't start.
 */
function configInvalid() {
  return window.denShell?.configInvalid?.() === true;
}

/**
 * SEC-1b: a refusal page (421, signed out; shell.js apiOff): every /api
 * call would answer the same refusal, so none is made.
 */
function apiOff() {
  return window.denShell?.apiOff?.() === true;
}

async function getDenConfig() {
  if (_cliConfig) return _cliConfig;
  if (configInvalid()) return { environments: ["local"] };
  try {
    _cliConfig = await fetch("/api/__DEN_CLI__/config").then((r) => r.json());
  } catch {
    _cliConfig = {
      environments: ["local"],
    };
  }
  return _cliConfig;
}

/**
 * Apply __DEN_CLI__ config to the nav — hide Workspaces when the local environment is disabled.
 * Call once on page load from each page's init function.
 */
export async function applyDenConfig() {
  const config = await getDenConfig();
  _renderOrgCrumb(config.org);
  const localEnabled = config.environments?.includes("local") ?? true;
  if (!localEnabled) {
    document
      .querySelectorAll(".den-rail a[href='/local-dev']")
      .forEach((el) => {
        el.style.display = "none";
      });
  }
  return config;
}

/**
 * The org (root of Org > Application > Repo > Services) as a small crumb
 * before the product name: "Globex › __DEN_CLI__".
 */
function _renderOrgCrumb(org) {
  // The shell's scope has an org part (the prototype's "/ ORG name").
  if (window.denShell?.setOrg?.(org)) return;
  const h1 = document.querySelector(".den-top .den-title, header h1");
  if (!h1 || !org?.title || document.getElementById("org-crumb")) return;
  const crumb = document.createElement("span");
  crumb.id = "org-crumb";
  crumb.title = t("org.titleId", { title: org.title, id: org.id });
  crumb.style.cssText =
    "font-size:12px;font-weight:600;color:var(--text);" +
    "white-space:nowrap;flex-shrink:0;display:flex;align-items:center;gap:8px";
  crumb.textContent = org.title;
  const sep = document.createElement("span");
  sep.textContent = "›";
  sep.style.cssText = "color:var(--muted);font-weight:400";
  crumb.appendChild(sep);
  h1.parentNode.insertBefore(crumb, h1);
}

// ── Applications (for grouping the health dots) ───────────────────────────────

// Focused workspace's applications, refreshed at most every 30s so a config
// edit shows up without a reload but polls don't refetch every 5s.
let _apps = null;
let _appsAt = 0;
async function _loadApps() {
  if (_apps && Date.now() - _appsAt < 30_000) return _apps;
  if (configInvalid()) return _apps ?? [];
  try {
    const r = await fetch("/api/applications", {
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      _apps = (await r.json()).applications ?? [];
      _appsAt = Date.now();
    }
  } catch {
    /* keep the last set (or none: dots render ungrouped) */
  }
  return _apps ?? [];
}

/**
 * Order repos by application and say which application box each sits in.
 * Declared applications get a box; a repo that is its own application (or is
 * in none) renders bare. Pure — exported for tests.
 */
export function groupReposByApplication(repos, apps) {
  const appOf = new Map();
  for (const a of apps || [])
    for (const r of a.repos || []) if (!appOf.has(r)) appOf.set(r, a);
  const out = [];
  const seen = new Set();
  for (const a of apps || []) {
    const members = repos.filter((r) => appOf.get(r) === a);
    if (!members.length) continue;
    members.forEach((r) => seen.add(r));
    out.push({ app: a.source === "declared" ? a : null, repos: members });
  }
  const rest = repos.filter((r) => !seen.has(r));
  if (rest.length) out.push({ app: null, repos: rest });
  return out;
}

// ── Workspace: the scope breadcrumb's Workspace ▾ menu (R4) ─────────────────

/**
 * Feed the shell's Workspace part (shell.js #ws-pill, a menu): "All active"
 * and each active workspace, the focused one marked. Choosing a workspace
 * makes it the CLI default (POST /api/workspaces `focus`, workspaces.yml)
 * and sets the view (POST /api/scope, a preference) for every page: one
 * "current workspace" (Ward's decision, 0.4.11). "All active" sets only the
 * view; the CLI default stays.
 *
 * The arguments are dev.17's (an env select, an onSwitch callback) and are
 * no longer used: the view applies to every env.
 */
export async function initWorkspacePill() {
  _watchProjectColours();
  await _renderScopeMenu();
}

/**
 * Issue 168: a colour saved in this tab (den:project-colours) or another
 * (the storage stamp) repaints the chip, and with it every colour the
 * shell knows (the bell's headings): no reload.
 */
let _coloursWatched = false;
function _watchProjectColours() {
  if (_coloursWatched || typeof window === "undefined") return;
  _coloursWatched = true;
  const again = () => void _renderScopeMenu();
  window.addEventListener("den:project-colours", again);
  window.addEventListener("storage", (e) => {
    if (e.key === PROJECT_COLOURS_KEY) again();
  });
}

/** Re-fetch and repaint the Workspace part (after a workspace change). */
export async function refreshWorkspacePill() {
  await _renderScopeMenu();
}

// Issue 1051: a failed load of the menu is tried again, 1 s after the
// first failure, doubling to every 30 s, until one answers. The menu it
// had stays meanwhile; with none yet, the part stays hidden.
const SCOPE_RETRY_FIRST_MS = 1_000;
const SCOPE_RETRY_MAX_MS = 30_000;
// A load that hasn't answered in this long counts as failed (a stalled
// connection never errors, so it would never be tried again; issue 1044's
// WebKit wait after a pick's reload). A Setting (web.menu_load_timeout_ms,
// from /api/settings); this default until the page has read it.
let _scopeLoadMs = 8_000;

/** fetch(url), ended (it throws) when it hasn't answered in `ms`. */
function fetchWithin(url, ms) {
  const ctl =
    typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  return fetch(url, ctl ? { signal: ctl.signal } : undefined).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
let _scopeShown = false;
let _scopeRetryMs = 0;
let _scopeRetry = null;

/** Issue 1051: the wait before the next try, after `ms` (0: the first). */
export function nextScopeRetryMs(ms) {
  return ms ? Math.min(ms * 2, SCOPE_RETRY_MAX_MS) : SCOPE_RETRY_FIRST_MS;
}

function _scopeFailed(sh) {
  if (!_scopeShown) sh.setWorkspaces(null);
  if (_scopeRetry) return;
  _scopeRetryMs = nextScopeRetryMs(_scopeRetryMs);
  _scopeRetry = setTimeout(() => {
    _scopeRetry = null;
    _renderScopeMenu();
  }, _scopeRetryMs);
}

if (typeof window !== "undefined") {
  window.addEventListener?.("pagehide", () => {
    if (_scopeRetry) clearTimeout(_scopeRetry);
    _scopeRetry = null;
  });
  // Back from the back/forward cache with no menu yet: try again now (the
  // retry pagehide cleared would otherwise wait for the next render).
  window.addEventListener?.("pageshow", (e) => {
    if (e.persisted && !_scopeShown) _renderScopeMenu();
  });
}

async function _renderScopeMenu() {
  const sh = window.denShell;
  if (!sh?.setWorkspaces || configInvalid()) return;
  try {
    const [data, scope] = await Promise.all([
      fetchWithin("/api/workspaces", _scopeLoadMs).then((r) => r.json()),
      fetchWithin("/api/scope", _scopeLoadMs)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    sh.setWorkspaces({
      // The page's language sorts the projects (ja its own way).
      ...buildScopeMenuModel(
        pageScope(scope, data),
        data,
        t,
        document.documentElement.lang || undefined,
      ),
      onSelect: _switchScope,
    });
    _scopeShown = true;
    _scopeRetryMs = 0;
  } catch {
    _scopeFailed(sh);
  }
}

/** The pages whose ?ws= wins over the stored view (Graph, Agents). */
const WS_URL_PAGES = new Set(["/graph", "/agents"]);

/**
 * The Graph page draws what its ?ws= names (it wins over the stored view,
 * 0.3.0-dev.33), so its pill shows that workspace too: the pill, the URL,
 * the header's line and the graph agree (0.3.0-dev.34, a consumer's
 * finding). The Agents page's ?ws= (the Workspaces page's "Open in
 * Agents") is the same. Elsewhere, and for a ?ws= that names no active
 * workspace, the stored view.
 */
function pageScope(scope, data) {
  if (!WS_URL_PAGES.has(location.pathname)) return scope;
  const q = new URLSearchParams(location.search);
  const ws = q.get("project") || q.get("ws");
  const active = Array.isArray(data?.active)
    ? data.active
    : data?.active
      ? [data.active]
      : [];
  return ws && active.includes(ws) ? { ...scope, scope: ws } : scope;
}

/**
 * A choice replaces ?ws= (All active drops it, a workspace sets it) on the
 * Graph and Agents pages, and on any page whose URL names a workspace
 * (Workspaces' detail pane), so the reload shows the choice rather than
 * the old ?ws=. The history entry is replaced, not pushed: Back does not
 * return to a view the picker has left.
 */
function followScopeInUrl(value) {
  const u = new URL(location.href);
  if (
    !WS_URL_PAGES.has(location.pathname) &&
    !u.searchParams.has("ws") &&
    !u.searchParams.has("project")
  )
    return;
  // #80: ?project=; an old ?ws= goes.
  u.searchParams.delete("ws");
  if (value === "all") u.searchParams.delete("project");
  else u.searchParams.set("project", value);
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}

/**
 * A workspace: first the CLI default (workspaces.yml), then the view. When
 * the CLI default can't be set, nothing changes and the error shows. "All
 * active": the view only. POST /api/scope stores the view (user.yml
 * `view`), then the page reloads to show it whole. The workspace already
 * in view (`inView`): the CLI default only, the view untouched. No
 * service, container, daemon or route changes.
 */
async function _switchScope(value, focus, inView) {
  if (value !== "all" && value !== focus && !(await _setFocus(value))) return;
  if (inView) {
    // A ?ws= page shows the pick after the reload, not its old ?ws=.
    followScopeInUrl(value);
    location.reload();
    return;
  }
  try {
    await window.denShell.api("POST", "/api/scope", { scope: value });
  } catch (err) {
    if (err?.denApi) {
      err.message = t("ws.viewFailed", { msg: err.message });
      window.denShell.errorToast(err);
    } else window.denShell?.toast?.(t("ws.viewFailed", { msg: err.message }));
    return;
  }
  followScopeInUrl(value);
  location.reload();
}

/**
 * Switch the View to one workspace, as the top bar's Workspace menu does
 * (the Graph page's Show <workspace>): the CLI default, then the view,
 * then a reload (the URL's hash stays).
 */
export async function switchView(name) {
  const scope = await fetch("/api/scope")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  await _switchScope(name, scope?.focus ?? null, false);
}

/**
 * Make `name` the CLI default: Local Dev's focus action (POST
 * /api/workspaces `focus`, which writes workspaces.yml and retargets the
 * CLI). False, with the error shown, when it couldn't.
 */
async function _setFocus(name) {
  try {
    await window.denShell.api("POST", "/api/workspaces", {
      name,
      action: "focus",
    });
  } catch (err) {
    if (err?.denApi) {
      err.message = t("ws.focusFailed", { msg: err.message });
      window.denShell.errorToast(err);
    } else window.denShell?.toast?.(t("ws.focusFailed", { msg: err.message }));
    return false;
  }
  return true;
}

// ── Health: the status chip and drawer (topbar.js, R6 and R15) ─────────────

/** Call once on page load. Does NOT manage env changes — caller handles that. */
export async function initHealth() {
  await Promise.all([envReady(), _readHealthPoll()]);
  if (configInvalid()) return;
  const env = healthEnv();
  const gen = ++pollGen;
  await renderHealth(env, gen);
  schedulePoll(env, gen);
}

/** Call whenever the environment changes. Cancels the current poll and restarts it for the new env. */
export async function refreshHealth(env, { force = false } = {}) {
  const gen = ++pollGen;
  clearTimeout(pollTimer);
  if (configInvalid()) return;
  // The chip goes neutral while the new env is checked: never red from
  // the old env's answers, never a partial count.
  if (env !== _healthEnvPainted) paintChecking();
  await renderHealth(env, gen, force);
  schedulePoll(env, gen);
}

// Background tabs throttle chained timers (Chrome clamps to ~1/min after a few
// hidden minutes), so the chip freezes while hidden — refresh immediately on
// return instead of showing pre-hide state for up to another minute.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pollGen > 0) {
    refreshHealth(healthEnv());
  }
});

function schedulePoll(env, gen) {
  if (gen !== pollGen) return; // superseded by an env switch/re-init
  if (configInvalid()) return; // a reload once fixed starts it again
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      await renderHealth(env, gen);
    } finally {
      // ALWAYS re-arm: a thrown/aborted tick must not silently kill polling
      // (that froze the chip at its last state until a page reload).
      schedulePoll(env, gen);
    }
  }, healthPollMs());
}

/**
 * Stream health results and paint them through the gate (health-fit.js):
 * a first cycle (a page load, an env switch) paints once, complete, so a
 * cold load never shows a partial count or a flash of red; later polls
 * seed from the last one and repaint debounced.
 */
async function renderHealth(env, gen = pollGen, force = false) {
  await _loadApps();
  const seed = gen === _healthAccGen ? [..._healthAcc] : [];
  _healthAccGen = gen;
  await healthCycle({
    seed,
    gate: _healthGate,
    stream: (onResult) => _streamHealth(env, force, onResult),
    // Stream unavailable or broken (older server, a proxy that buffers SSE,
    // a dropped connection): the plain endpoint completes the cycle.
    fetchAll: () =>
      fetch(
        `/api/health?env=${env}${force ? "&refresh=1" : ""}${_hiddenQuery()}`,
        {
          signal: AbortSignal.timeout(10_000),
        },
      )
        .then((r) => r.json())
        .catch(() => null),
    // What the chip shows now, for a paint before this cycle completes.
    last: () => (_healthPaintGen === gen ? _healthAcc : null),
    paint: (m) => {
      _healthAcc = m;
      _healthPaintGen = gen;
      _paintHealth(env, _sortHealth([...m.values()]));
    },
    current: () => gen === pollGen,
  });
}
const _healthGate = paintGate();
let _healthEnvPainted = null;

/**
 * Stable display order. `idx` is the server's graph-ranked position (entry repo
 * first … infra-stack last); results arrive in completion order, which differs
 * every poll, so sorting by it is what keeps the drawer from reshuffling. Falls
 * back to repo name when the server doesn't send `idx`.
 */
function _sortHealth(results) {
  return results.sort(
    (a, b) =>
      (a.idx ?? Number.MAX_SAFE_INTEGER) - (b.idx ?? Number.MAX_SAFE_INTEGER) ||
      a.repo.localeCompare(b.repo) ||
      String(a.service).localeCompare(String(b.service)),
  );
}

/**
 * Read /api/health/stream to completion, calling onResult per check.
 * Resolves "done" when the server ended the cycle (every check answered),
 * "partial" when it broke after some results, "none" when it gave nothing:
 * only "done" is a whole cycle (healthCycle).
 */
function _streamHealth(env, force, onResult) {
  return new Promise((resolve) => {
    let es;
    let got = false;
    // Backstop: a hung stream must not stall the poll chain forever.
    const broken = () => (got ? "partial" : "none");
    const guard = setTimeout(() => {
      try {
        es?.close();
      } catch {}
      resolve(broken());
    }, 15_000);
    const done = (ok) => {
      clearTimeout(guard);
      try {
        es?.close();
      } catch {}
      resolve(ok);
    };
    try {
      // force bypasses the server-side health cache — used right after a repo
      // sync, where the probes on disk may have just changed.
      es = new EventSource(
        `/api/health/stream?env=${encodeURIComponent(env)}${force ? "&refresh=1" : ""}${_hiddenQuery()}`,
      );
    } catch {
      clearTimeout(guard);
      return resolve("none");
    }
    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "result") {
        got = true;
        onResult(msg.result);
      } else if (msg.type === "done") {
        done("done");
      } else if (msg.type === "error") {
        done(broken());
      }
    };
    // An error ends the stream: before any result, fall back; after some,
    // the cycle is partial and /api/health completes it.
    es.onerror = () => done(broken());
  });
}

/**
 * One painted cycle: the shared rollup (buildRow, health-rollup.js) feeds
 * the rail (the Services badge and pinned dots) and the status chip and
 * drawer alike, so they never disagree (R6, R13): a down service counts
 * only once its repo's checks have all answered, pending and unchecked
 * ones never do.
 */
function _paintHealth(env, results) {
  // WS-6.4: the server checks every active workspace; the chip and the
  // drawer count only what the view scope shows (`inView`). The pages get
  // every row, so the Workspaces page knows any workspace's health.
  const shown = results.filter((r) => r.inView !== false);
  const repos = [...new Set(shown.map((r) => r.repo))];
  const groups = groupReposByApplication(repos, _apps);
  const row = buildRow(shown, groups);
  window.denShell?.setState(shellHealth(row));
  _healthEnvPainted = env;
  paintStatus({ row, groups, env });

  // Broadcast results so other components (e.g. dep graph) can stay in sync
  document.dispatchEvent(
    new CustomEvent("__DEN_CLI__:health-update", { detail: results }),
  );
}

// ── Log badge (shared across pages) ───────────────────────────────────────────

const LS_OPEN_LOGS = "__DEN_CLI__-open-logs";

/**
 * Read __DEN_CLI__-open-logs from localStorage and populate the #log-badge element.
 * Call once on page load from any page that has a Logs nav link with a badge.
 */
export function initLogBadge() {
  _updateBadgeFromStorage();
  // Stay in sync if another tab opens/closes a log stream
  window.addEventListener("storage", (e) => {
    if (e.key === LS_OPEN_LOGS) _updateBadgeFromStorage();
  });
}

/** The Logs page's NAV badge (shell.js) reads `openLogs`. */
function _updateBadgeFromStorage() {
  try {
    const logs = JSON.parse(localStorage.getItem(LS_OPEN_LOGS) || "[]");
    const count = Array.isArray(logs) ? logs.length : 0;
    window.denShell?.setState({ openLogs: count });
  } catch {
    window.denShell?.setState({ openLogs: 0 });
  }
}

/** Add a log entry to localStorage (call before navigating to /logs). */
export function storeOpenLog(repo, service, env) {
  try {
    const logs = JSON.parse(localStorage.getItem(LS_OPEN_LOGS) || "[]");
    const filtered = logs.filter(
      (l) => !(l.repo === repo && l.service === service),
    );
    filtered.push({ repo, service, env });
    localStorage.setItem(LS_OPEN_LOGS, JSON.stringify(filtered));
    _updateBadgeFromStorage();
  } catch {
    /* noop */
  }
}

// ── Primary-service resolution (shared by local-dev tabs + logs toolbar) ─────
/**
 * Map repo → its PRIMARY service (the "main system" service) from an
 * /api/services payload. Precedence: entrypoint > root-named (service===repo)
 * > first seen. This is the same rollup the health dots, log tabs, and logs
 * toolbar key off, so "one thing per system" means the same thing everywhere.
 */
export function computePrimaryByRepo(svcList) {
  const primary = new Map();
  const rank = new Map();
  for (const s of Array.isArray(svcList) ? svcList : []) {
    const r = s.isEntrypoint ? 2 : s.service === s.repo ? 1 : 0;
    if (!primary.has(s.repo) || r > (rank.get(s.repo) ?? -1)) {
      primary.set(s.repo, s.address);
      rank.set(s.repo, r);
    }
  }
  return primary;
}

// ── Stale-server watch (self-initializing on every page) ─────────────────────
// The __DEN_CLI__ web server loads its TypeScript at startup; edit server code
// without restarting and it keeps serving the OLD handlers while still serving
// FRESH HTML from disk — a confusing mismatch (the Releases-tab POST/SSE bug was
// exactly this). The server exposes /api/server-info { stale } (any src/*.ts
// newer than its start); when stale we surface an amber header pill offering a
// one-click Restart (POST /api/web/restart → detached `__DEN_CLI__ web restart`),
// then reconnect to the fresh daemon and reload.

const SERVER_INFO_POLL_MS = 12_000;
let _lastServerInfo = null; // most recent { pid, startedAt }

/**
 * The update-waiting pill after the version chip, the kit's (den-ui 0.7.0):
 * "⚠ stale server · Restart" while the server runs older code than is on
 * disk; a click restarts it.
 */
function _renderStalePill(info) {
  if (!info || !info.stale) {
    DenUI.version.waiting(null);
    return;
  }
  DenUI.version.waiting({
    label: t("stale.label"),
    action: t("stale.restart"),
    title: t("stale.title", { cli: "__DEN_CLI__" }),
    name: t("stale.aria"),
    onClick: _requestRestart,
  });
}

async function _fetchServerInfo() {
  try {
    return await fetch("/api/server-info", {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    }).then((r) => r.json());
  } catch {
    return null;
  }
}

async function _staleTick() {
  if (apiOff()) return;
  const info = await _fetchServerInfo();
  if (info && info.pid != null) _lastServerInfo = info;
  _renderStalePill(info);
  // MD-2: a newer engine on disk than the one this server runs.
  if (info && "engineStale" in info)
    window.denShell?.setEngine?.({
      stale: info.engineStale === true,
      loaded: info.loaded?.version ?? null,
      onDisk: info.onDisk?.version ?? null,
    });
  setTimeout(_staleTick, SERVER_INFO_POLL_MS);
}

async function _requestRestart() {
  // No confirm: the pill exists only when the server IS stale, and a click
  // on it is the ask. D64: the same in-place dialog as Restart Den (no page
  // reload; live connections reconnect).
  const info = await restartDen({
    confirm: false,
    before: _lastServerInfo,
    from: "update-pill",
  });
  if (info) {
    _lastServerInfo = info;
    _renderStalePill(info);
  }
}

// Self-init: begin watching once there's a <header> to anchor the pill into.
if (typeof document !== "undefined") {
  const _bootStaleWatch = () => _staleTick();
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", _bootStaleWatch);
  else _bootStaleWatch();
}
