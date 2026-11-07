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
 * only, behind the lock) is the Workspaces page's own agent route.
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
 * Start agent (AG-0.2, LK-1): the lock is checked before the dialog opens
 * (the server, then the vault: checkUnlock). Locked, the dialog asks for
 * the password inline at its top, and Start unlocks, then starts, without
 * closing anything. The runtime line says what will run, or why it
 * can't, before Start (agent-start.js readiness).
 */
import {
  checkUnlock,
  onLockChange,
  requireUnlock,
  unlockWith,
} from "/topbar.js";
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

/** The most panes at once (the prototype's 2x2). */
export const MAX_PANES = 4;
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
};

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
  u.searchParams.delete("start");
  const s = u.searchParams.toString().replace(/%2C/gi, ",");
  history.replaceState(history.state, "", u.pathname + (s ? `?${s}` : ""));
  paintSub();
}

// ── the list ────────────────────────────────────────────────────────────

/** The workspaces to show: ?ws= (when active), else the scope bar's view. */
function viewWorkspaces() {
  const all = st.data?.workspaces ?? [];
  const ws = new URLSearchParams(location.search).get("ws");
  if (ws && all.includes(ws)) return [ws];
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
  return ["running", "stopping", "stopped", "ended"].includes(state)
    ? t(`ag.state.${state}`)
    : state;
}

function displayName(r) {
  return r.kind === "agent" ? (r.persona ?? r.label) : r.label;
}

// A pane's title and its Close: the agent's display name (AG-10.8), else
// its id, never the persona. There is no display name before AG-10.
function paneName(r) {
  return r.kind === "agent" ? r.displayName || r.agent || r.label : r.label;
}

