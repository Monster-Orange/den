/**
 * The Agents tab (AG-4a-term, AG spec §5d): every session and agent of
 * the workspaces in view, grouped by workspace (the scope bar, or the
 * page's ?ws=), and up to four terminal panes beside the list.
 *
 * A pane is xterm.js (served from node_modules, /vendor/*) on a WebSocket
 * to /api/sessions/<id>/io: the session host's attach, so the pane gets
 * the scrollback first, then the live output; keystrokes go to the
 * session and the pane's size follows the pane. Closing a pane (or
 * leaving the page) detaches: the session keeps running. Stop (an agent
 * only) is the Workspaces page's own agent route.
 *
 * The open panes are the URL (?open=<id>,<id>), so a reload, Back or a
 * link reopens them, each reattaching with its scrollback.
 *
 * The size. A session has one PTY size and every viewer shares it (the
 * last resize wins: another browser, a CLI attach). The server says the
 * PTY's size on attach and whenever anyone changes it (a `size` frame),
 * and how many browsers view it (D54). One view sizes it: a lone one,
 * the one the person just opened, or the one typed in (or Take over).
 * Every other view draws at the PTY's size, never its own box's, with a
 * "Sized by another view" chip: an agent redraws its prompt at the PTY's
 * width, so a view at another width keeps a copy of it per redraw.
 * Opening, focusing or showing a view never takes the size. When the
 * view that sized it goes, a lone one left takes it. A
 * hidden pane never resizes the PTY, nor does one under 2x2. The cells
 * are measured again once the theme's fonts have loaded (a web font
 * arriving after the first fit would leave the cell width the fallback
 * font's) and after the theme changes.
 *
 * Nothing here keeps a session's state: the list is GET /api/sessions,
 * asked again every few seconds while the page is shown.
 *
 * Start agent (AG-10.1): a searchable persona list (category and source
 * chips, grouped by category, Plain session pinned last), What's a
 * persona?, Details, + New persona, Duplicate or Edit (persona-ui.js),
 * Runtime and Workspace, a first instruction (typed into the session once
 * it is ready, by the server: never an argument), and Advanced: model and
 * version (AG-12), permission mode and extra allowed commands with the
 * preview of what the runtime is given (AG-13). What differs from the
 * persona tags the session's row (AG-10.9). The runtime line says what
 * will run, or why it can't, before Start (agent-start.js readiness); a
 * persona whose runtime isn't installed starts on the first one that is,
 * and the dialog says so (AG-12.2). Starting, stopping and
 * resuming an agent never ask for the admin password: it is for sudo, and
 * no agent action runs sudo (LK-0).
 *
 * Stopped agents (AG-14) stay listed under their workspace, below the
 * running ones, each with why it stopped ("Stopped by you 19:52",
 * "Interrupted: Den restarted", "Exited (code 1)") and its actions:
 * Resume (the same conversation; its pane opens), Start fresh, Remove (one
 * click, and Undo in the toast for 10 s). A runtime that can't resume
 * shows only Start fresh, saying so. Clear stopped removes every stopped
 * agent in view. After a restart, one line says how many were interrupted,
 * with Resume all and Review.
 *
 * Layouts (AG-4b): Focus (the default: one pane; a click replaces it,
 * Shift- or ⌘-click adds one alongside), Tabs (one pane under a strip of
 * named tabs) or Tile (up to four in a grid: 1 full, 2 side by side, 3-4
 * as 2x2). The page header's switch, ⌃⇧1 / ⌃⇧2 / ⌃⇧3 (Ctrl+Shift+digit
 * on every OS: ⌘1-9 and Ctrl+1-9 are the browser's tabs) and ⌘K "Layout:
 * …" pick one; it is the person's (POST /api/settings agents_layout) and the URL's (&layout=; a
 * link's wins for that page and saves nothing). At phone width Focus and
 * Tile are Tabs. Every pane open stays attached; a pane out of sight never
 * resizes its PTY. Double-click a tab to rename the agent: the name is its
 * record's (POST …/agents/<id>/name), shown in the list, the pane, ⌘K.
 *
 * The terminal (AG-4b): Shift+Enter sends the runtime's soft newline (its
 * catalog softNewline, from /api/sessions: ESC CR, Codex's Ctrl+J; a
 * plain session's is Enter) and nothing else. The layout keys never reach
 * the agent. Links: plain URLs (addon-web-links) and OSC 8 links open on
 * ⌘-click (Ctrl-click elsewhere) in a new tab with noopener, http and
 * https only; a plain click selects as ever. A file path is a link when
 * the server says it exists inside the agent's workspace (GET …/paths,
 * stat only): ⌘-click opens it in Settings' editor_open (vscode, cursor,
 * zed, by URL scheme, at the line), or, with none (the default), copies
 * its absolute path. The session's name (its runtime's /rename, or Den's
 * rename, whichever is later) follows the runtime in the pane header and
 * the persona in its tab, when it says more than the agent's own name.
 *
 * Session rotation (den#4): an agent whose session rotated (after
 * agents.rotate.after_compactions compactions, or its pull request merged)
 * and whose handoff.md passes the check reads "Ready to relaunch (3
 * compactions)" or "(PR merged)", with Relaunch from handoff as its primary
 * action, then Start fresh and Remove; Resume is not offered. With the
 * handoff missing or failing the check, the row says so and keeps Resume
 * and Start fresh. A running one says "Handoff due" or "Ready to relaunch"
 * as a tag.
 */
import {
  quarantinedHtml,
  quarantineNext,
  readiness,
  runtimeName,
  runtimeOptions,
  wireQuarantine,
} from "/agent-start.js";
import { projectLabel } from "/workspace-picker.js";
import { focusBack, refindKey } from "/transcript-view.js";
import { OPEN_MS } from "/kit/busy.js";
import { formatTime, timeHtml } from "/kit/time.js";
import { dismissable } from "/popover.js";
import { startGateChip } from "/gate-chip.js";
import { latestShell } from "/shell-pick.js";
import {
  belongsOn,
  lastUsedProject,
  movedNoteHtml,
  newTerminalChoices,
  terminalGroups,
  terminalRowHtml,
  terminalsCountText,
} from "/terminals-list.js";
import { startFailText, terminalFailText } from "/pty-refusal.js";
import { askConfirm } from "/dialog-den.js";
import { reconnectOptions } from "/pane-reconnect.js";
import { termPane } from "/term-pane.js";
import { makeComposer } from "/agent-composer.js";
import { dropTo, orderable, orderGroup, orderTo } from "/agent-order.js";
import {
  attachFiles,
  guardPageDrops,
  pickFiles,
  wireDrop,
} from "/term-drop.js";
import {
  helperBadgeHtml,
  helperCountSaid,
  helperBarButtonHtml,
  helperRowsHtml,
  helperToggleHtml,
  openHelpers,
  wireHelperRows,
} from "/agent-helpers.js";
import {
  commandProblem,
  filterBarHtml,
  modelOptionsHtml,
  normalizeData,
  openPersonaEditor,
  overrideTagsHtml,
  ownModeLabel,
  modeLabel,
  openAgentModeMenu,
  permBlockHtml,
  personaDetail,
  personaDetailHtml,
  personaListHtml,
  personaName,
  personaRowHtml,
  personaRuntime,
  runtimeInstalled,
  splitCommands,
  syncPermBlock,
  versionLabel,
  versionOptionsHtml,
} from "/persona-ui.js";
import {
  editorUrl,
  findPaths,
  isMac,
  isWebUrl,
  layoutKeyIndex,
  linkModifier,
  linkOpen,
  imeOnce,
  softNewlineKey,
} from "/term-input.js";

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const api = (method, url, body, opts) =>
  window.denShell.api(method, url, body, opts);
const CLI = "__DEN_CLI__";
const TITLE = "__DEN_TITLE__";
/** ON-6: the server agent's scope (no workspace), shared/agents/server-agent.ts. */
const SERVER_WS = "den-server";
/** How long Remove's Undo stays offered (AG-14.1b). */
export const UNDO_MS = 10_000;

/** The most panes at once (the prototype's 2x2). */
export const MAX_PANES = 4;

/** The layouts (AG-4b), in the switch's order (⌃⇧1, ⌃⇧2, ⌃⇧3). */
export const LAYOUTS = ["focus", "tabs", "tile"];
/** At or below this width Focus and Tile are Tabs (the shell's phone width). */
const PHONE = "(max-width: 720px)";
/** The longest name a tab takes (records.ts MAX_DISPLAY_NAME). */
const MAX_NAME = 40;
const REFRESH_MS = 5_000;

const st = {
  root: null,
  /** Issue 96: the row being dragged (the list isn't redrawn meanwhile). */
  drag: null,
  /** Issue 96: a drag just ended, so the click it makes is swallowed. */
  dragClick: false,
  /** Issue 96: on a phone, the project whose agents show Up and Down. */
  reorderWs: null,
  /** Issue 226: on a phone, whether the Stopped group's agents show them. */
  reorderStopped: false,
  /** 0.4.46: panes.* (GET /api/settings panes_reconnect). */
  reconnect: reconnectOptions(undefined),
  /** 0.4.45: /api/workspaces, for the projects' names (projName). */
  projects: null,
  projectsAt: 0,
  scope: "all",
  scopeLabel: "",
  data: null,
  signedOut: false,
  open: [],
  panes: new Map(),
  // AG-18: agents (ws\0id) whose persona change started fresh, for the
  // pane's line once it follows them.
  fresh: new Set(),
  timer: null,
  xterm: null,
  // Issue 128: failed loads of the terminal code so far.
  xtermFails: 0,
  csrf: null,
  docWired: false,
  // AG-4b: the person's layout, the pane in front, and in Focus the panes
  // Shift-clicked in alongside it.
  layout: "focus",
  cur: null,
  side: new Set(),
  // D40: the pane whose terminal takes the keyboard once its socket opens,
  // and the one whose terminal last had it.
  focusOnOpen: null,
  // D58: whether that focus is a link's: only for a keyboard on nothing yet.
  focusIfIdle: false,
  // D54/D58: whether that pick also sizes the PTY (a pick from the list
  // does; a link that opens the page only puts the keyboard there).
  claimOnOpen: false,
  keyPane: null,
  // #80: ?open= ids of other projects' sessions, left out of this
  // project's tabs (one line offers them in All active).
  hiddenOpen: [],
  // #80: the project a deliberate open left (its "Back to" line), or null.
  switchedFrom: null,
  // #80: agents (ws\0id) whose helpers badge is open. Closed by default;
  // kept while the page is open, never across a reload.
  helpersOpen: new Set(),
  // #80: how many running helpers an open badge shows (agents.helpers_shown).
  helpersShown: 3,
  // AG-4b: where a path link opens (Settings editor_open).
  editorOpen: "none",
  // Issue 103: the deep link this page opened on, until its agent opens.
  deep: null,
};

/** ?layout=, when it names one; else null. */
export function layoutFromUrl(search) {
  const l = new URLSearchParams(search).get("layout");
  return LAYOUTS.includes(l) ? l : null;
}

const phone = () => !!window.matchMedia?.(PHONE).matches;

/** The layout drawn: the person's, except at phone width (Tabs). */
function shownLayout() {
  return phone() ? "tabs" : st.layout;
}

/** The panes in sight, in the URL's order. */
function visibleIds() {
  const l = shownLayout();
  if (l === "tile") return [...st.open];
  if (!st.open.includes(st.cur)) st.cur = st.open.at(-1) ?? null;
  if (l === "tabs") return st.cur ? [st.cur] : [];
  return st.open.filter((id) => id === st.cur || st.side.has(id));
}

// ── the URL ─────────────────────────────────────────────────────────────

/** The ids ?open= names (at most MAX_PANES, in order, no repeats). */
export function openFromUrl(search) {
  const raw = new URLSearchParams(search).get("open") ?? "";
  const ids = [];
  for (const id of raw.split(",").map((s) => s.trim())) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(-MAX_PANES);
}

/**
 * Issue 103: a deep link, /p/<project>/agents/<id>[?context=<url>]: the
 * page's own address for it (?agent=<id>&ws=<project>, which D43 opens),
 * and the context for the composer. Null when the path isn't one. The
 * server checked the project, the agent and the context before the page.
 */
