/**
 * The server agent's page (ON-6): this Den's own agent in a terminal pane,
 * framed as the page, with "Open in Agents" as the way out. A fresh Den's
 * first page (the server serves it at /). Its status is GET
 * /api/server-agent (server-agent-routes.ts).
 *
 *  - Fresh, with a runtime that can run it: it starts by itself. It only
 *    reads until the person allows a write (each write is held for the
 *    browser's Allow, ON-3).
 *  - No runtime: the manual path, and how to install a runtime.
 *  - Not fresh and not running: a Start button (never started by itself).
 *  - The runtime picker saves the person's choice (agents.server_runtime).
 *
 * serverAgentView(status) is pure (HTML from the status JSON), so tests
 * need no server.
 */

const t = (key, vars) => globalThis.window?.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const CLI = "__DEN_CLI__";

const RUNNING = new Set(["running", "stopping"]);

/**
 * What the page shows for `status`: its header line, its body, whether
 * the agent starts by itself, and whether a terminal opens.
 *
 *   { sub, body, autoStart, terminal }
 */
export function serverAgentView(s) {
  const running = RUNNING.has(s.state) && !!s.sessionId;
  const hasRuntime = !!s.runtime;
  const sub = s.fresh ? t("sa.sub.fresh") : t("sa.sub");
  const readsOnly = `<p class="note sa-reads" data-note="reads-only">${esc(t("sa.readsOnly"))}</p>`;
  if (running)
    return {
      sub,
      body: readsOnly,
      autoStart: false,
      terminal: s.sessionId,
    };
  if (!hasRuntime)
    return {
      sub,
      body: noRuntimeHtml(s),
      autoStart: false,
      terminal: null,
    };
  // Fresh and never started (or stopped): it starts by itself.
  if (s.fresh)
    return {
      sub,
      body: `<p class="note" data-note="starting">${esc(t("sa.starting"))}</p>${readsOnly}`,
      autoStart: true,
      terminal: null,
    };
  return {
    sub,
    body:
      `<div class="sa-idle" data-note="idle"><p>${esc(t("sa.idle", { name: s.name }))}</p>` +
      `<button type="button" class="den-btn primary" data-act="start">${esc(t("sa.start"))}</button></div>` +
      readsOnly,
    autoStart: false,
    terminal: null,
  };
}

/** No runtime can run it: how to install one, and the manual path. */
function noRuntimeHtml(s) {
  const installs = (s.runtimes ?? [])
    .filter((r) => !r.usable)
    .map(
      (r) =>
        `<li data-runtime="${esc(r.id)}"><b>${esc(r.label ?? r.id)}</b>` +
        (r.available && !r.denTools
          ? ` · ${esc(t("sa.noTools"))}`
          : r.install
            ? ` · <code>${esc(r.install)}</code>`
            : "") +
        `</li>`,
    )
    .join("");
  const manual = (s.manual ?? [])
    .map((c) => `<li><code>${esc(c)}</code></li>`)
    .join("");
  return (
    `<section class="sa-none" data-note="no-runtime"><h2 class="sec">${esc(t("sa.none.h"))}</h2>` +
    `<p>${esc(t("sa.none"))}</p>` +
    (installs ? `<ul class="sa-install">${installs}</ul>` : "") +
    `</section>` +
    `<section class="sa-manual" data-note="manual"><h2 class="sec">${esc(t("sa.manual.h"))}</h2>` +
    `<p>${esc(t("sa.manual"))}</p><ol class="sa-steps">${manual}</ol></section>`
  );
}

/** The runtime picker's options: the usable ones, the chosen one first. */
export function runtimeOptionsHtml(s) {
  const usable = (s.runtimes ?? []).filter((r) => r.usable);
  if (!usable.length) return "";
  return usable
    .map(
      (r) =>
        `<option value="${esc(r.id)}"${s.runtime?.id === r.id ? " selected" : ""}>${esc(r.label ?? r.id)}</option>`,
    )
    .join("");
}

// ── the page ────────────────────────────────────────────────────────────

const st = {
  root: null,
  status: null,
  pane: null,
  starting: false,
  autoTried: false,
};

