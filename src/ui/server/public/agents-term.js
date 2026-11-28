import { paintBar } from "/agents-bar.js";
import { CLI, agentPath, esc, rowOf, st, t } from "/agents-core.js";
import { FOLLOW_FOR_MS, forgetPty, refresh } from "/agents-data.js";
import { csrf, cssVar, focusTerm } from "/agents-layout.js";
import { editorUrl, findPaths, isMac, isWebUrl, linkModifier, linkOpen } from "/term-input.js";
import { termPane } from "/term-pane.js";

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
  // D54: a pane another view sizes draws at the PTY's size, never its own
  // box's: Claude Code redraws its prompt by moving the cursor up as many
  // lines as it wrapped at the PTY's width, so any other width leaves a
  // copy of the prompt behind on each redraw.
  if (p.following && p.pty) {
    followPty(p);
    return;
  }
  try {
    p.fit.fit();
  } catch {
    /* not laid out yet */
  }
  markSize(p);
}

/** D54: this pane at the PTY's size (another view sets it). */
function followPty(p) {
  const term = p.term;
  if (!term || !p.pty) return;
  if (term.cols !== p.pty.cols || term.rows !== p.pty.rows)
    term.resize(p.pty.cols, p.pty.rows);
  markSize(p);
  paintFollow(p);
}

/**
 * D54: the chip on a pane another view sizes: "Sized by another view",
 * and Take over (this pane's size, as typing does).
 */
function paintFollow(p) {
  const box = p.el.querySelector(".term");
  if (!box) return;
  p.el.classList.toggle("following", !!p.following);
  let chip = box.querySelector(".agfollow");
  if (!p.following) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement("div");
    chip.className = "agfollow";
    chip.setAttribute("role", "status");
    chip.innerHTML =
      `<span class="agfollow-t"></span>` +
      `<button type="button" class="den-btn sm" data-act="take-size"></button>`;
    chip.querySelector("button").addEventListener("click", (e) => {
      e.preventDefault();
      claimSize(p, true);
      p.term?.focus();
    });
    box.append(chip);
  }
  chip.querySelector(".agfollow-t").textContent = t("ag.size.follow", {
    cols: p.pty?.cols ?? "?",
    rows: p.pty?.rows ?? "?",
  });
  chip.querySelector("button").textContent = t("ag.size.take");
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
function sendSize(p, claim = false) {
  const term = p.term;
  if (!term || p.sock?.readyState !== WebSocket.OPEN || !paneShown(p))
    return false;
  if (term.cols < MIN_COLS || term.rows < MIN_ROWS) return false;
  // D54: a following pane never sizes the PTY (no ping-pong between views).
  if (p.following || !p.decided) return false;
  send(p, {
    type: "resize",
    cols: term.cols,
    rows: term.rows,
    ...(claim ? { claim: true } : {}),
  });
  // D54: until the host says this size back, an older frame (the size on
  // attach) is not another view taking it. The host says a size only when
  // it changes, so an unchanged one is never said back: that is no wait.
  // The same size said again (a claim's refit says it, then the claim)
  // keeps the wait the first one started.
  const at = (z) => !!z && z.cols === term.cols && z.rows === term.rows;
  if (!(at(p.awaiting) && Date.now() < p.awaiting.until))
    p.awaiting = at(p.pty)
      ? null
      : { cols: term.cols, rows: term.rows, until: Date.now() + 3000 };
  if (claim) p.claimedAt = Date.now();
  // What the PTY will be: the server's frame follows (or another
  // viewer's, if it resized after).
  p.pty = { cols: term.cols, rows: term.rows };
  markSize(p);
  return true;
}

/** D54: whether the data xterm just gave came from the person (a key, a paste). */
const PERSON_INPUT_MS = 1000;

function personTyped(p) {
  return (
    p.inputAt !== undefined && performance.now() - p.inputAt < PERSON_INPUT_MS
  );
}