export function deepLinkOf(pathname, search) {
  const m = /^\/p\/([^/]+)\/agents\/([^/]+)\/?$/.exec(pathname || "");
  if (!m) return null;
  let ws, agent;
  try {
    ws = decodeURIComponent(m[1]);
    agent = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const q = new URLSearchParams(search || "");
  const context = q.get("context");
  q.delete("context");
  q.set("agent", agent);
  q.set("ws", ws);
  return { ws, agent, context, href: `/agents?${q.toString()}` };
}

/**
 * Issue 482: which page this is: "terminal" (the Terminals page, served
 * from this file at /terminals) or "agents". Each lists its own kind.
 */
const PAGE =
  typeof document !== "undefined" &&
  document.getElementById?.("den-shell")?.dataset?.page === "terminal"
    ? "terminal"
    : "agents";

/** D73: the panes this browser has open, so a Terminal link adds a tab. */
// Issue 482: each page keeps its own.
const OPEN_KEY = PAGE === "terminal" ? "den-terminals-open" : "den-agents-open";

function rememberedOpen() {
  try {
    return openFromUrl(`?open=${localStorage.getItem(OPEN_KEY) ?? ""}`);
  } catch {
    return [];
  }
}

/**
 * Issue 448: when this browser last used each shell (a person clicked or
 * typed in its pane), so the rail's Terminal opens the one used last. The
 * server keeps when each was last typed in from any browser (inputAt);
 * this adds a click here. A shell never used counts from its start.
 */
const SHELL_USED_KEY = "den-shell-used";

function shellUsed() {
  try {
    const v = JSON.parse(localStorage.getItem(SHELL_USED_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function markShellUsed(id) {
  const r = rowOf(id);
  if (r?.kind !== "session") return;
  const was = shellUsed();
  // Every key calls here: once a second is enough.
  if (typeof was[id] === "number" && Date.now() - was[id] < 1000) return;
  const live = new Set((st.data?.sessions ?? []).map((x) => x.id));
  const used = {};
  for (const [k, v] of Object.entries(was))
    if (live.has(k) && typeof v === "number") used[k] = v;
  used[id] = Date.now();
  try {
    localStorage.setItem(SHELL_USED_KEY, JSON.stringify(used));
  } catch {
    /* none: the newest shell instead */
  }
}

function writeUrl() {
  try {
    // #80: the browser's tabs, every project's: a project's view only
    // leaves the others out (st.hiddenOpen), so a Terminal link brings
    // them back in All active.
    localStorage.setItem(
      OPEN_KEY,
      [...new Set([...st.hiddenOpen, ...st.open])].join(","),
    );
  } catch {
    /* none: the URL alone */
  }
  const u = new URL(location.href);
  if (st.open.length) u.searchParams.set("open", st.open.join(","));
  else u.searchParams.delete("open");
  // #80: the tab in front, so a reload keeps the pane the keyboard was in.
  if (st.open.length > 1 && st.open.includes(st.cur))
    u.searchParams.set("front", st.cur);
  else u.searchParams.delete("front");
  u.searchParams.set("layout", st.layout);
  u.searchParams.delete("start");
  u.searchParams.delete("folder");
  u.searchParams.delete("service");
  u.searchParams.delete("agent");
  u.searchParams.delete("terminal");
  u.searchParams.delete("fresh");
  const s = u.searchParams.toString().replace(/%2C/gi, ",");
  history.replaceState(history.state, "", u.pathname + (s ? `?${s}` : ""));
  paintSub();
}

// ── the list ────────────────────────────────────────────────────────────

/** A link that names one agent (?agent=): it picks the pane itself. */
const linkedAgentAsked = () =>
  new URLSearchParams(location.search).has("agent");

/** ?ws=: the one workspace the page was asked for, or null. */
const urlWorkspace = () => {
  // #80: ?project=, with ?ws= read as its old name.
  const q = new URLSearchParams(location.search);
  return q.get("project") || q.get("ws");
};

/**
 * The workspaces to show: ?ws= (always that one, even when it isn't active
 * or isn't known: never All in its place), else the scope bar's view.
 */
function viewWorkspaces() {
  const all = st.data?.workspaces ?? [];
  const ws = urlWorkspace();
  if (ws) return [ws];
  if (st.scope && st.scope !== "all" && all.includes(st.scope))
    return [st.scope];
  return all;
}

function stateTone(r) {
  // The shell's dot: plain is the good one (the repo table's look).
  if (r.state === "running") return "";
  if (r.state === "stopping") return "pending";
  if (/^exited \((?!0\))/.test(r.state)) return "bad";
  return "off";
}

function stateText(state) {
  const m = /^exited(?: \((-?\d+)\))?$/.exec(state);
  if (m)
    return m[1] === undefined
      ? t("ag.state.exited")
      : t("ag.state.exitedCode", { code: m[1] });
  return ["running", "stopping", "stopped", "ended", "interrupted"].includes(
    state,
  )
    ? t(`ag.state.${state}`)
    : state;
}

function displayName(r) {
  if (r.kind !== "agent") return r.label;
  return r.displayName || (r.persona ?? r.label);
}

/**
 * A row's name: the name a person gave it (AG-4b), then its persona and
 * id; else its persona, then its id (when they differ).
 */
function nameHtml(r) {
  const extra = sessionExtra(r);
  if (r.displayName)
    return `${esc(r.displayName)} <span class="id">${esc([r.persona, r.label, extra].filter(Boolean).join(" · "))}</span>`;
  const id = [r.persona && r.persona !== r.label ? r.label : "", extra]
    .filter(Boolean)
    .join(" · ");
  return `${esc(displayName(r))}${id ? ` <span class="id">${esc(id)}</span>` : ""}`;
}

/**
 * The session's name (AG-4b: the runtime's /rename or Den's, the later),
 * where it says more than the agent's own name: not empty, not the
 * persona, not the name already shown. Else "".
 */
function sessionExtra(r) {
  const n = r?.kind === "agent" ? (r.sessionTitle ?? "").trim() : "";
  if (!n || n === r.persona || n === paneName(r) || n === displayName(r))
    return "";
  return n;
}

// A pane's title and its Close: the agent's display name (AG-10.8), else
// its id, never the persona. There is no display name before AG-10.
function paneName(r) {
  return r.kind === "agent" ? r.displayName || r.agent || r.label : r.label;
}

/** An agent that isn't running: stopped, interrupted or exited (AG-14). */
export function isStopped(r) {
  return r.kind === "agent" && r.state !== "running" && r.state !== "stopping";
}

/** 0.4.45: a shell that exited (it has nothing to resume). */
export const exitedShell = (r) => r?.kind === "session" && r.exited === true;

/** 0.4.45: what the Stopped group holds: stopped agents, exited shells. */
export const inStopped = (r) => isStopped(r) || exitedShell(r);

/** issue 206: true when `iso` is today in the person's own zone. */
function isToday(iso) {
  const day = formatTime(iso, { style: "date" });
  return !!day && day === formatTime(Date.now(), { style: "date" });
}

/** "7:52 PM" today, else "Nov 6, 7:52 PM": the person's zone (issue 206). */
function when(iso) {
  return formatTime(iso, { style: isToday(iso) ? "time" : "datetime" });
}

/** Why a stopped agent stopped (AG-14.1). */
export function stopReason(r) {
  // Issue 659: its folder-trust question was declined: it never started.
  if (r.trustDeclined) return t("ag.why.trustDeclined");
  // Issue 631: it didn't come back after a restart (its terminal host's
  // too), and why.
  if (r.restartFailed?.why)
    return t("ag.why.restartFailed", { why: r.restartFailed.why });
  if (r.state === "interrupted")
    return t("ag.why.interrupted", { name: TITLE });
  if (r.state === "stopped")
    return t("ag.why.stopped", { time: when(r.stoppedAt ?? "") }).trim();
  const m = /^exited(?: \((-?\d+)\))?$/.exec(r.state);
  if (m)
    return m[1] === undefined
      ? t("ag.why.exited")
      : t("ag.why.exitedCode", { code: m[1] });
  return stateText(r.state);
}

/** Why it rotates, in words: "3 compactions", "PR merged" (den#4). */
function rotationWhy(rot) {
  if (rot.due === "pr-merged") return t("ag.rot.merged");
  return t(
    rot.compactions === 1 ? "ag.rot.compactions.one" : "ag.rot.compactions",
    {
      n: rot.compactions,
    },
  );
}

/** The Workspaces page, focused on workspace `ws` (0.4.17). */
function wsHref(ws) {
  const nav = window.denShell?.nav?.() ?? [];
  const base = nav.find((n) => n.id === "local-dev")?.href ?? "/local-dev";
  return `${base}?project=${encodeURIComponent(ws)}`;
}

/**
 * 0.4.45: a project's name as the header's picker shows it: Hub's when it
 * is linked to a Hub project, else its own (workspace-picker.js). From
 * /api/workspaces, read with the list now and then (st.projects).
 */
function projName(ws) {
  return projectLabel(st.projects, ws);
}

/** Workspace `ws` as a link to it on Workspaces. */
function wsLinkHtml(ws) {
  // ON-6: the server agent belongs to no workspace: its group is "Server".
  if (ws === SERVER_WS)
    return `<span class="wslink" data-server>${esc(t("ag.server"))}</span>`;
  const name = projName(ws);
  return `<a class="wslink" href="${esc(wsHref(ws))}" title="${esc(t("ag.goWs", { ws: name }))}">${esc(name)}</a>`;
}

/**
 * D20: where its session runs, as a tag: "Stops at logout" (the desktop
 * session) or "No GUI" (outside it: kept across logout). `button`: a
 * button that says why when tapped (the pane bar); else a span (a row,
 * itself a button). "" when the host didn't say (off macOS, older host).
 */
function whereTag(r, button = false) {
  const s = r?.launchd;
  const logout = s === "Aqua" || s === "LoginWindow";
  if (!logout && s !== "Background" && s !== "System") return "";
  const key = logout ? "ag.where.logout" : "ag.where.bg";
  const tip = t(`${key}Tip`, { cli: CLI });
  const cls = `tagx${logout ? " warn" : ""}`;
  const where = logout ? "logout" : "bg";
  return button
    ? `<button type="button" class="${cls}" data-act="where" data-where="${where}" title="${esc(tip)}" aria-label="${esc(`${t(key)}: ${tip}`)}">${logout ? "⚠ " : ""}${esc(t(key))}</button>`
    : `<span class="${cls}" data-where="${where}" title="${esc(tip)}">${logout ? "⚠ " : ""}${esc(t(key))}</span>`;
}

/**
 * D65 v2: "<project> › <repo>" in the pane bar, with Change; a repo that
 * is no longer its project's says so, with Re-link. Read from its record,
 * never its folder.
 */
function linkTag(r) {
  if (r?.kind !== "agent" || r.server) return "";
  const project = projName(r.project || r.workspace);
  const path = r.repo ? `${project} › ${r.repo}` : project;
  return (
    `<span class="aglink" data-link><span class="mono">${esc(path)}</span>` +
    (r.repoMissing
      ? `<span class="tagx warn" data-repo-missing>${esc(t("ag.link.missing"))}</span>`
      : "") +
    `<button type="button" class="den-lnk" data-act="link" aria-label="${esc(t("ag.link.changeName", { id: r.agent }))}">${esc(t(r.repoMissing ? "ag.link.relink" : "ag.link.change"))}</button></span>`
  );
}

/**
 * den#3: what its subagents run on, and where that came from: the pane
 * bar's tag. Nothing for a runtime that takes no subagent model.
 */
function subagentTag(r) {
  if (r?.kind !== "agent" || !r.subagentModel) return "";
  const inherit = r.subagentModel === "inherit";
  const model = inherit ? t("ag.subagents.inherit") : r.subagentModel;
  const from = r.subagentModelFrom || "default";
  // inherit: Den sets none, said plainly (not "runs on the runtime's").
  const tip = inherit
    ? t(`ag.subagents.inheritFrom.${from === "persona" ? "persona" : "org"}`)
    : t(`ag.subagents.from.${from}`, { model });
  return `<span class="tagx" data-subagents="${esc(r.subagentModel)}" title="${esc(tip)}">${esc(t("ag.subagents", { model }))}</span>`;
}

/**
 * Issue 340: the vendor account it runs on under the always-on service, by
 * its label (never an email): the pane bar's tag. Nothing without one.
 */
function signInTag(r) {
  if (r?.kind !== "agent" || !r.signIn) return "";
  return `<span class="tagx" data-signin title="${esc(t("ag.signIn.tip", { label: r.signIn }))}">${esc(t("ag.signIn", { label: r.signIn }))}</span>`;
}

/** Its rotation, when one is due: "ready" or "due" (den#4). */
function rotationOf(r) {
  // D28: on_due off: nothing will happen, so nothing is shown.
  if (!r.rotation?.due || r.rotation.onDue === "off") return "";
  return r.rotation.ready ? "ready" : "due";
}

/** D28: Settings › Agents (its Rotation row). */
function settingsHref() {
  const nav = window.denShell?.nav?.() ?? [];
  const base = nav.find((n) => n.id === "settings")?.href ?? "/settings";
  return `${base}?q=rotation#agents`;
}

/**
 * D28: what happens to a due agent, in words, from its on_due (auto: Den
 * asks for the handoff at idle and relaunches it; ask; auto that gave up
 * asking). Older servers send no on_due: as ask.
 */
function rotMessage(r) {
  const rot = r.rotation;
  const why = rotationWhy(rot);
  const auto = rot.onDue === "auto" && !rot.fellBack;
  if (rot.relaunchWanted && !rot.ready) return t("ag.rc.wanted", { why });
  if (auto && !isStopped(r))
    return t(rot.ready ? "ag.rc.autoReady" : "ag.rc.autoAsk", { why });
  if (rot.fellBack && !rot.ready)
    return t(
      rot.handoff === "invalid" ? "ag.rc.fellBackBad" : "ag.rc.fellBack",
      { why },
    );
  return t(
    rot.ready
      ? "ag.rc.ready"
      : rot.handoff === "invalid"
        ? "ag.rc.bad"
        : "ag.rc.missing",
    { why },
  );
}

/**
 * D28: the rotation callout's buttons, wherever it shows (a row, the pane
 * bar): Relaunch now (from the handoff, or asking for it first), Write
 * handoff (a running agent without one), Keep this conversation with
 * "don't ask again", and Settings. "" when nothing is due or on_due is off.
 */
function rotActionsHtml(r) {
  const rot = r.rotation;
  if (!rot?.due || rot.onDue === "off") return "";
  const id = r.agent;
  const now = `<button type="button" class="den-btn sm primary" data-act="relaunch" aria-label="${esc(t("ag.relaunchName", { id }))}">${esc(t("ag.relaunch"))}</button>`;
  const write =
    !isStopped(r) && !rot.ready && !rot.relaunchWanted
      ? `<button type="button" class="den-btn sm" data-act="rot-write" aria-label="${esc(t("ag.rc.writeName", { id }))}">${esc(t("ag.rc.write"))}</button>`
      : "";
  const keep = `<button type="button" class="den-btn sm" data-act="rot-keep" aria-label="${esc(t("ag.rc.keepName", { id }))}">${esc(t("ag.rc.keep"))}</button>`;
  const never = `<label class="agnever"><input type="checkbox" data-rot-never> ${esc(t("ag.rc.never"))}</label>`;
  const settings = `<a class="lnk" data-rot-settings href="${esc(settingsHref())}">${esc(t("ag.rc.settings"))}</a>`;
  return now + write + keep + never + settings;
}

/** D28: the effective settings and where each comes from, in words. */
function rotFromText(rot) {
  if (!rot?.from) return "";
  return t(
    rot.after === 0
      ? "ag.rc.fromNever"
      : rot.after === 1
        ? "ag.rc.from.one"
        : "ag.rc.from",
    {
      n: rot.after,
      src: rot.from.after_compactions,
      mode: t(`ag.rc.mode.${rot.onDue}`),
      src2: rot.from.on_due,
    },
  );
}

/** D28: the callout under a row: the message, its line of settings, the buttons. */
function rotCalloutHtml(r) {
  const acts = rotActionsHtml(r);
  if (!acts) return "";
  const from = rotFromText(r.rotation);
  return (
    `<span class="agcant" data-rot-msg data-handoff="${esc(r.rotation.handoff)}">${esc(rotMessage(r))}</span>` +
    (from
      ? `<span class="agcant agfrom" data-rot-from>${esc(from)}</span>`
      : "") +
    acts
  );
}

/** D37: "10:13 PM" today, else "Nov 6": short, a <time> (issue 206). */
function whenShort(iso) {
  return timeHtml(iso, { style: isToday(iso) ? "time" : "date" });
}

/** D37: a not-running agent's chip: Stopped, Exited or Interrupted. */
function stoppedChip(r) {
  if (r.state === "interrupted") return t("ag.chip.interrupted");
  if (/^exited\b/.test(r.state)) return t("ag.chip.exited");
  return t("ag.chip.stopped");
}

/** D37: what a stopped row leaves out, for its tooltip. */
function stoppedTip(r) {
  const who = [r.persona, r.agent].filter(Boolean).join(" · ");
  const meta = [r.runtime, cwdText(r)].filter(Boolean).join(" · ");
  const cant =
    !r.resumable && r.noResume
      ? r.noResume.startsWith(`${r.runtime} `)
        ? t("ag.noResume", { runtime: r.runtime })
        : r.noResume
      : "";
  return [who, meta, stopReason(r), cant].filter(Boolean).join("\n");
}

/**
 * A stopped agent's row (D37): one line. A hollow dot, its name, a chip
 * (Stopped, Exited, Interrupted), when, then Resume and ⋯ (Start fresh,
 * Remove). Its persona, id, runtime and folder are in its tooltip and its
 * pane. No Rename (a running agent's), no helpers (D34: only a running
 * agent's active ones). A runtime that can't resume: Start fresh instead
 * of Resume, and ⋯ has Remove. D28: a due rotation's callout stays.
 */
function stoppedHtml(r, wsTag = false) {
  const open = st.open.includes(r.id);
  const name = displayName(r);
  // Its own name, else its id: short, and unique (the persona is in the
  // tooltip; several stopped agents often share one).
  const label = r.displayName || r.agent || name;
  const who = esc(r.agent);
  const rot = rotationOf(r);
  const callout = rotCalloutHtml(r);
  const at = whenShort(r.stoppedAt ?? r.endedAt ?? "");
  const chip =
    rot === "ready"
      ? t("ag.rot.ready", { why: rotationWhy(r.rotation) })
      : stoppedChip(r);
  const first = r.resumable
    ? `<button type="button" class="den-btn sm primary" data-act="resume" aria-label="${esc(t("ag.resumeName", { id: r.agent }))}">${esc(t("ag.resume"))}</button>`
    : `<button type="button" class="den-btn sm" data-act="fresh" aria-label="${esc(t("ag.freshName", { id: r.agent }))}">${esc(t("ag.fresh"))}</button>`;
  const more = `<button type="button" class="den-btn sm" data-act="row-more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t("ag.more", { id: r.agent }))}" title="${esc(t("ag.more", { id: r.agent }))}">⋯</button>`;
  return (
    `<div class="agst agst1" data-agent="${who}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}"${rot ? ` data-rotation="${rot}"` : ""}>` +
    // D45: a click (or Enter) opens its details, with Resume in them.
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="agent" data-state="${esc(r.state)}" data-details=""` +
    ` aria-haspopup="dialog" aria-expanded="${agd.r?.id === r.id}"` +
    ` title="${esc(stoppedTip(r))}"` +
    ` aria-label="${esc(t("ag.det.label", { id: `${r.workspace} / ${name}` }))}">` +
    gripHtml(r) +
    `<span class="den-dot ${stateTone(r)} hollow" aria-hidden="true"></span>` +
    `<span class="nm">${esc(label)}${wsTag ? ` <span class="id">${esc(r.workspace)}</span>` : ""}</span>` +
    `<span class="stchip" title="${esc(chip)}">${esc(chip)}</span>` +
    (at ? `<span class="when">${at}</span>` : "") +
    `</button>` +
    `<span class="agacts">${first}${more}</span>` +
    (callout ? `<div class="agcallout">${callout}</div>` : "") +
    // Issue 278: deliveries still held after a loop: Clear.
    (compactingHtml(r)
      ? `<div class="agcallout">${compactingHtml(r)}</div>`
      : "") +
    hubWorkHtml(r) +
    `</div>`
  );
}

/**
 * 0.4.45: an exited shell in Stopped: its name, "Exited", and Remove. A
 * click opens its pane, where its last output still reads.
 */
function exitedShellHtml(r, wsTag = false) {
  const label = r.label || r.name;
  return (
    `<div class="agst agst1" data-shell="${esc(r.id)}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}">` +
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="session" data-state="${esc(r.state)}"` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${label}` }))}">` +
    `<span class="den-dot ${stateTone(r)} hollow" aria-hidden="true"></span>` +
    `<span class="nm">${esc(label)}${wsTag ? ` <span class="id">${esc(r.workspace)}</span>` : ""}</span>` +
    `<span class="stchip">${esc(stoppedChip(r))}</span>` +
    `</button>` +
    `<span class="agacts"><button type="button" class="den-btn sm" data-act="remove-shell" aria-label="${esc(t("ag.removeShell", { id: label }))}">${esc(t("ag.remove"))}</button></span>` +
    `</div>`
  );
}

/**
 * 0.4.40: "Working on N Hub comments · <artifact>" (its turn has them), or
 * "N Hub comments wait for it" (stopped, or mid-turn); the artifact links
 * to Hub. Under the row (never inside its button).
 */
export function hubWorkHtml(r, tr = t) {
  const w = r?.kind === "agent" ? r.hubWork : null;
  if (!w || !(w.working > 0 || w.queued > 0)) return "";
  const n = w.working > 0 ? w.working : w.queued;
  const key = w.working > 0 ? "ag.hub.working" : "ag.hub.queued";
  const url =
    typeof w.url === "string" && /^https?:\/\//.test(w.url) ? w.url : "";
  const art = w.artifact
    ? url
      ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(w.artifact)}</a>`
      : ` · ${esc(w.artifact)}`
    : "";
  // Issue 664: why the queued ones wait, when Den knows.
  const why =
    w.working > 0 || w.held !== "not_at_prompt"
      ? ""
      : ` · <span data-held="not_at_prompt">${esc(tr("ag.hub.notAtPrompt"))}</span>`;
  return (
    `<div class="aghub" data-hubwork="${w.working > 0 ? "working" : "queued"}">` +
    `<span class="den-dot ${w.working > 0 ? "ok" : "warn"}" aria-hidden="true"></span> ` +
    `${esc(tr(key, { n }))}${art}${why}</div>`
  );
}

/** Issue 278: "840 KB" (whole KB; under 1 KB: bytes). */
function sizeText(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Issue 278: the agent's instruction files were over the share of its
 * context at its last start: a tag, its tooltip naming the largest file.
 */
export function instructionsTag(r, tr = t) {
  const i = r?.kind === "agent" ? r.instructions : null;
  if (!i) return "";
  const tip = tr("ag.ins.tip", {
    size: sizeText(i.totalBytes),
    share: i.sharePercent,
    path: i.largest?.path ?? "",
    big: sizeText(i.largest?.bytes ?? 0),
  });
  return `<span class="tagx warn" data-instructions title="${esc(tip)}">${esc(tr("ag.ins.tag"))}</span>`;
}

/** Issue 278: "Compacting repeatedly" (a loop now) as a tag. */
export function compactingTag(r, tr = t) {
  const c = r?.kind === "agent" ? r.compacting : null;
  if (!c?.active) return "";
  return `<span class="tagx warn" data-compacting title="${esc(tr("ag.ctx.looping", { n: c.count }))}">${esc(tr("ag.ctx.tag"))}</span>`;
}

/**
 * Issue 278: under the row of an agent stuck compacting: what is
 * happening, the likely cause (its instruction files, when its start's
 * check warned), Stop (the same Stop as its pane's) and, when Den holds its
 * deliveries, Clear. Nothing when there is neither a loop nor a hold.
 */
export function compactingHtml(r, tr = t, { withStop = true } = {}) {
  const c = r?.kind === "agent" ? r.compacting : null;
  if (!c || !(c.active || c.paused)) return "";
  const i = r.instructions;
  const cause = i
    ? tr("ag.ctx.causeFiles", {
        size: sizeText(i.totalBytes),
        share: i.sharePercent,
        path: i.largest?.path ?? "",
        big: sizeText(i.largest?.bytes ?? 0),
      })
    : tr("ag.ctx.causeOther");
  const said = [
    c.active ? tr("ag.ctx.looping", { n: c.count }) : "",
    c.active ? cause : "",
    c.paused ? tr("ag.ctx.held") : "",
  ]
    .filter(Boolean)
    .join(" ");
  const stop =
    withStop && c.active && (r.state === "running" || r.state === "stopping")
      ? `<button type="button" class="den-btn sm" data-act="stop" aria-label="${esc(tr("ag.stopName", { id: r.agent }))}">${esc(tr("ag.stop"))}</button>`
      : "";
  const clear = `<button type="button" class="den-btn sm" data-act="ctx-clear" aria-label="${esc(tr("ag.ctx.clearName", { id: r.agent }))}">${esc(tr(c.paused ? "ag.ctx.clearHeld" : "ag.ctx.clear"))}</button>`;
  return (
    `<span class="agcant" data-compacting-msg>${esc(said)}</span>` +
    stop +
    clear
  );
}

/** Issue 278: a person looked: the loop is over for now; held deliveries go. */
async function clearCompacting(r, button) {
  await window.denShell.busyAction(
    "save",
    (headers) =>
      api("POST", agentPath(r, "compacting-clear"), undefined, { headers }),
    {
      button,
      success: () => t("ag.ctx.cleared", { id: r.agent }),
    },
  );
  await refresh();
}

/** NT-3b: what the "waiting" badge says: why, when the server knows. */
function waitingText(r) {
  const k = r.waitingWhy ? `ag.waiting.${r.waitingWhy}` : "";
  const s = k ? t(k) : "";
  return s && s !== k ? s : t("ag.waiting");
}

function rowHtml(r) {
  if (isStopped(r)) return stoppedHtml(r);
  const open = st.open.includes(r.id);
  const nm =
    r.kind === "agent"
      ? nameHtml(r)
      : `${esc(r.label)} <span class="sbdg">${esc(t("ag.session"))}</span>`;
  const right = r.waiting
    ? `<span class="wbdg">${esc(waitingText(r))}</span>`
    : `<span class="st">${esc(stateText(r.state))}</span>`;
  const meta = [r.runtime, cwdText(r)].filter(Boolean).join(" · ");
  // D62: the helpers chip is on line 2, before the meta, never in the dot's
  // column (it pushed this row's name right of the others').
  const chip = r.kind === "agent" ? helperBadgeHtml(r) : "";
  const said = r.kind === "agent" ? helperCountSaid(r) : "";
  const rot = rotationOf(r);
  const rotTag = rot
    ? `<span class="tagx warn" data-rotation="${rot}">${esc(
        t(rot === "ready" ? "ag.rot.ready" : "ag.rot.due", {
          why: rotationWhy(r.rotation),
        }),
      )}</span>`
    : "";
  const revokedTag = r.tokenRevoked
    ? `<span class="tagx warn" title="${esc(t("ag.revokedTip"))}">${esc(t("ag.revoked"))}</span>`
    : "";
  const ovTags = r.kind === "agent" ? overrideTagsHtml(r) : "";
  const wTag = whereTag(r);
  const mTag = mcpStaleTag(r, false);
  const modeTag = modeTagHtml(r, false);
  // Issue 144: this agent holds (or waits for) the machine's gate slot.
  const gateText =
    r.kind === "agent" ? (st.gate?.tagFor(`agent:${r.agent}`) ?? "") : "";
  const gateTag = gateText
    ? `<span class="tagx" data-gate-tag>${esc(gateText)}</span>`
    : "";
  // Issue 278: compacting repeatedly; instruction files over the share.
  const ctxTags = compactingTag(r) + instructionsTag(r);
  const tags =
    rotTag ||
    revokedTag ||
    ovTags ||
    wTag ||
    mTag ||
    modeTag ||
    gateTag ||
    ctxTags
      ? `<span class="agtags">${ctxTags}${revokedTag}${mTag}${modeTag}${gateTag}${rotTag}${wTag}${ovTags}</span>`
      : "";
  const button =
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}" data-state="${esc(r.state)}"` +
    ` aria-pressed="${open}"${open && r.id === st.cur ? ' aria-current="true"' : ""}${r.attachable ? "" : ' aria-disabled="true"'}` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${displayName(r)}` }) + (said ? ` · ${said}` : ""))}">` +
    gripHtml(r) +
    `<span class="den-dot ${r.waiting ? "warn" : stateTone(r)}" aria-hidden="true"></span>` +
    `<span class="nm">${nm}</span>${right}` +
    (chip
      ? `<span class="agl2">${chip}${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</span>`
      : meta
        ? `<span class="meta">${esc(meta)}</span>`
        : "") +
    tags +
    `</button>`;
  // D28: a running agent whose rotation is due: its callout, with buttons
  // (before, only a tag: nothing to press).
  // MODE-3: Restart to apply, under a row whose mode differs.
  // Issue 278: compacting repeatedly: why, Stop, and Clear.
  const callout =
    r.kind === "agent"
      ? rotCalloutHtml(r) + modeApplyHtml(r) + compactingHtml(r)
      : "";
  // D32: the helpers it started in its own session, under it. #80: only
  // once its badge is opened (closed by default, the agent in front too).
  const hOpen = r.kind === "agent" && st.helpersOpen.has(helperKey(r));
  const helpers =
    r.kind === "agent" ? helperRowsHtml(r, hOpen, st.helpersShown) : "";
  // #80: the badge is a button beside the row's (laid over its place).
  const toggle = r.kind === "agent" ? helperToggleHtml(r, hOpen) : "";
  const row = toggle ? `<div class="agrw">${button}${toggle}</div>` : button;
  const hub = hubWorkHtml(r);
  if (!callout) return row + hub + helpers;
  return (
    `<div class="agst" data-agent="${esc(r.agent)}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}"${rot ? ` data-rotation="${rot}"` : ""}>` +
    row +
    `<div class="agacts">${callout}</div>` +
    hub +
    `</div>` +
    helpers
  );
}

/** #80: an agent's key in st.helpersOpen. */
const helperKey = (r) => `${r.workspace}\0${r.agent}`;

/**
 * #80: each helpers badge sits over its placeholder on its row's second
 * line (the row is a button, and a button can't hold one).
 */
function placeHelperToggles(root) {
  for (const w of root.querySelectorAll(".agrw")) {
    const ph = w.querySelector(".agr-hp-ph");
    const b = w.querySelector(":scope > .agr-hpb");
    if (!ph || !b) continue;
    const a = w.getBoundingClientRect();
    const r = ph.getBoundingClientRect();
    b.style.left = `${Math.round(r.left - a.left)}px`;
    b.style.top = `${Math.round(r.top - a.top)}px`;
  }
}

/** Where focus was in the list, as a selector that finds it again once
 * the list is redrawn: a helper row or button, an agent's row, a link. */
function listFocusKey(el) {
  const key = refindKey(el);
  if (key) return key;
  const q = (v) => CSS.escape(String(v ?? ""));
  if (el.matches(".agr-hpb[data-agent]"))
    return `#agl .agr-hpb[data-agent="${q(el.dataset.agent)}"][data-ws="${q(el.dataset.ws)}"]`;
  if (el.matches("button.agr[data-id]"))
    return `#agl button.agr[data-id="${q(el.dataset.id)}"]`;
  if (el.matches("[data-act]")) {
    // Issue 96: a phone's Up and Down sit in the row's .agord, beside .agst.
    const row = el.closest(".agst[data-agent], .agord[data-agent]");
    const cls = row?.classList.contains("agord") ? "agord" : "agst";
    const act = `[data-act="${q(el.dataset.act)}"]`;
    return row
      ? `#agl .${cls}[data-agent="${q(row.dataset.agent)}"][data-ws="${q(row.dataset.ws)}"] ${act}`
      : `#agl ${act}`;
  }
  return "";
}

/** The list's HTML, written only when it changed; focus inside it is kept
 * (the refresh poll redraws it every few seconds). */
function setList(el, html) {
  // Issue 96: never under a drag (its rows and drop line would go); a drop or
  // its end paints the list again.
  if (st.drag) return;
  if (el.denHtml === html) return;
  el.denHtml = html;
  const had = el.contains(document.activeElement)
    ? document.activeElement
    : null;
  const key = had ? listFocusKey(had) : "";
  el.innerHTML = html;
  placeHelperToggles(el);
  if (had) focusBack(had, key);
}

function paintList() {
  const el = st.root.querySelector("#agl");
  el.removeAttribute("aria-busy");
  const notes = [];
  if (st.signedOut || st.data?.io?.allowed === false)
    notes.push(
      `<div class="signin" data-note="signin">${esc(t("ag.signin", { cli: CLI }))}</div>`,
    );
  else if (st.data && st.data.backend?.available === false)
    notes.push(
      `<div class="agnote" data-note="backend">${esc(t("ag.noBackend", { cli: CLI }))}</div>`,
    );
  // den#156: the host didn't answer in time: this list may be old.
  if (st.hostDown)
    notes.push(
      `<div class="agnote" data-note="host" role="status">${esc(t("ag.hostDown"))}</div>`,
    );
  if (!st.data) {
    setList(el, notes.join(""));
    return;
  }
  // ON-6: the server agent's group, "Server", first, whatever the view.
  // D71: agents whose workspace was deleted, under its old name.
  const orphans = st.data.sessions.filter(
    (s) => s.orphan && belongsOn(PAGE, s),
  );
  const shown = [
    ...new Set([
      ...(st.data.sessions.some((s) => s.server) ? [SERVER_WS] : []),
      ...viewWorkspaces(),
      ...orphans.map((s) => s.workspace),
    ]),
  ];
  if (orphans.length)
    notes.push(
      `<div class="agnote" data-note="orphan" role="status">` +
        esc(
          t(orphans.length === 1 ? "ag.orphan.one" : "ag.orphan.many", {
            n: orphans.length,
            // The agent, not its persona: its given name, else its id.
            names: orphans.map((r) => r.displayName || r.agent).join(", "),
          }),
        ) +
        `</div>`,
    );
  // #80: an agent opened on purpose switched the project: say so.
  const now = viewWorkspaces();
  if (st.switchedFrom && now.length === 1 && now[0] !== st.switchedFrom)
    notes.push(
      `<div class="agnote" data-note="switched" role="status">` +
        esc(t("ag.switchedTo", { ws: now[0] })) +
        ` · <button type="button" class="lnk" data-act="switch-back">${esc(t("ag.backTo", { ws: st.switchedFrom }))}</button></div>`,
    );
  // #80: tabs ?open= named from other projects, left out of this view.
  if (st.hiddenOpen.length)
    notes.push(
      `<div class="agnote" data-note="other-tabs" role="status">` +
        esc(
          t("ag.otherTabs", {
            n: st.hiddenOpen.length,
          }),
        ) +
        ` · <button type="button" class="lnk" data-act="show-all">${esc(t("ag.showAllActive"))}</button></div>`,
    );
  // ?ws= names a workspace that isn't active: say so, and offer the switch.
  const asked = st.data.requested;
  if (asked && !asked.active)
    notes.push(
      `<div class="agnote" data-note="inactive" role="status">` +
        esc(t("ag.inactive", { ws: asked.workspace })) +
        (asked.known
          ? ` · <button type="button" class="lnk" data-act="switch-ws">${esc(t("ag.switchWs", { ws: asked.workspace }))}</button>`
          : ` ${esc(t("ag.unknownWs"))}`) +
        `</div>`,
    );
  // AG-14.3: one line after a restart, for the agents it interrupted.
  const hit = visibleRows().filter((r) => r.state === "interrupted");
  if (hit.length)
    notes.push(
      `<div class="agnote" data-note="interrupted" role="status">` +
        `${esc(t(hit.length === 1 ? "ag.interrupted.one" : "ag.interrupted", { n: hit.length, name: TITLE }))}` +
        (hit.some((r) => r.resumable)
          ? ` · <button type="button" class="lnk" data-act="resume-all">${esc(t("ag.resumeAll"))}</button>`
          : "") +
        ` · <button type="button" class="lnk" data-act="review">${esc(t("ag.review"))}</button></div>`,
    );
  // Issue 482: the Agents page says once where the shells went.
  if (PAGE !== "terminal") notes.push(movedNote());
  // D37: running ones under their workspace; the agents that aren't
  // running in one "Stopped (n)" group at the bottom.
  const inView = shown.flatMap((ws) =>
    st.data.sessions.filter((s) => s.workspace === ws && belongsOn(PAGE, s)),
  );
  const stopped = inView.filter(inStopped);
  const groups = shown
    .map((ws) => ({
      ws,
      rows: inView.filter((s) => s.workspace === ws && !inStopped(s)),
    }))
    .filter((g) => g.rows.length > 0);
  const body =
    PAGE === "terminal"
      ? terminalsBodyHtml()
      : groups.length || stopped.length
        ? groups
            .map(
              (g) =>
                `<div class="wsg" data-ws="${esc(g.ws)}"><div class="wsh"><span>${wsLinkHtml(g.ws)}</span><span>${reorderButtonHtml(g)}${esc(g.rows.length)}</span></div>` +
                g.rows.map((r) => reorderRowHtml(g, r)).join("") +
                `</div>`,
            )
            .join("") + stoppedGroupHtml(stopped)
        : `<div class="none">${esc(t("ag.none.scope", { scope: st.scopeLabel }))}</div>`;
  setList(
    el,
    notes.join("") +
      body +
      `<div class="aghint" id="agl-hint">${esc(t(`ag.hint.${shownLayout()}`))} ${esc(t("ag.hint.keys"))}</div>`,
  );
  const clear = st.root.querySelector("#ag-clear");
  if (clear)
    clear.hidden = PAGE === "terminal" || !visibleRows().some(inStopped);
  // No such workspace: nothing to start an agent in.
  const start = st.root.querySelector("#ag-start");
  if (start) start.hidden = st.data.requested?.known === false;
}

/**
 * Issue 482: the Terminals page's list: Running, then Exited, each by
 * last used, newest first; under All projects each row names its
 * project. Empty: says so, and how to open one.
 */
function terminalsBodyHtml() {
  const used = shellUsed();
  const { running, exited } = terminalGroups(visibleRows(), used);
  if (!running.length && !exited.length)
    return (
      `<div class="none tmnone"><strong>${esc(t("tm.none"))}</strong>` +
      `<span>${esc(t("tm.noneP", { scope: st.scopeLabel }))}</span></div>`
    );
  const view = viewWorkspaces();
  const showProject = view.length !== 1;
  const row = (r) =>
    terminalRowHtml(r, {
      t,
      when: agoPlain,
      showProject,
      open: st.open.includes(r.id),
      current: r.id === st.cur,
      used,
    });
  const group = (key, list) =>
    list.length
      ? `<div class="wsg tmg" data-tm="${key}"><div class="wsh"><span>${esc(t(`tm.${key}`, { n: list.length }))}</span></div>` +
        list.map(row).join("") +
        `</div>`
      : "";
  return group("running", running) + group("exited", exited);
}

/** Issue 482: the Agents page's note, once per browser (until dismissed). */
const MOVED_KEY = "den-terminals-moved-seen";

function movedSeen() {
  try {
    return localStorage.getItem(MOVED_KEY) === "1";
  } catch {
    return false;
  }
}

function markMovedSeen() {
  try {
    localStorage.setItem(MOVED_KEY, "1");
  } catch {
    /* none: shown again on the next load */
  }
}

function movedNote() {
  if (movedSeen()) return "";
  const view = viewWorkspaces();
  const n = (st.data?.sessions ?? []).filter(
    (s) => s.kind === "session" && view.includes(s.workspace),
  ).length;
  return movedNoteHtml(n, t);
}

/** Issue 482: the Terminals page, in the project in view. */
function terminalsHref() {
  const view = viewWorkspaces();
  return view.length === 1
    ? `/terminals?project=${encodeURIComponent(view[0])}`
    : "/terminals";
}

const STOPPED_OPEN_KEY = "den-agents-stopped-open";

/** D37: whether "Stopped (n)" is open: as a person left it, else open
 * for 3 or fewer. */
function stoppedOpen(n) {
  try {
    const v = localStorage.getItem(STOPPED_OPEN_KEY);
    if (v === "1" || v === "0") return v === "1";
  } catch {
    /* none: the default */
  }
  return n <= 3;
}

function saveStoppedOpen(open) {
  try {
    localStorage.setItem(STOPPED_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* none: this page only */
  }
}

/** D37: the agents that aren't running, one line each, in one group. */
function stoppedGroupHtml(rows) {
  if (!rows.length) return "";
  // More than one workspace among them: each row names its own.
  const wsTag = new Set(rows.map((r) => r.workspace)).size > 1;
  return (
    `<details class="wsg agstg" data-stopped${stoppedOpen(rows.length) ? " open" : ""}>` +
    `<summary class="wsh" title="${esc(t("ag.stoppedGroupTip"))}"><span>${esc(t("ag.stoppedGroup", { n: rows.length }))}</span></summary>` +
    reorderStoppedHtml(rows) +
    rows
      .map((r) =>
        exitedShell(r)
          ? exitedShellHtml(r, wsTag)
          : // Issue 226: a phone's Reorder gives stopped agents Up and Down too.
            orderRowHtml(
              stoppedHtml(r, wsTag),
              r,
              phone() && st.reorderStopped && stoppedMovable(r),
            ),
      )
      .join("") +
    `</details>`
  );
}

/**
 * #80: whether session `s` belongs in this view: the view's projects, the
 * server agent (it spans projects) and an agent whose project was deleted
 * (D71). 0.4.44 added the open tabs' projects too, which mixed another
 * project's agents into a project's list; a tab from another project is
 * now left out instead (hideOtherProjects), so the list always has the
 * session in front.
 */
function inView(s) {
  if (!s) return false;
  // Issue 482: a shell is on the Terminals page, an agent on Agents.
  if (!belongsOn(PAGE, s)) return false;
  if (s.server || s.workspace === SERVER_WS || s.orphan) return true;
  return viewWorkspaces().includes(s.workspace);
}

function visibleRows() {
  return (st.data?.sessions ?? []).filter(inView);
}

/**
 * #80: the open panes of sessions outside this view leave the tabs (and
 * ?open=), kept in st.hiddenOpen for "Show in All active".
 */
function hideOtherProjects() {
  if (!st.data) return;
  const out = st.open.filter((id) => {
    const r = rowOf(id);
    return r && !inView(r);
  });
  if (!out.length) return;
  // Issue 482: the other page's kind leaves quietly (it is on its page).
  const other = out.filter((id) => belongsOn(PAGE, rowOf(id)));
  st.hiddenOpen = [...new Set([...st.hiddenOpen, ...other])];
  for (const id of out)
    if (st.panes.has(id)) closePane(id, { quiet: true });
    else st.open = st.open.filter((x) => x !== id);
  writeUrl();
}

/** #80: All active, with the hidden tabs back. */
async function showAllActive() {
  try {
    await window.denShell?.api?.("POST", "/api/scope", { scope: "all" });
  } catch {
    /* the link below still shows every project for this page */
  }
  const u = new URL(location.href);
  u.searchParams.delete("ws");
  u.searchParams.delete("project");
  u.searchParams.set(
    "open",
    [...new Set([...st.open, ...st.hiddenOpen])].join(","),
  );
  location.assign(
    u.pathname + "?" + u.searchParams.toString().replace(/%2C/gi, ","),
  );
}

/**
 * #80: opening another project's session from elsewhere (a link, ⌘K, a
 * bell item) switches this page to that project first.
 */
async function switchToProjectOf(r) {
  if (!r || inView(r)) return;
  const was = viewWorkspaces();
  st.switchedFrom = was.length === 1 ? was[0] : null;
  await showProject(r.workspace);
}

/** This page shows project `ws`: the address, the stored view, the top bar. */
async function showProject(ws) {
  const u = new URL(location.href);
  u.searchParams.delete("ws");
  u.searchParams.set("project", ws);
  history.replaceState(history.state, "", u.pathname + u.search);
  st.scope = ws;
  try {
    await window.denShell?.api?.("POST", "/api/scope", { scope: ws });
  } catch {
    /* the address still says it, for this page */
  }
  try {
    await (await import("/header.js")).refreshWorkspacePill?.();
  } catch {
    /* the top bar repaints on the next load */
  }
  await refresh();
}

/** #80: "Back to <project>": the project left, its tabs back. */
async function switchBack() {
  const ws = st.switchedFrom;
  if (!ws) return;
  st.switchedFrom = null;
  await showProject(ws);
  // Its tabs come back from where the browser kept them.
  for (const id of [...st.hiddenOpen]) {
    const r = rowOf(id);
    if (r && inView(r)) {
      st.hiddenOpen = st.hiddenOpen.filter((x) => x !== id);
      await openPane(id);
    }
  }
  paintList();
  writeUrl();
}

/**
 * #80, scope wins: no pane of this project is open (the top bar's project
 * changed under the pane): its most recent running agent comes in front,
 * else the pane says to pick one there.
 */
async function paneFollowsProject() {
  if (st.open.length) return;
  const view = viewWorkspaces();
  if (view.length !== 1) return;
  // Issue 482: the Terminals page: the project's terminal used last.
  if (PAGE === "terminal") {
    const sh = latestShell(visibleRows(), view[0], shellUsed());
    if (sh) await openPane(sh.id);
    return;
  }
  const latest = visibleRows()
    .filter(
      (r) => r.kind === "agent" && !isStopped(r) && r.workspace === view[0],
    )
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
  if (latest) await openPane(latest.id);
}

/**
 * The Agents page's count: "2 agents · 1 shell · 0 waiting · <scope>". A
 * plain terminal is a shell, not an agent; a part that is 0 is left out,
 * except waiting (and agents, when there is nothing at all).
 */
export function subText(rows, waiting, scope) {
  const agents = rows.filter((r) => r.kind === "agent").length;
  const shells = rows.length - agents;
  const parts = [];
  if (agents || !shells)
    parts.push(
      t(agents === 1 ? "ag.sub.agent" : "ag.sub.agents", { n: agents }),
    );
  if (shells)
    parts.push(
      t(shells === 1 ? "ag.sub.shell" : "ag.sub.shells", { n: shells }),
    );
  parts.push(t("ag.sub.waiting", { w: waiting }));
  if (scope) parts.push(scope);
  return parts.join(" · ");
}

function paintSub() {
  const rows = visibleRows();

  const waiting = rows.filter((r) => r.waiting).length;
  const count = st.root.querySelector("#ag-count");
  if (count)
    count.textContent =
      PAGE === "terminal"
        ? terminalsCountText(rows.length, st.scopeLabel, t)
        : subText(rows, waiting, st.scopeLabel);
  const url = st.root.querySelector("#ag-url");
  if (url) url.textContent = location.pathname + location.search;
  // Issue 482: the rail lights the page's own item (Terminals or Agents):
  // each page holds only its own kind.
}

/**
 * The person's layout (GET /api/settings agents_layout), else Focus; and
 * where a path link opens (editor_open), else none.
 */
async function savedLayout() {
  try {
    const r = await fetch("/api/settings", { headers: { accept: "json" } });
    const b = r.ok ? await r.json() : null;
    if (typeof b?.editor_open === "string") st.editorOpen = b.editor_open;
    st.reconnect = reconnectOptions(b?.panes_reconnect);
    if (Number.isInteger(b?.agents_helpers_shown) && b.agents_helpers_shown > 0)
      st.helpersShown = b.agents_helpers_shown;
    return LAYOUTS.includes(b?.agents_layout) ? b.agents_layout : "focus";
  } catch {
    return "focus";
  }
}

async function loadScope() {
  try {
    const r = await fetch("/api/scope");
    const s = r.ok ? await r.json() : null;
    st.scope = s?.scope ?? "all";
  } catch {
    st.scope = "all";
  }
}

function scopeLabelFor(shown) {
  const ws = urlWorkspace();
  if (ws && shown.length === 1 && shown[0] === ws) return projName(ws);
  return st.scope === "all" ? t("ag.all") : projName(st.scope);
}

/** 0.4.45: the projects' names changed: everything that says them. */
function repaintNames() {
  st.scopeLabel = scopeLabelFor(viewWorkspaces());
  paintList();
  paintSub();
  for (const pane of st.panes.values()) paintBar(pane);
  const strip = st.root?.querySelector("#agr > .agtabs");
  if (strip) paintTabs(strip);
}

/**
 * den#156: the list again, then the next one, always: an answer that never
 * comes (a host that doesn't answer) can't stop the list for good.
 */
async function refresh() {
  clearTimeout(st.timer);
  try {
    await refreshOnce();
  } finally {
    nextRefresh();
  }
}

/** den#156: until a list says otherwise (agents_list.refresh_timeout_seconds). */
const LIST_WAIT_S = 15;

async function refreshOnce() {
  try {
    const ws = urlWorkspace();
    // den#156: a list that doesn't come in time is a problem the page
    // says out loud (paintList), not a wait that holds it.
    const ac = new AbortController();
    const wait = setTimeout(
      () => ac.abort(),
      (st.listWaitS ?? LIST_WAIT_S) * 1000,
    );
    let r;
    try {
      r = await fetch(
        ws ? `/api/sessions?ws=${encodeURIComponent(ws)}` : "/api/sessions",
        { headers: { accept: "json" }, signal: ac.signal },
      );
    } catch (e) {
      st.hostDown = true;
      throw e;
    } finally {
      clearTimeout(wait);
    }
    // 0.4.45: the projects' names (a rename in Hub shows here within
    // 30 s of reaching this install). The first list waits for them, so
    // nothing paints a slug first.
    if (!st.projectsAt || Date.now() - st.projectsAt > 30_000) {
      st.projectsAt = Date.now();
      const names = fetch("/api/workspaces", { headers: { accept: "json" } })
        .then((x) => (x.ok ? x.json() : null))
        .then((d) => {
          if (!d) return false;
          const was = JSON.stringify(st.projects?.workspaces ?? null);
          st.projects = d;
          return JSON.stringify(d.workspaces ?? null) !== was;
        })
        .catch(() => false);
      // At most 3 s: a slow answer paints the slugs, then the names.
      if (!st.projects)
        await Promise.race([
          names.then((changed) => {
            if (changed && st.data) repaintNames();
          }),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      else
        void names.then((changed) => {
          if (changed) repaintNames();
        });
    }
    if (r.status === 401) {
      st.signedOut = true;
    } else if (r.ok) {
      st.data = await r.json();
      st.signedOut = false;
      // den#156: the host didn't answer (or couldn't be reached): say so.
      st.hostDown = !!st.data?.hostError;
      if (typeof st.data?.refreshTimeoutSeconds === "number")
        st.listWaitS = st.data.refreshTimeoutSeconds;
      toastAutoRelaunches(st.data?.sessions ?? []);
    }
  } catch {
    /* the last list stays; the next ask may answer */
  }
  followAgents();
  // D32: the rail's Agents badge: helpers running now.
  window.denShell?.setState?.({
    helpersRunning: (st.data?.sessions ?? []).reduce(
      (n, r) => n + (r.helpers?.running ?? 0),
      0,
    ),
  });
  st.scopeLabel = scopeLabelFor(viewWorkspaces());
  hideOtherProjects();
  paintList();
  paintSub();
  for (const p of st.panes.values()) {
    // D66: each pane keeps its soft newline for when its row is gone.
    const seq = rowOf(p.id)?.softNewline;
    if (typeof seq === "string" && seq) p.softNewline = seq;
    paintBar(p);
  }
  const strip = st.root.querySelector("#agr > .agtabs");
  if (strip) paintTabs(strip);
}

function nextRefresh() {
  if (!st.root?.isConnected) return;
  // A pane whose session just ended may have a new one soon (a persona
  // change, a resume): look again every second for a while.
  const soon = Date.now() < (st.followUntil ?? 0);
  st.timer = setTimeout(
    () => {
      if (!document.hidden) void refresh();
      else st.timer = setTimeout(refresh, REFRESH_MS);
    },
    soon ? FOLLOW_MS : REFRESH_MS,
  );
}

const rowOf = (id) => st.data?.sessions?.find((s) => s.id === id) ?? null;

/** How often, and how long, the list is read after a pane's session ends. */
const FOLLOW_MS = 1_000;
const FOLLOW_FOR_MS = 15_000;

/**
 * A pane follows its agent, not a session (AG-18): when the agent's
 * session changes (Change persona, Resume, a rotation), the pane moves to
 * the new one in the same slot, its scrollback kept.
 */
function followAgents() {
  for (const p of [...st.panes.values()]) {
    const r = knowAgent(p);
    if (!p.agent || p.closed || r?.state === "running") continue;
    const next = st.data?.sessions?.find(
      (x) =>
        x.kind === "agent" &&
        x.agent === p.agent &&
        x.workspace === p.agentWs &&
        x.id !== p.id &&
        x.state === "running",
    );
    if (next && !st.panes.has(next.id)) retarget(p, next);
  }
}

/**
 * Pane `p` notes its agent from its row, while the row is there; its row
 * goes when its session ends. Issue 202: a pane opened after a list read
 * learns it at once, not at the next read: a session ended before then
 * (Change persona) left the pane on the old one for good.
 */
function knowAgent(p) {
  const r = rowOf(p.id);
  if (r?.kind === "agent" && r.agent) {
    p.agent = r.agent;
    p.agentWs = r.workspace;
  }
  return r;
}

/** The pane's line for a resume that had nothing to continue (AG-14). */
function freshLine(p) {
  p.term?.write(`\x1b[2m${t("ag.freshLine")}\x1b[0m\r\n`);
}

/** Move pane `p` to session row `row`, where it was. */
function retarget(p, row) {
  const old = p.id;
  // Another session: a connection of its own.
  p.conn?.stop();
  p.conn = null;
  p.sock = null;
  p.recon = null;
  st.panes.delete(old);
  p.id = row.id;
  st.panes.set(row.id, p);
  st.open = st.open.map((x) => (x === old ? row.id : x));
  if (st.side.delete(old)) st.side.add(row.id);
  if (st.cur === old) st.cur = row.id;
  p.el.dataset.id = row.id;
  p.el.setAttribute("aria-label", row.label ?? row.id);
  p.exited = false;
  p.lost = false;
  p.term?.write(
    `\r\n\x1b[2m${t("ag.switched", { p: row.persona ?? row.agent })}\x1b[0m\r\n`,
  );
  if (st.fresh.delete(`${p.agentWs}\u0000${p.agent}`)) freshLine(p);
  paintBar(p);
  paintLayout();
  writeUrl();
  void connect(p);
}

// ── the panes ───────────────────────────────────────────────────────────

async function loadXterm() {
  // Issue 128: the browser keeps a module that failed to load as failed,
  // so a try after a failure asks for it at a new address.
  if (st.xterm) return st.xterm;
  // Issue 231: the address already carries Den's version (?v=), so the
  // try number joins it.
  const again = (u) =>
    st.xtermFails
      ? `${u}${u.includes("?") ? "&" : "?"}try=${st.xtermFails}`
      : u;
  const loading = (st.xterm = Promise.all([
    import(again("/vendor/xterm.mjs")),
    import(again("/vendor/addon-fit.mjs")),
    import(again("/vendor/addon-web-links.mjs")),
  ]).then(([x, f, w]) => {
    // 0.4.45: xterm's own words (its input's label, the screen reader's
    // overflow note) through the catalog, xterm's English when it has none.
    const tE = (key, en) => {
      const v = t(key);
      return v && v !== key ? v : en;
    };
    x.Terminal.strings.promptLabel = tE("term.input", "Terminal input");
    x.Terminal.strings.tooMuchOutput = tE(
      "term.tooMuch",
      "Too much output to announce, navigate to rows manually to read",
    );
    return {
      Terminal: x.Terminal,
      FitAddon: f.FitAddon,
      WebLinksAddon: w.WebLinksAddon,
    };
  }));
  // Issue 128: a failed load (Den restarted, the network blipped) is not
  // kept, so the next pane tries again.
  loading.catch(() => {
    if (st.xterm === loading) st.xterm = null;
    st.xtermFails += 1;
  });
  return loading;
}

async function csrf(fresh) {
  if (st.csrf && !fresh) return st.csrf;
  try {
    const r = await fetch("/api/session", { credentials: "same-origin" });
    const b = r.ok ? await r.json() : null;
    st.csrf = typeof b?.csrf === "string" ? b.csrf : null;
  } catch {
    st.csrf = null;
  }
  return st.csrf;
}

function cssVar(name) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || undefined;
}

/** The terminal's colours, from the theme's tokens (xterm's own when unset). */
function termTheme() {
  const bg = cssVar("--sunken");
  const fg = cssVar("--text");
  const theme = {
    background: bg,
    foreground: fg,
    cursor: cssVar("--accent") ?? fg,
    cursorAccent: bg,
    selectionBackground: cssVar("--border-strong"),
  };
  for (const k of Object.keys(theme))
    if (theme[k] === undefined) delete theme[k];
  return theme;
}

/** A tab's words: the agent's name, then its persona and workspace. */
function tabWords(id) {
  const r = rowOf(id);
  const p = st.panes.get(id);
  const wsName = (ws) =>
    !ws ? "" : ws === SERVER_WS ? t("ag.server") : projName(ws);
  if (!r) return { name: p?.label || id, meta: wsName(p?.workspace) };
  if (r.kind !== "agent")
    return {
      name: r.label,
      meta: [t("ag.session"), wsName(r.workspace)].join(" · "),
    };
  return {
    name: paneName(r),
    meta: [r.persona, wsName(r.workspace), sessionExtra(r)]
      .filter(Boolean)
      .join(" · "),
  };
}

/** The tab strip (AG-4b Tabs): one tab per open pane, its × beside it. */
function paintTabs(strip) {
  // A tab being renamed keeps its input.
  if (strip.querySelector("input")) return;
  const have = [...strip.querySelectorAll(":scope > .agtab-w")].map(
    (w) => w.dataset.id,
  );
  // The same tabs: changed in place, so a double-click's target stays.
  if (have.join("\n") === st.open.join("\n")) {
    for (const w of strip.querySelectorAll(":scope > .agtab-w")) {
      const id = w.dataset.id;
      const r = rowOf(id);
      const words = tabWords(id);
      const on = id === st.cur;
      const tab = w.querySelector('[role="tab"]');
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      tab.querySelector(".den-dot").className =
        `den-dot ${r?.waiting ? "warn" : r ? stateTone(r) : "pending"}`;
      tab.querySelector(".tn").textContent = words.name;
      tab.querySelector(".tm").textContent = words.meta;
      const sr = tab.querySelector(".den-sr");
      if (sr) {
        sr.hidden = !r?.waiting;
        if (r?.waiting) sr.textContent = `${waitingText(r)}: `;
      }
      w.querySelector(".agtab-x").setAttribute(
        "aria-label",
        t("ag.detachName", { id: words.name }),
      );
    }
    return;
  }
  strip.innerHTML = st.open
    .map((id) => {
      const r = rowOf(id);
      const w = tabWords(id);
      const on = id === st.cur;
      const tone = r?.waiting ? "warn" : r ? stateTone(r) : "pending";
      const rename =
        r?.kind === "agent" ? ` title="${esc(t("ag.renameTip"))}"` : "";
      return (
        `<span class="agtab-w" data-id="${esc(id)}">` +
        `<button type="button" role="tab" class="agtab" data-id="${esc(id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}" aria-keyshortcuts="Delete"${rename}>` +
        `<span class="den-dot ${tone}" aria-hidden="true"></span>` +
        `<span class="den-sr"${r?.waiting ? "" : " hidden"}>${esc(r?.waiting ? waitingText(r) : t("ag.waiting"))}: </span>` +
        `<span class="tn">${esc(w.name)}</span><span class="tm mono">${esc(w.meta)}</span></button>` +
        // Issue 297: a tablist owns only tabs, so × is the pointer's
        // (out of the tab order and the accessibility tree); the keyboard
        // closes a tab with Delete on it.
        `<button type="button" class="agtab-x" data-act="close" data-id="${esc(id)}" tabindex="-1" aria-hidden="true" aria-label="${esc(t("ag.detachName", { id: w.name }))}" title="${esc(t("ag.detach"))}">×</button>` +
        `</span>`
      );
    })
    .join("");
}

function paintLayout() {
  const box = st.root.querySelector("#agr");
  const n = st.open.length;
  paintSwitch();
  if (n === 0) {
    box.className = "agempty";
    delete box.dataset.layout;
    delete box.dataset.ws;
    const view = st.data ? viewWorkspaces() : [];
    box.innerHTML = `<div>${esc(PAGE === "terminal" ? t("tm.empty") : view.length === 1 && view[0] !== SERVER_WS ? t("ag.pickIn", { ws: view[0] }) : t("ag.empty"))}</div>`;
    return;
  }
  const layout = shownLayout();
  const shown = visibleIds();
  box.className = `agp n${Math.max(1, shown.length)}${layout === "tabs" ? " tabs" : ""}`;
  box.dataset.layout = layout;
  // The front agent's workspace: ⌘K lists it first (0.4.17).
  const front = rowOf(st.cur)?.workspace;
  if (front) box.dataset.ws = front;
  else delete box.dataset.ws;
  const empty = box.querySelector(":scope > div:not(.pane):not(.agtabs)");
  if (empty) empty.remove();
  let strip = box.querySelector(":scope > .agtabs");
  if (layout === "tabs") {
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "agtabs";
      strip.setAttribute("role", "tablist");
      strip.setAttribute("aria-label", t("ag.tabs"));
    }
    box.prepend(strip);
    paintTabs(strip);
    // The tab in front is in sight in the strip (it scrolls sideways;
    // the page itself never scrolls for it).
    const on = strip.querySelector('[role="tab"][aria-selected="true"]');
    const w = on?.parentElement;
    if (w && strip.clientWidth > 0) {
      const left = w.offsetLeft - strip.offsetLeft;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (left + w.offsetWidth > strip.scrollLeft + strip.clientWidth)
        strip.scrollLeft = left + w.offsetWidth - strip.clientWidth;
    }
  } else strip?.remove();
  // Panes in the URL's order; those out of sight stay attached, hidden.
  for (const id of st.open) {
    const p = st.panes.get(id);
    if (!p) continue;
    p.el.hidden = !shown.includes(id);
    p.el.classList.toggle("in-tabs", layout === "tabs");
    const x = p.el.querySelector('.bar2 [data-act="close"]');
    if (x) x.hidden = layout === "tabs";
    box.appendChild(p.el);
  }
  // Each pane in sight fits its new box (a hidden one is never measured).
  requestAnimationFrame(() => {
    for (const id of shown) {
      const p = st.panes.get(id);
      if (p) refit(p);
    }
  });
}

/** The header's switch: the person's layout pressed (AG-4b). */
function paintSwitch() {
  for (const b of st.root.querySelectorAll("[data-layouts] button"))
    b.setAttribute("aria-pressed", String(b.dataset.layout === st.layout));
}

/**
 * Switch the layout (the header's switch, ⌘1-3): drawn at once, the URL
 * follows, and it is saved for the person. Focus shows the pane in front.
 */
function setLayout(layout) {
  if (!LAYOUTS.includes(layout)) return;
  const was = st.layout;
  st.layout = layout;
  st.side.clear();
  paintLayout();
  paintList();
  writeUrl();
  if (layout === was) return;
  api("POST", "/api/settings", { agents_layout: layout }).catch((err) =>
    window.denShell?.errorToast?.(err),
  );
}

/**
 * D40: put the keyboard in pane `id`'s terminal once it can take keys: now
 * when its socket is open, else when it opens (connect). Never a pane
 * whose session ended.
 */
function focusTerm(id, claim = true, { ifIdle = false } = {}) {
  const p = st.panes.get(id);
  if (!p || p.exited || p.closed) return;
  st.claimOnOpen = claim;
  st.focusIfIdle = ifIdle;
  if (p.term && p.sock?.readyState === WebSocket.OPEN && p.heardSession) {
    st.focusOnOpen = null;
    // After the click that picked it has finished with the row; never
    // over a field the person went to since (a double-click's rename).
    const idle = st.focusIfIdle;
    st.focusIfIdle = false;
    requestAnimationFrame(() => {
      if (p.closed || p.exited || inField()) return;
      // D58: a link's focus is only for a keyboard that went nowhere yet.
      if (idle && !keyboardIdle()) return;
      p.term?.focus();
    });
  } else st.focusOnOpen = id;
}

/**
 * D40: a pick waiting for its socket is the person's latest choice only
 * until they choose something else. Their press or Tab outside that pane
 * (another row, a stopped row, a field) cancels it, so a socket that opens
 * late never takes the keyboard from where they went. Only their input
 * counts: the page moving focus back to a row it redrew does not.
 */
function dropStalePick(e) {
  const id = st.focusOnOpen;
  if (!id || !e.isTrusted) return;
  // Typing straight after a pick is for the picked agent; Tab moves away.
  if (e.type === "keydown" && e.key !== "Tab") return;
  const at = e.type === "keydown" ? document.activeElement : e.target;
  if (!st.panes.get(id)?.el?.contains(at)) st.focusOnOpen = null;
}
document.addEventListener("pointerdown", dropStalePick, true);
document.addEventListener("keydown", dropStalePick, true);

/**
 * Open (or bring forward) the session of a row the person clicked, as the
 * layout says: Focus replaces the pane (`add`: Shift- or ⌘-click, one
 * alongside), Tabs opens a tab, Tile adds a tile. D40: a pick (not an add)
 * puts the keyboard in its terminal; an add keeps it where it was, when
 * that pane is still in sight.
 */
async function pick(id, add) {
  const layout = shownLayout();
  if (layout === "focus" && !add) {
    st.side.clear();
    for (const other of [...st.open])
      if (other !== id) closePane(other, { quiet: true });
  } else if (layout === "focus" && add && st.cur && st.cur !== id)
    st.side.add(id);
  if (!(layout === "focus" && add)) st.cur = id;
  // An add: the keyboard goes back to the terminal that had it (the click
  // on the row took it).
  const back = add && st.keyPane !== id ? st.keyPane : null;
  // A stopped agent's pane (its last output) never takes the keyboard.
  const live = !isStopped(rowOf(id) ?? {});
  if (!add) {
    st.focusOnOpen = live ? id : null;
    st.claimOnOpen = live;
  } else if (st.focusOnOpen === id) st.focusOnOpen = null;
  if (st.panes.has(id)) {
    paintLayout();
    paintList();
    if (!add) {
      if (live) focusTerm(id);
    } else addFocus(back, id);
    return;
  }
  await openPane(id, { front: !(layout === "focus" && add) });
  if (add) addFocus(back, id);
}

/**
 * After an add, the keyboard goes back to the pane that had it, if that
 * pane is still in sight. Where only one pane shows (tabs, a phone) the
 * added one is in front, so the keyboard goes there.
 */
function addFocus(back, id) {
  const shown = visibleIds();
  if (back && shown.includes(back)) focusTerm(back);
  else if (shown.includes(id)) focusTerm(id);
}

/** Double-click a tab: its name becomes an input (Enter saves, Esc doesn't). */
/** Whether the keyboard is still on nothing (the page as it loaded). */
function keyboardIdle() {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

/** Whether the keyboard is in a field on the page (not a terminal's). */
function inField() {
  const a = document.activeElement;
  return !!a?.matches?.(
    'input, select, textarea:not(.xterm-helper-textarea), [contenteditable="true"]',
  );
}

function renameTab(tab) {
  const id = tab.dataset.id;
  const r = rowOf(id);
  if (r?.kind !== "agent" || tab.querySelector("input")) return;
  // D58: the clicks of this double-click picked the tab: their terminal
  // focus, still to come, is for this field now.
  if (st.focusOnOpen === id) st.focusOnOpen = null;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "agtab-in";
  input.maxLength = MAX_NAME;
  input.value = r.displayName || r.agent;
  input.setAttribute("aria-label", t("ag.renameName", { id: r.agent }));
  // Beside the tab, not in it (a button holds no input): the tab hides.
  tab.hidden = true;
  tab.before(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.remove();
    tab.hidden = false;
    if (save && name !== (r.displayName || r.agent)) {
      try {
        await api("POST", agentPath(r, "name"), {
          name: name && name !== r.agent ? name : null,
        });
      } catch (err) {
        window.denShell?.errorToast?.(err);
      }
      await refresh();
    }
    paintLayout();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener("blur", () => void finish(true));
  // A click in the input is the input's, not the tab's.
  input.addEventListener("click", (e) => e.stopPropagation());
}

/**
 * D47: on a running agent's pane, the services it reaches only through
 * their API; on a runtime that can't be held to it, that it isn't.
 */
function apiOnlyTag(r) {
  const names = Array.isArray(st.data?.apiOnly) ? st.data.apiOnly : [];
  if (!names.length || r?.kind !== "agent" || isStopped(r)) return "";
  const list = names.join(", ");
  return r.runtime === "den-claude"
    ? `<span class="tagx" data-api-only title="${esc(t("ag.apiOnlyTip", { names: list }))}">${esc(t("ag.apiOnly", { names: list }))}</span>`
    : `<span class="tagx warn" data-api-only="off" title="${esc(t("ag.apiOnlyOffTip", { names: list }))}">${esc(t("ag.apiOnlyOff"))}</span>`;
}

/**
 * D44: a running agent whose MCP servers are out of date (Hub connected or
 * disconnected since it launched): a tag, and on the pane bar Restart (at
 * its next idle, same conversation).
 */
function mcpStaleTag(r, withButton) {
  // Issue 193: Den restarts it to load Hub's new tools (no button: under way).
  if (r?.kind === "agent" && r.toolsRestarting)
    return `<span class="tagx warn" data-tools-restarting="1" title="${esc(t("ag.mcp.reloadingTip"))}">${esc(t("ag.mcp.reloading"))}</span>`;
  const sx = r?.kind === "agent" && !isStopped(r) ? r.mcpStale : null;
  if (!sx || !(sx.adds?.length || sx.drops?.length)) return "";
  const k = sx.adds?.length ? "adds" : "drops";
  const tag = `<span class="tagx warn" data-mcp-stale="${k}" title="${esc(t(`ag.mcp.${k}Tip`))}">${esc(t(`ag.mcp.${k}`))}</span>`;
  if (!withButton) return tag;
  return (
    `<span class="agstale">${tag}` +
    `<button type="button" class="den-btn sm" data-act="tools-restart" aria-label="${esc(t("ag.mcp.restartName", { id: r.agent }))}" title="${esc(t("ag.mcp.restartName", { id: r.agent }))}">${esc(t("ag.mcp.restart"))}</button></span>`
  );
}

/**
 * MODE-3 (0.4.48): a running agent's mode differs from the one its
 * process runs in (a mode chosen while it ran; MODE-2 restarts it after
 * its turn, unless that waits on something): { want, running }, else null.
 */
export function modeDriftOf(r) {
  if (r?.kind !== "agent" || isStopped(r) || !r.mode || !r.modeRunning)
    return null;
  return r.mode === r.modeRunning
    ? null
    : { want: r.mode, running: r.modeRunning };
}

const modeName = (m) => t(`pm.name.${m}`);

/**
 * MODE-3: its mode on its row and its pane bar ("mode: Auto"); on a
 * mismatch, "Set to Auto, running Ask", and in the pane bar Restart to
 * apply beside it (the row has it under the row: modeApplyHtml).
 */
export function modeTagHtml(r, withButton) {
  if (r?.kind !== "agent" || isStopped(r) || !r.mode) return "";
  const d = modeDriftOf(r);
  // Issue 199: a mode of its own says so, and the project's it doesn't follow.
  // Issue 225: every mode says where it comes from.
  const own = ownModeLabel(r);
  const src = r.modeSource ? ` data-mode-source="${esc(r.modeSource)}"` : "";
  if (!d)
    return `<span class="tagx${r.mode === "all" || own ? " warn" : ""}" data-mode="${esc(r.mode)}"${src}${own ? ' data-mode-own="1"' : ""}>${esc(modeLabel(r))}</span>`;
  const tag = `<span class="tagx warn" data-mode-drift="${esc(d.want)}">${esc(t("ag.mode.drift", { want: modeName(d.want), running: modeName(d.running) }))}</span>`;
  return withButton
    ? `<span class="agmode">${tag}${modeApplyHtml(r)}</span>`
    : tag;
}

/** MODE-3: Restart to apply, a person's one click (a mismatch only). */
function modeApplyHtml(r) {
  if (!modeDriftOf(r)) return "";
  return `<button type="button" class="den-btn sm primary" data-act="mode-apply" aria-label="${esc(t("ag.mode.applyName", { id: r.agent }))}">${esc(t("ag.mode.apply"))}</button>`;
}

/**
 * MODE-3: restart it now, on the same conversation; it starts in its mode
 * (the server reads it again at every start). Only a person's page can
 * (the restart route refuses an agent).
 */
async function applyMode(r, button) {
  await window.denShell.busyAction(
    "restart-agent",
    (headers) =>
      api("POST", agentPath(r, "restart"), { when: "now" }, { headers }),
    {
      button,
      vars: { name: r.agent },
      success: () => t("ag.mode.applied", { id: r.agent, m: modeName(r.mode) }),
    },
  );
  await refresh();
}

/**
 * D44: Restart at its next idle; the list shows it come back. 0.4.48: a
 * job it left running (a test run) is asked about first; Restart anyway
 * restarts it now, which ends the job.
 */
async function restartForTools(r, button) {
  const name = { name: r.agent };
  let job = null;
  // BUSY-1: the working pop-up, then what happened.
  await window.denShell.busyAction(
    "restart-agent",
    (headers) =>
      api(
        "POST",
        agentPath(r, "restart"),
        { when: "after-turn" },
        { headers },
      ).catch((e) => {
        if (e?.code !== "job_running") throw e;
        job = e.data?.job ?? { minutes: 0 };
        return { job };
      }),
    {
      button,
      vars: name,
      success: (out) =>
        out?.job
          ? t("ag.job.held", { id: r.agent })
          : t("ag.mcp.restarting", { id: r.agent }),
    },
  );
  if (job && (await confirmJob(r, job.minutes)))
    await window.denShell.busyAction(
      "restart-agent",
      (headers) =>
        api("POST", agentPath(r, "restart"), { when: "now" }, { headers }),
      {
        button,
        vars: name,
        success: () => t("ag.mcp.restarting", { id: r.agent }),
      },
    );
  await refresh();
}

/** 0.4.48: "a job is still running (N min); restart anyway?" */
function confirmJob(r, minutes) {
  const dlg = $d("#ag-job");
  if (!dlg) return Promise.resolve(false);
  $d("#ag-job-h").textContent = t("ag.job.h");
  $d("#ag-job-q").textContent = t("ag.job.q", {
    id: displayName(r),
    min: minutes,
  });
  $d("#ag-job-cancel").textContent = t("ag.rn.cancel");
  $d("#ag-job-go").textContent = t("ag.job.go");
  return new Promise((resolve) => {
    const done = (yes) => {
      dlg.removeEventListener("cancel", onCancel);
      dlg.close?.();
      dlg.removeAttribute("open");
      resolve(yes);
    };
    const onCancel = (e) => {
      e.preventDefault();
      done(false);
    };
    dlg.addEventListener("cancel", onCancel);
    $d("#ag-job-cancel").onclick = () => done(false);
    $d("#ag-job-form").onsubmit = (e) => {
      e.preventDefault();
      done(true);
    };
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    $d("#ag-job-cancel").focus();
  });
}

/** Which of the bar's controls `el` is: its data-act, or its place. */
function barKey(bar, el) {
  const c = el.closest("button, a, [tabindex]");
  if (!c || !bar.contains(c)) return null;
  if (c.dataset.act) return { act: c.dataset.act };
  const all = Array.from(bar.querySelectorAll("button, a, [tabindex]"));
  return { at: all.indexOf(c) };
}

function barFind(bar, k) {
  if (k.act) return bar.querySelector(`[data-act="${CSS.escape(k.act)}"]`);
  return bar.querySelectorAll("button, a, [tabindex]")[k.at] ?? null;
}

function paintBar(p) {
  const r = rowOf(p.id);
  const bar = p.el.querySelector(".bar2");
  const name = r ? paneName(r) : p.label || p.id;
  // AG-4b: the session's name last, when it says more. The workspace is a
  // link to it on Workspaces (0.4.17).
  const ws = r ? r.workspace : p.workspace || "";
  // D37: a stopped agent's pane has what its one-line row leaves out.
  const rest = r
    ? (isStopped(r)
        ? [r.persona, r.agent, r.runtime, cwdText(r)]
        : [r.runtime, sessionExtra(r)]
      )
        .filter(Boolean)
        .join(" · ")
    : "";
  // 0.4.44: the project stays whole; the runtime and the rest are cut.
  const where =
    (ws ? `<span class="wsn">${wsLinkHtml(ws)}</span>` : "") +
    (rest ? `<span class="rt">${ws ? " · " : ""}${esc(rest)}</span>` : "");
  const tone = r ? stateTone(r) : p.exited ? "off" : "pending";
  const stop =
    r?.kind === "agent" && (r.state === "running" || r.state === "stopping")
      ? `<button type="button" class="den-btn sm" data-act="stop" aria-label="${esc(t("ag.stopName", { id: r.agent }))}">${esc(t("ag.stop"))}</button>`
      : "";
  // The 0.4.39 gate's note: a shell is closed here, not only with `exit`.
  const closeShell =
    r?.kind === "session" && !r.exited
      ? `<button type="button" class="den-btn sm" data-act="close-shell" title="${esc(t("ag.closeShellTip"))}">${esc(t("ag.closeShell"))}</button>`
      : "";
  // Issue 448: a second shell on purpose (the rail's Terminal reopens this).
  const newShell =
    r?.kind === "session"
      ? `<button type="button" class="den-btn sm" data-act="new-shell" title="${esc(t("ag.newShellTip"))}">${esc(t("ag.newShell"))}</button>`
      : "";
  // The mock's pane bar: Resume (primary) on an ended agent that can.
  const resume =
    r && isStopped(r) && r.resumable
      ? `<button type="button" class="den-btn sm primary" data-act="resume" aria-label="${esc(t("ag.resumeName", { id: r.agent }))}">${esc(t("ag.resume"))}</button>`
      : "";
  const reconnect = reconnectHtml(p);
  // AG-DROP: Attach (a touch screen has no drop): a live session's only.
  const attach =
    !p.lost && !p.exited && !(r && isStopped(r))
      ? `<button type="button" class="den-btn sm" data-act="attach" aria-label="${esc(t("ag.up.attachName", { id: name }))}" title="${esc(t("ag.up.attachTip"))}">${esc(t("ag.up.attach"))}</button>`
      : "";
  // AG-18: ⋯, its menu: Rename… (D25, every agent), Change persona… (a
  // runtime that can resume).
  const more =
    r?.kind === "agent"
      ? `<button type="button" class="den-btn sm" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t("ag.more", { id: r.agent }))}" title="${esc(t("ag.more", { id: r.agent }))}">⋯</button>`
      : "";
  // Issue 170: the tags in one box. Beside the name on a wide pane; on a
  // phone a line of their own, so they never cut the project's name.
  const tags =
    (r?.tokenRevoked
      ? `<span class="tagx warn" title="${esc(t("ag.revokedTip"))}">${esc(t("ag.revoked"))}</span>`
      : "") +
    apiOnlyTag(r) +
    // Issue 278: compacting repeatedly; instructions. Why and Clear are
    // on a line of their own below (Stop is the bar's own).
    compactingTag(r) +
    instructionsTag(r) +
    mcpStaleTag(r, true) +
    modeTagHtml(r, true) +
    whereTag(r, true) +
    linkTag(r) +
    subagentTag(r) +
    signInTag(r);
  const html =
    `<span class="den-dot ${tone}" aria-hidden="true"></span>` +
    `<b>${esc(name)}</b>${where ? '<span class="sep" aria-hidden="true">·</span>' : ""}<span class="where mono">${where}</span>` +
    (r && isStopped(r)
      ? `<span class="why" data-why title="${esc(stoppedTip(r))}">${esc(stopReason(r))}</span>`
      : "") +
    (tags ? `<span class="agtags" data-tags>${tags}</span>` : "") +
    (r?.kind === "agent" && rotActionsHtml(r)
      ? `<span class="agrot" data-rot-bar title="${esc(rotMessage(r))}"><span class="tagx warn" data-rotation="${rotationOf(r)}">${esc(t(rotationOf(r) === "ready" ? "ag.rot.ready" : "ag.rot.due", { why: rotationWhy(r.rotation) }))}</span>${rotActionsHtml(r)}</span>`
      : "") +
    (r?.kind === "agent" && compactingHtml(r, t, { withStop: false })
      ? `<span class="agctx" data-compacting-bar>${compactingHtml(r, t, { withStop: false })}</span>`
      : "") +
    `<span class="x">${r?.kind === "agent" ? helperBarButtonHtml(r) : ""}${reconnect}${attach}${stop}${newShell}${closeShell}${resume}${more}<button type="button" class="den-btn sm" data-act="close" aria-label="${esc(t("ag.detachName", { id: name }))}" title="${esc(t("ag.detach"))}">×</button></span>`;
  // A refresh (a helper's update, the list's poll) redraws only what
  // changed, and never takes the keyboard off the bar: a button there that
  // had focus has it again after a redraw.
  if (p.barHtml !== html) {
    const had = bar.contains(document.activeElement)
      ? barKey(bar, document.activeElement)
      : null;
    bar.innerHTML = html;
    p.barHtml = html;
    if (had) barFind(bar, had)?.focus();
  } else {
    // Unchanged: a button an action turned off while it ran (Stop, Write
    // handoff) comes back, as a redraw used to bring it back. The bar's
    // own HTML never turns one off.
    for (const b of bar.querySelectorAll("button:disabled")) b.disabled = false;
  }
  // 0.4.44: who the keyboard types to, under the terminal, in the
  // project's colour (a message once went to the wrong agent's tab).
  const to = p.el.querySelector(".agto");
  if (to) {
    const said = ws
      ? t("ag.to", {
          name,
          ws: ws === SERVER_WS ? t("ag.server") : projName(ws),
        })
      : t("ag.toName", { name });
    if (to.textContent !== said) to.textContent = said;
    to.style.setProperty("--ws-h", String(wsHue(ws)));
  }
  // Tabs: the tab's × closes it; the pane's bar has none.
  const x = bar.querySelector('[data-act="close"]');
  if (x) x.hidden = shownLayout() === "tabs";
}

/** A project's colour (0.4.44): a hue from its name, the same everywhere. */
export function wsHue(ws) {
  let h = 0;
  for (const c of String(ws ?? "")) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function send(p, obj) {
  if (p.sock?.readyState === WebSocket.OPEN) p.sock.send(JSON.stringify(obj));
}

/** The smallest size a pane ever asks for (a pane not laid out yet). */
const MIN_COLS = 2;
const MIN_ROWS = 2;

/** Shown: the page is visible and the pane has a box. */
function paneShown(p) {
  return (
    !document.hidden &&
    p.el.isConnected &&
    p.el.offsetWidth > 0 &&
    p.el.offsetHeight > 0
  );
}

/** Fit the terminal to its pane (its own cols and rows; nothing is sent). */
function refit(p) {
  const box = p.el.querySelector(".term");
  if (!p.fit || !p.el.isConnected || !box || box.clientWidth <= 0) return;
  // D54: a pane another view sizes draws at the PTY's size, never its own
  // box's: Claude Code redraws its prompt by moving the cursor up as many
  // lines as it wrapped at the PTY's width, so any other width leaves a
  // copy of the prompt behind on each redraw.
  if (p.following && p.pty) {
    followPty(p);
    return;
  }
  try {
    p.fit.fit();
  } catch {
    /* not laid out yet */
  }
  markSize(p);
}

/** D54: this pane at the PTY's size (another view sets it). */
function followPty(p) {
  const term = p.term;
  if (!term || !p.pty) return;
  if (term.cols !== p.pty.cols || term.rows !== p.pty.rows)
    term.resize(p.pty.cols, p.pty.rows);
  markSize(p);
  paintFollow(p);
}

/**
 * D54: the chip on a pane another view sizes: "Sized by another view",
 * and Take over (this pane's size, as typing does).
 */
function paintFollow(p) {
  const box = p.el.querySelector(".term");
  if (!box) return;
  p.el.classList.toggle("following", !!p.following);
  let chip = box.querySelector(".agfollow");
  if (!p.following) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement("div");
    chip.className = "agfollow";
    chip.setAttribute("role", "status");
    chip.innerHTML =
      `<span class="agfollow-t"></span>` +
      `<button type="button" class="den-btn sm" data-act="take-size"></button>`;
    chip.querySelector("button").addEventListener("click", (e) => {
      e.preventDefault();
      claimSize(p);
      p.term?.focus();
    });
    box.append(chip);
  }
  chip.querySelector(".agfollow-t").textContent = t("ag.size.follow", {
    cols: p.pty?.cols ?? "?",
    rows: p.pty?.rows ?? "?",
  });
  chip.querySelector("button").textContent = t("ag.size.take");
}

/**
 * The pane's size and the PTY's, on the pane (data-cols, data-pty-cols),
 * and the cell size xterm drew with (data-cell-w, data-cell-h: its
 * renderer's CSS cell, sub-pixel), so a check can tell a missed row from
 * a fit's remainder.
 */
function markSize(p) {
  if (!p.term) return;
  p.el.dataset.cols = String(p.term.cols);
  p.el.dataset.rows = String(p.term.rows);
  let cell = null;
  try {
    cell = p.term._core?._renderService?.dimensions?.css?.cell ?? null;
  } catch {
    cell = null;
  }
  if (cell?.width > 0 && cell?.height > 0) {
    p.el.dataset.cellW = String(cell.width);
    p.el.dataset.cellH = String(cell.height);
  }
  if (p.pty) {
    p.el.dataset.ptyCols = String(p.pty.cols);
    p.el.dataset.ptyRows = String(p.pty.rows);
  }
}

/**
 * Whether this pane must say its size before a keystroke: the PTY is known
 * to have another size, or the host never says the PTY's size (an older
 * session host that outlived an upgrade sends no size frames), so another
 * viewer may have resized it unseen. Saying the same size again is free:
 * the PTY only redraws when the size really changes.
 */
function outOfStep(p) {
  if (!p.term) return false;
  if (!p.heardSize) return true;
  return !!p.pty && (p.pty.cols !== p.term.cols || p.pty.rows !== p.term.rows);
}

/**
 * Say this pane's size to the session (the PTY takes it: last writer
 * wins). Never from a hidden pane, never under 2x2.
 */
function sendSize(p) {
  const term = p.term;
  if (!term || p.sock?.readyState !== WebSocket.OPEN || !paneShown(p))
    return false;
  if (term.cols < MIN_COLS || term.rows < MIN_ROWS) return false;
  // D54: a following pane never sizes the PTY (no ping-pong between views).
  if (p.following) return false;
  send(p, { type: "resize", cols: term.cols, rows: term.rows });
  // D54: until the host says this size back, an older frame (the size on
  // attach) is not another view taking it. The host says a size only when
  // it changes, so an unchanged one is never said back: that is no wait.
  // The same size said again (a claim's refit says it, then the claim)
  // keeps the wait the first one started.
  const at = (z) => !!z && z.cols === term.cols && z.rows === term.rows;
  if (!(at(p.awaiting) && Date.now() < p.awaiting.until))
    p.awaiting = at(p.pty)
      ? null
      : { cols: term.cols, rows: term.rows, until: Date.now() + 3000 };
  // What the PTY will be: the server's frame follows (or another
  // viewer's, if it resized after).
  p.pty = { cols: term.cols, rows: term.rows };
  markSize(p);
  return true;
}

/** D54: whether the data xterm just gave came from the person (a key, a paste). */
const PERSON_INPUT_MS = 1000;
function personTyped(p) {
  return (
    p.inputAt !== undefined && performance.now() - p.inputAt < PERSON_INPUT_MS
  );
}

/**
 * This pane is in use (typed in, Take over, just opened): it leads. Fit it
 * to its box and make the PTY its size; any other view follows.
 */
function claimSize(p) {
  p.following = false;
  paintFollow(p);
  refit(p);
  sendSize(p);
}

/**
 * Measure the cells again (xterm measures them once, when the font is
 * set) and refit: a web font that arrived after the first fit, or a theme
 * whose --mono is another font. A change the PTY hears via onResize.
 */
function remeasure(p) {
  const term = p.term;
  if (!term) return;
  const family = cssVar("--mono") ?? "monospace";
  // Setting the same family is a no-op in xterm: set another first (never
  // drawn: the theme's family is back before the refit).
  if (term.options["fontFamily"] === family)
    Object.assign(term.options, { fontFamily: `${family}, monospace` });
  Object.assign(term.options, { fontFamily: family });
  refit(p);
}

function remeasureAll() {
  for (const p of st.panes.values()) remeasure(p);
}

/** The bar's reconnect part: a quiet line while it tries, else a button. */
function reconnectHtml(p) {
  const s = p.recon;
  const btn = `<button type="button" class="den-btn sm" data-act="reconnect">${esc(t("ag.reconnect"))}</button>`;
  if (s?.kind === "retrying")
    return `<span class="ag-recon" role="status">${esc(t("ag.reconnecting"))}</span>`;
  if (s?.kind === "tripped")
    return `<span class="ag-recon" role="status">${esc(t("ag.reconnectGaveUp", { n: s.tries, min: Math.round(st.reconnect.windowMs / 60000) }))}${s.why ? ` (${esc(s.why)})` : ""}</span>${btn}`;
  return p.lost ? btn : "";
}

/** The words a refused terminal gives (term-pane.js refusalOf). */
const PANE_WORDS = {
  signin: () => t("ag.signin", { cli: CLI }),
  refusedUnknown: () => t("ag.refusedUnknown"),
  refusedStatus: (status) => t("ag.refusedStatus", { status }),
  notAnswering: () => t("ag.notAnswering"),
};

/**
 * Pane `p`'s connection to its session (term-pane.js, shared with the
 * __DEN_TITLE__ agent's page): it reconnects on its own after a drop.
 */
function connect(p) {
  if (p.closed) return;
  p.conn ??= termPane({
    id: p.id,
    term: () => p.term,
    csrf: (fresh) => csrf(fresh),
    settings: st.reconnect,
    words: PANE_WORDS,
    paint: (r) => {
      p.recon = r;
      p.lost = r.kind === "tripped" || r.kind === "refused";
      paintBar(p);
    },
    onOpen: (sock) => {
      p.sock = sock;
      p.heardSession = false;
      p.pty = null;
      p.heardSize = false;
      // D54: who sizes the PTY is decided on the session frame (it says
      // how many view it); until then, this pane waits.
      p.following = false;
      p.decided = false;
      refit(p);
    },
    onText: (msg) => paneText(p, msg),
    onClose: ({ opened, refused, why }) => {
      p.sock = null;
      if (!opened) void refresh();
      if (refused) p.term?.write(`\r\n${t("ag.lost", { why })}\r\n`);
    },
  });
  return p.conn.connect();
}

/** A JSON frame from pane `p`'s session. */
function paneText(p, msg) {
  if (msg?.type === "size") {
    if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      p.heardSize = true;
      const said = (z) => !!z && z.cols === msg.cols && z.rows === msg.rows;
      const w = p.awaiting && Date.now() < p.awaiting.until ? p.awaiting : null;
      p.pty = { cols: msg.cols, rows: msg.rows };
      let mine = false;
      if (p.following) p.awaiting = null;
      else if (w) {
        // Still waiting for this pane's own size: an older frame. The
        // PTY will be this pane's.
        mine = true;
        if (said(w)) p.awaiting = null;
        else p.pty = { cols: w.cols, rows: w.rows };
      } else {
        p.awaiting = null;
        mine = said(p.term);
      }
      // D54: another view set it: draw at its size until typed in.
      // Alone, a size this pane didn't say is only an older one (a
      // hidden pane that couldn't say its own yet): never a reason to
      // follow.
      if (!mine && (p.viewers ?? 1) > 1) p.following = true;
      if (p.following) followPty(p);
      else markSize(p);
    }
  } else if (msg?.type === "session") {
    p.label = msg.label;
    p.workspace = msg.workspace;
    p.exited = !!msg.exited;
    p.heardSession = true;
    paintBar(p);
    if (!p.decided) {
      p.decided = true;
      // D54: a lone viewer, or the pane the person just opened, sizes
      // the PTY; another view of a session already in use follows
      // its size until typed in, so opening one never redraws the
      // other. An older server says no count: this pane leads.
      p.viewers = Number.isInteger(msg.viewers) ? msg.viewers : 1;
      const alone = p.viewers <= 1;
      if (alone || (st.focusOnOpen === p.id && st.claimOnOpen)) claimSize(p);
      else {
        p.following = true;
        if (p.pty) followPty(p);
        else paintFollow(p);
      }
    }
    // D40: the pane the person picked takes the keyboard once the
    // server says its session is live (the first frame), never one
    // that has ended.
    if (st.focusOnOpen === p.id) {
      if (p.exited) st.focusOnOpen = null;
      else focusTerm(p.id, st.claimOnOpen, { ifIdle: st.focusIfIdle });
    }
  } else if (msg?.type === "viewers") {
    // D54: the view that sized the PTY went away: this one, alone now,
    // sizes it.
    if (Number.isInteger(msg.n)) {
      p.viewers = msg.n;
      if (msg.n <= 1 && p.following) claimSize(p);
    }
  } else if (msg?.type === "exit") {
    p.exited = true;
    // Its agent may continue in a new session (followAgents).
    st.followUntil = Date.now() + FOLLOW_FOR_MS;
    const code = typeof msg.exitCode === "number" ? ` (${msg.exitCode})` : "";
    p.term?.write(`\r\n${t("ag.exitedLine", { code })}\r\n`);
    void refresh();
  }
}

// ── links and keys in a pane (AG-4b) ───────────────────────────────────

/**
 * What Shift+Enter sends to a pane's session: its row's (the server sends
 * every kind's; a plain session's is Enter). D66: a pane whose row the list
 * no longer has (another workspace in scope, mid-restart) keeps the one it
 * last had, and never knowing one, gets the catalog default, ESC CR. Never
 * a bare CR: that sent the prompt.
 */
const SOFT_NEWLINE_DEFAULT = "\u001b\r";
function softNewlineOf(id) {
  const seq = rowOf(id)?.softNewline;
  const p = st.panes.get(id);
  if (typeof seq === "string" && seq) {
    if (p) p.softNewline = seq;
    return seq;
  }
  return p?.softNewline || SOFT_NEWLINE_DEFAULT;
}

/**
 * A URL or an OSC 8 link clicked: with ⌘ (Ctrl elsewhere), an http or
 * https one opens in a new tab, noopener. A plain click opens nothing
 * (it selects); every other scheme (javascript:, data:, file:) nothing.
 *
 * D35: xterm tells on mouseup; Safari blocks window.open there. The link
 * waits for the click that follows (a gesture Safari honours) and opens
 * as a real link (linkOpen); no click within a moment: it opens anyway.
 */
let pendingWeb = null;
function openWeb(e, uri) {
  if (!linkModifier(e) || !isWebUrl(uri)) return;
  e?.preventDefault?.();
  if (pendingWeb) clearTimeout(pendingWeb.timer);
  pendingWeb = {
    uri,
    timer: setTimeout(() => {
      const p = pendingWeb;
      pendingWeb = null;
      if (p) linkOpen(p.uri);
    }, 300),
  };
}

function takePendingWeb() {
  const p = pendingWeb;
  if (!p) return;
  pendingWeb = null;
  clearTimeout(p.timer);
  linkOpen(p.uri);
}

/** D35: how to open a console link, on its hover: "⌘-click to open". */
function linkHint(p, on) {
  const el = p.el.querySelector(".term");
  if (!el) return;
  if (on) el.title = t("ag.linkHint", { key: isMac() ? "⌘" : "Ctrl" });
  else el.removeAttribute("title");
}

/** The most paths asked about at once (agent-paths.ts MAX_PATHS). */
const MAX_ASK = 64;

/**
 * Which of `paths` are links for agent row `r`: absolute path or null,
 * each asked once per pane (GET …/agents/<id>/paths: the server resolves
 * them against its cwd, inside its workspace; stat only).
 */
async function pathLinks(p, r, paths) {
  p.paths ??= new Map();
  const ask = [...new Set(paths)].filter((x) => !p.paths.has(x));
  for (let i = 0; i < ask.length; i += MAX_ASK) {
    const batch = ask.slice(i, i + MAX_ASK);
    const q = batch.map((x) => `p=${encodeURIComponent(x)}`).join("&");
    const got = fetch(`${agentPath(r, "paths")}?${q}`, {
      headers: { accept: "json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    for (const x of batch)
      p.paths.set(
        x,
        got.then((b) => {
          const v = b?.paths?.[x];
          return typeof v === "string" ? v : null;
        }),
      );
  }
  const out = new Map();
  for (const x of paths) out.set(x, await p.paths.get(x));
  return out;
}

/** xterm asks for line `y`'s links (1-based): its paths that exist. */
async function providePathLinks(p, y, done) {
  try {
    const r = rowOf(p.id);
    const line = p.term?.buffer.active.getLine(y - 1)?.translateToString(true);
    if (r?.kind !== "agent" || !r.agent || !line) return done(undefined);
    const found = findPaths(line);
    if (!found.length) return done(undefined);
    const abs = await pathLinks(
      p,
      r,
      found.map((m) => m.path),
    );
    const links = found
      .filter((m) => abs.get(m.path))
      .map((m) => ({
        text: m.text,
        range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
        decorations: { pointerCursor: true, underline: true },
        activate: (e) => void openPath(e, p, r, abs.get(m.path), m.line, m.col),
        hover: () => linkHint(p, true),
        leave: () => linkHint(p, false),
      }));
    done(links.length ? links : undefined);
  } catch {
    done(undefined);
  }
}

const EDITOR_NAMES = { vscode: "VS Code", cursor: "Cursor", zed: "Zed" };

/**
 * A path link clicked with ⌘ (Ctrl elsewhere): a menu at the pointer.
 * Download (AG-DROP-2: the file to this browser's machine, which may not
 * be the agent's), Open in the editor set in Settings (editor_open, at
 * the line, by its URL scheme), Copy path.
 */
function openPath(e, p, r, abs, line, col) {
  if (!linkModifier(e) || !abs || !r?.agent) return;
  e?.preventDefault?.();
  const url = editorUrl(st.editorOpen, abs, line, col);
  window.denShell?.openMenu?.(pathAnchor(p, e), {
    label: abs,
    items: [
      {
        label: t("ag.path.download"),
        onSelect: () => void downloadPath(r, abs),
      },
      ...(url
        ? [
            {
              label: t("ag.path.open", {
                ed: EDITOR_NAMES[st.editorOpen] ?? st.editorOpen,
              }),
              // D35: the same tab, to the editor's own scheme (zed://,
              // vscode://): a navigation, not a new window, so no popup
              // blocker stands in it.
              onSelect: () => window.open(url, "_self"),
            },
          ]
        : []),
      { label: t("ag.path.copy"), onSelect: () => void copyPath(abs) },
    ],
  });
}

async function copyPath(abs) {
  try {
    await navigator.clipboard.writeText(abs);
    window.denShell?.toast?.(t("ag.copied"));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
}

/**
 * AG-DROP-2: the file at `abs` downloads to this browser, from the agent's
 * workspace, cwd or uploads (the server checks; it says so when not).
 */
async function downloadPath(r, abs) {
  const url = `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/file?p=${encodeURIComponent(abs)}`;
  const name = abs.split("/").pop() || abs;
  try {
    const h = await fetch(url, { method: "HEAD", credentials: "same-origin" });
    if (!h.ok) throw new Error(t("ag.path.noFile", { name }));
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  window.denShell?.toast?.(t("ag.path.downloading", { name }));
}

/**
 * Where a path's menu opens: a point at the click, made once. Focus that
 * comes back to it (Esc) goes on to the pane's terminal.
 */
function pathAnchor(p, e) {
  let a = document.getElementById("ag-path-anchor");
  if (!a) {
    a = document.createElement("span");
    a.id = "ag-path-anchor";
    a.tabIndex = -1;
    a.setAttribute("aria-hidden", "true");
    a.style.cssText =
      "position:fixed;width:1px;height:1px;pointer-events:none;opacity:0";
    a.addEventListener("focus", () =>
      st.panes.get(a.dataset.pane)?.term?.focus(),
    );
    document.body.append(a);
  }
  a.dataset.pane = p.id;
  a.style.left = `${Math.round(e?.clientX ?? 0)}px`;
  a.style.top = `${Math.round(e?.clientY ?? 0)}px`;
  return a;
}

async function openPane(id, { front = true } = {}) {
  if (st.panes.has(id)) {
    st.panes.get(id).term?.focus();
    return;
  }
  if (front) st.cur = id;
  if (st.open.length >= MAX_PANES) {
    const oldest = st.open[0];
    window.denShell?.toast?.(
      t("ag.cap", { id: rowOf(oldest)?.label ?? oldest }),
    );
    closePane(oldest, { quiet: true });
  }
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.id = id;
  // xterm opens in .tbox, the .term's content box: the fit measures its
  // parent's height and width as they are, so the .term's padding must
  // not be in it (AG-4b: every terminal fits its pane).
  el.innerHTML = `<div class="bar2"></div><div class="term"><div class="tbox"></div></div><div class="agto" data-to data-toast-clear></div>`;
  const p = {
    id,
    el,
    term: null,
    fit: null,
    sock: null,
    closed: false,
    // The PTY's size as last heard (the server's size frame), or null.
    pty: null,
  };
  knowAgent(p);
  st.panes.set(id, p);
  st.open.push(id);
  paintBar(p);
  paintLayout();
  writeUrl();
  paintList();
  el.setAttribute("aria-label", rowOf(id)?.label ?? id);
  let lib;
  try {
    lib = await loadXterm();
  } catch (err) {
    // Issue 128: the failed pane goes, so a click on the agent tries again.
    if (!p.closed) closePane(id, { quiet: true });
    window.denShell?.errorToast?.(err);
    return;
  }
  if (p.closed) return;
  const term = new lib.Terminal({
    fontFamily: cssVar("--mono") ?? "monospace",
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: false,
    scrollback: 5000,
    theme: termTheme(),
    allowProposedApi: false,
    // OSC 8 links (AG-4b): ⌘/Ctrl-click, http and https only, no confirm.
    linkHandler: {
      activate: (e, uri) => void openWeb(e, uri),
      hover: () => linkHint(p, true),
      leave: () => linkHint(p, false),
      allowNonHttpProtocols: false,
    },
  });
  const fit = new lib.FitAddon();
  term.loadAddon(fit);
  // Plain URLs (AG-4b): the same rule as OSC 8.
  term.loadAddon(
    new lib.WebLinksAddon((e, uri) => void openWeb(e, uri), {
      hover: () => linkHint(p, true),
      leave: () => linkHint(p, false),
    }),
  );
  // D35: the click after xterm's mouseup opens a waiting link.
  el.querySelector(".term").addEventListener("click", takePendingWeb, true);
  term.open(el.querySelector(".term .tbox"));
  p.term = term;
  p.fit = fit;
  const enc = new TextEncoder();
  const typeIn = (d) => {
    if (p.sock?.readyState !== WebSocket.OPEN) return;
    // The one typing wins: another viewer resized the PTY since. Only a
    // person's typing: xterm's own answers to the agent's questions (its
    // kind, the cursor's place: a TUI asks on start, and a view that
    // opens replays them) come here too, and go to the agent as they are.
    if (personTyped(p) && (p.following || outOfStep(p))) claimSize(p);
    p.sock.send(enc.encode(d));
  };
  // D54: what a person did in this pane (a key, a paste, IME), heard
  // before xterm turns it into data.
  for (const ev of [
    "keydown",
    "paste",
    "beforeinput",
    "compositionend",
    "drop",
  ])
    el.addEventListener(
      ev,
      (e) => {
        if (!e.isTrusted) return;
        p.inputAt = performance.now();
        markShellUsed(p.id);
      },
      true,
    );
  imeOnce(el, typeIn);
  term.onData(typeIn);
  p.typeIn = typeIn;
  // AG-DROP: a file dropped or pasted here goes to the server; its path is
  // typed at the cursor.
  wireDrop(el, dropOpts(p));
  // AG-4b: Shift+Enter is the runtime's soft newline, never a CR; the
  // layout keys (⌃⇧1-3) are the page's, never the agent's.
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.shiftKey && /^Digit[123]$/.test(e.code ?? ""))
      return false;
    if (
      e.key === "Enter" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      if (e.isComposing) return true;
      e.preventDefault();
      if (softNewlineKey(e)) typeIn(softNewlineOf(p.id));
      return false;
    }
    return true;
  });
  // File paths (AG-4b): links only where the server says they exist in
  // the agent's workspace.
  term.registerLinkProvider({
    provideLinks: (y, done) => void providePathLinks(p, y, done),
  });
  term.onResize(() => sendSize(p));
  // Focused: the keyboard's pane (D40). D54: focus alone never takes the
  // PTY's size (a look at another tab must not redraw the one in use);
  // the first keystroke does.
  el.addEventListener("focusin", () => {
    if (!p.following) claimSize(p);
    st.keyPane = p.id;
  });
  // Issue 448: used means a person's click or key here, never the focus
  // the page gives a pane itself (a load puts the front tab's terminal in
  // focus, which must not make it the one used last).
  el.addEventListener(
    "pointerdown",
    (e) => {
      if (e.isTrusted) markShellUsed(p.id);
    },
    true,
  );
  p.ro = new ResizeObserver(() => refit(p));
  p.ro.observe(el.querySelector(".term"));
  refit(p);
  // The theme's font may still be loading: measure again once it has.
  document.fonts?.ready?.then(() => {
    if (!p.closed) remeasure(p);
  });
  void connect(p);
}

/** AG-DROP: what a pane's drop, paste and Attach need. */
function dropOpts(p) {
  return {
    // The pane's session now: a restart moves the pane to a new one.
    get id() {
      return p.id;
    },
    t,
    csrf,
    name: () => {
      const r = rowOf(p.id);
      return r ? paneName(r) : p.label || p.id;
    },
    // A live session only: its terminal is open and it is running.
    can: () => attachable(p),
    why: () => {
      const r = rowOf(p.id);
      const name = r ? paneName(r) : p.label || p.id;
      return p.exited || p.closed || (r && isStopped(r))
        ? t("ag.up.cant", { name })
        : t("ag.up.cantConn", { name });
    },
    say: (msg) => window.denShell?.toast?.(msg),
    typeIn: (text) => {
      p.typeIn?.(text);
      p.term?.focus();
    },
  };
}

/** A pane that takes a file now: connected, its session not ended. */
function attachable(p) {
  const r = rowOf(p.id);
  return (
    !p.closed &&
    !p.lost &&
    !p.exited &&
    p.sock?.readyState === WebSocket.OPEN &&
    !(r && isStopped(r))
  );
}

function closePane(id, { quiet = false } = {}) {
  const p = st.panes.get(id);
  if (!p) return;
  p.closed = true;
  p.conn?.stop();
  st.panes.delete(id);
  st.open = st.open.filter((x) => x !== id);
  st.side.delete(id);
  if (st.cur === id) st.cur = st.open.at(-1) ?? null;
  try {
    p.sock?.close(1000, "closed");
  } catch {
    /* already closed */
  }
  p.ro?.disconnect();
  p.term?.dispose();
  p.el.remove();
  if (!quiet)
    window.denShell?.toast?.(
      t("ag.detached", { id: rowOf(id)?.label ?? p.label ?? id }),
    );
  paintLayout();
  writeUrl();
  paintList();
}

function stopAgent(p, button) {
  const r = rowOf(p.id);
  if (!r?.agent) return;
  return oneAtATime(r, "stop", () => stopAgentNow(r, button));
}

async function stopAgentNow(r, button) {
  button.disabled = true;
  try {
    const out = await api(
      "POST",
      `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/stop`,
    );
    window.denShell?.toast?.(
      t(out?.stillStopping ? "ag.stillStopping" : "ag.stopped", {
        id: r.agent,
      }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/**
 * Close a shell: the server ends it as closing its terminal does (HUP,
 * then KILL) and forgets it; its pane closes.
 */
async function closeShell(p, button) {
  const r = rowOf(p.id);
  if (!r || r.kind !== "session") return;
  button.disabled = true;
  try {
    await api("POST", `/api/sessions/${encodeURIComponent(r.id)}/close`);
    // Quiet: the pane's own "it keeps running" toast would be wrong here.
    closePane(p.id, { quiet: true });
    window.denShell?.toast?.(t("ag.shellClosed", { id: r.label ?? r.name }));
  } catch (err) {
    button.disabled = false;
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/** Issue 448: the shell bar's New terminal: another shell in its project. */
async function newShell(r, button) {
  button.disabled = true;
  try {
    await openTerminal(r.workspace, { fresh: true });
  } finally {
    button.disabled = false;
  }
}

// ── Stopped agents (AG-14) ──────────────────────────────────────────────

const agentPath = (r, verb) =>
  `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/${verb}`;

// ── Issue 96: a project's agents in the person's order ─────────────────
// A grip and a pointer drag (mouse, pen and touch), ⋯ Move up, Move down
// and Move to top, Alt+↑ and Alt+↓ on a row, and on a phone Reorder in
// the project's header (Up and Down per row, then Done). A row moves
// inside its group (agent-order.js); the server stores the order in the
// person's user config and every list follows.

/** The agent ids of r's group, as the list shows them. */
const groupOf = (r) => orderGroup(st.data?.sessions ?? [], r, inStopped);

/** The grip a pointer drags a row by (any pointer: mouse, pen, touch). */
const gripHtml = (r) =>
  orderable(r, SERVER_WS)
    ? `<span class="agrip" data-grip="" role="img" aria-label="${esc(t("ag.ord.gripOne", { id: displayName(r) }))}" title="${esc(t("ag.ord.grip"))}">⠿</span>`
    : "";

/** A phone's Reorder (or Done) in a project's header, when it has two agents to order. */
function reorderButtonHtml(g) {
  if (!phone() || g.ws === SERVER_WS) return "";
  if (g.rows.filter((r) => orderable(r, SERVER_WS)).length < 2) return "";
  const on = st.reorderWs === g.ws;
  return `<button type="button" class="den-btn sm agord-t" data-act="reorder" data-ws="${esc(g.ws)}" aria-pressed="${on}" aria-label="${esc(on ? t("ag.ord.done") : t("ag.ord.reorderOne", { ws: projName(g.ws) }))}">${esc(on ? t("ag.ord.done") : t("ag.ord.reorder"))}</button>`;
}

/**
 * Issue 226: a phone's Reorder (or Done) for the Stopped group, when one
 * of its projects has two stopped agents to order.
 */
function reorderStoppedHtml(rows) {
  if (!phone() || !rows.some(stoppedMovable)) return "";
  const on = st.reorderStopped;
  return `<div class="agord-sb"><button type="button" class="den-btn sm agord-t" data-act="reorder" data-stopped="" aria-pressed="${on}" aria-label="${esc(on ? t("ag.ord.done") : t("ag.ord.reorderStopped"))}">${esc(on ? t("ag.ord.done") : t("ag.ord.reorder"))}</button></div>`;
}

/** Issue 226: a stopped row that can move: its group has two or more. */
const stoppedMovable = (r) => orderable(r, SERVER_WS) && groupOf(r).length >= 2;

/** A running row; in a phone's Reorder, with its Up and Down beside it. */
function reorderRowHtml(g, r) {
  return orderRowHtml(
    rowHtml(r),
    r,
    phone() && st.reorderWs === g.ws && orderable(r, SERVER_WS),
  );
}

/** `html`, the row of `r`; with its Up and Down beside it when `on`. */
function orderRowHtml(html, r, on) {
  if (!on) return html;
  const ids = groupOf(r);
  const btn = (dir, key, sign) =>
    `<button type="button" class="den-btn sm" data-act="ord-${dir}" aria-label="${esc(t(key, { id: displayName(r) }))}"${orderTo(ids, r.agent, dir) ? "" : ' aria-disabled="true"'}>${sign}</button>`;
  return (
    `<div class="agord" data-agent="${esc(r.agent)}" data-ws="${esc(r.workspace)}"><div class="agord-r">${html}</div>` +
    `<span class="agord-b">${btn("up", "ag.ord.upOne", "↑")}${btn("down", "ag.ord.downOne", "↓")}</span></div>`
  );
}

/** ⋯'s Move up, Move down and Move to top, those that can move it. */
function orderItems(r, focusRow) {
  if (!orderable(r, SERVER_WS)) return [];
  const ids = groupOf(r);
  return [
    ["up", "ag.ord.up"],
    ["down", "ag.ord.down"],
    ["top", "ag.ord.top"],
  ]
    .filter(([dir]) => orderTo(ids, r.agent, dir))
    .map(([dir, key]) => ({
      label: t(key),
      onSelect: () => void moveDir(r, dir, focusRow),
    }));
}

const moveDir = (r, dir, focusRow) =>
  moveOrder(r, orderTo(groupOf(r), r.agent, dir), focusRow);

/**
 * The move, shown at once (the list is redrawn in the new order), then
 * POSTed; then the list again, "<name> moved to position N of M" for a
 * screen reader, and (from the list) focus on the moved row. A quick
 * answer shows no pop-up and no toast; a slow one gets the working
 * pop-up, as every write does.
 */
async function moveOrder(r, to, focusRow) {
  if (!to) return;
  showMoved(r, to);
  const out = await window.denShell.busyAction(
    "agent-order",
    (headers) => api("POST", agentPath(r, "order"), { to }, { headers }),
    { vars: { id: displayName(r) }, toastFast: false },
  );
  await refresh();
  if (!out) return;
  const now =
    (st.data?.sessions ?? []).find(
      (s) =>
        s.kind === "agent" &&
        s.agent === r.agent &&
        s.workspace === r.workspace,
    ) ?? r;
  const ids = groupOf(now);
  announceOrder(
    t("ag.ord.moved", {
      name: displayName(now),
      n: ids.indexOf(r.agent) + 1,
      of: ids.length,
    }),
  );
  if (focusRow)
    st.root
      ?.querySelector(`#agl button.agr[data-id="${CSS.escape(now.id)}"]`)
      ?.focus();
}

/** The list in its new order before the server answers (refresh() corrects it). */
function showMoved(r, to) {
  const all = st.data?.sessions;
  if (!all) return;
  const from = all.indexOf(r);
  const other = all.find(
    (s) =>
      s.kind === "agent" &&
      s.workspace === r.workspace &&
      s.agent === (to.before ?? to.after),
  );
  if (from < 0 || !other) return;
  const rest = all.filter((s) => s !== r);
  const at = rest.indexOf(other) + (to.after ? 1 : 0);
  st.data.sessions = [...rest.slice(0, at), r, ...rest.slice(at)];
  paintList();
}

/** The polite live line under the list (the list itself is redrawn). */
function announceOrder(text) {
  const el = st.root?.querySelector("#ag-order-live");
  if (!el) return;
  el.textContent = "";
  requestAnimationFrame(() => (el.textContent = text));
}

/** How far a pointer moves on a grip before it's a drag, not a click (px). */
const DRAG_SLOP = 4;

/**
 * Alt+↑ and Alt+↓ on a row, and a pointer drag by the grip with its drop
 * line. Pointer events, not HTML drag and drop, so a finger on a phone or
 * tablet drags too; Escape cancels.
 */
function wireOrder(agl) {
  agl.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const b = e.target.closest?.("button.agr[data-id]");
    const r = b ? rowOf(b.dataset.id) : null;
    if (!orderable(r, SERVER_WS)) return;
    e.preventDefault();
    void moveDir(r, e.key === "ArrowUp" ? "up" : "down", true);
  });
  const clearDrop = () => {
    for (const x of agl.querySelectorAll("[data-drop], .lift")) {
      x.removeAttribute("data-drop");
      x.classList.remove("lift");
    }
  };
  /** Where the pointer at (x, y) would drop the dragged row, or null. */
  const hit = (x, y) => {
    const r = st.drag?.r;
    const el = r ? document.elementFromPoint(x, y) : null;
    const b = el?.closest?.("#agl button.agr[data-id]");
    const over = b ? rowOf(b.dataset.id) : null;
    if (
      !over ||
      over.kind !== "agent" ||
      over.workspace !== r.workspace ||
      inStopped(over) !== inStopped(r)
    )
      return null;
    const box = b.getBoundingClientRect();
    const after = y > box.top + box.height / 2;
    const to = dropTo(groupOf(r), r.agent, over.agent, after);
    return to ? { b, after, to } : null;
  };
  const end = () => {
    const d = st.drag;
    if (!d) return null;
    st.drag = null;
    try {
      d.grip.releasePointerCapture?.(d.id);
    } catch {
      /* already released */
    }
    clearDrop();
    agl.classList.remove("agdragging");
    return d;
  };
  agl.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest?.("[data-grip]");
    if (!grip || st.drag || (e.pointerType === "mouse" && e.button !== 0))
      return;
    const b = grip.closest("button.agr[data-id]");
    const r = b ? rowOf(b.dataset.id) : null;
    if (!orderable(r, SERVER_WS)) return;
    e.preventDefault();
    st.drag = { r, b, grip, id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      grip.setPointerCapture?.(e.pointerId);
    } catch {
      /* a synthetic pointer: moves still reach the list */
    }
  });
  agl.addEventListener("pointermove", (e) => {
    const d = st.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_SLOP) return;
      d.moved = true;
      agl.classList.add("agdragging");
    }
    e.preventDefault();
    for (const x of agl.querySelectorAll("[data-drop]"))
      x.removeAttribute("data-drop");
    d.b.classList.add("lift");
    const h = hit(e.clientX, e.clientY);
    if (h) h.b.setAttribute("data-drop", h.after ? "after" : "before");
  });
  agl.addEventListener("pointerup", (e) => {
    const d = st.drag;
    if (!d || e.pointerId !== d.id) return;
    const h = d.moved ? hit(e.clientX, e.clientY) : null;
    end();
    if (!d.moved) return;
    // The click that follows a drag isn't a click on the row.
    st.dragClick = true;
    setTimeout(() => (st.dragClick = false), 0);
    paintList();
    if (h) void moveOrder(d.r, h.to, true);
  });
  agl.addEventListener("pointercancel", () => {
    if (end()) paintList();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st.drag && end()) paintList();
  });
  agl.addEventListener(
    "click",
    (e) => {
      if (!st.dragClick) return;
      e.preventDefault();
      e.stopPropagation();
      st.dragClick = false;
    },
    true,
  );
}

// ── the double-click fix: one action per agent at a time ───────────────
// Held while the server answers. Every redraw (the list's poll, a pane's
// header) paints the agent's buttons disabled, the pressed one held with
// the kit's dots (issue 698),
// so a second click can't send it again; the server answers a repeat
// with the first result anyway. Success clears it; an error is shown and
// the buttons come back.
const busyActs = new Map();
const busyKey = (r) => `${r.workspace}/${r.agent}`;
const BUSY_ACTS = ["resume", "fresh", "relaunch", "rot-write", "stop"];

async function oneAtATime(r, verb, fn) {
  const k = busyKey(r);
  if (busyActs.has(k)) return;
  busyActs.set(k, verb);
  paintBusy();
  try {
    await fn();
  } finally {
    busyActs.delete(k);
    paintBusy();
  }
}

/** Each pressed button held with dots here, with its release. */
const dotsHeld = new WeakMap();

/** Paint every busy agent's buttons: disabled, the pressed one's dots. */
function paintBusy() {
  const root = st.root;
  if (!root) return;
  const keyOf = (el) => {
    const row = el.closest(".agst, .agr, [data-agent][data-ws]");
    if (row?.dataset.agent && row.dataset.ws)
      return `${row.dataset.ws}/${row.dataset.agent}`;
    const pane = el.closest(".pane[data-id]");
    const r = pane ? rowOf(pane.dataset.id) : null;
    return r?.agent ? busyKey(r) : null;
  };
  const sel = BUSY_ACTS.map((a) => `button[data-act="${a}"]`).join(",");
  for (const b of root.querySelectorAll(sel)) {
    const verb = busyActs.get(keyOf(b));
    if (verb) {
      if (!b.disabled) b.disabled = true;
      b.setAttribute("aria-busy", verb === b.dataset.act ? "true" : "false");
      // Issue 698: the kit's dots in place of the label (a redrawn
      // button too), never words of its own.
      if (verb === b.dataset.act && !dotsHeld.has(b))
        dotsHeld.set(b, window.denShell?.holdDots?.(b) ?? (() => {}));
    } else if (dotsHeld.has(b)) {
      const release = dotsHeld.get(b);
      dotsHeld.delete(b);
      void release();
      b.removeAttribute("aria-busy");
      b.disabled = false;
    }
  }
}

/**
 * Resume (the same conversation), Start fresh, or Relaunch from handoff
 * (den#4: a new conversation that starts from handoff.md); its pane opens
 * on it.
 */
function restartRow(r, verb, button, body) {
  return oneAtATime(r, verb, () => restartRowNow(r, verb, button, body));
}

async function restartRowNow(r, verb, button, body) {
  if (button) button.disabled = true;
  const name = { name: r.agent };
  // BUSY-1: the working pop-up while Den starts it, then what happened.
  let opened;
  const out = await window.denShell.busyAction(
    "start-agent",
    (headers) => api("POST", agentPath(r, verb), body, { headers }),
    {
      button,
      vars: name,
      success: (o) =>
        t(
          verb === "relaunch"
            ? "ag.relaunched"
            : verb !== "resume"
              ? "ag.startedFresh"
              : o?.handoff
                ? // Issue 658: never written; its last handoff began it.
                  "ag.resumedHandoff"
                : o?.fresh
                  ? "ag.resumedFresh"
                  : "ag.resumed",
          { id: r.agent },
        ),
      // Its open pane follows it to the new session (followAgents, in
      // refresh); one that couldn't (not running yet) is closed for it.
      onDone: (o) => (opened = follow(o)),
      // Issue 479: a quarantined runtime: Settings at its row, not a
      // dead end (Try again would refuse the same way).
      next: (err) => quarantineNext(err, t, r.workspace),
    },
  );
  await (out ? opened : refresh());
  async function follow(o) {
    await refresh();
    const next = o?.agent?.sessionId;
    if (next && next !== r.id && st.panes.has(r.id))
      closePane(r.id, { quiet: true });
    if (next) await openPane(next);
  }
}

/**
 * D28 Relaunch now: from the handoff when it passes; else Den asks for it
 * first (a stopped agent resumes to write it) and relaunches it once it
 * passes, by itself.
 */
function relaunchNow(r, button) {
  if (r.rotation?.ready) return restartRow(r, "relaunch", button);
  return oneAtATime(r, "relaunch", () => askRelaunch(r, button));
}

async function askRelaunch(r, button) {
  if (button) button.disabled = true;
  try {
    const out = await api("POST", agentPath(r, "handoff"), { relaunch: true });
    window.denShell?.toast?.(
      t(out?.resumed ? "ag.rc.askedResumed" : "ag.rc.askedRelaunch", {
        id: r.agent,
      }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/** D28 Write handoff: the prompt, typed into its session at idle. */
function writeHandoff(r, button) {
  return oneAtATime(r, "rot-write", () => writeHandoffNow(r, button));
}

async function writeHandoffNow(r, button) {
  if (button) button.disabled = true;
  try {
    await api("POST", agentPath(r, "handoff"), {});
    window.denShell?.toast?.(t("ag.rc.asked", { id: r.agent }));
  } catch (err) {
    // Mid-turn is expected, not an error: say when to try again.
    if (/mid-turn/.test(String(err?.message ?? "")))
      window.denShell?.toast?.(t("ag.rc.midTurn", { id: r.agent }));
    else window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/**
 * D59: "Resume after a restart", a check in an agent's ⋯ (its persona's,
 * tagged "default", until a person sets it).
 */
function restartResumeItem(r) {
  const on = !!r.resumesOnRestart;
  return {
    label: t("ag.rr.item"),
    checked: on,
    ...(r.resumeOnRestart === undefined ? { tag: t("ag.rr.default") } : {}),
    onSelect: () => void setRestartResume(r, !on),
  };
}

async function setRestartResume(r, on) {
  try {
    await api("POST", agentPath(r, "settings"), { resumeOnRestart: on });
    window.denShell?.toast?.(
      t(on ? "ag.rr.on" : "ag.rr.off", { id: displayName(r) }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/** D28 Keep this conversation (and "don't ask again": never, for it). */
async function keepConversation(r, button) {
  const never = !!button
    ?.closest(".agacts, .agrot")
    ?.querySelector("[data-rot-never]")?.checked;
  if (button) button.disabled = true;
  try {
    await api("POST", agentPath(r, "keep"), never ? { never: true } : {});
    window.denShell?.toast?.(
      t(never ? "ag.rc.keptNever" : "ag.rc.kept", { id: r.agent }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/**
 * D28: a relaunch Den did by itself since the last look: a toast saying
 * so, and that the old conversation is kept. The first look only notes
 * what is there.
 */
function toastAutoRelaunches(rows) {
  const seen = (st.rotSeen ??= new Map());
  const first = !st.rotLooked;
  st.rotLooked = true;
  for (const r of rows) {
    const last = r.kind === "agent" ? r.lastRotation : undefined;
    if (!last) continue;
    const key = `${r.workspace}/${r.agent}`;
    if (seen.get(key) === last.at) continue;
    seen.set(key, last.at);
    if (first || !last.auto) continue;
    window.denShell?.toast?.(
      t("ag.rc.autoRelaunched", {
        id: r.agent,
        why:
          last.reason === "pr-merged"
            ? t("ag.rot.merged")
            : t(
                last.compactions === 1
                  ? "ag.rot.compactions.one"
                  : "ag.rot.compactions",
                { n: last.compactions },
              ),
        old: last.conversation ?? "?",
      }),
    );
  }
}

/** Undo: the removed agents come back (POST /api/agents/restore). */
async function undoRemove(ids) {
  try {
    const out = await api("POST", "/api/agents/restore", { agents: ids });
    const back = out?.restored ?? [];
    if (back.length)
      window.denShell?.toast?.(t("ag.restored", { ids: back.join(", ") }));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/** The removal's toast, with Undo for UNDO_MS. */
function removedToast(msg, ids) {
  const shell = window.denShell;
  if (shell?.toastAction)
    shell.toastAction(msg, t("ag.undo"), () => void undoRemove(ids), UNDO_MS);
  else shell?.toast?.(msg);
}

/** Remove: one click, no confirm (AG-14.1b). */
async function removeRow(r, button) {
  if (button) button.disabled = true;
  try {
    const out = await api("POST", agentPath(r, "remove"));
    if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
    const ids = (out?.removed ?? []).map((x) => x.agent);
    await refresh();
    removedToast(
      t("ag.removed", { id: r.agent }),
      ids.length ? ids : [r.agent],
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
    await refresh();
  }
}

/**
 * 0.4.45: Remove on an exited shell: the host forgets it (the close route,
 * which never ends a running one: this is only offered once it exited).
 */
async function removeShell(r, button) {
  if (!exitedShell(r)) return;
  if (button) button.disabled = true;
  try {
    await api("POST", `/api/sessions/${encodeURIComponent(r.id)}/close`);
    if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
    window.denShell?.toast?.(t("ag.removed", { id: r.label || r.name }));
  } catch (err) {
    if (button) button.disabled = false;
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/**
 * Issue 482: Restart on an exited terminal: a new one in the same folder
 * (its project's when the host didn't say), in front; the exited one is
 * removed, so the list keeps one row for it.
 */
async function restartShell(r, button) {
  if (!exitedShell(r)) return;
  const url = `/api/workspaces/${encodeURIComponent(r.workspace)}/sessions`;
  // One request (the pop-up's id runs once): the server starts the new
  // one, then forgets the exited one it replaces.
  const body = { ...(r.cwd ? { cwd: r.cwd } : {}), replaces: r.id };
  const out = await window.denShell.busyAction(
    "open-terminal",
    (headers) => api("POST", url, body, { headers }),
    { button },
  );
  const id = out?.session?.id;
  if (!id) return;
  if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
  await refresh();
  await bringShell(id);
}

/**
 * Issue 482: the Terminals page's New terminal: one click in a project;
 * under All projects a small picker of projects, the one used last first
 * (its first item, where the keyboard starts).
 */
async function newTerminal(button) {
  const view = viewWorkspaces();
  if (view.length === 1) return void openTerminal(view[0], { fresh: true });
  const choices = newTerminalChoices(
    st.data?.workspaces ?? [],
    st.data?.sessions ?? [],
    shellUsed(),
  );
  if (!choices.length) return void openTerminal("", { fresh: true });
  window.denShell?.openMenu?.(button, {
    label: t("tm.pick"),
    items: choices.map((ws) => ({
      label: ws,
      onSelect: () => void openTerminal(ws, { fresh: true }),
    })),
  });
}

/** Clear stopped: every stopped agent and exited shell in view (AG-14.1b). */
async function clearStopped(button) {
  const workspaces = [
    ...new Set(
      visibleRows()
        .filter(isStopped)
        .map((r) => r.workspace),
    ),
  ];
  const shells = visibleRows().filter(exitedShell);
  if (!workspaces.length && !shells.length) return;
  button.disabled = true;
  try {
    const out = workspaces.length
      ? await api("POST", "/api/agents/clear-stopped", { workspaces })
      : null;
    const ids = (out?.removed ?? []).map((x) => x.agent);
    for (const r of visibleRows())
      if (ids.includes(r.agent) && st.panes.has(r.id))
        closePane(r.id, { quiet: true });
    // 0.4.45: the exited shells too (nothing to undo: a shell can't come
    // back).
    let gone = 0;
    for (const r of shells)
      try {
        await api("POST", `/api/sessions/${encodeURIComponent(r.id)}/close`);
        if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
        gone++;
      } catch {
        /* still listed: its row says so */
      }
    await refresh();
    const n = ids.length + gone;
    if (gone && n)
      removedToast(
        t(n === 1 ? "ag.clearedMany.one" : "ag.clearedMany", { n }),
        ids,
      );
    else if (ids.length)
      removedToast(
        t(ids.length === 1 ? "ag.removedMany.one" : "ag.removedMany", {
          n: ids.length,
        }),
        ids,
      );
  } catch (err) {
    window.denShell?.errorToast?.(err);
    await refresh();
  } finally {
    button.disabled = false;
  }
}

/** Resume all: every interrupted agent in view that can resume (AG-14.3). */
async function resumeAll(button) {
  const workspaces = [
    ...new Set(
      visibleRows()
        .filter((r) => r.state === "interrupted")
        .map((r) => r.workspace),
    ),
  ];
  if (!workspaces.length) return;
  button.disabled = true;
  try {
    const out = await window.denShell.api(
      "POST",
      "/api/agents/resume-interrupted",
      { workspaces },
    );
    const n = out?.resumed?.length ?? 0;
    window.denShell?.toast?.(
      t(n === 1 ? "ag.resumedAll.one" : "ag.resumedAll", { n }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/**
 * Switch to ?ws='s workspace: make it active (as Local Dev's Activate
 * does), then view it (POST /api/scope, the top bar's Workspace switch),
 * then reload, as that switch does.
 */
async function switchWorkspace(button) {
  const ws = st.data?.requested?.workspace;
  if (!ws) return;
  button.disabled = true;
  try {
    await api("POST", "/api/workspaces", { name: ws, action: "activate" });
    await api("POST", "/api/scope", { scope: ws });
  } catch (err) {
    window.denShell?.errorToast?.(err);
    button.disabled = false;
    return;
  }
  location.reload();
}

/** Review: the first interrupted agent, scrolled to and focused. */
function review() {
  const first = st.root.querySelector('#agl .agst[data-state="interrupted"]');
  if (!first) return;
  for (const el of st.root.querySelectorAll("#agl .agst[data-review]"))
    el.removeAttribute("data-review");
  for (const el of st.root.querySelectorAll(
    '#agl .agst[data-state="interrupted"]',
  ))
    el.setAttribute("data-review", "");
  first.scrollIntoView({ block: "nearest" });
  (
    first.querySelector('[data-act="resume"]') ?? first.querySelector(".agr")
  )?.focus();
}

// ── Start agent (AG-10.1) ───────────────────────────────────────────────

// Personas and runtimes, per workspace (AG-0.5: a workspace's own runtime
// paths win), asked once per page each.
const personasAsked = new Map();

function personasFor(ws) {
  const key = ws || "";
  if (!personasAsked.has(key))
    personasAsked.set(
      key,
      api(
        "GET",
        `/api/personas${ws ? `?workspace=${encodeURIComponent(ws)}` : ""}`,
      ).catch((err) => {
        personasAsked.delete(key);
        throw err;
      }),
    );
  return personasAsked.get(key);
}

/**
 * "Plain session": no persona, a shell in the workspace (AG-10.1). A ":"
 * is never in a persona's id.
 */
const PLAIN = ":plain";

/** The dialog's state while it is open. */
const sd = {
  data: null,
  f: { q: "", cat: "", src: "" },
  pid: "",
  det: false,
  what: false,
  detail: null,
  // Advanced: "" = the persona's.
  model: "",
  ver: "",
  intent: "ask",
  extras: [],
  extrasOpen: false,
  // AG-17.1, Bring in: null for Start; else the workspace's conversations,
  // the runtimes that can't bring one in, and the one picked.
  bring: null,
  // AG-18, Change persona: null; else the agent's row (id, workspace,
  // persona, model) whose persona changes.
  change: null,
};

/** Bring in's conversations: the project's, then (D56) those started outside any. */
function bringAll() {
  return [...(sd.bring?.list ?? []), ...(sd.bring?.away ?? [])];
}

/** The conversation picked in Bring in, when it can be brought in. */
function bringPick() {
  const c = bringAll().find((x) => x.id === sd.bring.pick);
  return c && !c.open && !c.agent ? c : null;
}

/** D56: where an agent runs, saying so when that is outside its project. */
function cwdText(r) {
  return r.outside && r.cwd ? t("ag.outside", { folder: r.cwd }) : r.cwd;
}

/** "3 minutes ago", "2 hours ago", or the date: a <time> (issue 206). */
function agoText(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return timeHtml(iso, { style: ms < 48 * 3600_000 ? "relative" : "date" });
}

/**
 * Issue 482: agoText as plain text, for a time inside a translated
 * sentence ("Last used 3 minutes ago"), in the person's zone.
 */
function agoPlain(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return formatTime(iso, { style: ms < 48 * 3600_000 ? "relative" : "date" });
}

/** The folder a conversation ran in, inside the workspace's when it is. */
function convFolder(c) {
  const root = sd.bring?.root;
  if (root && c.cwd === root) return ".";
  if (root && c.cwd.startsWith(`${root}/`)) return c.cwd.slice(root.length + 1);
  return c.cwd;
}

function convRowHtml(c) {
  const taken = c.agent
    ? ` <span class="tagx">${esc(t("ag.bring.agent", { id: c.agent }))}</span>`
    : c.open
      ? ` <span class="tagx warn" title="${esc(t("ag.bring.openTip"))}">${esc(t("ag.bring.open"))}</span>`
      : "";
  const off = c.agent || c.open;
  return (
    `<button type="button" class="pr" role="radio" data-cid="${esc(c.id)}" aria-checked="${c.id === sd.bring.pick}"${off ? ' aria-disabled="true"' : ""}>` +
    `<span class="rd" aria-hidden="true"></span><span class="pn pnc"><span class="pt">${esc(c.title || t("ag.bring.untitled"))}</span>${taken}</span><span class="mono">${agoText(c.lastAt)}</span>` +
    `<span class="pd mono">${esc(convFolder(c))} · ${esc(c.id.slice(0, 8))}</span></button>`
  );
}

/** Bring in's conversation list and its help line. */
function paintConversations() {
  const f = $d("#ag-conv-f");
  f.hidden = !sd.bring;
  if (!sd.bring) return;
  const list = sd.bring.list;
  const cant = (sd.bring.runtimes ?? [])
    .filter((r) => !r.bringIn && r.id !== "generic")
    .map((r) => r.why);
  $d("#ag-conv-h").textContent = [
    list.length ? t("ag.bring.help") : t("ag.bring.none"),
    // Each its own sentence (they read as one run-on line before).
    ...cant.map((w) => (/[.!?]$/.test(w) ? w : `${w}.`)),
  ].join(" ");
  $d("#ag-conv").innerHTML = list.map(convRowHtml).join("");
  $d("#ag-conv").hidden = !list.length;
  // D56: started outside every project: each runs in its own folder.
  const away = sd.bring.away ?? [];
  for (const id of ["#ag-conv-oh", "#ag-conv-ohelp", "#ag-conv-o"])
    $d(id).hidden = !away.length;
  $d("#ag-conv-ohelp").textContent = t("ag.bring.outsideHelp");
  $d("#ag-conv-o").innerHTML = away.map(convRowHtml).join("");
}

/** Ask for the workspace's conversations (Bring in). */
async function fillConversations(ws) {
  if (!sd.bring) return true;
  try {
    const r = await api(
      "GET",
      `/api/workspaces/${encodeURIComponent(ws)}/conversations`,
    );
    sd.bring.list = r?.conversations ?? [];
    sd.bring.away = r?.outside ?? [];
    sd.bring.runtimes = r?.runtimes ?? [];
    sd.bring.root = r?.folder ?? "";
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return false;
  }
  // Never one from outside picked for you: that is the person's own ask.
  if (!bringAll().some((c) => c.id === sd.bring.pick))
    sd.bring.pick = sd.bring.list.find((c) => !c.open && !c.agent)?.id ?? "";
  paintConversations();
  return true;
}

function pickConversation(id) {
  const c = bringAll().find((x) => x.id === id);
  if (!c || c.open || c.agent) return;
  sd.bring.pick = id;
  for (const b of st.root.querySelectorAll(
    "#ag-conv [data-cid], #ag-conv-o [data-cid]",
  ))
    b.setAttribute("aria-checked", String(b.dataset.cid === id));
  // AG-17.1c: its suggested persona, preselected (never submitted).
  if (c.suggest && (sd.data?.personas ?? []).some((p) => p.id === c.suggest))
    pickPersona(c.suggest);
  else paintRuntime(false);
}

/**
 * AG-17.1c, AG-18: what the persona changes, in one short list under it:
 * the model kept (or the one picked), what it works as from now on, and
 * for Bring in the MCP servers it won't have.
 */
function paintKeep() {
  const el = $d("#ag-keep");
  if (!el) return;
  const p = curPersona();
  const from = sd.bring ? bringPick() : sd.change;
  el.hidden = !p || !from;
  if (el.hidden) return void (el.innerHTML = "");
  const items = [];
  if (sd.model) items.push(t("ag.keep.modelNew", { m: sd.model }));
  else if (from.model) items.push(t("ag.keep.model", { m: from.model }));
  items.push(
    t("ag.keep.from", {
      p: personaName(p),
      mode: t(`pm.${p.permission || "ask"}`),
    }),
  );
  if (sd.bring && from.lost?.length)
    items.push(t("ag.keep.lost", { s: from.lost.join(", ") }));
  el.innerHTML = items
    .map((x, i) => `<li data-keep="${i}">${esc(x)}</li>`)
    .join("");
}

const $d = (sel) => st.root.querySelector(sel);
const curPersona = () =>
  sd.pid === PLAIN
    ? null
    : (sd.data?.personas ?? []).find((p) => p.id === sd.pid) || null;

/** The runtime the dialog will start: the one picked, else the persona's. */
function chosenRuntime() {
  // Change persona and Bring in: the agent's, or the conversation's.
  if (sd.change?.runtime) return sd.change.runtime;
  const conv = sd.bring ? bringPick() : null;
  if (conv?.runtime) return conv.runtime;
  const p = curPersona();
  return $d("#ag-runtime").value || personaRuntime(sd.data, p);
}

/** The persona's own model and version, on the runtime chosen (AG-12.3). */
function personaModel() {
  const p = curPersona();
  const same = p && personaRuntime(sd.data, p) === chosenRuntime();
  return {
    model: same ? p.model || "" : "",
    version: same ? p.version || "latest" : "latest",
  };
}

/** The persona list's rows, and Plain session pinned at the bottom. */
function plistHtml() {
  const ps = sd.data?.personas ?? [];
  const cats = sd.data?.categories ?? [];
  const rows = personaListHtml(sd.f, ps, cats, (p) =>
    personaRowHtml(p, p.id === sd.pid, sd.data),
  );
  // Bring in continues a conversation, and a change keeps one: each needs
  // a persona.
  if (sd.bring || sd.change) return rows;
  return (
    rows +
    `<div class="pgh"><span>${esc(t("ag.session"))}</span><span></span></div>` +
    `<button type="button" class="pr" role="radio" data-pid="${esc(PLAIN)}" aria-checked="${sd.pid === PLAIN}"><span class="rd" aria-hidden="true"></span><span class="pn">${esc(t("ag.new.plain"))}</span><span></span><span class="pd">${esc(t("ag.new.plainP"))}</span></button>`
  );
}

function paintPlist(keepScroll = true) {
  const l = $d("#ag-persona");
  const top = l.scrollTop;
  l.innerHTML = plistHtml();
  // AG-18: the agent's persona now, marked.
  const cur =
    sd.change &&
    [...l.querySelectorAll("[data-pid]")].find(
      (b) => b.dataset.pid === sd.change.persona,
    );
  cur
    ?.querySelector(".pn")
    ?.insertAdjacentHTML(
      "beforeend",
      ` <span class="tagx" data-current>${esc(t("ag.pc.current"))}</span>`,
    );
  l.scrollTop = keepScroll ? top : 0;
}

/** The Details row (and Duplicate or Edit) under the list, and Details. */
function paintDetails() {
  const p = curPersona();
  const el = $d("#ag-detrow");
  if (!p) {
    el.innerHTML = "";
    return;
  }
  const mine = p.origin === "local";
  el.innerHTML =
    `<div class="fldh"><button type="button" class="lnk" data-x="det" aria-expanded="${sd.det}" aria-controls="ag-det">${esc(sd.det ? t("ag.new.hide") : t("ag.new.details", { n: personaName(p) }))}</button><span class="sp"></span>` +
    (mine
      ? `<button type="button" class="lnk" data-x="edit">${esc(t("pe.editB"))}</button>`
      : "") +
    `<button type="button" class="lnk" data-x="dup">${esc(t("pe.dup"))}</button></div>` +
    (sd.det
      ? personaDetailHtml(
          sd.detail?.id === p.id ? sd.detail : { ...p, instructions: null },
          sd.data,
        )
      : "");
}

/**
 * The runtime select and its readiness line (AG-0.2), and AG-12.2: a
 * persona whose runtime isn't installed starts on the first one that is,
 * and the dialog says so.
 */
function paintRuntime(reset) {
  paintRuntimeFields(reset);
  paintKeep();
  // Last: a Name that names a running agent disables Start (AG-10.10b).
  paintStartsAs();
}

function paintRuntimeFields(reset) {
  const rs = $d("#ag-runtime");
  const go = $d("#ag-go");
  const ready = $d("#ag-r-ready");
  const plain = sd.pid === PLAIN;
  // Bring in: the conversation's runtime, its own history; no first
  // instruction, no Advanced (it keeps what the persona gives).
  // Change persona: the agent's runtime and name stay. Advanced (the
  // model) shows for both (AG-17.1c, AG-18).
  const keeps = !!sd.bring || !!sd.change;
  $d("#ag-r-l").hidden = plain || keeps;
  $d("#ag-task-l").hidden = plain || keeps;
  $d("#ag-adv").hidden = plain;
  $d("#ag-name-l").hidden = plain || keeps;
  if (sd.change) {
    $d("#ag-r-miss").hidden = true;
    ready.hidden = true;
    const p = curPersona();
    const ok = !!p && (p.id !== sd.change.persona || !!sd.model);
    go.disabled = !ok;
    go.dataset.blocked = ok ? "" : "persona";
    return;
  }
  if (sd.bring) {
    $d("#ag-r-miss").hidden = true;
    ready.hidden = true;
    const ok = !!bringPick() && !!curPersona();
    go.disabled = !ok;
    go.dataset.blocked = ok ? "" : "conversation";
    return;
  }
  const fb = $d("#ag-r-fb");
  fb.hidden = true;
  if (plain) {
    $d("#ag-r-miss").hidden = true;
    ready.hidden = true;
    go.disabled = false;
    go.dataset.blocked = "";
    return;
  }
  const personas = sd.data?.personas ?? [];
  const runtimes = sd.data?.runtimes ?? [];
  const keep = reset ? "" : rs.value;
  rs.innerHTML = runtimeOptions(personas, runtimes, sd.pid, t);
  if ([...rs.options].some((o) => o.value === keep && !o.disabled))
    rs.value = keep;
  const p = curPersona();
  if (reset && p && !runtimeInstalled(sd.data, p)) {
    const first = [...rs.options].find((o) => o.value && !o.disabled);
    if (first) {
      rs.value = first.value;
      fb.textContent = t("rt.fallback", {
        p: personaName(p),
        r: runtimeName(runtimes, personaRuntime(sd.data, p)),
        f: runtimeName(runtimes, first.value),
      });
      fb.hidden = false;
    }
  }
  // AG-12.1: what isn't installed here, and Install… (later).
  const miss = runtimes.filter(
    (x) => !x.available && x.denTools !== undefined && x.source !== "setting",
  );
  const ml = $d("#ag-r-miss");
  ml.innerHTML = miss.length
    ? `${esc(t("rt.missingLine"))} ${miss.map((x) => `<span class="mono">${esc(x.label || x.id)}</span>`).join(", ")} · <span class="lnk" aria-disabled="true" title="${esc(t("rt.later"))}">${esc(t("rt.install"))}</span> <span class="tagx">${esc(t("rt.later"))}</span>`
    : "";
  ml.hidden = !miss.length;
  const r = readiness(sd.data, sd.pid, rs.value, t);
  ready.innerHTML = r.html;
  ready.hidden = !r.html;
  ready.dataset.tone = r.tone;
  wireStartQuarantine(ready);
  go.disabled = !r.ok;
  go.dataset.blocked = r.ok ? "" : "runtime";
}

/** Advanced (AG-12, AG-13): model, version and the permission block. */
function paintAdvanced() {
  const p = curPersona();
  const body = $d("#ag-adv-b");
  if (!p) {
    body.innerHTML = "";
    return;
  }
  const rt = chosenRuntime();
  const rtv = (sd.data?.runtimes ?? []).find((r) => r.id === rt);
  const name = runtimeName(sd.data?.runtimes ?? [], rt);
  const def = personaModel();
  const models = rtv?.models ?? [];
  // AG-17.1c, AG-18: the conversation's model stays unless one is picked.
  const from = sd.bring ? bringPick() : sd.change;
  if (sd.bring || sd.change) {
    const keep = from?.model
      ? t("ag.keep.opt", { m: from.model })
      : t("ag.keep.optNone");
    body.innerHTML =
      `<p>${esc(t("ag.keep.advNote"))}</p>` +
      `<div class="two"><label class="fld"><span>${esc(t("ag.new.model"))}</span><select id="ag-model"${models.length ? "" : " disabled"}>${models.length ? modelOptionsHtml(sd.data, rt, sd.model, keep) : `<option value="">${esc(keep)}</option>`}</select></label>` +
      `<label class="fld"><span>${esc(t("ag.new.ver"))}</span><select id="ag-ver"${models.length && sd.model ? "" : " disabled"}>${versionOptionsHtml(sd.data, rt, sd.model, sd.ver, t("ag.new.verDef", { v: versionLabel("latest") }))}</select></label></div>`;
    return;
  }
  const model = sd.model || def.model;
  const first = t("ag.new.modelDef", {
    // No model of its own: just the version, so the label fits the select.
    m: def.model
      ? `${def.model} · ${versionLabel(def.version)}`
      : versionLabel("latest"),
  });
  const verFirst = t("ag.new.verDef", {
    v: versionLabel(
      sd.model && sd.model !== def.model ? "latest" : def.version,
    ),
  });
  const wsPm = sd.data?.workspacePermission;
  body.innerHTML =
    `<p>${esc(t("ag.new.advNote"))}</p>` +
    (wsPm
      ? `<p class="faint" id="ag-wspm">${esc(t("pm.wsDefault", { m: t(`pm.${wsPm}`) }))}</p>`
      : "") +
    `<div class="two"><label class="fld"><span>${esc(t("ag.new.model"))}</span><select id="ag-model"${models.length ? "" : " disabled"}>${models.length ? modelOptionsHtml(sd.data, rt, sd.model, first) : `<option value="">${esc(t("pe.nsModel", { r: name }))}</option>`}</select></label>` +
    `<label class="fld"><span>${esc(t("ag.new.ver"))}</span><select id="ag-ver"${models.length && model ? "" : " disabled"}>${versionOptionsHtml(sd.data, rt, model, sd.ver, verFirst)}</select></label></div>` +
    permBlockHtml("ag", sd.data, {
      intent: sd.intent,
      role: p.role,
      extras: sd.extras,
      runtime: rt,
      extrasOpen: sd.extrasOpen,
      disabled: !rtv?.permissions,
    });
  $d("#ag-tools").disabled = false;
}

/** Pick persona `id` (or PLAIN): its own choices fill Advanced in. */
function pickPersona(id) {
  sd.pid = id;
  sd.det = sd.det && id !== PLAIN;
  const p = curPersona();
  sd.model = "";
  sd.ver = "";
  // den#48: the workspace's mode first, then the persona's.
  sd.intent = sd.data?.workspacePermission || p?.permission || "ask";
  sd.extras = [...(p?.allowedCommands ?? [])];
  sd.extrasOpen = sd.extras.length > 0;
  for (const b of st.root.querySelectorAll("#ag-persona [data-pid]"))
    b.setAttribute("aria-checked", String(b.dataset.pid === id));
  paintDetails();
  paintRuntime(true);
  paintAdvanced();
  if (sd.det) void loadDetail();
}

async function loadDetail() {
  const p = curPersona();
  if (!p) return;
  try {
    const d = await personaDetail(p.id, sd.data?.workspace);
    if (curPersona()?.id !== d.id) return;
    sd.detail = d;
    paintDetails();
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
}

/** The whole persona field, for the data asked. */
function paintPersonaField() {
  const ps = sd.data?.personas ?? [];
  $d("#ag-pfbar").innerHTML = filterBarHtml(
    sd.f,
    "ag",
    ps,
    sd.data?.categories ?? [],
  );
  $d("#ag-what").hidden = !sd.what;
  paintPlist(false);
}

/** Ask for the workspace's personas and runtimes; false when it failed. */
async function fillForWorkspace(ws) {
  try {
    sd.data = normalizeData(await personasFor(ws));
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return false;
  }
  if (!(await fillConversations(ws))) return false;
  if ((sd.bring || sd.change) && sd.pid === PLAIN) sd.pid = "";
  const ps = sd.data?.personas ?? [];
  // AG-17.1c: the picked conversation's suggested persona, preselected.
  const sug = sd.bring ? bringPick()?.suggest : null;
  if (sug && ps.some((p) => p.id === sug)) sd.pid = sug;
  // AG-18: its persona now (marked; Change stays off until another).
  if (sd.change && ps.some((p) => p.id === sd.change.persona))
    sd.pid = sd.change.persona;
  if (sd.pid !== PLAIN && !ps.some((p) => p.id === sd.pid)) {
    // The first persona the list shows (grouped by category).
    const cats = (sd.data?.categories ?? []).map((c) => c.id);
    const sorted = [...ps].sort(
      (a, b) =>
        (cats.indexOf(a.category) + 1 || 99) -
        (cats.indexOf(b.category) + 1 || 99),
    );
    sd.pid = sorted[0]?.id ?? PLAIN;
  }
  paintPersonaField();
  pickPersona(sd.pid);
  paintRepoField();
  return true;
}

/**
 * D65 v2: the Start dialog's Repo: its workspace's repos, None (the whole
 * project), or From its folder (Den proposes; the pane's Change fixes it).
 * A service card's Start agent here picks its repo.
 */
function paintRepoField() {
  const sel = $d("#ag-repo");
  if (!sel) return;
  const repos = sd.data?.repos ?? [];
  const lbl = $d("#ag-repo-l");
  if (lbl) lbl.hidden = Boolean(sd.change);
  sel.innerHTML =
    `<option value="auto">${esc(t("ag.repo.auto"))}</option>` +
    `<option value="">${esc(t("ag.repo.none"))}</option>` +
    repos.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
  sel.value = sd.repo && repos.includes(sd.repo) ? sd.repo : "auto";
}

/** The dialog's words for Start, or for Bring in (AG-17.1). */
function dialogMode(bring, change = null) {
  sd.bring = bring ? { list: [], runtimes: [], root: "", pick: "" } : null;
  sd.change = change;
  $d("#ag-dlg-h").textContent = change
    ? t("ag.pc.title", { id: change.name })
    : t(bring ? "ag.bring.title" : "ag.new.title");
  $d("#ag-note").textContent = t(
    change ? "ag.pc.note" : bring ? "ag.bring.note" : "ag.new.note",
  );
  $d("#ag-go").textContent = goLabel();
  $d("#ag-conv-f").hidden = !bring;
  // 0.4.18: a new agent's folder (Start agent here fills it).
  for (const id of ["#ag-folder-l", "#ag-folder-h"]) {
    const el = $d(id);
    if (el) el.hidden = !!(bring || change);
  }
}

/** 0.4.18: Start agent here (the service panel): ?start=1&ws=…&folder=…. */
let startPrefill = null;

/** The submit button's words for the dialog's mode. */
function goLabel() {
  return t(sd.change ? "ag.pc.go" : sd.bring ? "ag.bring.go" : "ag.go");
}

/**
 * D65 v2: Change: which repo of its project agent `r` works on (or none).
 * The same choices as the Start dialog's Repo.
 */
async function openLink(r, opener) {
  const dlg = $d("#ag-ln");
  if (!dlg || dlg.open) return;
  const sel = $d("#ag-ln-repo");
  const err = $d("#ag-ln-err");
  const project = r.project || r.workspace;
  $d("#ag-ln-h").textContent = t("ag.link.title", { id: paneName(r) });
  $d("#ag-ln-t").textContent = t("ag.repo");
  $d("#ag-ln-help").textContent = t("ag.link.help", { p: project });
  $d("#ag-ln-go").textContent = t("ag.link.save");
  $d("#ag-ln-cancel").textContent = t("ag.rn.cancel");
  let repos = [];
  try {
    repos = normalizeData(await personasFor(r.workspace)).repos ?? [];
  } catch (e) {
    window.denShell?.errorToast?.(e);
    return;
  }
  sel.innerHTML =
    `<option value="">${esc(t("ag.repo.none"))}</option>` +
    repos.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  sel.value = r.repo && repos.includes(r.repo) ? r.repo : "";
  err.hidden = true;
  const close = () => {
    dlg.close?.();
    dlg.removeAttribute("open");
    opener?.focus?.();
  };
  $d("#ag-ln-cancel").onclick = close;
  $d("#ag-ln-form").onsubmit = async (e) => {
    e.preventDefault();
    const go = $d("#ag-ln-go");
    go.disabled = true;
    try {
      await api("POST", agentPath(r, "link"), { repo: sel.value || null });
      close();
      await refresh();
      paintLayout();
    } catch (x) {
      err.textContent = x?.message ?? String(x);
      err.hidden = false;
    } finally {
      go.disabled = false;
    }
  };
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  sel.focus();
}

/**
 * D25: the Rename dialog for agent row `r`: its name (empty: back to its
 * id), and the name other sessions will see it by (D24).
 */
function openRename(r, opener) {
  const dlg = $d("#ag-rn");
  if (!dlg || dlg.open) return;
  const input = $d("#ag-rn-name");
  const help = $d("#ag-rn-help");
  const err = $d("#ag-rn-err");
  $d("#ag-rn-h").textContent = t("ag.rn.title", { id: r.agent });
  $d("#ag-rn-t").textContent = t("ag.rn.name");
  $d("#ag-rn-go").textContent = t("ag.rn.go");
  $d("#ag-rn-cancel").textContent = t("ag.rn.cancel");
  input.value = r.displayName || "";
  input.placeholder = r.agent;
  const paintHelp = () => {
    const name = input.value.trim() || r.agent;
    help.textContent = t("ag.rn.help", {
      id: r.agent,
      peer: `${CLI}-${r.workspace}:${name}`,
    });
  };
  paintHelp();
  err.hidden = true;
  input.oninput = paintHelp;
  const close = () => {
    dlg.close?.();
    dlg.removeAttribute("open");
    opener?.focus?.();
  };
  $d("#ag-rn-cancel").onclick = close;
  $d("#ag-rn-form").onsubmit = async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    const go = $d("#ag-rn-go");
    go.disabled = true;
    try {
      await api("POST", agentPath(r, "name"), {
        name: name && name !== r.agent ? name : null,
      });
      close();
      await refresh();
      paintLayout();
    } catch (x) {
      err.textContent = x?.message || String(x);
      err.hidden = false;
    } finally {
      go.disabled = false;
    }
  };
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  input.focus();
  input.select();
}

/**
 * D72: Move to workspace… for agent row `r`. Stopped: its record moves.
 * Running: Den waits for its turn to end (or Move now), then resumes the
 * same conversation there.
 */
function openMove(r, opener) {
  const dlg = $d("#ag-mv");
  if (!dlg || dlg.open) return;
  const sel = $d("#ag-mv-ws");
  const err = $d("#ag-mv-err");
  const go = $d("#ag-mv-go");
  const running = !isStopped(r);
  const others = (st.data?.workspaces ?? []).filter((w) => w !== r.workspace);
  $d("#ag-mv-h").textContent = t("ag.mv.title", { id: displayName(r) });
  $d("#ag-mv-t").textContent = t("ag.mv.to");
  $d("#ag-mv-go").textContent = t("ag.mv.go");
  $d("#ag-mv-cancel").textContent = t("ag.rn.cancel");
  $d("#ag-mv-now-t").textContent = t("ag.mv.now");
  $d("#ag-mv-now-l").hidden = !running;
  $d("#ag-mv-now").checked = false;
  $d("#ag-mv-help").textContent = others.length
    ? t(running ? "ag.mv.helpRunning" : "ag.mv.helpStopped")
    : t("ag.mv.none");
  sel.innerHTML = others
    .map((w) => `<option value="${esc(w)}">${esc(w)}</option>`)
    .join("");
  sel.disabled = !others.length;
  go.disabled = !others.length;
  err.hidden = true;
  const close = () => {
    dlg.close?.();
    dlg.removeAttribute("open");
    opener?.focus?.();
  };
  $d("#ag-mv-cancel").onclick = close;
  $d("#ag-mv-form").onsubmit = async (e) => {
    e.preventDefault();
    const to = sel.value;
    if (!to) return;
    const now = !running || $d("#ag-mv-now").checked;
    go.disabled = true;
    try {
      const out = await api("POST", agentPath(r, "move"), {
        to,
        when: now ? "now" : "after-turn",
      });
      close();
      window.denShell?.toast?.(
        t(out?.pending ? "ag.mv.pending" : "ag.mv.done", {
          id: displayName(r),
          ws: to,
        }),
      );
      await refresh();
      paintLayout();
    } catch (x) {
      err.textContent = x?.message || String(x);
      err.hidden = false;
    } finally {
      go.disabled = false;
    }
  };
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  sel.focus();
}

/** AG-18: Change persona… for agent row `r` (its persona, model, name). */
function openPersonaChange(r) {
  return openStart(false, {
    id: r.agent,
    workspace: r.workspace,
    persona: r.persona,
    runtime: r.runtime,
    model: r.model || "",
    name: paneName(r),
  });
}

async function openStart(bring = false, change = null) {
  const dlg = $d("#ag-dlg");
  if (!dlg || dlg.open) return;
  dialogMode(bring, change);
  const pre = change || bring ? null : startPrefill;
  startPrefill = null;
  const shown = change ? [change.workspace] : viewWorkspaces();
  if (pre?.ws && !shown.includes(pre.ws)) shown.push(pre.ws);
  const wsSel = $d("#ag-ws");
  wsSel.innerHTML = shown
    .map((w) => `<option value="${esc(w)}">${esc(w)}</option>`)
    .join("");
  wsSel.disabled = shown.length <= 1;
  if (pre?.ws) wsSel.value = pre.ws;
  const folder = $d("#ag-folder");
  if (folder) folder.value = pre?.folder ?? "";
  // D65 v2: a service card's Start agent here names its repo.
  sd.repo = pre?.repo ?? null;
  sd.f = { q: "", cat: "", src: "" };
  sd.det = false;
  sd.what = false;
  $d("#ag-err").hidden = true;
  $d("#ag-task").value = "";
  $d("#ag-adv").open = false;
  if (!(await fillForWorkspace(wsSel.value || shown[0]))) return;
  if (dlg.open) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  $d("#ag-q")?.focus();
}

/** What Start sends (agent-routes.ts checks each field again). */
function startBody() {
  const p = curPersona();
  const rt = chosenRuntime();
  const rtv = (sd.data?.runtimes ?? []).find((r) => r.id === rt);
  const runtime = $d("#ag-runtime").value;
  const body = { persona: p.id, ...(runtime ? { runtime } : {}) };
  const def = personaModel();
  if (rtv?.models?.length) {
    if (sd.model) body.model = sd.model;
    if (sd.ver) {
      body.version = sd.ver;
      body.model ??= def.model || undefined;
      if (!body.model) delete body.version;
    }
  }
  if (rtv?.permissions) {
    // A persona's own mode Den doesn't name (Claude Code's plan) stays its
    // own unless a mode is picked.
    if (
      p.permission !== undefined ||
      sd.data?.workspacePermission ||
      sd.intent !== "ask"
    )
      body.permission = sd.intent;
    body.allow = sd.extras;
  }
  const task = $d("#ag-task").value.trim();
  if (task) body.instruction = task;
  const name = $d("#ag-name").value.trim();
  if (name) body.name = name;
  const folder = $d("#ag-folder")?.value.trim();
  if (folder) body.folder = folder;
  // D65 v2: "" none; "auto" Den proposes from the folder; else a repo.
  const repo = $d("#ag-repo")?.value ?? "auto";
  if (repo !== "auto") body.repo = repo || null;
  return body;
}

function showStartError(err) {
  const el = $d("#ag-err");
  // Issue 479: its runtime's copy is quarantined: why, the path and the
  // choices (Use this, Copy path), not only the message.
  const q = err?.data?.quarantined;
  if (q?.path) {
    el.innerHTML = quarantinedHtml(q, t);
    wireStartQuarantine(el);
    el.hidden = false;
    return;
  }
  el.textContent = startFailText(err, t);
  // AG-10.10: that agent is running: offer to open it.
  const running = err?.data?.running;
  if (running?.sessionId) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "den-btn sm";
    b.id = "ag-open-running";
    b.textContent = t("ag.new.openRunning");
    b.addEventListener("click", () => {
      $d("#ag-dlg").close?.();
      void openPane(running.sessionId);
    });
    el.append(" ", b);
  }
  el.hidden = false;
}

/**
 * Issue 479: the quarantine line's buttons in the Start dialog (its
 * readiness line, or the refusal after Start). A pin or Check again asks
 * the runtimes again and repaints; the person presses Start.
 */
function wireStartQuarantine(host) {
  wireQuarantine(host, {
    api,
    t,
    ws: () => $d("#ag-ws")?.value || viewWorkspaces()[0],
    reload: async () => {
      const ws = $d("#ag-ws")?.value || viewWorkspaces()[0];
      personasAsked.delete(ws || "");
      $d("#ag-err").hidden = true;
      await fillForWorkspace(ws);
    },
  });
}

/**
 * AG-10.10b: the id a Name gives, as the server's nameSlug: lowercase,
 * spaces to "-", only id characters, at most 64; null when none is left.
 */
export function nameSlug(name) {
  const s = String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-._]+$/, "");
  return s && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : null;
}

/**
 * The id this start takes (AG-10.10, 10.10b), said as you type: a Name is
 * the id as its slug. A running agent here with that id or title: "is
 * already running · Open it", Start off. A stopped one: "Resume it", or
 * Start takes the next suffix.
 */
function paintStartsAs() {
  const el = $d("#ag-as");
  if (!el) return;
  const p =
    sd.pid && sd.pid !== PLAIN && !sd.bring && !sd.change ? curPersona() : null;
  el.hidden = !p;
  el.textContent = "";
  if (!p) return;
  const name = ($d("#ag-name")?.value ?? "").trim();
  const slug = name ? nameSlug(name) : null;
  const ws = $d("#ag-ws")?.value || viewWorkspaces()[0];
  const here = (st.data?.sessions ?? []).filter(
    (r) => r.kind === "agent" && r.workspace === ws,
  );
  const live = (r) => r.state === "running" || r.state === "stopping";
  const match = name
    ? (here.find(
        (r) =>
          live(r) &&
          (r.agent === slug ||
            (r.displayName ?? "").toLowerCase() === name.toLowerCase()),
      ) ?? here.find((r) => r.agent === slug))
    : null;
  const act = (label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "den-btn sm";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };
  if (match && live(match)) {
    el.append(
      t("ag.new.isRunning", { id: match.agent }) + " · ",
      act(t("ag.new.openIt"), () => {
        $d("#ag-dlg").close?.();
        void openPane(match.id);
      }),
    );
    $d("#ag-go").disabled = true;
    return;
  }
  if (match) {
    el.append(
      t("ag.new.isStopped", { id: match.agent }) + " · ",
      act(t("ag.new.resumeIt"), () => {
        $d("#ag-dlg").close?.();
        void restartRow(match, "resume", null);
      }),
      " " + t("ag.new.orNext", { id: nextFree(slug) }),
    );
    return;
  }
  el.textContent = t("ag.new.as", {
    id: slug ?? sd.data?.startsAs?.[p.id] ?? p.id,
  });
}

/** The first `<slug>-<n>` no agent on this page has (the server decides). */
function nextFree(slug) {
  const ids = new Set((st.data?.sessions ?? []).map((r) => r.agent));
  for (let n = 2; n < 1000; n++)
    if (!ids.has(`${slug.slice(0, 58)}-${n}`))
      return `${slug.slice(0, 58)}-${n}`;
  return slug;
}

async function submitStart(form) {
  const dlg = $d("#ag-dlg");
  const go = $d("#ag-go");
  if (go.disabled) return;
  const ws = form.querySelector("#ag-ws").value || viewWorkspaces()[0];
  if (!ws || !sd.pid) return;
  if (sd.bring) return submitBringIn(ws);
  if (sd.change) return submitPersonaChange();
  const bad = sd.extras.find((c) => commandProblem(c));
  if (sd.pid !== PLAIN && bad)
    return showStartError(new Error(t("pe.badCmd", { c: bad })));
  // Issue 698: busyAction holds Go with the kit's dots.
  go.disabled = true;
  // BUSY-1: the working pop-up while Den starts it; the dialog keeps the
  // error too.
  const plain = sd.pid === PLAIN;
  const name = {
    name: plain ? t("ag.session") : $d("#ag-name").value || sd.pid,
  };
  const wsUrl = `/api/workspaces/${encodeURIComponent(ws)}`;
  const body = plain ? undefined : startBody();
  let opened;
  try {
    const r = await window.denShell.busyAction(
      "start-agent",
      (headers) =>
        api("POST", plain ? `${wsUrl}/sessions` : `${wsUrl}/agents`, body, {
          headers,
        }),
      {
        button: go,
        vars: name,
        success: (o) =>
          plain
            ? t("ag.new.started", { p: t("ag.session"), w: ws })
            : t("ag.started", { id: o?.agent?.id ?? sd.pid }),
        onFail: (err) => showStartError(err),
        onDone: (o) => (opened = startedOk(o)),
      },
    );
    if (r) await opened;
  } finally {
    go.disabled = false;
    go.textContent = goLabel();
    if (dlg.open) paintRuntime(false);
  }

  async function startedOk(r) {
    if (plain) {
      dlg.close?.();
      // Issue 482: a terminal opens on the Terminals page.
      if (PAGE !== "terminal" && r?.session?.id)
        return void location.assign(
          `/terminals?project=${encodeURIComponent(ws)}&open=${encodeURIComponent(r.session.id)}`,
        );
      await refresh();
      if (r?.session?.id) await openPane(r.session.id);
      return;
    }
    // AG-10.10: the next start of this persona takes another id.
    personasAsked.delete(ws);
    $d("#ag-name").value = "";
    for (const w of r?.warnings ?? []) window.denShell?.toast?.(w);
    dlg.close?.();
    await refresh();
    if (r?.agent?.sessionId) await openPane(r.agent.sessionId);
  }
}

/**
 * AG-18: change the agent's persona (the same conversation resumes as the
 * new one). Mid-turn the server asks: After this turn, or Stop it now.
 */
async function submitPersonaChange(when) {
  const dlg = $d("#ag-dlg");
  const go = $d("#ag-go");
  const ch = sd.change;
  const p = curPersona();
  if (!ch || !p) return;
  const body = { persona: p.id };
  if (sd.model) body.model = sd.model;
  if (sd.model && sd.ver) body.version = sd.ver;
  if (when) body.when = when;
  // Issue 698: the kit's dots on Go until the answer; the dialog says
  // what happened.
  const release = window.denShell?.holdDots?.(go) ?? (async () => {});
  go.disabled = true;
  $d("#ag-err").hidden = true;
  try {
    const r = await api(
      "POST",
      `/api/workspaces/${encodeURIComponent(ch.workspace)}/agents/${encodeURIComponent(ch.id)}/persona`,
      body,
    );
    window.denShell?.toast?.(
      t(
        r?.pending ? "ag.pc.pending" : r?.fresh ? "ag.pc.fresh" : "ag.pc.done",
        { id: ch.name, p: personaName(p) },
      ),
    );
    // Never prompted: nothing was resumed. Its pane says so, now if it
    // has already moved to the new session, else when it does.
    if (r?.fresh) {
      const pane = [...st.panes.values()].find(
        (q) => q.agent === ch.id && q.agentWs === ch.workspace,
      );
      if (pane && pane.id === r.agent?.sessionId) freshLine(pane);
      else st.fresh.add(`${ch.workspace}\u0000${ch.id}`);
    }
    for (const w of r?.warnings ?? []) window.denShell?.toast?.(w);
    dlg.close?.();
    await refresh();
  } catch (err) {
    if (err?.code === "busy") showBusy();
    else showStartError(err);
  } finally {
    await release();
    go.textContent = goLabel();
    if (dlg.open) paintRuntime(false);
  }
}

/** It's mid-turn: never cut silently; the person picks (AG-18). */
function showBusy() {
  const el = $d("#ag-err");
  el.textContent = t("ag.pc.busy") + " ";
  const b = (id, label, when) => {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "den-btn sm";
    x.id = id;
    x.textContent = label;
    x.addEventListener("click", () => void submitPersonaChange(when));
    return x;
  };
  el.append(
    b("ag-pc-after", t("ag.pc.after"), "after-turn"),
    " ",
    b("ag-pc-now", t("ag.pc.now"), "now"),
  );
  el.hidden = false;
}

/** Bring in (AG-17.1): the runtime's resume of the conversation picked. */
async function submitBringIn(ws) {
  const dlg = $d("#ag-dlg");
  const go = $d("#ag-go");
  const c = bringPick();
  const p = curPersona();
  if (!c || !p) return;
  // Issue 698: the kit's dots on Go until the answer.
  const release = window.denShell?.holdDots?.(go) ?? (async () => {});
  go.disabled = true;
  try {
    const r = await api(
      "POST",
      `/api/workspaces/${encodeURIComponent(ws)}/conversations/${encodeURIComponent(c.id)}/import`,
      {
        persona: p.id,
        runtime: c.runtime,
        // AG-17.1c: the conversation's own model unless one is picked.
        ...(sd.model ? { model: sd.model } : {}),
        ...(sd.model && sd.ver ? { version: sd.ver } : {}),
        // D56: picked from outside any project: the ask names its folder.
        ...((sd.bring?.away ?? []).includes(c) ? { outside: c.cwd } : {}),
      },
    );
    window.denShell?.toast?.(t("ag.bring.done", { id: r?.agent?.id ?? p.id }));
    for (const w of r?.warnings ?? []) window.denShell?.toast?.(w);
    dlg.close?.();
    await refresh();
    if (r?.agent?.sessionId) await openPane(r.agent.sessionId);
  } catch (err) {
    showStartError(err);
    // Still open elsewhere, or taken since: the list says so now.
    await fillConversations(ws);
  } finally {
    await release();
    go.textContent = t("ag.bring.go");
    if (dlg.open) paintRuntime(false);
  }
}

/** New persona, Edit or Duplicate from the dialog; back to it after. */
async function editFromStart(kind) {
  const p = curPersona();
  let src = null;
  if (kind !== "new" && p) {
    try {
      src = await personaDetail(p.id, sd.data?.workspace);
    } catch (err) {
      return void window.denShell?.errorToast?.(err);
    }
  }
  openPersonaEditor({
    data: sd.data,
    src,
    dup: kind === "dup",
    onSaved: async (saved) => {
      personasAsked.clear();
      if (saved) sd.pid = saved.id;
      await fillForWorkspace($d("#ag-ws").value);
    },
  });
}

/** Wire the dialog once (mountAgentsPage). */
function wireStartDialog(root) {
  const form = root.querySelector("#ag-form");
  form.addEventListener("click", (e) => {
    const cr = e.target.closest("#ag-conv [data-cid], #ag-conv-o [data-cid]");
    if (cr) {
      e.preventDefault();
      pickConversation(cr.dataset.cid);
      return;
    }
    const pr = e.target.closest("#ag-persona [data-pid]");
    if (pr) {
      e.preventDefault();
      pickPersona(pr.dataset.pid);
      pr.focus();
      return;
    }
    const chip = e.target.closest("[data-pf]");
    if (chip) {
      e.preventDefault();
      sd.f[chip.dataset.pf] = chip.dataset.v;
      for (const c of form.querySelectorAll(`[data-pf="${chip.dataset.pf}"]`))
        c.setAttribute("aria-pressed", String(c.dataset.v === chip.dataset.v));
      return paintPlist(false);
    }
    const pm = e.target.closest("[data-pm]");
    if (pm) {
      e.preventDefault();
      if (pm.disabled) return;
      sd.intent = pm.dataset.pm;
      return syncPermBlock(form, "ag", sd.data, {
        intent: sd.intent,
        role: curPersona()?.role,
        extras: sd.extras,
        runtime: chosenRuntime(),
      });
    }
    const x = e.target.closest("[data-x]")?.dataset.x;
    if (!x) return;
    e.preventDefault();
    if (x === "what") {
      sd.what = !sd.what;
      $d("#ag-what").hidden = !sd.what;
      e.target
        .closest("[data-x]")
        .setAttribute("aria-expanded", String(sd.what));
    } else if (x === "det") {
      sd.det = !sd.det;
      paintDetails();
      if (sd.det) void loadDetail();
    } else if (x === "clear") {
      sd.f = { q: "", cat: "", src: "" };
      paintPersonaField();
    } else if (x === "raw") window.denShell?.toast?.(t("pe.rawLater"));
    else if (x === "newp") void editFromStart("new");
    else if (x === "dup") void editFromStart("dup");
    else if (x === "edit") void editFromStart("edit");
  });
  form.addEventListener("input", (e) => {
    if (e.target.id === "ag-q") {
      sd.f.q = e.target.value;
      paintPlist(false);
    } else if (e.target.id === "ag-name") {
      // AG-10.10b: what the Name gives, as you type.
      paintRuntime(false);
    } else if (e.target.id === "ag-tools") {
      sd.extras = splitCommands(e.target.value);
      syncPermBlock(form, "ag", sd.data, {
        intent: sd.intent,
        role: curPersona()?.role,
        extras: sd.extras,
        runtime: chosenRuntime(),
      });
    }
  });
  form.addEventListener(
    "toggle",
    (e) => {
      if (e.target.id === "ag-xtra") sd.extrasOpen = e.target.open;
    },
    true,
  );
  form.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "ag-ws") void fillForWorkspace(e.target.value);
    else if (id === "ag-runtime") {
      sd.model = "";
      sd.ver = "";
      $d("#ag-r-fb").hidden = true;
      paintRuntime(false);
      paintAdvanced();
    } else if (id === "ag-model") {
      sd.model = e.target.value;
      sd.ver = "";
      paintAdvanced();
      paintRuntime(false);
    } else if (id === "ag-ver") sd.ver = e.target.value;
  });
  // ↑ ↓ move through the persona list (a radio group).
  root.querySelector("#ag-persona").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll("[data-pid]")];
    const i = rows.indexOf(document.activeElement);
    const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    pickPersona(next.dataset.pid);
    next.focus();
  });
}

/**
 * Once per document: a font that loads later (the theme's --mono as a web
 * font) and a theme applied without a reload (its sheet, then
 * den:appearance) measure the cells again; the page shown again makes
 * each pane say its size (another viewer may have taken the PTY while it
 * was hidden).
 */
function wireDocument() {
  st.docWired = true;
  document.fonts?.addEventListener?.("loadingdone", remeasureAll);
  // D64: Den restarted in place (restart-den.js): lost panes reconnect,
  // no reload, so what was typed stays.
  window.addEventListener("den:server-back", () => {
    for (const p of st.panes.values())
      if (p.lost && p.conn) p.conn.retry();
      else if (!p.sock) p.conn ? p.conn.nudge() : void connect(p);
    void refresh();
  });
  window.addEventListener("den:appearance", () => {
    for (const p of st.panes.values())
      if (p.term) p.term.options.theme = termTheme();
    remeasureAll();
  });
  document.addEventListener(
    "load",
    (e) => {
      if (e.target?.id === "theme-css") {
        for (const p of st.panes.values())
          if (p.term) p.term.options.theme = termTheme();
        remeasureAll();
      }
    },
    true,
  );
  // Shown again: a pane that leads says its size again (an older host
  // sends no size frames); one another view sizes keeps following (D54).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    for (const p of st.panes.values()) if (!p.following) claimSize(p);
  });
}

// ── mount ───────────────────────────────────────────────────────────────

function translateStatic(root) {
  const set = (sel, key) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = t(key);
  };
  // Issue 482: the Terminals page: its title, New terminal, and none of
  // the agents' own buttons.
  const term = PAGE === "terminal";
  set("#ag-h", term ? "n.terminal" : "n.agents");
  set("#ag-start", term ? "ag.newShell" : "ag.start");
  if (term)
    for (const id of ["#ag-bring", "#ag-clear"]) {
      const b = root.querySelector(id);
      if (b) b.hidden = true;
    }
  if (!term) set("#ag-bring", "ag.bring");
  set("#ag-conv-t", "ag.bring.conv");
  set("#ag-conv-ot", "ag.bring.outside");
  set("#ag-clear", "ag.clear");
  set("#ag-dlg-h", "ag.new.title");
  set("#ag-ws-t", "ag.ws");
  set("#ag-p-t", "ag.persona");
  set("#ag-r-t", "ag.runtime");
  set("#ag-what-b", "ag.new.what");
  set("#ag-newp", "ag.new.newP");
  set("#ag-what-p", "pe.what");
  set("#ag-task-t", "ag.new.task");
  set("#ag-name-t", "ag.new.name");
  set("#ag-folder-t", "ag.new.folder");
  set("#ag-folder-h", "ag.new.folderHelp");
  set("#ag-repo-t", "ag.repo");
  set("#ag-repo-h", "ag.repo.help");
  set("#ag-adv-s", "ag.new.adv");
  set("#ag-note", "ag.new.note");
  const task = root.querySelector("#ag-task");
  if (task) task.placeholder = t("ag.new.taskPh");
  root
    .querySelector("#ag-persona")
    ?.setAttribute("aria-label", t("ag.persona"));
  set("#ag-cancel", "ag.cancel");
  set("#ag-go", "ag.go");
  for (const b of root.querySelectorAll("[data-layouts] button")) {
    b.textContent = t(`ag.l.${b.dataset.layout}`);
    b.title = t("ag.l.tip", {
      name: b.textContent,
      key: `⌃⇧${LAYOUTS.indexOf(b.dataset.layout) + 1}`,
    });
  }
  root
    .querySelector("[data-layouts]")
    ?.setAttribute("aria-label", t("ag.layout"));
}

/**
 * Issue 252: a running agent's Mode, in its ⋯: the four modes and Follow
 * project, the one in effect checked. None for a runtime without modes.
 */
function modeItems(r, opener) {
  if (r?.kind !== "agent" || !r.mode) return [];
  return [
    {
      label: t("ag.mode.item", { m: t(`pm.name.${r.mode}`) }),
      onSelect: () =>
        openAgentModeMenu(
          opener,
          {
            workspace: r.workspace,
            agent: r.agent,
            ...(r.displayName ? { name: r.displayName } : {}),
            ...(r.modeOwn ? { own: r.mode } : {}),
            project: r.modeOwn ? r.modeFollowed : r.mode,
          },
          () => void refresh(),
        ),
    },
  ];
}

/** D37: a stopped agent's ⋯: Start fresh (when Resume is its button), Remove. */
function stoppedMenuItems(r, opener) {
  return [
    ...(r.resumable
      ? [
          {
            label: t("ag.fresh"),
            onSelect: () => void restartRow(r, "fresh", opener),
          },
        ]
      : []),
    // Issue 658: a handoff on file while no rotation is ready.
    ...(r.handoffOnFile
      ? [
          {
            label: t("ag.relaunchHandoff"),
            onSelect: () =>
              void restartRow(r, "relaunch", opener, { fromHandoff: true }),
          },
        ]
      : []),
    restartResumeItem(r),
    { label: t("ag.mv.item"), onSelect: () => openMove(r, opener) },
    ...orderItems(r, !!opener?.closest?.("#agl")),
    { label: t("ag.remove"), onSelect: () => void removeRow(r, opener) },
  ];
}

// ── D45: a stopped agent's details ─────────────────────────────────────────

/** Under this width the details are a bottom sheet (as the service panel). */
const DET_SHEET = "(max-width: 639px)";
/** The open details: the row, its opener, the pop-over and its scrim. */
const agd = {
  r: null,
  opener: null,
  el: null,
  scrim: null,
  det: null,
  release: null,
};

function detailsHtml(r, det) {
  const name = displayName(r);
  const rot = rotationOf(r);
  const runtime = [r.runtime, r.model].filter(Boolean).join(" · ");
  const ended = stopReason(r);
  const sec = (k, body) =>
    `<div class="den-svp-sec"><div class="den-svp-k">${esc(t(k))}</div>${body}</div>`;
  const ask =
    det === null
      ? `<div class="den-svp-help">${esc(t("ag.det.reading"))}</div>`
      : det?.lastPrompt?.text
        ? `<div class="den-agd-v">${esc(det.lastPrompt.text)}</div>` +
          (det.lastPrompt.at
            ? `<div class="den-svp-ms">${timeHtml(det.lastPrompt.at, { style: isToday(det.lastPrompt.at) ? "time" : "datetime" })}</div>`
            : "")
        : `<div class="den-svp-help">${esc(t("ag.det.noAsk"))}</div>`;
  const comp = r.rotation?.compactions
    ? `<div class="den-svp-line">${esc(t("ag.det.compactions", { n: r.rotation.compactions }))}</div>`
    : "";
  const due = rot
    ? `<div class="den-svp-line"><span class="tagx warn">${esc(t("ag.det.handoffDue", { why: rotationWhy(r.rotation) }))}</span></div>`
    : "";
  const first = r.resumable
    ? `<button type="button" class="den-btn primary" data-agd="resume">${esc(t("ag.resume"))}</button>` +
      `<button type="button" class="den-btn" data-agd="fresh">${esc(t("ag.fresh"))}</button>`
    : `<button type="button" class="den-btn primary" data-agd="fresh">${esc(t("ag.fresh"))}</button>`;
  return (
    `<div class="den-svp-h"><div class="den-svp-t"><span class="den-dot ${stateTone(r)} hollow" aria-hidden="true"></span>` +
    `<b title="${esc(name)}">${esc(name)}</b>` +
    `<button type="button" class="den-ib den-svp-x" data-agd="close" aria-label="${esc(t("ag.det.close"))}" title="${esc(t("ag.det.close"))}">✕</button></div>` +
    `<div class="den-svp-meta">${r.persona ? `<span>${esc(r.persona)}</span>` : ""}` +
    (runtime ? `<span class="den-svp-ms">${esc(runtime)}</span>` : "") +
    `</div></div>` +
    `<div class="den-svp-acts">${first}<button type="button" class="den-btn" data-agd="remove">${esc(t("ag.remove"))}</button>` +
    // Its session ended but is still there: its output, in its pane.
    (r.attachable
      ? `<button type="button" class="den-btn" data-agd="open">${esc(t("ag.det.output"))}</button>`
      : "") +
    `</div>` +
    sec(
      "ag.det.ended",
      `<div class="den-svp-line"><span class="stchip">${esc(stoppedChip(r))}</span> <span>${esc(ended)}</span></div>` +
        (det?.lastLine
          ? `<div class="den-svp-k">${esc(t("ag.det.lastLine"))}</div><div class="den-svp-url">${esc(det.lastLine)}</div>`
          : "") +
        comp +
        due,
    ) +
    sec("ag.det.lastAsk", ask) +
    sec(
      "ag.det.where",
      `<div><span class="den-wsp">${esc(r.workspace ?? "")}</span></div>` +
        (r.cwd ? `<div class="den-svp-url">${esc(r.cwd)}</div>` : ""),
    ) +
    reportFoot()
  );
}

/**
 * den#143: its Report button drawn with it (every pop-up has one, den#81),
 * so it is there when they are shown and stays through a repaint. Left to
 * the page's injector, it came a frame after and the details grew.
 */
const reportFoot = () => window.denShell?.reportFoot?.() ?? "";

function placeDetails() {
  if (!agd.el) return;
  const sheet = !!window.matchMedia?.(DET_SHEET).matches;
  agd.el.classList.toggle("den-sheet", sheet);
  if (sheet && !agd.scrim) {
    agd.scrim = document.createElement("div");
    agd.scrim.className = "den-scrim den-svp-scrim";
    agd.scrim.addEventListener("click", () => closeDetails(true));
    document.body.append(agd.scrim);
  } else if (!sheet && agd.scrim) {
    agd.scrim.remove();
    agd.scrim = null;
  }
  const top = window.denShell?.topLayer;
  if (!top) return;
  if (sheet) top.show(agd.el, document.body, { sheet: true });
  else
    top.show(agd.el, agd.opener?.isConnected ? agd.opener : document.body, {
      gap: 6,
    });
}

/**
 * Paint the details. `inPlace` (den#143: details that came after it was
 * shown): it keeps its top edge and place and is not placed again; what
 * it gains scrolls inside it, down to the window's bottom when it sits
 * below its row, at its own height when it sits above it or is a sheet.
 */
function paintAgentDetails(inPlace = false) {
  if (!agd.el || !agd.r) return;
  const a = document.activeElement;
  const key = a && agd.el.contains(a) ? a.dataset?.agd : null;
  const was = inPlace ? agd.el.getBoundingClientRect() : null;
  const sc = agd.el.scrollTop;
  agd.el.innerHTML = detailsHtml(agd.r, agd.det);
  if (!was) placeDetails();
  else {
    const op = agd.opener?.isConnected
      ? agd.opener.getBoundingClientRect()
      : null;
    const below =
      !agd.el.classList.contains("den-sheet") && !!op && was.top >= op.top;
    const room = below ? window.innerHeight - was.top - 8 : was.height;
    agd.el.style.maxHeight = `${Math.max(80, Math.floor(room))}px`;
    agd.el.scrollTop = sc;
  }
  if (key) agd.el.querySelector(`[data-agd="${key}"]`)?.focus();
}

/** The row's button again, once the list was drawn again. */
function detailsOpener() {
  const id = agd.r?.id;
  if (agd.opener?.isConnected) return agd.opener;
  return id
    ? st.root?.querySelector(`#agl .agr[data-id="${CSS.escape(id)}"]`)
    : null;
}

function closeDetails(refocus) {
  if (!agd.el) return;
  const back = detailsOpener();
  window.denShell?.topLayer?.hide(agd.el);
  agd.el.remove();
  agd.scrim?.remove();
  // D50: its outside press and Esc (popover.js).
  agd.release?.();
  document.removeEventListener("click", detailsAct, true);
  window.removeEventListener("resize", placeDetails);
  agd.el = agd.scrim = agd.r = agd.det = agd.release = null;
  agd.opener = null;
  back?.setAttribute("aria-expanded", "false");
  if (refocus) back?.focus();
}

/** Its buttons. Closing on a press outside or Esc is popover.js's (D50). */
function detailsAct(e) {
  if (!agd.el) return;
  const tgt = e.target;
  if (!agd.el.contains(tgt)) return;
  const b = tgt.closest?.("[data-agd]");
  if (!b || b.disabled) return;
  const r = agd.r;
  const which = b.dataset.agd;
  if (which === "close") return closeDetails(true);
  // The row's own actions: the same calls as its Resume and ⋯.
  const opener = detailsOpener();
  closeDetails(false);
  if (which === "open") void pick(r.id, false);
  else if (which === "resume" || which === "fresh")
    void restartRow(r, which, opener ?? b);
  else if (which === "remove") void removeRow(r, opener ?? b);
}

/**
 * D45: a stopped agent's details beside its row (a bottom sheet on a
 * phone), the service panel's pop-over: who it is, how it ended (its last
 * line when it exited), what it was last asked, compactions or a due
 * handoff, where it ran; Resume (primary), Start fresh and Remove. Esc or a
 * press outside closes it and focus goes back to the row (popover.js,
 * D50). Its row again: closes it.
 */
async function openDetails(r, opener) {
  if (agd.r?.id === r.id) return closeDetails(true);
  closeDetails(false);
  const el = document.createElement("div");
  el.className = "den-pop den-svp den-agd";
  el.tabIndex = -1;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("ag.det.label", { id: displayName(r) }));
  // den#143: out of sight until its details are in (or OPEN_MS has passed
  // without them, the working pop-up's own wait), then painted, placed
  // and focused once, so it never grows or moves under a press.
  // data-state says which: "loading", then "ready".
  el.dataset.state = "loading";
  el.style.visibility = "hidden";
  document.body.append(el);
  Object.assign(agd, { r, opener, el, det: null });
  opener.setAttribute("aria-expanded", "true");
  const reveal = () => {
    if (agd.r !== r || el.dataset.state === "ready") return;
    paintAgentDetails();
    el.style.visibility = "";
    el.dataset.state = "ready";
    (el.querySelector(".den-svp-acts .den-btn") || el).focus();
  };
  const late = setTimeout(reveal, OPEN_MS);
  document.addEventListener("click", detailsAct, true);
  agd.release = dismissable(el, {
    opener: detailsOpener,
    close: (refocus) => closeDetails(refocus),
  });
  window.addEventListener("resize", placeDetails);
  let det = { lastPrompt: null };
  try {
    const res = await fetch(
      `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/details`,
      { headers: { accept: "application/json" } },
    );
    if (res.ok) det = await res.json();
  } catch {
    /* no details: the row's own facts */
  }
  clearTimeout(late);
  if (agd.r !== r) return;
  agd.det = det;
  // Shown already (a slow answer): its details fill in where it is.
  if (el.dataset.state === "ready") paintAgentDetails(true);
  else reveal();
}

function openStoppedMenu(r, opener) {
  window.denShell?.openMenu?.(opener, {
    label: t("ag.more", { id: r.agent }),
    items: stoppedMenuItems(r, opener),
  });
}

/** Fill the page drawn by agents.html and wire it. */
export async function mountAgentsPage(root) {
  if (!root) return;
  st.root = root;
  // The double-click fix: a redraw keeps a busy agent's buttons held.
  if (typeof MutationObserver === "function")
    new MutationObserver(() => {
      if (busyActs.size || root.querySelector("[data-busy-was]")) paintBusy();
    }).observe(root, { childList: true, subtree: true });
  translateStatic(root);
  if (window.denShell?.apiOff?.()) return;
  // Issue 103: a deep link is read as ?agent=&ws= (D43); its context goes
  // to the agent's composer, once (the address drops it).
  const deep = deepLinkOf(location.pathname, location.search);
  if (deep) {
    history.replaceState(history.state, "", deep.href);
    st.deep = deep;
  }
  st.open = [];
  // D73: a Terminal link (the rail's, a project's Terminal here) adds a
  // tab: the panes this browser had open come along, and the page shows
  // every project (?ws= names only where the shell starts), so tabs from
  // other projects stay.
  const q0 = new URLSearchParams(location.search);
  const termWs =
    q0.get("terminal") === "1" ? q0.get("project") || q0.get("ws") || "" : null;
  // Issue 482: New terminal on a project's page: a new one, never a reuse.
  const freshAsked = q0.get("fresh") === "1";
  // #80: read before the panes open (each writes the address).
  const frontAsked = q0.get("front");
  const wanted =
    termWs !== null && !q0.get("open")
      ? rememberedOpen()
      : openFromUrl(location.search);
  if (termWs !== null && termWs) {
    const u = new URL(location.href);
    u.searchParams.delete("ws");
    u.searchParams.delete("project");
    history.replaceState(history.state, "", u.pathname + u.search);
  }
  const linked = layoutFromUrl(location.search);
  const startAsked = new URLSearchParams(location.search).get("start") === "1";
  if (startAsked) {
    const q = new URLSearchParams(location.search);
    startPrefill = {
      ws: q.get("project") || q.get("ws") || "",
      folder: q.get("folder") || "",
      repo: q.get("repo") || null,
    };
  }

  // D32: helper rows open their transcript; "All helpers" the full list.
  // #80: the helpers badges follow their rows when the list's width
  // changes (a resize, the rail, a font that arrives late).
  {
    const agl = root.querySelector("#agl");
    if (typeof ResizeObserver === "function")
      new ResizeObserver(() => placeHelperToggles(agl)).observe(agl);
    document.fonts?.ready?.then(() => placeHelperToggles(agl));
  }
  wireHelperRows(
    root.querySelector("#agl"),
    (agent, ws) => {
      const r = visibleRows().find(
        (x) => x.agent === agent && x.workspace === ws,
      );
      return r ? displayName(r) : agent;
    },
    // D34: after Clear done (the Helpers list), the list again.
    () => refresh(),
  );
  wireOrder(root.querySelector("#agl"));
  root.querySelector("#agl").addEventListener("click", (e) => {
    // D37: a person's open or closed "Stopped (n)" is kept.
    const sum = e.target.closest("details[data-stopped] > summary");
    if (sum) {
      saveStoppedOpen(!sum.parentElement.open);
      return;
    }
    const act = e.target.closest("button[data-act]");
    if (act) {
      const which = act.dataset.act;
      if (which === "resume-all") return void resumeAll(act);
      if (which === "review") return review();
      if (which === "switch-ws") return void switchWorkspace(act);
      if (which === "show-all") return void showAllActive();
      if (which === "switch-back") return void switchBack();
      // #80: the helpers badge opens or closes them under its agent.
      if (which === "helpers-toggle") {
        const k = `${act.dataset.ws}\0${act.dataset.agent}`;
        if (st.helpersOpen.has(k)) st.helpersOpen.delete(k);
        else st.helpersOpen.add(k);
        paintList();
        return;
      }
      // Issue 96: a phone's Reorder, and its Up and Down per row.
      if (which === "reorder") {
        if (act.hasAttribute("data-stopped"))
          st.reorderStopped = !st.reorderStopped;
        else
          st.reorderWs =
            st.reorderWs === act.dataset.ws ? null : act.dataset.ws;
        paintList();
        return;
      }
      if (which === "ord-up" || which === "ord-down") {
        const w = act.closest(".agord");
        const r = visibleRows().find(
          (x) => x.agent === w?.dataset.agent && x.workspace === w?.dataset.ws,
        );
        if (r && act.getAttribute("aria-disabled") !== "true")
          void moveDir(r, which === "ord-up" ? "up" : "down", false);
        return;
      }
      // Issue 482: Restart an exited terminal; the Agents page's note.
      if (which === "restart-shell")
        return void restartShell(
          rowOf(act.closest(".agst")?.dataset.shell),
          act,
        );
      if (which === "open-terminals") {
        markMovedSeen();
        return void location.assign(terminalsHref());
      }
      if (which === "dismiss-moved") {
        markMovedSeen();
        return void paintList();
      }
      if (which === "remove-shell")
        return void removeShell(
          rowOf(act.closest(".agst")?.dataset.shell),
          act,
        );
      const agent = act.closest(".agst")?.dataset.agent;
      const ws = act.closest(".agst")?.dataset.ws;
      const r = visibleRows().find(
        (x) => x.agent === agent && x.workspace === ws,
      );
      if (!r) return;
      if (which === "relaunch") void relaunchNow(r, act);
      else if (which === "rot-write") void writeHandoff(r, act);
      else if (which === "rot-keep") void keepConversation(r, act);
      else if (which === "mode-apply") void applyMode(r, act);
      // Issue 278: the row's Stop is its pane's Stop; Clear ends the hold.
      else if (which === "stop")
        void oneAtATime(r, "stop", () => stopAgentNow(r, act));
      else if (which === "ctx-clear") void clearCompacting(r, act);
      else if (which === "resume" || which === "fresh")
        void restartRow(r, which, act);
      else if (which === "remove") void removeRow(r, act);
      else if (which === "rename") openRename(r, act);
      else if (which === "row-more") openStoppedMenu(r, act);
      return;
    }
    const b = e.target.closest(".agr");
    if (!b) return;
    if (b.hasAttribute("data-details")) {
      const r = visibleRows().find((x) => x.id === b.dataset.id);
      if (r) void openDetails(r, b);
      return;
    }
    if (b.getAttribute("aria-disabled") === "true") return;
    void pick(b.dataset.id, e.shiftKey || e.metaKey || e.ctrlKey);
  });
  root.querySelector("[data-layouts]")?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-layout]");
    if (b) setLayout(b.dataset.layout);
  });
  root.querySelector("#agr").addEventListener("dblclick", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) renameTab(tab);
  });
  // Issue 297: Delete on a tab closes it, as × does; the tab in front
  // then has the keyboard.
  root.querySelector("#agr").addEventListener("keydown", (e) => {
    if (e.key !== "Delete") return;
    const tab = e.target.closest?.('.agtabs [role="tab"]');
    if (!tab) return;
    e.preventDefault();
    closePane(tab.dataset.id);
    root
      .querySelector('#agr .agtabs [role="tab"][aria-selected="true"]')
      ?.focus();
  });
  // AG-DROP: a file dropped beside a pane never replaces the page.
  guardPageDrops(document, () => window.denShell?.toast?.(t("ag.up.miss")));
  root.querySelector("#agr").addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) {
      // D58: a pointer's pick puts the keyboard in its terminal; Enter or
      // Space on the tab (a click with no pointer) keeps it on the tab.
      const pointer = e.detail > 0;
      if (st.cur !== tab.dataset.id) {
        st.cur = tab.dataset.id;
        paintLayout();
        paintList();
        writeUrl();
      }
      if (pointer && !isStopped(rowOf(tab.dataset.id) ?? {}))
        focusTerm(tab.dataset.id, false);
      else tab.focus();
      return;
    }
    // D58: a click on a pane's bar, off its controls, is a pick of it too.
    const bar = e.target.closest(".pane .bar2");
    if (
      bar &&
      e.detail > 0 &&
      !e.target.closest("button, a, input, select, textarea, [contenteditable]")
    ) {
      const id = bar.closest(".pane")?.dataset.id;
      if (id && !isStopped(rowOf(id) ?? {})) focusTerm(id, false);
      return;
    }
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.closest(".pane")?.dataset.id ?? b.dataset.id;
    const p = id && st.panes.get(id);
    if (!p) return;
    if (b.dataset.act === "where") {
      // D20: why it stops at logout (or what it lacks), for touch too.
      window.denShell?.toast?.(b.title);
      return;
    }
    if (b.dataset.act === "close") closePane(id);
    else if (b.dataset.act === "relaunch" || b.dataset.act.startsWith("rot-")) {
      // D28: the callout's buttons in the pane bar.
      const r = rowOf(id);
      if (!r) return;
      if (b.dataset.act === "relaunch") void relaunchNow(r, b);
      else if (b.dataset.act === "rot-write") void writeHandoff(r, b);
      else if (b.dataset.act === "rot-keep") void keepConversation(r, b);
    } else if (b.dataset.act === "ctx-clear") {
      // Issue 278: the bar's Clear, as under the row.
      const r = rowOf(id);
      if (r) void clearCompacting(r, b);
    } else if (b.dataset.act === "link") {
      const r = rowOf(id);
      if (r) void openLink(r, b);
    } else if (b.dataset.act === "stop") void stopAgent(p, b);
    else if (b.dataset.act === "close-shell") void closeShell(p, b);
    else if (b.dataset.act === "new-shell") {
      const r = rowOf(id);
      if (r?.kind === "session") void newShell(r, b);
    } else if (b.dataset.act === "tools-restart") {
      const r = rowOf(id);
      if (r) void restartForTools(r, b);
    } else if (b.dataset.act === "mode-apply") {
      const r = rowOf(id);
      if (r) void applyMode(r, b);
    } else if (b.dataset.act === "resume") {
      const r = rowOf(id);
      if (r) void restartRow(r, "resume", b);
    } else if (b.dataset.act === "reconnect")
      p.conn ? p.conn.retry() : void connect(p);
    else if (b.dataset.act === "attach")
      pickFiles((files) => void attachFiles(p.el, files, dropOpts(p)));
    else if (b.dataset.act === "helpers") {
      const r = rowOf(id);
      if (r?.kind === "agent")
        void openHelpers({
          ws: r.workspace,
          agent: r.agent,
          name: paneName(r),
          opener: b,
        });
    } else if (b.dataset.act === "more") {
      const r = rowOf(id);
      if (!r) return;
      window.denShell?.openMenu?.(b, {
        label: t("ag.more", { id: r.agent }),
        items: [
          // D25: a visible Rename, for touch and keyboard (not only a
          // double-click on a tab). D37: a running agent's only.
          ...(isStopped(r)
            ? stoppedMenuItems(r, b)
            : [
                { label: t("ag.rn.item"), onSelect: () => openRename(r, b) },
                ...modeItems(r, b),
                restartResumeItem(r),
                { label: t("ag.mv.item"), onSelect: () => openMove(r, b) },
                ...orderItems(r, false),
              ]),
          // D28: its rotation settings and where each comes from.
          {
            label: t("ag.rc.menu"),
            onSelect: () =>
              window.denShell?.toast?.(
                rotFromText(r.rotation) || t("ag.rc.noState"),
              ),
          },
          ...(r.personaChange
            ? [
                {
                  label: t("ag.pc.item"),
                  onSelect: () => void openPersonaChange(r),
                },
              ]
            : []),
        ],
      });
    }
  });
  root.querySelector("#ag-start").addEventListener("click", (e) => {
    // Issue 482: on the Terminals page it is New terminal.
    if (PAGE === "terminal") return void newTerminal(e.currentTarget);
    void openStart();
  });
  root.querySelector("#ag-bring")?.addEventListener("click", () => {
    void openStart(true);
  });
  root.querySelector("#ag-clear")?.addEventListener("click", (e) => {
    void clearStopped(e.currentTarget);
  });
  wireStartDialog(root);
  root.querySelector("#ag-cancel").addEventListener("click", () => {
    root.querySelector("#ag-dlg").close?.();
  });
  root.querySelector("#ag-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void submitStart(e.currentTarget);
  });
  // Enter starts from any field (a select doesn't submit on its own); Esc
  // cancels (the dialog's own cancel). A button keeps its own Enter.
  root.querySelector("#ag-form").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.target.closest("button, textarea, summary")) return;
    e.preventDefault();
    if (!st.root.querySelector("#ag-go").disabled)
      e.currentTarget.requestSubmit();
  });
  // The terminals follow the mode (light, dark) and the theme.
  new MutationObserver(() => {
    for (const p of st.panes.values())
      if (p.term) p.term.options.theme = termTheme();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-mode", "data-theme", "class"],
  });
  if (!st.docWired) wireDocument();
  // ⌃⇧1 / ⌃⇧2 / ⌃⇧3 on every OS: the layouts, even from a terminal (whose
  // key handler never passes them to the agent). ⌘1-9 and Ctrl+1-9 are
  // the browser's (its tabs): the page leaves them alone.
  document.addEventListener(
    "keydown",
    (e) => {
      const i = layoutKeyIndex(e);
      if (i < 0 || st.root.querySelector("#ag-dlg")?.open) return;
      e.preventDefault();
      e.stopPropagation();
      setLayout(LAYOUTS[i]);
    },
    true,
  );
  // ⌘K: "Layout: Focus", "Layout: Tabs", "Layout: Tile".
  for (const l of LAYOUTS)
    window.denShell?.registerCommand?.({
      id: `agents-layout:${l}`,
      label: () => t("ag.pal.layout", { name: t(`ag.l.${l}`) }),
      keywords: ["layout", "agents", l, t(`ag.l.${l}`)],
      run: () => setLayout(l),
    });
  // The phone width comes and goes: Tabs there, the person's layout here.
  window.matchMedia?.(PHONE).addEventListener?.("change", () => {
    paintLayout();
    paintList();
  });

  // NT-2: while this tab is visible and focused, the agents in its panes
  // don't notify (the bell); Den forgets it 10 s after the last word.
  const looking = () => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    const agents = visibleIds()
      .map((id) => rowOf(id))
      .filter((r) => r?.kind === "agent")
      .map((r) => r.agent);
    if (agents.length)
      void api("POST", "/api/notifications/looking", { agents }).catch(
        () => {},
      );
  };
  setInterval(looking, 4000);
  window.addEventListener("focus", looking);
  document.addEventListener("visibilitychange", looking);

  // Issue 144: the machine's gate slot (heavy test runs take turns).
  const gateBtn = st.root.querySelector("#ag-gate");
  if (gateBtn && !st.gate)
    st.gate = startGateChip({
      button: gateBtn,
      t,
      api,
      busyAction: (...a) => window.denShell.busyAction(...a),
      confirm: askConfirm,
      onChange: () => paintList(),
    });
  const [, saved] = await Promise.all([loadScope(), savedLayout()]);
  // A link's &layout= wins for this page; else the person's.
  st.layout = linked ?? saved;
  await refresh();
  paintLayout();
  // An id the list no longer has (removed, another distribution's) is
  // dropped from the URL rather than opened onto a refusal.
  // Issue 482: a link that opens only the other page's kind (an older
  // /agents?open=<a shell>) goes to that page, with its tabs.
  if (st.data && q0.get("open")) {
    const known = wanted.filter((id) => rowOf(id));
    const away = known.filter((id) => !belongsOn(PAGE, rowOf(id)));
    if (away.length && away.length === known.length) {
      const to = PAGE === "terminal" ? "/agents" : "/terminals";
      // The same query (its project, layout and tabs).
      location.replace(`${to}${location.search}`);
      return;
    }
  }
  if (!st.signedOut && st.data?.io?.allowed !== false)
    for (const id of wanted) {
      // Issue 482: the other page's kind is on that page.
      if (st.data && rowOf(id) && !belongsOn(PAGE, rowOf(id))) continue;
      // #80: another project's session stays out of this view's tabs.
      if (st.data && rowOf(id) && !inView(rowOf(id))) {
        if (!st.hiddenOpen.includes(id)) st.hiddenOpen.push(id);
        continue;
      }
      if (!st.data || rowOf(id)) await openPane(id);
    }
  // #80: ?front= (the tab that was in front) comes in front again.
  if (frontAsked && st.open.includes(frontAsked) && st.cur !== frontAsked) {
    st.cur = frontAsked;
    paintLayout();
  }
  if (st.hiddenOpen.length) {
    // #80: the tabs were another project's: this project's agent instead.
    if (!linkedAgentAsked()) await paneFollowsProject();
    paintList();
  }
  // D58: a link to an agent (⌘K, another page's Open) puts the keyboard in
  // its terminal. Never its size: that is the person's typing (D54).
  const front = st.cur && st.open.includes(st.cur) ? st.cur : st.open.at(-1);
  if (wanted.length && front && !isStopped(rowOf(front) ?? {}))
    focusTerm(front, false, { ifIdle: true });
  const linkedAgent = new URLSearchParams(location.search).get("agent");
  writeUrl();
  if (linkedAgent) await openLinkedAgent(linkedAgent, urlWorkspace());
  if (termWs !== null) await openTerminal(termWs, { fresh: freshAsked });
  if (startAsked) void openStart();
}

/**
 * D73: /agents?terminal=1 (the rail's Terminal, a project's Terminal
 * here): a plain shell in the project's folder (?ws=, else the one in
 * view), in a pane like an agent's. The pane is in ?open=, so a reload
 * keeps it, and the shell outlives a Den restart (the sessions host).
 * Used once: the URL drops ?terminal=.
 *
 * Issue 448: a shell already running in that project opens again (the
 * one used last) and takes the keyboard; a new one starts only when none
 * runs, or with `fresh` (the shell bar's New terminal).
 */
async function openTerminal(asked = "", { fresh = false } = {}) {
  // Issue 448: decide on the server's list as it is now (a shell may have
  // ended since this page's last list), and on when each was last typed in.
  if (!fresh) await refresh().catch(() => {});
  const all = st.data?.workspaces ?? [];
  const used = shellUsed();
  // Issue 448: no project named or in view (every project shows): the
  // shell used last, in any of them, before the first project.
  const ws =
    asked ||
    urlWorkspace() ||
    (st.scope && st.scope !== "all" && all.includes(st.scope)
      ? st.scope
      : (fresh ? null : latestShell(visibleRows(), null, used)?.workspace) ||
        // Issue 482: none running: the project a terminal was used in last.
        lastUsedProject(st.data?.sessions ?? [], used, all));
  if (!ws) {
    window.denShell?.toast?.(t("ag.term.failed", { e: t("ag.term.noWs") }));
    return;
  }
  const running = fresh ? null : latestShell(st.data?.sessions ?? [], ws, used);
  if (running) {
    await switchToProjectOf(running);
    await bringShell(running.id);
    return;
  }
  try {
    const r = await api(
      "POST",
      `/api/workspaces/${encodeURIComponent(ws)}/sessions`,
    );
    window.denShell?.toast?.(t("ag.term.started", { w: ws }));
    await refresh();
    // #80: a shell in another project: this page switches to it first.
    if (r?.session?.id) await switchToProjectOf(rowOf(r.session.id));
    if (r?.session?.id) await bringShell(r.session.id);
  } catch (err) {
    // Issue 503: never silent; no PTY has its own words.
    window.denShell?.toast?.(terminalFailText(err, t));
  }
}

/**
 * Issue 448: shell `id`'s pane in front (opened as a tab when it is not
 * open), with the keyboard once its terminal can take keys.
 */
async function bringShell(id) {
  if (st.panes.has(id)) {
    st.cur = id;
    paintLayout();
    paintList();
    writeUrl();
  } else await openPane(id);
  focusTerm(id);
}

/**
 * D43: /agents?agent=<id>&ws=<ws>, a stable link to one agent (another
 * tool links an agent's name here). A running agent's pane opens and takes
 * the keyboard, as a pick does; a stopped one's details open by its row.
 * The link is used once: the URL keeps ?open= and ?ws=, not ?agent=.
 */
async function openLinkedAgent(agent, ws) {
  // #80: in this view, else in any project (and then switch to it).
  // Issue 103: a deep link names the project too: only that one's agent
  // (an id may repeat across projects).
  const deep = st.deep;
  st.deep = null;
  const all = st.data?.sessions ?? [];
  const named = (x) =>
    x.kind === "agent" &&
    x.agent === agent &&
    (!deep || x.workspace === deep.ws);
  let r =
    visibleRows().find((x) => named(x) && (!ws || x.workspace === ws)) ??
    all.find(named);
  if (r && !inView(r)) {
    await switchToProjectOf(r);
    r = visibleRows().find((x) => x.id === r.id) ?? r;
  }
  if (!r) {
    window.denShell?.toast?.(
      t("ag.link.none", { id: ws ? `${ws} / ${agent}` : agent }),
    );
    return;
  }
  if (isStopped(r)) {
    const row = st.root.querySelector(
      `#agl .agr[data-id="${CSS.escape(r.id)}"]`,
    );
    const group = row?.closest("details[data-stopped]");
    if (group && !group.open) group.open = true;
    row?.scrollIntoView({ block: "nearest" });
    row?.focus();
    if (deep?.context)
      window.denShell?.toast?.(t("agc.stopped", { name: displayName(r) }));
    await openDetails(r, row);
    return;
  }
  if (r.attachable === false) return;
  await pick(r.id, false);
  if (deep?.context) openComposer(r, deep.context);
}

/**
 * Issue 103: the composer under an agent's terminal, `text` in it.
 * Nothing is sent until the person presses Send (POST …/say).
 */
function openComposer(r, text) {
  const p = st.panes.get(r.id);
  if (!p) return;
  if (!p.composer) {
    const name = displayName(r);
    const c = makeComposer({
      t,
      name,
      holds: true,
      // BUSY-1: Send goes through the working pop-up. A quick refusal
      // comes back to the composer, which says it; the pop-up closed
      // after a failure resolves null, and the text stays in the box.
      send: async ({ text: said, button }) => {
        const out = await window.denShell.busyAction(
          "send-message",
          (headers) =>
            api(
              "POST",
              `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/say`,
              { text: said },
              { headers },
            ),
          {
            button,
            vars: { name },
            quietFail: true,
            inlineError: true,
            toastFast: false,
          },
        );
        if (!out) throw new Error(t("agc.kept"));
      },
      onClose: () => {
        c.el.remove();
        p.composer = null;
        refit(p);
        p.term?.focus();
      },
    });
    p.composer = c;
    p.el.insertBefore(c.el, p.el.querySelector(".agto"));
    refit(p);
  }
  p.composer.setText(text);
  // The keyboard is the composer's now, not the terminal's once it opens.
  if (st.focusOnOpen === r.id) st.focusOnOpen = null;
  p.composer.focus();
}
