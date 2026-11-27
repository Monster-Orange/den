import { oneAtATime } from "/agents-actions.js";
import { paintBar } from "/agents-bar.js";
import { MAX_PANES, api, rowOf, st, t } from "/agents-core.js";
import { knowAgent, refresh } from "/agents-data.js";
import { csrf, cssVar, focusTerm, loadXterm, paintLayout, termTheme } from "/agents-layout.js";
import { paintList, switchToProjectOf, visibleRows } from "/agents-list.js";
import { isStopped, markOpened, paneName } from "/agents-rows.js";
import { claimSize, connect, linkHint, openWeb, outOfStep, personTyped, providePathLinks, refit, remeasure, sendSize, softNewlineOf, takePendingWeb } from "/agents-term.js";
import { markShellUsed, shellUsed, urlWorkspace, writeUrl } from "/agents-url.js";
import { terminalFailText } from "/pty-refusal.js";
import { latestShell } from "/shell-pick.js";
import { wireDrop } from "/term-drop.js";
import { imeOnce, softNewlineKey } from "/term-input.js";
import { lastUsedProject } from "/terminals-list.js";

async function openPane(id, { front = true } = {}) {
  markOpened(id);
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
  el.innerHTML = `<div class="bar2"></div><div class="term"><div class="tbox"></div></div><div class="agto" data-to data-toast-clear></div>`;
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
  knowAgent(p);
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
    // Issue 128: the failed pane goes, so a click on the agent tries again.
    if (!p.closed) closePane(id, { quiet: true });
    window.denShell?.errorToast?.(err);
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
    // OSC 8 links (AG-4b): ⌘/Ctrl-click, http and https only, no confirm.
    linkHandler: {
      activate: (e, uri) => void openWeb(e, uri),
      hover: () => linkHint(p, true),
      leave: () => linkHint(p, false),
      allowNonHttpProtocols: false,
    },
  });
  const fit = new lib.FitAddon();
  term.loadAddon(fit);
  // Plain URLs (AG-4b): the same rule as OSC 8.
  term.loadAddon(
    new lib.WebLinksAddon((e, uri) => void openWeb(e, uri), {
      hover: () => linkHint(p, true),
      leave: () => linkHint(p, false),
    }),
  );
  // D35: the click after xterm's mouseup opens a waiting link.
  el.querySelector(".term").addEventListener("click", takePendingWeb, true);
  term.open(el.querySelector(".term .tbox"));
  p.term = term;
  p.fit = fit;
  const enc = new TextEncoder();
  const typeIn = (d) => {
    if (p.sock?.readyState !== WebSocket.OPEN) return;
    // The one typing wins: another viewer resized the PTY since. Only a
    // person's typing: xterm's own answers to the agent's questions (its
    // kind, the cursor's place: a TUI asks on start, and a view that
    // opens replays them) come here too, and go to the agent as they are.
    if (personTyped(p) && (p.following || outOfStep(p))) claimSize(p, true);
    p.sock.send(enc.encode(d));
  };
  // D54: what a person did in this pane (a key, a paste, IME), heard
  // before xterm turns it into data.
  for (const ev of [
    "keydown",
    "paste",
    "beforeinput",
    "compositionend",
    "drop",
  ])
    el.addEventListener(
      ev,
      (e) => {
        if (!e.isTrusted) return;
        p.inputAt = performance.now();
        markShellUsed(p.id);
      },
      true,
    );
  imeOnce(el, typeIn);
  term.onData(typeIn);
  p.typeIn = typeIn;
  // AG-DROP: a file dropped or pasted here goes to the server; its path is
  // typed at the cursor.
  wireDrop(el, dropOpts(p));
  // AG-4b: Shift+Enter is the runtime's soft newline, never a CR; the
  // layout keys (⌃⇧1-3) are the page's, never the agent's.
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.shiftKey && /^Digit[123]$/.test(e.code ?? ""))
      return false;
    if (
      e.key === "Enter" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      if (e.isComposing) return true;
      e.preventDefault();
      if (softNewlineKey(e)) typeIn(softNewlineOf(p.id));
      return false;
    }
    return true;
  });
  // File paths (AG-4b): links only where the server says they exist in
  // the agent's workspace.
  term.registerLinkProvider({
    provideLinks: (y, done) => void providePathLinks(p, y, done),
  });
  term.onResize(() => sendSize(p));
  // Focused: the keyboard's pane (D40). D54: focus alone never takes the
  // PTY's size (a look at another tab must not redraw the one in use);
  // the first keystroke does.
  el.addEventListener("focusin", () => {
    if (!p.following) claimSize(p);
    st.keyPane = p.id;
  });
  // Issue 448: used means a person's click or key here, never the focus
  // the page gives a pane itself (a load puts the front tab's terminal in
  // focus, which must not make it the one used last).
  el.addEventListener(
    "pointerdown",
    (e) => {
      if (e.isTrusted) markShellUsed(p.id);
    },
    true,
  );
  p.ro = new ResizeObserver(() => refit(p));
  p.ro.observe(el.querySelector(".term"));
  refit(p);
  // The theme's font may still be loading: measure again once it has.
  document.fonts?.ready?.then(() => {
    if (!p.closed) remeasure(p);
  });
  void connect(p);
}

