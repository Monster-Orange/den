/**
 * Issue 791: Peek. A click on an agent's row in the bell opens that
 * agent's real terminal in a panel over the page the person is on; they
 * read it and type an answer without leaving their view. Built to Den
 * Design's mock (in Hub, Den project: "Peek: answer one agent without
 * leaving your view (mock)", version 2), its rules table:
 *
 *   - Opens from: a click on a bell row (bell.js). The row's small "Open
 *     in Agents" link still goes to the page. No other entry point yet.
 *   - What it is: the agent's live terminal (the Agents page's attach,
 *     term-pane.js) in the kit's dialog (/kit/dialog.js, with Report).
 *     Typing works and goes only to that agent. The page behind keeps its
 *     place, its tiles and its scroll.
 *   - Seen: opening it counts as looking (the bell marks the agent's
 *     items read; issue 773 brings the seen mark).
 *   - Closes: Esc, the × or a click on the dim area. Focus goes back to
 *     the bell row it came from. Nothing is left open (the socket closes,
 *     the terminal goes).
 *   - Keep it: Open in layout goes to the agent in the Agents layout.
 *   - Another agent needs you: a strip names the next one, with Switch;
 *     switching replaces the panel's agent, never a second panel.
 *   - Finishes or stops: the chip and a strip say so; a stopped agent
 *     offers Restart. The panel stays until the person closes it.
 *   - Phone: a full-screen sheet with a back arrow to the bell (peek.css).
 *
 * The size (issue 791, clause 3): the panel is a second view of the
 * terminal. It never takes the size on open while another view has it:
 * it draws at the PTY's size. Typing in it makes it the active view (the
 * server's last-active-viewer rule, term-size-lead.ts); when it closes,
 * the page's own view takes its size back.
 *
 * The first half of this file is pure (tested without a browser); the
 * browser half opens and runs the panel.
 */
import { dialogHtml } from "/kit/dialog.js";

const tr = (k, v) => window.denShell?.t?.(k, v) ?? k;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** The Agents layout's address for one agent (its deep link, D43). */
export const layoutLink = (agent, workspace) =>
  `/agents?project=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`;

/**
 * What a bell item peeks at: an agent's item whose link is Den's own
 * Agents page (or none). Anything else (Settings, Hub, a record) opens
 * its link as before: null.
 */