/**
 * This pane is in use (typed in, Take over, just opened): it leads. Fit it
 * to its box and make the PTY its size; any other view follows.
 */
function claimSize(p, claim = false) {
  p.following = false;
  if (claim) p.otherHolds = false;
  if (claim && !p.decided) p.claimLater = true;
  paintFollow(p);
  refit(p);
  sendSize(p, claim);
}

function follow(p) {
  p.following = true;
  if (p.pty) followPty(p);
  else paintFollow(p);
}

const VIEWS_KEY = "den-views";

function keepInTab(k, v) {
  try {
    sessionStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
}

function newViewId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function paneView(id) {
  st.views ??= {};
  if (!st.views[id]) {
    st.views[id] = newViewId();
    keepInTab(VIEWS_KEY, JSON.stringify(st.views));
  }
  return st.views[id];
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

/** The bar's reconnect part: a quiet line while it tries, else a button. */
function reconnectHtml(p) {
  const s = p.recon;
  const btn = `<button type="button" class="den-btn sm" data-act="reconnect">${esc(t("ag.reconnect"))}</button>`;
  if (s?.kind === "retrying")
    return `<span class="ag-recon" role="status">${esc(t("ag.reconnecting"))}</span>`;
  if (s?.kind === "tripped")
    return `<span class="ag-recon" role="status">${esc(t("ag.reconnectGaveUp", { n: s.tries, min: Math.round(st.reconnect.windowMs / 60000) }))}${s.why ? ` (${esc(s.why)})` : ""}</span>${btn}`;
  return p.lost ? btn : "";
}

/** The words a refused terminal gives (term-pane.js refusalOf). */
const PANE_WORDS = {
  signin: () => t("ag.signin", { cli: CLI }),
  refusedUnknown: () => t("ag.refusedUnknown"),
  refusedStatus: (status) => t("ag.refusedStatus", { status }),
  notAnswering: () => t("ag.notAnswering"),
};

/**
 * Pane `p`'s connection to its session (term-pane.js, shared with the
 * __DEN_TITLE__ agent's page): it reconnects on its own after a drop.
 */
function connect(p) {
  if (p.closed) return;
  p.conn ??= termPane({
    id: p.id,
    view: () => paneView(p.id),
    term: () => p.term,
    csrf: (fresh) => csrf(fresh),
    settings: st.reconnect,
    words: PANE_WORDS,
    paint: (r) => {
      p.recon = r;
      p.lost = r.kind === "tripped" || r.kind === "refused";
      paintBar(p);
    },
    onOpen: (sock, again) => {
      p.sock = sock;
      if (again) for (const line of p.notes ?? []) p.term?.write(line);
      p.heardSession = false;
      forgetPty(p);
      p.heardSize = false;
      // D54: who sizes the PTY is decided on the session frame (it says
      // how many view it); until then, this pane waits.
      p.following = false;
      p.decided = false;
      p.claimLater = false;
      refit(p);
    },
    onText: (msg) => paneText(p, msg),
    onClose: ({ opened, refused, why }) => {
      p.sock = null;
      if (!opened) void refresh();
      if (refused) p.term?.write(`\r\n${t("ag.lost", { why })}\r\n`);
    },
  });
  return (st.viewsReady ?? Promise.resolve()).then(() => p.conn?.connect());
}

/** A JSON frame from pane `p`'s session. */
function paneText(p, msg) {
  if (msg?.type === "size") {
    if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      p.heardSize = true;
      const said = (z) => !!z && z.cols === msg.cols && z.rows === msg.rows;
      if (msg.lead === false) {
        if (p.claimedAt && Date.now() - p.claimedAt < 3000) return;
        p.awaiting = null;
      }
      const w = p.awaiting && Date.now() < p.awaiting.until ? p.awaiting : null;
      p.pty = { cols: msg.cols, rows: msg.rows };
      let mine = false;
      if (p.following) p.awaiting = null;
      else if (w) {
        // Still waiting for this pane's own size: an older frame. The
        // PTY will be this pane's.
        mine = true;
        if (said(w)) p.awaiting = null;
        else p.pty = { cols: w.cols, rows: w.rows };
      } else {
        p.awaiting = null;
        mine = said(p.term);
      }
      // D54: another view set it: draw at its size until typed in.
      // Alone, a size this pane didn't say is only an older one (a
      // hidden pane that couldn't say its own yet): never a reason to
      // follow.
      if (!mine && ((p.viewers ?? 1) > 1 || msg.lead === false))
        p.following = true;
      if (p.following) followPty(p);
      else markSize(p);
    }
  } else if (msg?.type === "session") {
    p.label = msg.label;
    p.workspace = msg.workspace;
    p.exited = !!msg.exited;
    p.heardSession = true;
    paintBar(p);
    if (!p.decided) {
      p.decided = true;
      // D54: a lone viewer, or the pane the person just opened, sizes
      // the PTY; another view of a session already in use follows
      // its size until typed in, so opening one never redraws the
      // other. An older server says no count: this pane leads.
      p.viewers = Number.isInteger(msg.viewers) ? msg.viewers : 1;
      const alone = p.viewers <= 1;
      const meant =
        (st.deliberate?.id === p.id || st.deliberate?.id === "*") &&
        Date.now() - st.deliberate.at < 10_000;
      if (meant) st.deliberate = null;
      p.otherHolds = msg.held === true && msg.lead === false;
      if (meant || p.claimLater) claimSize(p, true);
      else if (typeof msg.lead === "boolean") {
        if (msg.lead) claimSize(p);
        else follow(p);
      } else if (alone) claimSize(p);
      else follow(p);
    }
    // D40: the pane the person picked takes the keyboard once the
    // server says its session is live (the first frame), never one
    // that has ended.
    if (st.focusOnOpen === p.id) {
      if (p.exited) st.focusOnOpen = null;
      else focusTerm(p.id, st.claimOnOpen, { ifIdle: st.focusIfIdle });
    }
  } else if (msg?.type === "waiting") {
    // Issue 1311: messages held while the person's draft is on the line.
    const n = Number.isInteger(msg.n) && msg.n > 0 ? msg.n : 0;
    if (n !== (p.draftWaiting ?? 0)) {
      p.draftWaiting = n;
      paintBar(p);
    }
  } else if (msg?.type === "viewers") {
    // D54: the view that sized the PTY went away: this one, alone now,
    // sizes it.
    if (Number.isInteger(msg.n)) {
      p.viewers = msg.n;
      if (p.el) p.el.dataset.viewers = String(msg.n);
      if (msg.n <= 1 && p.following && !p.otherHolds) claimSize(p);
    }
  } else if (msg?.type === "lead") {
    p.otherHolds = !msg.yours && !!msg.held;
    if (msg.yours) {
      if (p.following) claimSize(p);
    } else if (!p.following && !(p.claimedAt > Date.now() - 3000)) follow(p);
  } else if (msg?.type === "exit") {
    p.exited = true;
    // Its agent may continue in a new session (followAgents).
    st.followUntil = Date.now() + FOLLOW_FOR_MS;
    const code = typeof msg.exitCode === "number" ? ` (${msg.exitCode})` : "";
    p.term?.write(`\r\n${t("ag.exitedLine", { code })}\r\n`);
    void refresh();
  }
}

/**
 * What Shift+Enter sends to a pane's session: its row's (the server sends
 * every kind's; a plain session's is Enter). D66: a pane whose row the list
 * no longer has (another workspace in scope, mid-restart) keeps the one it
 * last had, and never knowing one, gets the catalog default, ESC CR. Never
 * a bare CR: that sent the prompt.
 */
const SOFT_NEWLINE_DEFAULT = "\u001b\r";

function softNewlineOf(id) {
  const seq = rowOf(id)?.softNewline;
  const p = st.panes.get(id);
  if (typeof seq === "string" && seq) {
    if (p) p.softNewline = seq;
    return seq;
  }
  return p?.softNewline || SOFT_NEWLINE_DEFAULT;
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
        activate: (e) => void openPath(e, p, r, abs.get(m.path), m.line, m.col),
        hover: () => linkHint(p, true),
        leave: () => linkHint(p, false),
      }));
    done(links.length ? links : undefined);
  } catch {
    done(undefined);
  }
}

