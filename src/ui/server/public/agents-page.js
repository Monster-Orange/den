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
 * PTY's size on attach and whenever anyone changes it (a `size` frame), so
 * a pane knows when it is out of step, and the pane in use wins: it says
 * its own size when it is focused, when the page is shown again, and
 * before the first keystroke after the PTY's size changed under it. A
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
import { readiness, runtimeName, runtimeOptions } from "/agent-start.js";
import { focusBack, refindKey } from "/transcript-view.js";
import { dismissable } from "/popover.js";
import {
  helperBadgeHtml,
  helperBarButtonHtml,
  helperRowsHtml,
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
const api = (method, url, body) => window.denShell.api(method, url, body);
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
  keyPane: null,
  // AG-4b: where a path link opens (Settings editor_open).
  editorOpen: "none",
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

function writeUrl() {
  const u = new URL(location.href);
  if (st.open.length) u.searchParams.set("open", st.open.join(","));
  else u.searchParams.delete("open");
  u.searchParams.set("layout", st.layout);
  u.searchParams.delete("start");
  u.searchParams.delete("folder");
  const s = u.searchParams.toString().replace(/%2C/gi, ",");
  history.replaceState(history.state, "", u.pathname + (s ? `?${s}` : ""));
  paintSub();
}

// ── the list ────────────────────────────────────────────────────────────

/** ?ws=: the one workspace the page was asked for, or null. */
const urlWorkspace = () => new URLSearchParams(location.search).get("ws");

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

/** "19:52" today, else "Nov 6, 19:52" (the browser's own format). */
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** Why a stopped agent stopped (AG-14.1). */
export function stopReason(r) {
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
  return `${base}?ws=${encodeURIComponent(ws)}`;
}

/** Workspace `ws` as a link to it on Workspaces. */
function wsLinkHtml(ws) {
  // ON-6: the server agent belongs to no workspace: its group is "Server".
  if (ws === SERVER_WS)
    return `<span class="wslink" data-server>${esc(t("ag.server"))}</span>`;
  return `<a class="wslink" href="${esc(wsHref(ws))}" title="${esc(t("ag.goWs", { ws }))}">${esc(ws)}</a>`;
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

/** D37: "22:13" today, else "Nov 6": short, for a one-line row. */
function whenShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
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
  const meta = [r.runtime, r.cwd].filter(Boolean).join(" · ");
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
    `<span class="den-dot ${stateTone(r)} hollow" aria-hidden="true"></span>` +
    `<span class="nm">${esc(label)}${wsTag ? ` <span class="id">${esc(r.workspace)}</span>` : ""}</span>` +
    `<span class="stchip" title="${esc(chip)}">${esc(chip)}</span>` +
    (at ? `<span class="when">${esc(at)}</span>` : "") +
    `</button>` +
    `<span class="agacts">${first}${more}</span>` +
    (callout ? `<div class="agcallout">${callout}</div>` : "") +
    `</div>`
  );
}

function rowHtml(r) {
  if (isStopped(r)) return stoppedHtml(r);
  const open = st.open.includes(r.id);
  const nm =
    r.kind === "agent"
      ? nameHtml(r)
      : `${esc(r.label)} <span class="sbdg">${esc(t("ag.session"))}</span>`;
  const right =
    (r.waiting
      ? `<span class="wbdg">${esc(t("ag.waiting"))}</span>`
      : `<span class="st">${esc(stateText(r.state))}</span>`) +
    (r.kind === "agent" ? helperBadgeHtml(r) : "");
  const meta = [r.runtime, r.cwd].filter(Boolean).join(" · ");
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
  const tags =
    rotTag || revokedTag || ovTags || wTag
      ? `<span class="agtags">${revokedTag}${rotTag}${wTag}${ovTags}</span>`
      : "";
  const button =
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}" data-state="${esc(r.state)}"` +
    ` aria-pressed="${open}"${r.attachable ? "" : ' aria-disabled="true"'}` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${displayName(r)}` }))}">` +
    `<span class="den-dot ${r.waiting ? "warn" : stateTone(r)}" aria-hidden="true"></span>` +
    `<span class="nm">${nm}</span>${right}` +
    (meta ? `<span class="meta">${esc(meta)}</span>` : "") +
    tags +
    `</button>`;
  // D28: a running agent whose rotation is due: its callout, with buttons
  // (before, only a tag: nothing to press).
  const callout = r.kind === "agent" ? rotCalloutHtml(r) : "";
  // D32: the helpers it started in its own session, under it.
  // D34: only under the agent in front.
  const helpers = r.kind === "agent" ? helperRowsHtml(r, r.id === st.cur) : "";
  if (!callout) return button + helpers;
  return (
    `<div class="agst" data-agent="${esc(r.agent)}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}" data-rotation="${rot}">` +
    button +
    `<div class="agacts">${callout}</div>` +
    `</div>` +
    helpers
  );
}

