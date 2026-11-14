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
 *  - Its runtime asks to trust its folder (SRV-1b: the server sees the
 *    prompt in its output, status.prompt): Trust and Not now. Trust types
 *    the runtime's yes; Not now types nothing, and the line says the agent
 *    waits for an answer, here or in its terminal.
 *  - Running on Claude on a fresh Den: a line saying to log in to Claude in
 *    the terminal if it asks (Den can't tell whether it is logged in). Which
 *    runtime it runs on is its record's (runningRuntime), never the
 *    picker's: the two differ after the picker changes, or when the runtime
 *    is not found again on a later read.
 *  - Started by itself, but not running yet when the page reads it back:
 *    the page reads again, a few times, until it runs (so the terminal and
 *    its lines come up without a reload).
 *  - Not fresh and not running: a Start button (never started by itself).
 *  - The runtime picker saves the person's choice (agents.server_runtime),
 *    and the model picker beside it (agents.server_model), with only the
 *    runtime's own models.
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
export function serverAgentView(s, o = {}) {
  const running = RUNNING.has(s.state) && !!s.sessionId;
  const hasRuntime = !!s.runtime;
  const sub = s.fresh ? t("sa.sub.fresh") : t("sa.sub");
  const readsOnly = `<p class="note sa-reads" data-note="reads-only">${esc(t("sa.readsOnly"))}</p>`;
  // Den can't tell whether Claude is logged in (ON-6). On a fresh Den's
  // first run, one line above the terminal says a login prompt is
  // expected, so Claude's own login screen never reads as a crash.
  // SRV-1b: the runtime asks once whether to trust the agent's folder.
  // Den never answers for the person (that is the runtime's own file):
  // the person's Trust here types the runtime's yes.
  const trust =
    s.prompt?.kind === "trust"
      ? `<div class="note sa-trust" data-note="trust"><p>${esc(t("sa.trust", { folder: s.prompt.folder }))}</p>` +
        (o.trustLater
          ? `<p data-note="trust-wait">${esc(t("sa.trust.wait"))}</p>`
          : "") +
        `<button type="button" class="den-btn primary" data-act="trust-yes">${esc(t("sa.trust.yes"))}</button>` +
        (o.trustLater
          ? ""
          : ` <button type="button" class="den-btn" data-act="trust-no">${esc(t("sa.trust.no"))}</button>`) +
        `</div>`
      : "";
  const onClaude =
    s.fresh &&
    (running ? (s.runningRuntime ?? s.runtime?.id) : s.runtime?.id) ===
      "den-claude";
  const login =
    trust +
    (onClaude
      ? `<p class="note sa-login" data-note="login">${esc(t("sa.login", { name: s.name }))}</p>`
      : "");
  // 0.4.46 Start fresh: ends its conversation, starts a new one.
  const freshBtn = `<div class="sa-acts"><button type="button" class="den-btn sm" data-act="fresh">${esc(t("sa.fresh"))}</button></div>`;
  if (running)
    return {
      sub,
      body: login + readsOnly + freshBtn,
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
      readsOnly +
      freshBtn,
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

/** The model picker's options: the runtime's own models, the chosen one selected. */
export function modelOptionsHtml(s) {
  const models = s.models ?? [];
  if (!models.length) return "";
  return models
    .map(
      (m) =>
        `<option value="${esc(m.id)}"${s.model === m.id ? " selected" : ""}>${esc(m.label ?? m.id)}</option>`,
    )
    .join("");
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
  /** Reads after a start that came back not running yet. */
  rereads: 0,
  /** SRV-1b: the person chose Not now on the trust prompt. */
  trustLater: false,
  /** The next check for the trust prompt, and the one that hides a stale one. */
  lookTimer: 0,
  staleTimer: 0,
};

/** Gate 0.4.44: the check interval when the server names none (ms). */
const CHECK_MS = 2000;
/** Checks without an answer before a shown prompt counts as stale. */
const STALE_CHECKS = 3;
/** With no prompt showing, checks are this many intervals apart. */
const QUIET_CHECKS = 5;

/**
 * Gate 0.4.44: when to check again for the runtime's trust prompt (ms), or
 * null. While a prompt shows, every interval for as long as the page is
 * open (no count to run out); running with none, five intervals apart (one
 * can come later); never while the agent isn't running or the tab is
 * hidden (it checks again when shown).
 */
export function nextLookMs(running, prompt, hidden, checkMs = CHECK_MS) {
  if (!running || hidden) return null;
  return prompt ? checkMs : checkMs * QUIET_CHECKS;
}

/** How many times, a second apart, a start is read back until it runs. */
const REREADS = 15;

function checkMs() {
  const ms = st.status?.promptCheckMs;
  return typeof ms === "number" && ms >= 100 ? ms : CHECK_MS;
}

async function readStatus() {
  // A check that hangs is no answer: it ends when it would count as stale.
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), checkMs() * STALE_CHECKS);
  try {
    const r = await fetch("/api/server-agent", {
      headers: { accept: "json" },
      signal: ctl.signal,
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(tm);
  }
}

/** Gate 0.4.44: Trust / Not now off the page (a stale or failed check). */
function hideTrust() {
  st.root?.querySelector(".sa-trust")?.remove();
}

function paint() {
  const s = st.status;
  const sub = st.root.querySelector("#sa-sub");
  const body = st.root.querySelector("#sa-body");
  const open = st.root.querySelector("#sa-open");
  const pick = st.root.querySelector("#sa-runtime");
  const mpick = st.root.querySelector("#sa-model");
  body.removeAttribute("aria-busy");
  if (!s) {
    sub.textContent = t("sa.unread");
    body.innerHTML = "";
    return null;
  }
  const v = serverAgentView(s, { trustLater: st.trustLater });
  sub.textContent = v.sub;
  body.innerHTML = v.body;
  const opts = runtimeOptionsHtml(s);
  pick.hidden = !opts;
  if (opts) pick.querySelector("select").innerHTML = opts;
  const mopts = modelOptionsHtml(s);
  if (mpick) {
    mpick.hidden = !mopts;
    if (mopts) mpick.querySelector("select").innerHTML = mopts;
  }
  open.hidden = !v.terminal;
  if (v.terminal)
    open.setAttribute("href", `/agents?open=${encodeURIComponent(v.terminal)}`);
  return v;
}

/** The next check, from what the last one saw (gate 0.4.44). */
function schedule(v) {
  clearTimeout(st.lookTimer);
  const prompt = st.status?.prompt ?? null;
  // A check that failed while the agent may run: try again soon.
  const ms = st.status
    ? nextLookMs(Boolean(v?.terminal), prompt, document.hidden, checkMs())
    : document.hidden
      ? null
      : checkMs();
  if (ms !== null) st.lookTimer = setTimeout(() => void refresh(), ms);
  // A shown prompt not confirmed again in time is stale: Trust goes.
  clearTimeout(st.staleTimer);
  if (prompt) st.staleTimer = setTimeout(hideTrust, checkMs() * STALE_CHECKS);
}

async function refresh() {
  st.status = await readStatus();
  const v = paint();
  schedule(v);
  if (!v) return;
  if (v.terminal) void openTerminal(v.terminal);
  else closeTerminal();
  // Once per page: a start that ends at once is never retried in a loop.
  if (v.autoStart && !st.autoTried) {
    st.autoTried = true;
    void start();
    return;
  }
  // Started, but not running yet: read again until it is.
  if (st.autoTried && !v.terminal && v.autoStart && st.rereads < REREADS) {
    st.rereads++;
    setTimeout(() => void refresh(), 1000);
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

/**
 * 0.4.46 Start fresh: asks first (its conversation ends), then stops it,
 * removes it and starts a new one, with the working pop-up.
 */
function confirmFresh(name) {
  return new Promise((resolve) => {
    let d = document.getElementById("sa-fresh-dlg");
    if (!d) {
      d = document.createElement("dialog");
      d.id = "sa-fresh-dlg";
      d.className = "sa-fresh-dlg";
      d.setAttribute("role", "alertdialog");
      d.setAttribute("aria-labelledby", "sa-fresh-h");
      document.body.append(d);
    }
    d.innerHTML =
      `<div class="sa-fresh-b"><h2 id="sa-fresh-h" tabindex="-1">${esc(t("sa.fresh.h"))}</h2>` +
      `<p>${esc(t("sa.fresh.q", { name }))}</p>` +
      `<div class="sa-fresh-acts"><button type="button" class="den-btn sm" data-saf="cancel">${esc(t("sa.fresh.cancel"))}</button>` +
      `<button type="button" class="den-btn sm primary" data-saf="go">${esc(t("sa.fresh.go"))}</button></div></div>`;
    const done = (yes) => {
      d.removeEventListener("cancel", onCancel);
      if (d.open && typeof d.close === "function") d.close();
      else d.removeAttribute("open");
      resolve(yes);
    };
    const onCancel = (e) => {
      e.preventDefault();
      done(false);
    };
    d.addEventListener("cancel", onCancel);
    d.querySelector('[data-saf="cancel"]').addEventListener("click", () =>
      done(false),
    );
    d.querySelector('[data-saf="go"]').addEventListener("click", () =>
      done(true),
    );
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
    d.querySelector('[data-saf="cancel"]').focus();
  });
}

async function startFresh(button) {
  const name = st.status?.name ?? "";
  if (!(await confirmFresh(name))) {
    button?.focus();
    return;
  }
  closeTerminal();
  await window.denShell.busyAction({
    button,
    who: "Den",
    title: t("sa.fresh.w", { name }),
    done: t("sa.fresh.done", { name }),
    failed: t("sa.fresh.fail", { name }),
    run: (headers) =>
      window.denShell.api("POST", "/api/server-agent/fresh", {}, { headers }),
  });
  await refresh();
}

async function answerTrust(answer) {
  // Gate 0.4.44: check right before sending; a prompt gone since the last
  // check sends nothing (the server's 409 stays the guard behind this).
  const now = await readStatus();
  if (now?.prompt?.kind !== "trust") {
    st.status = now;
    schedule(paint());
    return;
  }
  try {
    await window.denShell.api("POST", "/api/server-agent/trust", { answer });
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  st.trustLater = answer === "no";
  await refresh();
}

async function saveModel(id) {
  try {
    await window.denShell.api("POST", "/api/server-agent/model", {
      model: id,
    });
    window.denShell?.toast?.(t("sa.saved"));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
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
    ["#sa-model > span", "sa.model"],
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
    if (b?.dataset.act === "fresh") void startFresh(b);
    if (b?.dataset.act === "trust-yes" || b?.dataset.act === "trust-no") {
      b.disabled = true;
      void answerTrust(b.dataset.act === "trust-yes" ? "yes" : "no");
    }
  });
  // Gate 0.4.44: back in view, check at once; hidden, checks pause.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
    else clearTimeout(st.lookTimer);
  });
  root.querySelector("#sa-runtime select")?.addEventListener("change", (e) => {
    void saveRuntime(e.target.value);
  });
  root.querySelector("#sa-model select")?.addEventListener("change", (e) => {
    void saveModel(e.target.value);
  });
  await refresh();
}