/** AG-DROP: what a pane's drop, paste and Attach need. */
function dropOpts(p) {
  return {
    // The pane's session now: a restart moves the pane to a new one.
    get id() {
      return p.id;
    },
    t,
    csrf,
    name: () => {
      const r = rowOf(p.id);
      return r ? paneName(r) : p.label || p.id;
    },
    // A live session only: its terminal is open and it is running.
    can: () => attachable(p),
    why: () => {
      const r = rowOf(p.id);
      const name = r ? paneName(r) : p.label || p.id;
      return p.exited || p.closed || (r && isStopped(r))
        ? t("ag.up.cant", { name })
        : t("ag.up.cantConn", { name });
    },
    say: (msg) => window.denShell?.toast?.(msg),
    typeIn: (text) => {
      p.typeIn?.(text);
      p.term?.focus();
    },
  };
}

/** A pane that takes a file now: connected, its session not ended. */
function attachable(p) {
  const r = rowOf(p.id);
  return (
    !p.closed &&
    !p.lost &&
    !p.exited &&
    p.sock?.readyState === WebSocket.OPEN &&
    !(r && isStopped(r))
  );
}

function closePane(id, { quiet = false } = {}) {
  const p = st.panes.get(id);
  if (!p) return;
  p.closed = true;
  p.conn?.stop();
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

/**
 * Close a shell: the server ends it as closing its terminal does (HUP,
 * then KILL) and forgets it; its pane closes.
 */
async function closeShell(p, button) {
  const r = rowOf(p.id);
  if (!r || r.kind !== "session") return;
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    await api("POST", `/api/sessions/${encodeURIComponent(r.id)}/close`);
    // Quiet: the pane's own "it keeps running" toast would be wrong here.
    closePane(p.id, { quiet: true });
    window.denShell?.toast?.(t("ag.shellClosed", { id: r.label ?? r.name }));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  } finally {
    void release();
  }
  await refresh();
}

/** Issue 448: the shell bar's New terminal: another shell in its project. */
async function newShell(r, button) {
  await openTerminal(r.workspace, { fresh: true, button });
}

/**
 * D73: /agents?terminal=1 (the rail's Terminal, a project's Terminal
 * here): a plain shell in the project's folder (?ws=, else the one in
 * view), in a pane like an agent's. The pane is in ?open=, so a reload
 * keeps it, and the shell outlives a Den restart (the sessions host).
 * Used once: the URL drops ?terminal=.
 *
 * Issue 448: a shell already running in that project opens again (the
 * one used last) and takes the keyboard; a new one starts only when none
 * runs, or with `fresh` (the shell bar's New terminal).
 */
async function openTerminal(asked = "", { fresh = false, button = null } = {}) {
  // Issue 448: decide on the server's list as it is now (a shell may have
  // ended since this page's last list), and on when each was last typed in.
  if (!fresh) await refresh().catch(() => {});
  const all = st.data?.workspaces ?? [];
  const used = shellUsed();
  // Issue 448: no project named or in view (every project shows): the
  // shell used last, in any of them, before the first project.
  const ws =
    asked ||
    urlWorkspace() ||
    (st.scope && st.scope !== "all" && all.includes(st.scope)
      ? st.scope
      : (fresh ? null : latestShell(visibleRows(), null, used)?.workspace) ||
        // Issue 482: none running: the project a terminal was used in last.
        lastUsedProject(st.data?.sessions ?? [], used, all));
  if (!ws) {
    window.denShell?.toast?.(t("ag.term.failed", { e: t("ag.term.noWs") }));
    return;
  }
  const running = fresh ? null : latestShell(st.data?.sessions ?? [], ws, used);
  if (running) {
    await switchToProjectOf(running);
    await bringShell(running.id);
    return;
  }
  // Issue 1054: the pressed New terminal (when one was) holds the kit's dots.
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    const r = await api(
      "POST",
      `/api/workspaces/${encodeURIComponent(ws)}/sessions`,
    );
    window.denShell?.toast?.(t("ag.term.started", { w: ws }));
    await refresh();
    // #80: a shell in another project: this page switches to it first.
    if (r?.session?.id) await switchToProjectOf(rowOf(r.session.id));
    if (r?.session?.id) await bringShell(r.session.id);
  } catch (err) {
    // Issue 503: never silent; no PTY has its own words.
    window.denShell?.toast?.(terminalFailText(err, t));
  } finally {
    void release();
  }
}

/**
 * Issue 448: shell `id`'s pane in front (opened as a tab when it is not
 * open), with the keyboard once its terminal can take keys.
 */
async function bringShell(id) {
  if (st.panes.has(id)) {
    st.cur = id;
    paintLayout();
    paintList();
    writeUrl();
  } else await openPane(id);
  focusTerm(id);
}


function stopAgent(p, button) {
  const r = rowOf(p.id);
  if (!r?.agent) return;
  return oneAtATime(r, "stop", () => stopAgentNow(r, button));
}

async function stopAgentNow(r, button) {
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
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
  try {
    await refresh();
  } finally {
    void release();
  }
}

export { attachable, bringShell, closePane, closeShell, dropOpts, newShell, openPane, openTerminal, stopAgent, stopAgentNow };