/** Where focus was in the list, as a selector that finds it again once
 * the list is redrawn: a helper row or button, an agent's row, a link. */
function listFocusKey(el) {
  const key = refindKey(el);
  if (key) return key;
  const q = (v) => CSS.escape(String(v ?? ""));
  if (el.matches("button.agr[data-id]"))
    return `#agl button.agr[data-id="${q(el.dataset.id)}"]`;
  if (el.matches("[data-act]")) {
    const row = el.closest(".agst[data-agent]");
    const act = `[data-act="${q(el.dataset.act)}"]`;
    return row
      ? `#agl .agst[data-agent="${q(row.dataset.agent)}"][data-ws="${q(row.dataset.ws)}"] ${act}`
      : `#agl ${act}`;
  }
  return "";
}

/** The list's HTML, written only when it changed; focus inside it is kept
 * (the refresh poll redraws it every few seconds). */
function setList(el, html) {
  if (el.denHtml === html) return;
  el.denHtml = html;
  const had = el.contains(document.activeElement)
    ? document.activeElement
    : null;
  const key = had ? listFocusKey(had) : "";
  el.innerHTML = html;
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
  if (!st.data) {
    setList(el, notes.join(""));
    return;
  }
  // ON-6: the server agent's group, "Server", first, whatever the view.
  const shown = st.data.sessions.some((s) => s.server)
    ? [SERVER_WS, ...viewWorkspaces()]
    : viewWorkspaces();
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
  // D37: running ones (and plain sessions) under their workspace; the
  // agents that aren't running in one "Stopped (n)" group at the bottom.
  const inView = shown.flatMap((ws) =>
    st.data.sessions.filter((s) => s.workspace === ws),
  );
  const stopped = inView.filter(isStopped);
  const groups = shown
    .map((ws) => ({
      ws,
      rows: inView.filter((s) => s.workspace === ws && !isStopped(s)),
    }))
    .filter((g) => g.rows.length > 0);
  const body =
    groups.length || stopped.length
      ? groups
          .map(
            (g) =>
              `<div class="wsg" data-ws="${esc(g.ws)}"><div class="wsh"><span>${wsLinkHtml(g.ws)}</span><span>${esc(g.rows.length)}</span></div>` +
              g.rows.map(rowHtml).join("") +
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
  if (clear) clear.hidden = !visibleRows().some(isStopped);
  // No such workspace: nothing to start an agent in.
  const start = st.root.querySelector("#ag-start");
  if (start) start.hidden = st.data.requested?.known === false;
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
    rows.map((r) => stoppedHtml(r, wsTag)).join("") +
    `</details>`
  );
}

function visibleRows() {
  const shown = new Set(viewWorkspaces());
  shown.add(SERVER_WS);
  return (st.data?.sessions ?? []).filter((s) => shown.has(s.workspace));
}

function paintSub() {
  const rows = visibleRows();
  const waiting = rows.filter((r) => r.waiting).length;
  const n = rows.length;
  const count = st.root.querySelector("#ag-count");
  if (count)
    count.textContent = t(n === 1 ? "ag.sub.one" : "ag.sub", {
      n,
      w: waiting,
      scope: st.scopeLabel,
    });
  const url = st.root.querySelector("#ag-url");
  if (url) url.textContent = location.pathname + location.search;
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
  if (ws && shown.length === 1 && shown[0] === ws) return ws;
  return st.scope === "all" ? t("ag.all") : st.scope;
}

