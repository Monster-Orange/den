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
 * Start agent (AG-0.2): the runtime line says what will run, or why it
 * can't, before Start (agent-start.js readiness). Starting, stopping and
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
 * as 2x2). The page header's switch and ⌘1 / ⌘2 / ⌘3 pick one; it is the
 * person's (POST /api/settings agents_layout) and the URL's (&layout=; a
 * link's wins for that page and saves nothing). At phone width Focus and
 * Tile are Tabs. Every pane open stays attached; a pane out of sight never
 * resizes its PTY. Double-click a tab to rename the agent: the name is its
 * record's (POST …/agents/<id>/name), shown in the list, the pane, ⌘K.
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
import { fillStartForm } from "/agent-start.js";

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
/** How long Remove's Undo stays offered (AG-14.1b). */
export const UNDO_MS = 10_000;

/** The most panes at once (the prototype's 2x2). */
export const MAX_PANES = 4;

/** The layouts (AG-4b), in the switch's order (⌘1, ⌘2, ⌘3). */
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
  timer: null,
  xterm: null,
  csrf: null,
  docWired: false,
  // AG-4b: the person's layout, the pane in front, and in Focus the panes
  // Shift-clicked in alongside it.
  layout: "focus",
  cur: null,
  side: new Set(),
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
  if (r.displayName)
    return `${esc(r.displayName)} <span class="id">${esc([r.persona, r.label].filter(Boolean).join(" · "))}</span>`;
  return `${esc(displayName(r))}${r.persona && r.persona !== r.label ? ` <span class="id">${esc(r.label)}</span>` : ""}`;
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

/** Its rotation, when one is due: "ready" or "due" (den#4). */
function rotationOf(r) {
  if (!r.rotation?.due) return "";
  return r.rotation.ready ? "ready" : "due";
}

/** A stopped agent's row: its button (it opens an ended pane) and actions. */
function stoppedHtml(r) {
  const open = st.open.includes(r.id);
  const name = displayName(r);
  const nm = nameHtml(r);
  const meta = [r.runtime, r.cwd].filter(Boolean).join(" · ");
  const who = esc(r.agent);
  const rot = rotationOf(r);
  const relaunch =
    rot === "ready"
      ? `<button type="button" class="den-btn sm primary" data-act="relaunch" aria-label="${esc(t("ag.relaunchName", { id: r.agent }))}">${esc(t("ag.relaunch"))}</button>`
      : "";
  const resume = r.resumable
    ? `<button type="button" class="den-btn sm primary" data-act="resume" aria-label="${esc(t("ag.resumeName", { id: r.agent }))}">${esc(t("ag.resume"))}</button>`
    : "";
  const fresh = `<button type="button" class="den-btn sm" data-act="fresh" aria-label="${esc(t("ag.freshName", { id: r.agent }))}">${esc(t("ag.fresh"))}</button>`;
  const remove = `<button type="button" class="den-btn sm" data-act="remove" aria-label="${esc(t("ag.removeName", { id: r.agent }))}">${esc(t("ag.remove"))}</button>`;
  // A rotation due without a handoff that passes: say so (den#4).
  const handoff =
    rot === "due"
      ? `<span class="agcant" data-handoff="${esc(r.rotation.handoff)}">${esc(
          t(
            r.rotation.handoff === "missing"
              ? "ag.rot.noHandoff"
              : "ag.rot.badHandoff",
            { why: rotationWhy(r.rotation) },
          ),
        )}</span>`
      : "";
  const cant =
    !r.resumable && r.noResume && rot !== "ready"
      ? `<span class="agcant" data-no-resume>${esc(r.noResume.startsWith(`${r.runtime} `) ? t("ag.noResume", { runtime: r.runtime }) : r.noResume)}</span>`
      : "";
  const stText =
    rot === "ready"
      ? t("ag.rot.ready", { why: rotationWhy(r.rotation) })
      : stateText(r.state);
  return (
    `<div class="agst" data-agent="${who}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}"${rot ? ` data-rotation="${rot}"` : ""}>` +
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="agent" data-state="${esc(r.state)}"` +
    ` aria-pressed="${open}"${r.attachable ? "" : ' aria-disabled="true"'}` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${name}` }))}">` +
    `<span class="den-dot ${stateTone(r)}" aria-hidden="true"></span>` +
    `<span class="nm">${nm}</span><span class="st">${esc(stText)}</span>` +
    (meta ? `<span class="meta">${esc(meta)}</span>` : "") +
    `<span class="why">${esc(stopReason(r))}</span>` +
    `</button>` +
    `<div class="agacts">${handoff}${cant}${relaunch}${resume}${fresh}${remove}</div>` +
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
  const right = r.waiting
    ? `<span class="wbdg">${esc(t("ag.waiting"))}</span>`
    : `<span class="st">${esc(stateText(r.state))}</span>`;
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
  const tags =
    rotTag || revokedTag
      ? `<span class="agtags">${revokedTag}${rotTag}</span>`
      : "";
  return (
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}" data-state="${esc(r.state)}"` +
    ` aria-pressed="${open}"${r.attachable ? "" : ' aria-disabled="true"'}` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${displayName(r)}` }))}">` +
    `<span class="den-dot ${r.waiting ? "warn" : stateTone(r)}" aria-hidden="true"></span>` +
    `<span class="nm">${nm}</span>${right}` +
    (meta ? `<span class="meta">${esc(meta)}</span>` : "") +
    tags +
    `</button>`
  );
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
    el.innerHTML = notes.join("");
    return;
  }
  const shown = viewWorkspaces();
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
  const groups = shown
    .map((ws) => ({
      ws,
      // Running ones (and plain sessions) first, then the stopped agents.
      rows: st.data.sessions
        .filter((s) => s.workspace === ws)
        .map((s, i) => ({ s, i }))
        .sort(
          (a, b) =>
            Number(isStopped(a.s)) - Number(isStopped(b.s)) || a.i - b.i,
        )
        .map((x) => x.s),
    }))
    .filter((g) => g.rows.length > 0);
  const body = groups.length
    ? groups
        .map(
          (g) =>
            `<div class="wsg" data-ws="${esc(g.ws)}"><div class="wsh"><span>${esc(g.ws)}</span><span>${esc(g.rows.length)}</span></div>` +
            g.rows.map(rowHtml).join("") +
            `</div>`,
        )
        .join("")
    : `<div class="none">${esc(t("ag.none.scope", { scope: st.scopeLabel }))}</div>`;
  el.innerHTML =
    notes.join("") +
    body +
    `<div class="aghint" id="agl-hint">${esc(t(`ag.hint.${shownLayout()}`))}</div>`;
  const clear = st.root.querySelector("#ag-clear");
  if (clear) clear.hidden = !visibleRows().some(isStopped);
  // No such workspace: nothing to start an agent in.
  const start = st.root.querySelector("#ag-start");
  if (start) start.hidden = st.data.requested?.known === false;
}