async function readStatus() {
  try {
    const r = await fetch("/api/server-agent", { headers: { accept: "json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function paint() {
  const s = st.status;
  const sub = st.root.querySelector("#sa-sub");
  const body = st.root.querySelector("#sa-body");
  const open = st.root.querySelector("#sa-open");
  const pick = st.root.querySelector("#sa-runtime");
  body.removeAttribute("aria-busy");
  if (!s) {
    sub.textContent = t("sa.unread");
    body.innerHTML = "";
    return null;
  }
  const v = serverAgentView(s);
  sub.textContent = v.sub;
  body.innerHTML = v.body;
  const opts = runtimeOptionsHtml(s);
  pick.hidden = !opts;
  if (opts) pick.querySelector("select").innerHTML = opts;
  open.hidden = !v.terminal;
  if (v.terminal)
    open.setAttribute("href", `/agents?open=${encodeURIComponent(v.terminal)}`);
  return v;
}

async function refresh() {
  st.status = await readStatus();
  const v = paint();
  if (!v) return;
  if (v.terminal) void openTerminal(v.terminal);
  else closeTerminal();
  // Once per page: a start that ends at once is never retried in a loop.
  if (v.autoStart && !st.autoTried) {
    st.autoTried = true;
    void start();
  }
}

async function start() {
  if (st.starting) return;
  st.starting = true;
  try {
    await window.denShell.api("POST", "/api/server-agent/start", {});
  } catch (err) {
    st.starting = false;
    const body = st.root.querySelector("#sa-body");
    const why = err?.message ?? String(err);
    body.innerHTML = `<p class="note bad" data-note="failed" role="alert">${esc(t("sa.failed", { why, cli: CLI }))}</p>`;
    return;
  }
  st.starting = false;
  await refresh();
}

async function saveRuntime(id) {
  try {
    await window.denShell.api("POST", "/api/server-agent/runtime", {
      runtime: id,
    });
    window.denShell?.toast?.(t("sa.saved"));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

// ── the terminal ────────────────────────────────────────────────────────

function cssVar(name) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || undefined;
}

async function csrf() {
  try {
    const r = await fetch("/api/session", { credentials: "same-origin" });
    const b = r.ok ? await r.json() : null;
    return typeof b?.csrf === "string" ? b.csrf : null;
  } catch {
    return null;
  }
}

function closeTerminal() {
  const p = st.pane;
  if (!p) return;
  st.pane = null;
  p.closed = true;
  p.sock?.close();
  p.term?.dispose();
  p.observer?.disconnect();
  p.el.remove();
}

async function openTerminal(id) {
  if (st.pane?.id === id) return;
  closeTerminal();
  const el = document.createElement("div");
  el.className = "sa-term";
  el.dataset.id = id;
  el.innerHTML = `<div class="tbox"></div>`;
  st.root.querySelector("#sa-pane").appendChild(el);
  const p = { id, el, term: null, fit: null, sock: null, closed: false };
  st.pane = p;
  let lib;
  try {
    const [x, f] = await Promise.all([
      import("/vendor/xterm.mjs"),
      import("/vendor/addon-fit.mjs"),
    ]);
    lib = { Terminal: x.Terminal, FitAddon: f.FitAddon };
  } catch (err) {
    el.innerHTML = `<p class="note">${esc(err?.message ?? String(err))}</p>`;
    return;
  }
  if (p.closed) return;
  const bg = cssVar("--sunken");
  const term = new lib.Terminal({
    fontFamily: cssVar("--mono") ?? "monospace",
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: { background: bg, foreground: cssVar("--text"), cursorAccent: bg },
  });
  const fit = new lib.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector(".tbox"));
  p.term = term;
  p.fit = fit;
  const refit = () => {
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
  };
  refit();
  p.observer = new ResizeObserver(refit);
  p.observer.observe(el);
  const enc = new TextEncoder();
  term.onData((d) => {
    if (p.sock?.readyState === WebSocket.OPEN) p.sock.send(enc.encode(d));
  });
  const size = () => {
    if (p.sock?.readyState === WebSocket.OPEN && term.cols > 1 && term.rows > 1)
      p.sock.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
      );
  };
  term.onResize(size);
  const token = await csrf();
  if (p.closed) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(
    `${proto}//${location.host}/api/sessions/${encodeURIComponent(id)}/io`,
    ["den.io", `den.csrf.${token ?? ""}`],
  );
  sock.binaryType = "arraybuffer";
  p.sock = sock;
  sock.onopen = () => {
    refit();
    size();
    term.focus();
  };
  sock.onmessage = (e) => {
    if (typeof e.data === "string") {
      let msg = null;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg?.type === "exit") {
        term.write(`\r\n${t("ag.exitedLine", { code: "" })}\r\n`);
        setTimeout(() => void refresh(), 1000);
      }
      return;
    }
    term.write(new Uint8Array(e.data));
  };
  sock.onclose = (e) => {
    if (p.closed || p.sock !== sock) return;
    p.sock = null;
    term.write(`\r\n${t("ag.lost", { why: e.reason || String(e.code) })}\r\n`);
  };
}

export async function mountServerAgentPage(root) {
  if (!root) return;
  st.root = root;
  for (const [sel, key] of [
    ["#sa-title", "n.serverAgent"],
    ["#sa-runtime > span", "sa.runsOn"],
    ["#sa-open", "sa.openAgents"],
  ]) {
    const el = root.querySelector(sel);
    if (el) el.textContent = t(key);
  }
  if (window.denShell?.apiOff?.()) return;
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b?.dataset.act === "start") {
      b.disabled = true;
      void start();
    }
  });
  root.querySelector("#sa-runtime select")?.addEventListener("change", (e) => {
    void saveRuntime(e.target.value);
  });
  await refresh();
}