const EDITOR_NAMES = { vscode: "VS Code", cursor: "Cursor", zed: "Zed" };

/**
 * A path link clicked with ⌘ (Ctrl elsewhere): a menu at the pointer.
 * Download (AG-DROP-2: the file to this browser's machine, which may not
 * be the agent's), Open in the editor set in Settings (editor_open, at
 * the line, by its URL scheme), Copy path.
 */
function openPath(e, p, r, abs, line, col) {
  if (!linkModifier(e) || !abs || !r?.agent) return;
  e?.preventDefault?.();
  const url = editorUrl(st.editorOpen, abs, line, col);
  window.denShell?.openMenu?.(pathAnchor(p, e), {
    label: abs,
    items: [
      {
        label: t("ag.path.download"),
        onSelect: () => void downloadPath(r, abs),
      },
      ...(url
        ? [
            {
              label: t("ag.path.open", {
                ed: EDITOR_NAMES[st.editorOpen] ?? st.editorOpen,
              }),
              // D35: the same tab, to the editor's own scheme (zed://,
              // vscode://): a navigation, not a new window, so no popup
              // blocker stands in it.
              onSelect: () => window.open(url, "_self"),
            },
          ]
        : []),
      { label: t("ag.path.copy"), onSelect: () => void copyPath(abs) },
    ],
  });
}