function visibleRows() {
  const shown = new Set(viewWorkspaces());
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

/** The person's layout (GET /api/settings agents_layout), else Focus. */
async function savedLayout() {
  try {
    const r = await fetch("/api/settings", { headers: { accept: "json" } });
    const b = r.ok ? await r.json() : null;
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
    }
  } catch {
    /* the last list stays; the next ask may answer */
  }
  st.scopeLabel = scopeLabelFor(viewWorkspaces());
  paintList();
  paintSub();
  for (const p of st.panes.values()) paintBar(p);
  const strip = st.root.querySelector("#agr > .agtabs");
  if (strip) paintTabs(strip);
  if (!st.root.isConnected) return;
  st.timer = setTimeout(() => {
    if (!document.hidden) void refresh();
    else st.timer = setTimeout(refresh, REFRESH_MS);
  }, REFRESH_MS);
}

const rowOf = (id) => st.data?.sessions?.find((s) => s.id === id) ?? null;

// ── the panes ───────────────────────────────────────────────────────────

async function loadXterm() {
  st.xterm ??= Promise.all([
    import("/vendor/xterm.mjs"),
    import("/vendor/addon-fit.mjs"),
  ]).then(([x, f]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon }));
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
    meta: [r.persona, r.workspace].filter(Boolean).join(" · "),
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
    box.innerHTML = `<div>${esc(t("ag.empty"))}</div>`;
    return;
  }
  const layout = shownLayout();
  const shown = visibleIds();
  box.className = `agp n${Math.max(1, shown.length)}${layout === "tabs" ? " tabs" : ""}`;
  box.dataset.layout = layout;
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
 * Open (or bring forward) the session of a row the person clicked, as the
 * layout says: Focus replaces the pane (`add`: Shift- or ⌘-click, one
 * alongside), Tabs opens a tab, Tile adds a tile.
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
  if (st.panes.has(id)) {
    paintLayout();
    paintList();
    st.panes.get(id).term?.focus();
    return;
  }
  await openPane(id, { front: !(layout === "focus" && add) });
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

