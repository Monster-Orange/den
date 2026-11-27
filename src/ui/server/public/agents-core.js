import { reconnectOptions } from "/pane-reconnect.js";

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

const BY = ["need", "project", "group"];

const st = {
  root: null,
  seenNow: new Map(),
  loadFailed: false,
  /**
   * Issue 1407: each agent's answer to a restart for its tools (ws\0id →
   * now, turn, job with what and how long, unknown), shown under its row
   * until its tools are current.
   */
  restarts: new Map(),
  restartRun: null,
  /** Issue 96: the row being dragged (the list isn't redrawn meanwhile). */
  drag: null,
  /** Issue 96: a drag just ended, so the click it makes is swallowed. */
  dragClick: false,
  /** Issue 226: on a phone, whether the Stopped group's agents show them. */
  reorderStopped: false,
  reorderBand: null,
  /** 0.4.46: panes.* (GET /api/settings panes_reconnect). */
  reconnect: reconnectOptions(undefined),
  /** 0.4.45: /api/workspaces, for the projects' names (projName). */
  projects: null,
  projectsAt: 0,
  scope: "all",
  /** Issue 750: Hub's groups (GET /api/hub/groups), or null until read. */
  groupsRead: null,
  groupsAt: 0,
  /** Issue 750: the list by project (as before) or by group. */
  by: savedBy(),
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
  focusSoon: null,
  // D58: whether that focus is a link's: only for a keyboard on nothing yet.
  focusIfIdle: false,
  // D54/D58: whether that pick also sizes the PTY (a pick from the list
  // does; a link that opens the page only puts the keyboard there).
  claimOnOpen: false,
  // Issue 1315: a person picked a pane (a tab, a row) while the page was
  // still opening its ?open= panes: their pick stays in front. Cleared
  // once start-up has opened them.
  picked: false,
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

function savedBy() {
  try {
    const v = localStorage.getItem("den-agents-by");
    return BY.includes(v) ? v : "need";
  } catch {
    return "need";
  }
}

export {
  t,
  esc,
  api,
  CLI,
  TITLE,
  SERVER_WS,
  PHONE,
  MAX_NAME,
  REFRESH_MS,
  BY,
  st,
};
