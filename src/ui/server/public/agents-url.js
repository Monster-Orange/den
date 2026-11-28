import { paintSub } from "/agents-list.js";
import { LAYOUTS, MAX_PANES, PHONE, rowOf, st } from "/agents-core.js";

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
  return pickedWorkspace() ? [pickedWorkspace()] : (st.data?.workspaces ?? []);
}

function pickedWorkspace() {
  const all = st.data?.workspaces ?? [];
  const ws = urlWorkspace();
  if (ws) return ws;
  if (st.scope && st.scope !== "all" && all.includes(st.scope)) return st.scope;
  return null;
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

export { OPEN_KEY, PAGE, SHELL_USED_KEY, linkedAgentAsked, markShellUsed, phone, pickedWorkspace, rememberedOpen, shellUsed, shownLayout, urlWorkspace, viewWorkspaces, visibleIds, writeUrl };