function paintBar(p) {
  const r = rowOf(p.id);
  const bar = p.el.querySelector(".bar2");
  const name = r ? paneName(r) : p.label || p.id;
  const where = r
    ? [r.workspace, r.runtime].filter(Boolean).join(" · ")
    : p.workspace || "";
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
  bar.innerHTML =
    `<span class="den-dot ${tone}" aria-hidden="true"></span>` +
    `<b>${esc(name)}</b><span class="where mono">${esc(where)}</span>` +
    (r?.tokenRevoked
      ? `<span class="tagx warn" title="${esc(t("ag.revokedTip"))}">${esc(t("ag.revoked"))}</span>`
      : "") +
    `<span class="x">${reconnect}${stop}${resume}<button type="button" class="den-btn sm" data-act="close" aria-label="${esc(t("ag.detachName", { id: name }))}" title="${esc(t("ag.detach"))}">×</button></span>`;
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

/** The pane's size and the PTY's, on the pane (data-cols, data-pty-cols). */
function markSize(p) {
  if (!p.term) return;
  p.el.dataset.cols = String(p.term.cols);
  p.el.dataset.rows = String(p.term.rows);
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
        paintBar(p);
      } else if (msg?.type === "exit") {
        p.exited = true;
        const code =
          typeof msg.exitCode === "number" ? ` (${msg.exitCode})` : "";
        p.term?.write(`\r\n${t("ag.exitedLine", { code })}\r\n`);
        void refresh();
      }
      return;
    }
    p.term?.write(new Uint8Array(e.data));
  };
  sock.onclose = (e) => {
    if (p.sock !== sock) return;
    p.sock = null;
    if (p.closed) return;
    // Refused before it opened: beyond loopback without a session, the
    // upgrade is 401 (a browser sees only the close).
    if (!opened) void refresh();
    const why =
      e.reason || (opened ? String(e.code) : t("ag.signin", { cli: CLI }));
    p.term?.write(`\r\n${t("ag.lost", { why })}\r\n`);
    p.lost = true;
    paintBar(p);
  };
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
  });
  const fit = new lib.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector(".term .tbox"));
  p.term = term;
  p.fit = fit;
  const enc = new TextEncoder();
  term.onData((d) => {
    if (p.sock?.readyState !== WebSocket.OPEN) return;
    // The one typing wins: another viewer resized the PTY since.
    if (outOfStep(p)) claimSize(p);
    p.sock.send(enc.encode(d));
  });
  term.onResize(() => sendSize(p));
  // Focused (a click, the window coming back): this pane's size.
  el.addEventListener("focusin", () => claimSize(p));
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
    if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
    await refresh();
    if (out?.agent?.sessionId) await openPane(out.agent.sessionId);
  } catch (err) {
    window.denShell?.errorToast?.(err);
    await refresh();
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

// ── Start agent ─────────────────────────────────────────────────────────

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

/** Fill the form for the workspace picked; false when the ask failed. */
async function fillForWorkspace(ws) {
  let data;
  try {
    data = await personasFor(ws);
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return false;
  }
  const form = st.root.querySelector("#ag-form");
  const keep = [
    form.querySelector("#ag-persona").value,
    form.querySelector("#ag-runtime").value,
  ];
  fillStartForm(form, data, t);
  // The persona and runtime picked stay, where the new list still has them.
  const ps = form.querySelector("#ag-persona");
  if (keep[0] && [...ps.options].some((o) => o.value === keep[0])) {
    ps.value = keep[0];
    ps.onchange?.();
  }
  const rs = form.querySelector("#ag-runtime");
  if ([...rs.options].some((o) => o.value === keep[1] && !o.disabled)) {
    rs.value = keep[1];
    rs.onchange?.();
  }
  return true;
}

async function openStart() {
  const dlg = st.root.querySelector("#ag-dlg");
  if (!dlg || dlg.open) return;
  const shown = viewWorkspaces();
  const wsSel = st.root.querySelector("#ag-ws");
  wsSel.innerHTML = shown
    .map((w) => `<option value="${esc(w)}">${esc(w)}</option>`)
    .join("");
  st.root.querySelector("#ag-ws-l").hidden = shown.length <= 1;
  if (!(await fillForWorkspace(wsSel.value || shown[0]))) return;
  if (dlg.open) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

async function submitStart(form) {
  const dlg = st.root.querySelector("#ag-dlg");
  const go = st.root.querySelector("#ag-go");
  if (go.disabled) return;
  const ws = form.querySelector("#ag-ws").value || viewWorkspaces()[0];
  const persona = form.querySelector("#ag-persona").value;
  const runtime = form.querySelector("#ag-runtime").value;
  if (!ws || !persona) return;
  go.disabled = true;
  go.textContent = t("ag.starting");
  try {
    const r = await api(
      "POST",
      `/api/workspaces/${encodeURIComponent(ws)}/agents`,
      {
        persona,
        ...(runtime ? { runtime } : {}),
      },
    );
    window.denShell?.toast?.(t("ag.started", { id: r?.agent?.id ?? persona }));
    dlg.close?.();
    await refresh();
    if (r?.agent?.sessionId) await openPane(r.agent.sessionId);
  } catch (err) {
    window.denShell?.errorToast?.(err);
  } finally {
    go.disabled = false;
    go.textContent = t("ag.go");
  }
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
  set("#ag-clear", "ag.clear");
  set("#ag-dlg-h", "ag.start");
  set("#ag-ws-t", "ag.ws");
  set("#ag-p-t", "ag.persona");
  set("#ag-r-t", "ag.runtime");
  set("#ag-cancel", "ag.cancel");
  set("#ag-go", "ag.go");
  for (const b of root.querySelectorAll("[data-layouts] button")) {
    b.textContent = t(`ag.l.${b.dataset.layout}`);
    b.title = t("ag.l.tip", {
      name: b.textContent,
      key: `⌘${LAYOUTS.indexOf(b.dataset.layout) + 1}`,
    });
  }
  root
    .querySelector("[data-layouts]")
    ?.setAttribute("aria-label", t("ag.layout"));
  const h = root.querySelector("#ag-dlg-h");
  if (h) h.textContent = h.textContent.replace(/^\+\s*/, "");
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

  root.querySelector("#agl").addEventListener("click", (e) => {
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
      if (which === "resume" || which === "fresh" || which === "relaunch")
        void restartRow(r, which, act);
      else if (which === "remove") void removeRow(r, act);
      return;
    }
    const b = e.target.closest(".agr");
    if (!b) return;
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
    if (b.dataset.act === "close") closePane(id);
    else if (b.dataset.act === "stop") void stopAgent(p, b);
    else if (b.dataset.act === "resume") {
      const r = rowOf(id);
      if (r) void restartRow(r, "resume", b);
    } else if (b.dataset.act === "reconnect") void connect(p);
  });
  root.querySelector("#ag-start").addEventListener("click", () => {
    void openStart();
  });
  root.querySelector("#ag-clear")?.addEventListener("click", (e) => {
    void clearStopped(e.currentTarget);
  });
  root.querySelector("#ag-ws").addEventListener("change", (e) => {
    void fillForWorkspace(e.currentTarget.value);
  });
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
    if (e.target.closest("button, textarea")) return;
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
  // ⌘1 / ⌘2 / ⌘3 (Ctrl elsewhere): the layouts, even from a terminal.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const i = ["1", "2", "3"].indexOf(e.key);
      if (i < 0 || st.root.querySelector("#ag-dlg")?.open) return;
      e.preventDefault();
      e.stopPropagation();
      setLayout(LAYOUTS[i]);
    },
    true,
  );
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