function rowHtml(r) {
  const open = st.open.includes(r.id);
  const nm =
    r.kind === "agent"
      ? `${esc(displayName(r))}${r.persona && r.persona !== r.label ? ` <span class="id">${esc(r.label)}</span>` : ""}`
      : `${esc(r.label)} <span class="sbdg">${esc(t("ag.session"))}</span>`;
  const right = r.waiting
    ? `<span class="wbdg">${esc(t("ag.waiting"))}</span>`
    : `<span class="st">${esc(stateText(r.state))}</span>`;
  const meta = [r.runtime, r.cwd].filter(Boolean).join(" · ");
  const tags = r.tokenRevoked
    ? `<span class="agtags"><span class="tagx warn" title="${esc(t("ag.revokedTip"))}">${esc(t("ag.revoked"))}</span></span>`
    : "";
  return (
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}" data-state="${esc(r.state)}"` +
    ` aria-pressed="${open}"${r.attachable ? "" : ' aria-disabled="true"'}` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${displayName(r)}` }))}">` +
    `<span class="den-dot ${stateTone(r)}" aria-hidden="true"></span>` +
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
  const groups = shown
    .map((ws) => ({
      ws,
      rows: st.data.sessions.filter((s) => s.workspace === ws),
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
  el.innerHTML = notes.join("") + body;
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
  const ws = new URLSearchParams(location.search).get("ws");
  if (ws && shown.length === 1 && shown[0] === ws) return ws;
  return st.scope === "all" ? t("ag.all") : st.scope;
}

async function refresh() {
  clearTimeout(st.timer);
  try {
    const r = await fetch("/api/sessions", { headers: { accept: "json" } });
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

function paintLayout() {
  const box = st.root.querySelector("#agr");
  const n = st.open.length;
  if (n === 0) {
    box.className = "agempty";
    box.innerHTML = `<div>${esc(t("ag.empty"))}</div>`;
    return;
  }
  box.className = `agp n${n}`;
  const empty = box.querySelector(":scope > div:not(.pane)");
  if (empty) empty.remove();
  // Panes in the URL's order.
  for (const id of st.open) {
    const p = st.panes.get(id);
    if (p) box.appendChild(p.el);
  }
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
  const reconnect = p.lost
    ? `<button type="button" class="den-btn sm" data-act="reconnect">${esc(t("ag.reconnect"))}</button>`
    : "";
  bar.innerHTML =
    `<span class="den-dot ${tone}" aria-hidden="true"></span>` +
    `<b>${esc(name)}</b><span class="where mono">${esc(where)}</span>` +
    (r?.tokenRevoked
      ? `<span class="tagx warn" title="${esc(t("ag.revokedTip"))}">${esc(t("ag.revoked"))}</span>`
      : "") +
    `<span class="x">${reconnect}${stop}<button type="button" class="den-btn sm" data-act="close" aria-label="${esc(t("ag.detachName", { id: name }))}" title="${esc(t("ag.detach"))}">×</button></span>`;
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

/** Whether the PTY is known to have another size than this pane. */
function outOfStep(p) {
  return (
    !!p.pty &&
    !!p.term &&
    (p.pty.cols !== p.term.cols || p.pty.rows !== p.term.rows)
  );
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

async function openPane(id) {
  if (st.panes.has(id)) {
    st.panes.get(id).term?.focus();
    return;
  }
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
  el.innerHTML = `<div class="bar2"></div><div class="term"></div>`;
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
  term.open(el.querySelector(".term"));
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
  if (!r?.agent || !(await requireUnlock())) return;
  button.disabled = true;
  try {
    await api(
      "POST",
      `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/stop`,
    );
    window.denShell?.toast?.(t("ag.stopped", { id: r.agent }));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
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
  // LK-1: the lock before the modal. Locked, its password is asked here.
  paintInlineLock(!(await checkUnlock()));
  if (dlg.open) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  st.root.querySelector("#ag-lock:not([hidden]) input")?.focus();
}

/** Show (or hide) the dialog's inline password field (LK-1). */
function paintInlineLock(locked) {
  const box = st.root?.querySelector("#ag-lock");
  if (!box) return;
  box.hidden = !locked;
  const err = box.querySelector("#ag-lock-err");
  if (!locked) {
    box.querySelector("#ag-lock-pw").value = "";
    err.hidden = true;
  }
}

/**
 * The lock, for Start: the dialog's own field when it shows one (unlock,
 * then go on), else the shell's rule (its popover is in the top layer).
 */
async function unlockForStart(go) {
  const box = st.root.querySelector("#ag-lock");
  if (box.hidden) return requireUnlock();
  if (await checkUnlock()) {
    paintInlineLock(false);
    return true;
  }
  const input = box.querySelector("#ag-lock-pw");
  const err = box.querySelector("#ag-lock-err");
  if (!input.value) {
    err.textContent = t("lock.title");
    err.hidden = false;
    input.focus();
    return false;
  }
  go.disabled = true;
  go.textContent = t("lock.checking");
  const r = await unlockWith(input.value);
  go.disabled = false;
  go.textContent = t("ag.go");
  if (r.ok) {
    paintInlineLock(false);
    return true;
  }
  err.textContent = r.error;
  err.hidden = false;
  input.value = "";
  input.focus();
  return false;
}

async function submitStart(form) {
  const dlg = st.root.querySelector("#ag-dlg");
  const go = st.root.querySelector("#ag-go");
  if (go.disabled) return;
  if (!(await unlockForStart(go))) return;
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
  set("#ag-dlg-h", "ag.start");
  set("#ag-ws-t", "ag.ws");
  set("#ag-p-t", "ag.persona");
  set("#ag-r-t", "ag.runtime");
  set("#ag-cancel", "ag.cancel");
  set("#ag-go", "ag.go");
  set("#ag-lock-t", "lock.pw");
  set("#ag-lock-note", "lock.title");
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
  const startAsked = new URLSearchParams(location.search).get("start") === "1";

  root.querySelector("#agl").addEventListener("click", (e) => {
    const b = e.target.closest(".agr");
    if (!b) return;
    if (b.getAttribute("aria-disabled") === "true") return;
    const id = b.dataset.id;
    if (st.panes.has(id)) st.panes.get(id).term?.focus();
    else void openPane(id);
  });
  root.querySelector("#agr").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.closest(".pane")?.dataset.id;
    const p = id && st.panes.get(id);
    if (!p) return;
    if (b.dataset.act === "close") closePane(id);
    else if (b.dataset.act === "stop") void stopAgent(p, b);
    else if (b.dataset.act === "reconnect") void connect(p);
  });
  root.querySelector("#ag-start").addEventListener("click", () => {
    void openStart();
  });
  root.querySelector("#ag-ws").addEventListener("change", (e) => {
    void fillForWorkspace(e.currentTarget.value);
  });
  // Unlocked elsewhere (the chip, another tab): the field goes.
  onLockChange((unlocked) => {
    if (unlocked) paintInlineLock(false);
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

  await loadScope();
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