async function copyPath(abs) {
  try {
    await navigator.clipboard.writeText(abs);
    window.denShell?.toast?.(t("ag.copied"));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
}

/**
 * AG-DROP-2: the file at `abs` downloads to this browser, from the agent's
 * workspace, cwd or uploads (the server checks; it says so when not).
 */
async function downloadPath(r, abs) {
  const url = `/api/workspaces/${encodeURIComponent(r.workspace)}/agents/${encodeURIComponent(r.agent)}/file?p=${encodeURIComponent(abs)}`;
  const name = abs.split("/").pop() || abs;
  try {
    const h = await fetch(url, { method: "HEAD", credentials: "same-origin" });
    if (!h.ok) throw new Error(t("ag.path.noFile", { name }));
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  window.denShell?.toast?.(t("ag.path.downloading", { name }));
}

/**
 * Where a path's menu opens: a point at the click, made once. Focus that
 * comes back to it (Esc) goes on to the pane's terminal.
 */
function pathAnchor(p, e) {
  let a = document.getElementById("ag-path-anchor");
  if (!a) {
    a = document.createElement("span");
    a.id = "ag-path-anchor";
    a.tabIndex = -1;
    a.setAttribute("aria-hidden", "true");
    a.style.cssText =
      "position:fixed;width:1px;height:1px;pointer-events:none;opacity:0";
    a.addEventListener("focus", () =>
      st.panes.get(a.dataset.pane)?.term?.focus(),
    );
    document.body.append(a);
  }
  a.dataset.pane = p.id;
  a.style.left = `${Math.round(e?.clientX ?? 0)}px`;
  a.style.top = `${Math.round(e?.clientY ?? 0)}px`;
  return a;
}

export { EDITOR_NAMES, MAX_ASK, MIN_COLS, MIN_ROWS, PANE_WORDS, PERSON_INPUT_MS, SOFT_NEWLINE_DEFAULT, VIEWS_KEY, claimSize, connect, copyPath, downloadPath, follow, followPty, keepInTab, linkHint, markSize, newViewId, openPath, openWeb, outOfStep, paintFollow, paneShown, paneText, paneView, pathAnchor, pathLinks, pendingWeb, personTyped, providePathLinks, reconnectHtml, refit, remeasure, send, sendSize, softNewlineOf, takePendingWeb };
