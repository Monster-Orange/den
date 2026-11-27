import { LAYOUTS, MAX_PANES, PHONE, st } from "/agents-core.js";

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

export {
  OPEN_KEY,
  PAGE,
  SHELL_USED_KEY,
  linkedAgentAsked,
  phone,
  pickedWorkspace,
  rememberedOpen,
  shellUsed,
  shownLayout,
  urlWorkspace,
  viewWorkspaces,
  visibleIds,
};
