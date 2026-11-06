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
 * Nothing here keeps a session's state: the list is GET /api/sessions,
 * asked again every few seconds while the page is shown.
 */
import { requireUnlock } from "/topbar.js";

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
    if (p.term)
      send(p, { type: "resize", cols: p.term.cols, rows: p.term.rows });
  };
  sock.onmessage = (e) => {
    if (typeof e.data === "string") {
      let msg = null;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg?.type === "session") {
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
  const p = { id, el, term: null, fit: null, sock: null, closed: false };
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
    if (p.sock?.readyState === WebSocket.OPEN) p.sock.send(enc.encode(d));
  });
  term.onResize(({ cols, rows }) => send(p, { type: "resize", cols, rows }));
  const refit = () => {
    try {
      if (el.isConnected && el.clientWidth > 0) fit.fit();
    } catch {
      /* not laid out yet */
    }
  };
  p.ro = new ResizeObserver(() => refit());
  p.ro.observe(el.querySelector(".term"));
  refit();
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
  if (!r?.agent || !requireUnlock()) return;
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

let personasAsked = null;

async function openStart() {
  const dlg = st.root.querySelector("#ag-dlg");
  if (!dlg || dlg.open) return;
  const shown = viewWorkspaces();
  const wsSel = st.root.querySelector("#ag-ws");
  wsSel.innerHTML = shown
    .map((w) => `<option value="${esc(w)}">${esc(w)}</option>`)
    .join("");
  st.root.querySelector("#ag-ws-l").hidden = shown.length <= 1;
  personasAsked ??= api("GET", "/api/personas").catch((err) => {
    personasAsked = null;
    throw err;
  });
  let data;
  try {
    data = await personasAsked;
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return;
  }
  st.root.querySelector("#ag-persona").innerHTML = (data.personas ?? [])
    .map(
      (p) =>
        `<option value="${esc(p.id)}">${esc(p.id)}${p.role ? ` — ${esc(p.role)}` : ""}</option>`,
    )
    .join("");
  st.root.querySelector("#ag-runtime").innerHTML =
    `<option value="">${esc(t("ag.runtime.auto"))}</option>` +
    (data.runtimes ?? [])
      .map(
        (r) =>
          `<option value="${esc(r.id)}"${r.available ? "" : " disabled"}>${esc(r.id)}${r.available ? "" : ` — ${esc(t("ag.unavailable"))}`}</option>`,
      )
      .join("");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

async function submitStart(form) {
  if (!requireUnlock()) return;
  const dlg = st.root.querySelector("#ag-dlg");
  const go = st.root.querySelector("#ag-go");
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
  root.querySelector("#ag-cancel").addEventListener("click", () => {
    root.querySelector("#ag-dlg").close?.();
  });
  root.querySelector("#ag-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void submitStart(e.currentTarget);
  });
  // The terminals follow the mode (light, dark) and the theme.
  new MutationObserver(() => {
    for (const p of st.panes.values())
      if (p.term) p.term.options.theme = termTheme();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-mode", "data-theme", "class"],
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