async function refresh() {
  clearTimeout(st.timer);
  try {
    const ws = urlWorkspace();
    const r = await fetch(
      ws ? `/api/sessions?ws=${encodeURIComponent(ws)}` : "/api/sessions",
      { headers: { accept: "json" } },
    );
    if (r.status === 401) {
      st.signedOut = true;
    } else if (r.ok) {
      st.data = await r.json();
      st.signedOut = false;
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
  paintList();
  paintSub();
  for (const p of st.panes.values()) paintBar(p);
  const strip = st.root.querySelector("#agr > .agtabs");
  if (strip) paintTabs(strip);
  if (!st.root.isConnected) return;
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
    const r = rowOf(p.id);
    if (r?.kind === "agent" && r.agent) {
      p.agent = r.agent;
      p.agentWs = r.workspace;
    }
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

/** The pane's line for a resume that had nothing to continue (AG-14). */
function freshLine(p) {
  p.term?.write(`\x1b[2m${t("ag.freshLine")}\x1b[0m\r\n`);
}

/** Move pane `p` to session row `row`, where it was. */
function retarget(p, row) {
  const old = p.id;
  const sock = p.sock;
  p.sock = null;
  try {
    sock?.close(1000, "switched");
  } catch {
    /* already closed */
  }
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
  st.xterm ??= Promise.all([
    import("/vendor/xterm.mjs"),
    import("/vendor/addon-fit.mjs"),
    import("/vendor/addon-web-links.mjs"),
  ]).then(([x, f, w]) => ({
    Terminal: x.Terminal,
    FitAddon: f.FitAddon,
    WebLinksAddon: w.WebLinksAddon,
  }));
  return st.xterm;
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
  if (!r) return { name: p?.label || id, meta: p?.workspace || "" };
  if (r.kind !== "agent")
    return {
      name: r.label,
      meta: [t("ag.session"), r.workspace].join(" · "),
    };
  return {
    name: paneName(r),
    meta: [r.persona, r.workspace, sessionExtra(r)].filter(Boolean).join(" · "),
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
      if (sr) sr.hidden = !r?.waiting;
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
        `<button type="button" role="tab" class="agtab" data-id="${esc(id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}"${rename}>` +
        `<span class="den-dot ${tone}" aria-hidden="true"></span>` +
        `<span class="den-sr"${r?.waiting ? "" : " hidden"}>${esc(t("ag.waiting"))}: </span>` +
        `<span class="tn">${esc(w.name)}</span><span class="tm mono">${esc(w.meta)}</span></button>` +
        `<button type="button" class="agtab-x" data-act="close" data-id="${esc(id)}" aria-label="${esc(t("ag.detachName", { id: w.name }))}" title="${esc(t("ag.detach"))}">×</button>` +
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
    box.innerHTML = `<div>${esc(t("ag.empty"))}</div>`;
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
function focusTerm(id) {
  const p = st.panes.get(id);
  if (!p || p.exited || p.closed) return;
  if (p.term && p.sock?.readyState === WebSocket.OPEN && p.heardSession) {
    st.focusOnOpen = null;
    // After the click that picked it has finished with the row.
    requestAnimationFrame(() => {
      if (!p.closed && !p.exited) p.term?.focus();
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
  if (!add) st.focusOnOpen = live ? id : null;
  else if (st.focusOnOpen === id) st.focusOnOpen = null;
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
function renameTab(tab) {
  const id = tab.dataset.id;
  const r = rowOf(id);
  if (r?.kind !== "agent" || tab.querySelector("input")) return;
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
        ? [r.persona, r.agent, r.runtime, r.cwd]
        : [r.runtime, sessionExtra(r)]
      )
        .filter(Boolean)
        .join(" · ")
    : "";
  const where =
    (ws ? wsLinkHtml(ws) : "") + (ws && rest ? " · " : "") + esc(rest);
  const tone = r ? stateTone(r) : p.exited ? "off" : "pending";
  const stop =
    r?.kind === "agent" && (r.state === "running" || r.state === "stopping")
      ? `<button type="button" class="den-btn sm" data-act="stop" aria-label="${esc(t("ag.stopName", { id: r.agent }))}">${esc(t("ag.stop"))}</button>`
      : "";
  // The mock's pane bar: Resume (primary) on an ended agent that can.
  const resume =
    r && isStopped(r) && r.resumable
      ? `<button type="button" class="den-btn sm primary" data-act="resume" aria-label="${esc(t("ag.resumeName", { id: r.agent }))}">${esc(t("ag.resume"))}</button>`
      : "";
  const reconnect = p.lost
    ? `<button type="button" class="den-btn sm" data-act="reconnect">${esc(t("ag.reconnect"))}</button>`
    : "";
  // AG-18: ⋯, its menu: Rename… (D25, every agent), Change persona… (a
  // runtime that can resume).
  const more =
    r?.kind === "agent"
      ? `<button type="button" class="den-btn sm" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t("ag.more", { id: r.agent }))}" title="${esc(t("ag.more", { id: r.agent }))}">⋯</button>`
      : "";
  const html =
    `<span class="den-dot ${tone}" aria-hidden="true"></span>` +
    `<b>${esc(name)}</b><span class="where mono">${where}</span>` +
    (r && isStopped(r)
      ? `<span class="why" data-why title="${esc(stoppedTip(r))}">${esc(stopReason(r))}</span>`
      : "") +
    (r?.tokenRevoked
      ? `<span class="tagx warn" title="${esc(t("ag.revokedTip"))}">${esc(t("ag.revoked"))}</span>`
      : "") +
    whereTag(r, true) +
    subagentTag(r) +
    (r?.kind === "agent" && rotActionsHtml(r)
      ? `<span class="agrot" data-rot-bar title="${esc(rotMessage(r))}"><span class="tagx warn" data-rotation="${rotationOf(r)}">${esc(t(rotationOf(r) === "ready" ? "ag.rot.ready" : "ag.rot.due", { why: rotationWhy(r.rotation) }))}</span>${rotActionsHtml(r)}</span>`
      : "") +
    `<span class="x">${r?.kind === "agent" ? helperBarButtonHtml(r) : ""}${reconnect}${stop}${resume}${more}<button type="button" class="den-btn sm" data-act="close" aria-label="${esc(t("ag.detachName", { id: name }))}" title="${esc(t("ag.detach"))}">×</button></span>`;
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
  // Tabs: the tab's × closes it; the pane's bar has none.
  const x = bar.querySelector('[data-act="close"]');
  if (x) x.hidden = shownLayout() === "tabs";
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
  try {
    p.fit.fit();
  } catch {
    /* not laid out yet */
  }
  markSize(p);
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
  send(p, { type: "resize", cols: term.cols, rows: term.rows });
  // What the PTY will be: the server's frame follows (or another
  // viewer's, if it resized after).
  p.pty = { cols: term.cols, rows: term.rows };
  markSize(p);
  return true;
}

/** This pane is in use: fit it and make the PTY its size. */
function claimSize(p) {
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

async function connect(p) {
  p.lost = false;
  paintBar(p);
  const token = await csrf(false);
  if (p.closed) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/api/sessions/${encodeURIComponent(p.id)}/io`;
  let sock;
  try {
    sock = new WebSocket(url, ["den.io", `den.csrf.${token ?? ""}`]);
  } catch (err) {
    p.term?.write(`\r\n${t("ag.lost", { why: err?.message ?? "error" })}\r\n`);
    p.lost = true;
    paintBar(p);
    return;
  }
  sock.binaryType = "arraybuffer";
  p.sock = sock;
  p.heardSession = false;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    p.pty = null;
    p.heardSize = false;
    refit(p);
    sendSize(p);
  };
  sock.onmessage = (e) => {
    if (typeof e.data === "string") {
      let msg = null;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg?.type === "size") {
        if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          p.heardSize = true;
          p.pty = { cols: msg.cols, rows: msg.rows };
          markSize(p);
        }
      } else if (msg?.type === "session") {
        p.label = msg.label;
        p.workspace = msg.workspace;
        p.exited = !!msg.exited;
        p.heardSession = true;
        paintBar(p);
        // D40: the pane the person picked takes the keyboard once the
        // server says its session is live (the first frame), never one
        // that has ended.
        if (st.focusOnOpen === p.id) {
          if (p.exited) st.focusOnOpen = null;
          else focusTerm(p.id);
        }
      } else if (msg?.type === "exit") {
        p.exited = true;
        // Its agent may continue in a new session (followAgents).
        st.followUntil = Date.now() + FOLLOW_FOR_MS;
        const code =
          typeof msg.exitCode === "number" ? ` (${msg.exitCode})` : "";
        p.term?.write(`\r\n${t("ag.exitedLine", { code })}\r\n`);
        void refresh();
      }
      return;
    }
    p.term?.write(new Uint8Array(e.data));
  };
  sock.onclose = async (e) => {
    if (p.sock !== sock) return;
    p.sock = null;
    if (p.closed) return;
    // Refused before it opened: a browser sees only the close, so ask the
    // route why with a plain GET (0.4.17). "Sign in" only when it's 401.
    let why = e.reason || String(e.code);
    if (!opened) {
      void refresh();
      why = await refusalReason(p.id);
      if (p.closed || p.sock) return;
    }
    p.term?.write(`\r\n${t("ag.lost", { why })}\r\n`);
    p.lost = true;
    paintBar(p);
  };
}

/** Why session `id`'s io upgrade was refused, in words for its pane. */
async function refusalReason(id) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/io`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (r.status === 401) return t("ag.signin", { cli: CLI });
    const b = await r.json().catch(() => null);
    if (r.status === 426) return t("ag.refusedUnknown");
    if (typeof b?.error === "string" && b.error) return b.error;
    return t("ag.refusedStatus", { status: r.status });
  } catch {
    return t("ag.refusedUnknown");
  }
}

// ── links and keys in a pane (AG-4b) ───────────────────────────────────

/** What Shift+Enter sends to a pane's session (a plain session: Enter). */
function softNewlineOf(id) {
  const seq = rowOf(id)?.softNewline;
  return typeof seq === "string" && seq ? seq : "\r";
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
        activate: (e) => void openPath(e, abs.get(m.path), m.line, m.col),
        hover: () => linkHint(p, true),
        leave: () => linkHint(p, false),
      }));
    done(links.length ? links : undefined);
  } catch {
    done(undefined);
  }
}

/**
 * A path link clicked: with ⌘ (Ctrl elsewhere), the editor in Settings
 * (editor_open) at the line, by its URL scheme; none copies the path.
 */
async function openPath(e, abs, line, col) {
  if (!linkModifier(e) || !abs) return;
  e?.preventDefault?.();
  const url = editorUrl(st.editorOpen, abs, line, col);
  if (url) {
    // D35: the same tab, to the editor's own scheme (zed://, vscode://):
    // a navigation, not a new window, so no popup blocker stands in it.
    window.open(url, "_self");
    return;
  }
  try {
    await navigator.clipboard.writeText(abs);
    window.denShell?.toast?.(t("ag.copied"));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
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
  el.innerHTML = `<div class="bar2"></div><div class="term"><div class="tbox"></div></div>`;
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
    el.querySelector(".term").innerHTML =
      `<p class="note">${esc(err?.message ?? String(err))}</p>`;
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
    // The one typing wins: another viewer resized the PTY since.
    if (outOfStep(p)) claimSize(p);
    p.sock.send(enc.encode(d));
  };
  term.onData(typeIn);
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
  // Focused (a click, the window coming back): this pane's size.
  el.addEventListener("focusin", () => {
    claimSize(p);
    // D40: the terminal that last had the keyboard (an add gives it back).
    st.keyPane = p.id;
  });
  p.ro = new ResizeObserver(() => refit(p));
  p.ro.observe(el.querySelector(".term"));
  refit(p);
  // The theme's font may still be loading: measure again once it has.
  document.fonts?.ready?.then(() => {
    if (!p.closed) remeasure(p);
  });
  void connect(p);
}

function closePane(id, { quiet = false } = {}) {
  const p = st.panes.get(id);
  if (!p) return;
  p.closed = true;
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

async function stopAgent(p, button) {
  const r = rowOf(p.id);
  if (!r?.agent) return;
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

// ── Stopped agents (AG-14) ──────────────────────────────────────────────

const agentPath = (r, verb) =>
  `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/${verb}`;

/**
 * Resume (the same conversation), Start fresh, or Relaunch from handoff
 * (den#4: a new conversation that starts from handoff.md); its pane opens
 * on it.
 */
async function restartRow(r, verb, button) {
  if (button) button.disabled = true;
  try {
    const out = await api("POST", agentPath(r, verb));
    window.denShell?.toast?.(
      t(
        verb === "relaunch"
          ? "ag.relaunched"
          : verb !== "resume"
            ? "ag.startedFresh"
            : out?.fresh
              ? "ag.resumedFresh"
              : "ag.resumed",
        { id: r.agent },
      ),
    );
    // Its open pane follows it to the new session (followAgents, in
    // refresh); one that couldn't (not running yet) is closed for it.
    await refresh();
    const next = out?.agent?.sessionId;
    if (next && next !== r.id && st.panes.has(r.id))
      closePane(r.id, { quiet: true });
    if (next) await openPane(next);
  } catch (err) {
    window.denShell?.errorToast?.(err);
    await refresh();
  }
}

/**
 * D28 Relaunch now: from the handoff when it passes; else Den asks for it
 * first (a stopped agent resumes to write it) and relaunches it once it
 * passes, by itself.
 */
async function relaunchNow(r, button) {
  if (r.rotation?.ready) return restartRow(r, "relaunch", button);
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
async function writeHandoff(r, button) {
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

/** Clear stopped: every stopped agent in view (AG-14.1b). */
async function clearStopped(button) {
  const workspaces = [
    ...new Set(
      visibleRows()
        .filter(isStopped)
        .map((r) => r.workspace),
    ),
  ];
  if (!workspaces.length) return;
  button.disabled = true;
  try {
    const out = await api("POST", "/api/agents/clear-stopped", { workspaces });
    const ids = (out?.removed ?? []).map((x) => x.agent);
    for (const r of visibleRows())
      if (ids.includes(r.agent) && st.panes.has(r.id))
        closePane(r.id, { quiet: true });
    await refresh();
    if (ids.length)
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

/** The conversation picked in Bring in, when it can be brought in. */
function bringPick() {
  const c = (sd.bring?.list ?? []).find((x) => x.id === sd.bring.pick);
  return c && !c.open && !c.agent ? c : null;
}

/** "3 min ago", "2 h ago", or the date. */
function agoText(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return t("ag.bring.now");
  if (m < 60) return t("ag.bring.min", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t("ag.bring.h", { n: h });
  return iso.slice(0, 10);
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
    `<span class="rd" aria-hidden="true"></span><span class="pn pnc"><span class="pt">${esc(c.title || t("ag.bring.untitled"))}</span>${taken}</span><span class="mono">${esc(agoText(c.lastAt))}</span>` +
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
    sd.bring.runtimes = r?.runtimes ?? [];
    sd.bring.root = r?.folder ?? "";
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return false;
  }
  if (!sd.bring.list.some((c) => c.id === sd.bring.pick))
    sd.bring.pick = sd.bring.list.find((c) => !c.open && !c.agent)?.id ?? "";
  paintConversations();
  return true;
}

function pickConversation(id) {
  const c = (sd.bring?.list ?? []).find((x) => x.id === id);
  if (!c || c.open || c.agent) return;
  sd.bring.pick = id;
  for (const b of st.root.querySelectorAll("#ag-conv [data-cid]"))
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
  body.innerHTML =
    `<p>${esc(t("ag.new.advNote"))}</p>` +
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
  sd.intent = p?.permission || "ask";
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
    const d = await personaDetail(p.id);
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
  return true;
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
    if (p.permission !== undefined || sd.intent !== "ask")
      body.permission = sd.intent;
    body.allow = sd.extras;
  }
  const task = $d("#ag-task").value.trim();
  if (task) body.instruction = task;
  const name = $d("#ag-name").value.trim();
  if (name) body.name = name;
  const folder = $d("#ag-folder")?.value.trim();
  if (folder) body.folder = folder;
  return body;
}

function showStartError(err) {
  const el = $d("#ag-err");
  el.textContent = err?.message || String(err);
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
  go.disabled = true;
  go.textContent = t("ag.starting");
  try {
    if (sd.pid === PLAIN) {
      const r = await api(
        "POST",
        `/api/workspaces/${encodeURIComponent(ws)}/sessions`,
      );
      window.denShell?.toast?.(
        t("ag.new.started", { p: t("ag.session"), w: ws }),
      );
      dlg.close?.();
      await refresh();
      if (r?.session?.id) await openPane(r.session.id);
      return;
    }
    const r = await api(
      "POST",
      `/api/workspaces/${encodeURIComponent(ws)}/agents`,
      startBody(),
    );
    window.denShell?.toast?.(t("ag.started", { id: r?.agent?.id ?? sd.pid }));
    // AG-10.10: the next start of this persona takes another id.
    personasAsked.delete(ws);
    $d("#ag-name").value = "";
    for (const w of r?.warnings ?? []) window.denShell?.toast?.(w);
    dlg.close?.();
    await refresh();
    if (r?.agent?.sessionId) await openPane(r.agent.sessionId);
  } catch (err) {
    showStartError(err);
  } finally {
    go.disabled = false;
    go.textContent = goLabel();
    if (dlg.open) paintRuntime(false);
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
  go.disabled = true;
  go.textContent = t("ag.pc.going");
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
  go.disabled = true;
  go.textContent = t("ag.bring.going");
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
      src = await personaDetail(p.id);
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
    const cr = e.target.closest("#ag-conv [data-cid]");
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
  // Shown again: each pane says its size (another viewer may have taken
  // the PTY while this page was hidden).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    for (const p of st.panes.values()) claimSize(p);
  });
}

// ── mount ───────────────────────────────────────────────────────────────

function translateStatic(root) {
  const set = (sel, key) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = t(key);
  };
  set("#ag-h", "n.agents");
  set("#ag-start", "ag.start");
  set("#ag-bring", "ag.bring");
  set("#ag-conv-t", "ag.bring.conv");
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
            ? `<div class="den-svp-ms">${esc(when(det.lastPrompt.at))}</div>`
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
    )
  );
}

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

function paintAgentDetails() {
  if (!agd.el || !agd.r) return;
  const a = document.activeElement;
  const key = a && agd.el.contains(a) ? a.dataset?.agd : null;
  agd.el.innerHTML = detailsHtml(agd.r, agd.det);
  placeDetails();
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
  document.body.append(el);
  Object.assign(agd, { r, opener, el, det: null });
  opener.setAttribute("aria-expanded", "true");
  paintAgentDetails();
  (el.querySelector(".den-svp-acts .den-btn") || el).focus();
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
  if (agd.r !== r) return;
  agd.det = det;
  paintAgentDetails();
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
  translateStatic(root);
  if (window.denShell?.apiOff?.()) return;
  st.open = [];
  const wanted = openFromUrl(location.search);
  const linked = layoutFromUrl(location.search);
  const startAsked = new URLSearchParams(location.search).get("start") === "1";
  if (startAsked) {
    const q = new URLSearchParams(location.search);
    startPrefill = { ws: q.get("ws") || "", folder: q.get("folder") || "" };
  }

  // D32: helper rows open their transcript; "All helpers" the full list.
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
      const agent = act.closest(".agst")?.dataset.agent;
      const ws = act.closest(".agst")?.dataset.ws;
      const r = visibleRows().find(
        (x) => x.agent === agent && x.workspace === ws,
      );
      if (!r) return;
      if (which === "relaunch") void relaunchNow(r, act);
      else if (which === "rot-write") void writeHandoff(r, act);
      else if (which === "rot-keep") void keepConversation(r, act);
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
  root.querySelector("#agr").addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) {
      if (st.cur === tab.dataset.id) return;
      st.cur = tab.dataset.id;
      paintLayout();
      paintList();
      tab.focus();
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
    } else if (b.dataset.act === "stop") void stopAgent(p, b);
    else if (b.dataset.act === "resume") {
      const r = rowOf(id);
      if (r) void restartRow(r, "resume", b);
    } else if (b.dataset.act === "reconnect") void connect(p);
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
            : [{ label: t("ag.rn.item"), onSelect: () => openRename(r, b) }]),
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
  root.querySelector("#ag-start").addEventListener("click", () => {
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
  window.addEventListener("pagehide", () => {
    for (const p of st.panes.values()) {
      p.closed = true;
      try {
        p.sock?.close(1000, "page closed");
      } catch {
        /* already closed */
      }
    }
  });

  const [, saved] = await Promise.all([loadScope(), savedLayout()]);
  // A link's &layout= wins for this page; else the person's.
  st.layout = linked ?? saved;
  await refresh();
  paintLayout();
  // An id the list no longer has (removed, another distribution's) is
  // dropped from the URL rather than opened onto a refusal.
  if (!st.signedOut && st.data?.io?.allowed !== false)
    for (const id of wanted) {
      if (!st.data || rowOf(id)) await openPane(id);
    }
  writeUrl();
  if (startAsked) void openStart();
}