export function peekTarget(n) {
  const m = /^agent:(.+)$/.exec(n?.subject ?? "");
  const ws = /^workspace\/(.+)$/.exec(n?.scope ?? "");
  if (!m || !ws) return null;
  const link = n.link;
  if (link !== undefined && link !== null && link !== "") {
    if (typeof link !== "string" || !/^\/agents(?:[?#]|$)/.test(link))
      return null;
    return { agent: m[1], workspace: ws[1], link };
  }
  return { agent: m[1], workspace: ws[1], link: layoutLink(m[1], ws[1]) };
}

/**
 * The next agent that needs the person, other than `agent`: the first in
 * the bell's Needs you (GET /api/notifications's groups), with its name
 * and why from the sessions list. null when there is none.
 */
export function nextNeeding(bell, rows, agent) {
  for (const g of bell?.groups ?? [])
    for (const s of g.subjects ?? [])
      for (const n of s.items ?? []) {
        if (n.kind !== "waiting") continue;
        const t = peekTarget(n);
        if (!t || t.agent === agent) continue;
        const r = (rows ?? []).find(
          (x) => x.kind === "agent" && x.agent === t.agent,
        );
        return {
          ...t,
          name: r?.displayName || t.agent,
          why: r?.waitingWhy ?? "",
        };
      }
  return null;
}

/** A stopped (or ended) row: nothing to answer. */
const stoppedRow = (r) => !!r && (r.exited === true || r.attachable === false);

/**
 * What the panel shows for sessions-list row `r` (null: Den doesn't list
 * the agent) and `ctx`: {conn: connecting | live | failed, projectName,
 * agent (when r is null), wasNeeding (it needed the person when the panel
 * opened), next (nextNeeding's)}.
 */
export function peekView(r, ctx = {}) {
  const name = r?.displayName || r?.agent || r?.label || ctx.agent || "";
  const project = ctx.projectName ?? r?.workspace ?? "";
  const failed = ctx.conn === "failed" || !r;
  const stopped = stoppedRow(r);
  let mark = "work";
  let chip = { kind: "work", text: tr("peek.chipRunning") };
  let strip = null;
  if (stopped) {
    mark = "idle";
    chip = { kind: "idle", text: tr("peek.chipStopped") };
    strip = {
      kind: "bad",
      text: tr("peek.stopped", { name }),
      ...(r.kind === "agent" && r.agent
        ? { act: "restart", label: tr("peek.restart") }
        : {}),
    };
  } else if (r?.waiting) {
    mark = "need";
    chip = {
      kind: "need",
      text: r.waitingWhy
        ? tr("peek.chipNeed", { why: tr(`ag.waiting.${r.waitingWhy}`) })
        : tr("peek.chipNeedPlain"),
    };
  } else if (r && ctx.wasNeeding) {
    mark = "done";
    chip = { kind: "done", text: tr("peek.chipDone") };
    strip = {
      kind: "ok",
      text: tr("peek.finished", { name }),
      act: "close",
      label: tr("dlg.close"),
    };
  }
  if (failed)
    strip = {
      kind: "bad",
      text: tr("peek.noConnect", { name }),
      act: "retry",
      label: tr("peek.retry"),
    };
  else if (!strip && ctx.next)
    strip = {
      kind: "warn",
      text: tr("peek.next", {
        name: ctx.next.name,
        project: ctx.next.workspace,
        why: ctx.next.why
          ? tr(`ag.waiting.${ctx.next.why}`)
          : tr("peek.whyWaiting"),
      }),
      act: "switch",
      label: tr("peek.switch", { name: ctx.next.name }),
      next: ctx.next,
    };
  const typing = ctx.conn === "live" && !stopped && !failed;
  return {
    agent: r?.agent ?? ctx.agent ?? "",
    name,
    project,
    mark,
    chip,
    strip,
    typing,
    body:
      ctx.conn === "connecting" && !failed
        ? tr("peek.connecting", { name })
        : "",
    foot: typing ? tr("peek.footType", { name }) : tr("peek.footEsc"),
  };
}

const MARKS = { need: "!", done: "✓", work: "", idle: "" };

export const markHtml = (v) =>
  `<span class="den-peek-m ${esc(v.mark)}" aria-hidden="true">${MARKS[v.mark] ?? ""}</span>`;

export const chipHtml = (v) =>
  `<span class="den-peek-chip ${esc(v.chip.kind)}">${esc(v.chip.text)}</span>`;

/** The strip under the header: what happened, and its one action. */
export function stripHtml(v) {
  const s = v.strip;
  if (!s) return "";
  const btn = !s.act
    ? ""
    : s.act === "switch"
      ? `<button type="button" class="den-btn sm" data-peek="switch" data-agent="${esc(s.next.agent)}" data-ws="${esc(s.next.workspace)}">${esc(s.label)}</button>`
      : `<button type="button" class="den-btn sm${s.act === "restart" ? " primary" : ""}" data-peek="${esc(s.act)}">${esc(s.label)}</button>`;
  return `<div class="den-peek-strip ${esc(s.kind)}" role="status"><span>${esc(s.text)}</span>${btn}</div>`;
}

export const footHtml = (v) =>
  `<span>${esc(v.foot)}</span><span>${esc([v.name, v.project].filter(Boolean).join(" · "))}</span>`;

/**
 * The whole panel: the kit's dialog frame (kind panel), its header with
 * a back arrow (phone), the state mark, the name, the project, the chip,
 * Open in layout and ×; the strip; the terminal's place; the footer line.
 * The kit adds Report to the footer when it mounts it.
 */
export function peekHtml(v, link) {
  const html = dialogHtml({
    kind: "panel",
    id: "den-peek",
    className: "den-peek",
    // The mock's phone rule, a full-screen sheet: the kit's.
    sheet: true,
    title: v.name,
    subtitle: v.project,
    headActions: [
      {
        label: tr("peek.openInLayout"),
        href: link,
        className: "den-peek-layout",
        attrs: { "data-peek": "layout" },
      },
    ],
    closeLabel: "×",
    closeAttrs: { "aria-label": tr("peek.close"), title: tr("peek.close") },
    body:
      `<div class="den-peek-stripw">${stripHtml(v)}</div>` +
      `<div class="den-peek-term"><div class="den-peek-msg">${esc(v.body)}</div><div class="den-peek-tbox"></div></div>`,
    foot: `<div class="den-peek-foot">${footHtml(v)}</div>`,
  });
  return html
    .replace(
      '<div class="dk-hd">',
      `<div class="dk-hd"><button type="button" class="den-peek-back" data-peek="back" aria-label="${esc(tr("peek.back"))}">‹</button>${markHtml(v)}`,
    )
    .replace('<span class="dk-acts">', `${chipHtml(v)}<span class="dk-acts">`);
}

// ── the browser half ─────────────────────────────────────────────────────

/** The panel open now (one at most): its state. */
let cur = null;

/** Whether a peek is open (the bell asks before it repaints focus). */
export const peekOpen = () => !!cur;

function cssLink() {
  if (document.getElementById("den-peek-css")) return;
  const l = document.createElement("link");
  l.id = "den-peek-css";
  l.rel = "stylesheet";
  l.href = "/peek.css";
  document.head.append(l);
}

async function sessions() {
  try {
    const r = await fetch("/api/sessions", {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (!r.ok) return null;
    return (await r.json())?.sessions ?? null;
  } catch {
    return null;
  }
}

let xterm = null;
let xtermFails = 0;
/** xterm.js and its fit addon (/vendor/*), as the Agents page loads them. */
function loadXterm() {
  if (xterm) return xterm;
  // Issue 128: a module that failed is asked for at a new address.
  const again = (u) => (xtermFails ? `${u}?try=${xtermFails}` : u);
  const loading = (xterm = Promise.all([
    import(again("/vendor/xterm.mjs")),
    import(again("/vendor/addon-fit.mjs")),
  ]).then(([x, f]) => {
    const tE = (key, en) => {
      const v = tr(key);
      return v && v !== key ? v : en;
    };
    x.Terminal.strings.promptLabel = tE("term.input", "Terminal input");
    return { Terminal: x.Terminal, FitAddon: f.FitAddon };
  }));
  loading.catch(() => {
    if (xterm === loading) xterm = null;
    xtermFails += 1;
  });
  return loading;
}

function xtermCss() {
  if (document.querySelector('link[href^="/vendor/xterm.css"]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/vendor/xterm.css";
  document.head.append(l);
}

let csrfTok = null;
async function csrf(fresh) {
  if (csrfTok && !fresh) return csrfTok;
  try {
    const r = await fetch("/api/session", { credentials: "same-origin" });
    const b = r.ok ? await r.json() : null;
    csrfTok = typeof b?.csrf === "string" ? b.csrf : null;
  } catch {
    csrfTok = null;
  }
  return csrfTok;
}

function cssVar(name) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || undefined;
}

const PANE_WORDS = {
  signin: () => tr("ag.signin", { cli: "__DEN_CLI__" }),
  refusedUnknown: () => tr("ag.refusedUnknown"),
  refusedStatus: (status) => tr("ag.refusedStatus", { status }),
  notAnswering: () => tr("ag.notAnswering"),
};

/** The person's keys within this long count as the person typing (ms). */
const PERSON_INPUT_MS = 1000;

/**
 * Open the peek on `target` ({agent, workspace, link}: peekTarget's),
 * from `opener` (the bell row's link: focus goes back to it). `bell()`
 * gives the bell's last answer (for the next agent that needs the
 * person). An open peek switches to `target` instead: never two.
 */
export async function openPeek(target, { opener = null, bell = null } = {}) {
  if (cur) {
    await switchTo(cur, target);
    return cur;
  }
  cssLink();
  xtermCss();
  const { mountDialog } = await import("/dialog-den.js");
  const st = {
    target,
    bell,
    row: null,
    rows: [],
    conn: "connecting",
    wasNeeding: false,
    term: null,
    fit: null,
    pane: null,
    sock: null,
    pty: null,
    viewers: 1,
    following: false,
    inputAt: undefined,
    closed: false,
    handle: null,
  };
  cur = st;
  st.handle = mountDialog(peekHtml(view(st), target.link), {
    opener,
    focus: ".den-peek-back",
    onClose: () => teardown(st),
  });
  const d = st.handle.dialog;
  st.dialog = d;
  wire(st, d);
  await load(st, true);
  void attach(st);
  return st;
}

/** Repaint after the bell's poll (its answer in `b`). */
export function peekRefresh(b) {
  if (!cur) return;
  if (b) cur.lastBell = b;
  void load(cur, false);
}

function view(st) {
  const r = st.row;
  return peekView(r, {
    conn: st.conn,
    projectName: r?.workspace ?? st.target.workspace,
    agent: st.target.agent,
    wasNeeding: st.wasNeeding,
    next: nextNeeding(
      st.lastBell ?? st.bell?.() ?? null,
      st.rows,
      st.target.agent,
    ),
  });
}

async function load(st, first) {
  const rows = await sessions();
  if (st.closed || cur !== st) return;
  if (rows) {
    st.rows = rows;
    st.row =
      rows.find((x) => x.kind === "agent" && x.agent === st.target.agent) ??
      null;
    if (first && st.row?.waiting) st.wasNeeding = true;
  }
  paint(st);
}

/** The parts that change: mark, chip, strip, the line in the body, foot. */
function paint(st) {
  const d = st.dialog;
  if (!d) return;
  const v = view(st);
  const h = d.querySelector(".dk-hd h2");
  if (h && h.textContent !== v.name) h.textContent = v.name;
  const sub = d.querySelector(".dk-sub");
  if (sub && sub.textContent !== v.project) sub.textContent = v.project;
  d.querySelector(".den-peek-m")?.replaceWith(frag(markHtml(v)));
  d.querySelector(".den-peek-chip")?.replaceWith(frag(chipHtml(v)));
  const sw = d.querySelector(".den-peek-stripw");
  const strip = stripHtml(v);
  if (sw && sw.innerHTML !== strip) {
    const had = d.contains(document.activeElement)
      ? document.activeElement?.dataset?.peek
      : null;
    sw.innerHTML = strip;
    if (had && sw.querySelector(`[data-peek="${had}"]`))
      sw.querySelector(`[data-peek="${had}"]`).focus();
  }
  const msg = d.querySelector(".den-peek-msg");
  if (msg) {
    msg.textContent = v.body;
    msg.hidden = !v.body;
  }
  const foot = d.querySelector(".den-peek-foot");
  const fh = footHtml(v);
  if (foot && foot.innerHTML !== fh) foot.innerHTML = fh;
  const layout = d.querySelector('[data-peek="layout"]');
  if (layout) layout.setAttribute("href", st.target.link);
}

function frag(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content.firstElementChild;
}

function wire(st, d) {
  // The bell stays open under the panel (focus goes back to its row):
  // a press in the panel is not a press outside the bell.
  d.addEventListener("pointerdown", (e) => e.stopPropagation());
  // A click on the dim area (the backdrop: the dialog itself, outside
  // its box) closes it.
  d.addEventListener("click", (e) => {
    if (e.target !== d) return;
    const b = d.getBoundingClientRect();
    const inside =
      e.clientX >= b.left &&
      e.clientX <= b.right &&
      e.clientY >= b.top &&
      e.clientY <= b.bottom;
    if (!inside) st.handle.close("cancel");
  });
  d.addEventListener("click", (e) => {
    const el = e.target.closest?.("[data-peek]");
    if (!el || !d.contains(el)) return;
    const what = el.dataset.peek;
    if (what === "back") st.handle.close("cancel");
    else if (what === "layout") {
      // Keep it: the panel goes, and the link opens the agent in the
      // Agents layout (its own default action).
      st.handle.close("layout");
    } else if (what === "close") st.handle.close("close");
    else if (what === "retry") {
      st.conn = "connecting";
      paint(st);
      if (st.pane) st.pane.retry();
      else void load(st, false).then(() => attach(st));
    } else if (what === "switch")
      void switchTo(st, {
        agent: el.dataset.agent,
        workspace: el.dataset.ws,
        link: layoutLink(el.dataset.agent, el.dataset.ws),
      });
    else if (what === "restart") void restart(st, el);
  });
}

/** Restart a stopped agent (its own Resume), then attach to its session. */
async function restart(st, button) {
  const r = st.row;
  if (!r?.agent) return;
  const ok = await window.denShell?.busyAction?.(
    "start-agent",
    (headers) =>
      window.denShell.api(
        "POST",
        `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/resume`,
        undefined,
        { headers },
      ),
    {
      button,
      vars: { name: r.agent },
      success: () => tr("ag.resumed", { id: r.agent }),
    },
  );
  if (!ok || st.closed) return;
  detachTerm(st);
  st.conn = "connecting";
  st.wasNeeding = false;
  await load(st, false);
  void attach(st);
}

/** Switch the one panel to another agent: never a second panel. */
async function switchTo(st, target) {
  if (st.closed) return;
  detachTerm(st);
  st.target = target;
  st.row = null;
  st.conn = "connecting";
  st.wasNeeding = false;
  paint(st);
  await load(st, true);
  void attach(st);
  st.dialog?.querySelector(".dk-hd h2")?.focus?.();
}

/** The live terminal: xterm on the session's io socket (term-pane.js). */
async function attach(st) {
  const r = st.row;
  const d = st.dialog;
  if (st.closed || !d) return;
  if (!r || r.attachable === false) {
    if (!r) st.conn = "failed";
    paint(st);
    return;
  }
  let lib;
  try {
    lib = await loadXterm();
  } catch {
    if (st.closed) return;
    st.conn = "failed";
    paint(st);
    return;
  }
  const [{ termPane, paneSettings }] = await Promise.all([
    import("/term-pane.js"),
  ]);
  if (st.closed || st.row !== r) return;
  const box = d.querySelector(".den-peek-tbox");
  const term = new lib.Terminal({
    fontFamily: cssVar("--mono") ?? "monospace",
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: false,
    scrollback: 5000,
    theme: {
      background: cssVar("--sunken"),
      foreground: cssVar("--text"),
      cursor: cssVar("--accent"),
    },
  });
  const fit = new lib.FitAddon();
  term.loadAddon(fit);
  term.open(box);
  st.term = term;
  st.fit = fit;
  const enc = new TextEncoder();
  // Esc closes the panel (the mock's "Esc closes"): never sent to the
  // agent. Shift+Enter is the runtime's soft newline, as in a pane.
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === "Escape") return false;
    if (
      e.type === "keydown" &&
      e.key === "Enter" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.isComposing
    ) {
      e.preventDefault();
      typeIn(st.row?.softNewline || "\u001b\r");
      return false;
    }
    return true;
  });
  for (const ev of ["keydown", "paste", "beforeinput", "compositionend"])
    box.addEventListener(
      ev,
      (e) => {
        if (e.isTrusted) st.inputAt = performance.now();
      },
      true,
    );
  const typeIn = (data) => {
    if (st.sock?.readyState !== WebSocket.OPEN) return;
    const person =
      st.inputAt !== undefined &&
      performance.now() - st.inputAt < PERSON_INPUT_MS;
    // The one typing leads: it takes the size (the server's rule too).
    if (person && st.following) claim(st);
    st.sock.send(enc.encode(data));
  };
  term.onData(typeIn);
  term.onResize(() => {
    if (!st.following) sendSize(st, false);
  });
  st.pane = termPane({
    id: r.id,
    term: () => st.term,
    csrf: (fresh) => csrf(fresh),
    settings: await paneSettings(),
    words: PANE_WORDS,
    paint: (s) => {
      if (s.kind === "tripped" || s.kind === "refused") {
        st.conn = "failed";
        paint(st);
      }
    },
    onOpen: (sock) => {
      st.sock = sock;
      st.conn = "live";
      st.pty = null;
      paint(st);
    },
    onText: (msg) => onText(st, msg),
    onClose: () => {
      st.sock = null;
    },
  });
  void st.pane.connect();
  term.focus();
}

function fitBox(st) {
  try {
    st.fit?.fit();
  } catch {
    /* not laid out yet */
  }
}

function sendSize(st, claimIt) {
  const t = st.term;
  if (!t || st.sock?.readyState !== WebSocket.OPEN) return;
  if (t.cols < 2 || t.rows < 2) return;
  st.sock.send(
    JSON.stringify({
      type: "resize",
      cols: t.cols,
      rows: t.rows,
      ...(claimIt ? { claim: true } : {}),
    }),
  );
}

/** This panel leads: its box's size. */
function claim(st) {
  st.following = false;
  st.dialog?.classList.remove("following");
  fitBox(st);
  sendSize(st, true);
}

/** Another view leads: draw at the PTY's size (it never redraws). */
function follow(st) {
  st.following = true;
  st.dialog?.classList.add("following");
  const t = st.term;
  if (t && st.pty && (t.cols !== st.pty.cols || t.rows !== st.pty.rows))
    t.resize(st.pty.cols, st.pty.rows);
}

function onText(st, msg) {
  if (msg?.type === "session") {
    st.viewers = Number.isInteger(msg.viewers) ? msg.viewers : 1;
    // Alone, it sizes the PTY; with the page's own view open, it follows.
    if (st.viewers <= 1) claim(st);
    else follow(st);
  } else if (msg?.type === "size") {
    if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return;
    st.pty = { cols: msg.cols, rows: msg.rows };
    const t = st.term;
    const mine = !!t && t.cols === msg.cols && t.rows === msg.rows;
    if (st.following || (!mine && st.viewers > 1) || msg.lead === false)
      follow(st);
  } else if (msg?.type === "viewers") {
    if (Number.isInteger(msg.n)) {
      st.viewers = msg.n;
      if (msg.n <= 1 && st.following) claim(st);
    }
  } else if (msg?.type === "exit") {
    void load(st, false);
  }
}

function detachTerm(st) {
  try {
    st.pane?.stop();
  } catch {
    /* closed */
  }
  st.pane = null;
  st.sock = null;
  try {
    st.term?.dispose();
  } catch {
    /* gone */
  }
  st.term = null;
  st.fit = null;
  st.following = false;
  st.dialog?.classList.remove("following");
}

/** Nothing left open: the socket, the terminal, the panel's state. */
function teardown(st) {
  if (st.closed) return;
  st.closed = true;
  detachTerm(st);
  if (cur === st) cur = null;
}
