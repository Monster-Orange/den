import { closePane, openPane } from "/agents-panes.js";
import { paintList } from "/agents-list.js";
import { refresh } from "/agents-data.js";
import { LAYOUTS, MAX_NAME, SERVER_WS, agentPath, api, esc, rowOf, st, t } from "/agents-core.js";
import { isStopped, markOpened, paneName, pcAttr, projName, sessionExtra, stateTone, waitingText } from "/agents-rows.js";
import { refit } from "/agents-term.js";
import { PAGE, shownLayout, viewWorkspaces, visibleIds, writeUrl } from "/agents-url.js";

async function loadXterm() {
  // Issue 128: the browser keeps a module that failed to load as failed,
  // so a try after a failure asks for it at a new address.
  if (st.xterm) return st.xterm;
  // Issue 231: the address already carries Den's version (?v=), so the
  // try number joins it.
  const again = (u) =>
    st.xtermFails
      ? `${u}${u.includes("?") ? "&" : "?"}try=${st.xtermFails}`
      : u;
  const loading = (st.xterm = Promise.all([
    import(again("/vendor/xterm.mjs")),
    import(again("/vendor/addon-fit.mjs")),
    import(again("/vendor/addon-web-links.mjs")),
  ]).then(([x, f, w]) => {
    // 0.4.45: xterm's own words (its input's label, the screen reader's
    // overflow note) through the catalog, xterm's English when it has none.
    const tE = (key, en) => {
      const v = t(key);
      return v && v !== key ? v : en;
    };
    x.Terminal.strings.promptLabel = tE("term.input", "Terminal input");
    x.Terminal.strings.tooMuchOutput = tE(
      "term.tooMuch",
      "Too much output to announce, navigate to rows manually to read",
    );
    return {
      Terminal: x.Terminal,
      FitAddon: f.FitAddon,
      WebLinksAddon: w.WebLinksAddon,
    };
  }));
  // Issue 128: a failed load (Den restarted, the network blipped) is not
  // kept, so the next pane tries again.
  loading.catch(() => {
    if (st.xterm === loading) st.xterm = null;
    st.xtermFails += 1;
  });
  return loading;
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
  const wsName = (ws) =>
    !ws ? "" : ws === SERVER_WS ? t("ag.server") : projName(ws);
  if (!r) return { name: p?.label || id, meta: wsName(p?.workspace) };
  if (r.kind !== "agent")
    return {
      name: r.label,
      meta: [t("ag.session"), wsName(r.workspace)].join(" · "),
    };
  return {
    name: paneName(r),
    meta: [r.persona, wsName(r.workspace), sessionExtra(r)]
      .filter(Boolean)
      .join(" · "),
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
      if (sr) {
        sr.hidden = !r?.waiting;
        if (r?.waiting) sr.textContent = `${waitingText(r)}: `;
      }
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
        `<button type="button" role="tab" class="agtab" data-id="${esc(id)}"${r ? pcAttr(r.workspace) : ""} aria-selected="${on}" tabindex="${on ? 0 : -1}" aria-keyshortcuts="Delete"${rename}>` +
        `<span class="den-dot ${tone}" aria-hidden="true"></span>` +
        `<span class="den-sr"${r?.waiting ? "" : " hidden"}>${esc(r?.waiting ? waitingText(r) : t("ag.waiting"))}: </span>` +
        `<span class="tn">${esc(w.name)}</span><span class="tm mono">${esc(w.meta)}</span></button>` +
        // Issue 297: a tablist owns only tabs, so × is the pointer's
        // (out of the tab order and the accessibility tree); the keyboard
        // closes a tab with Delete on it.
        `<button type="button" class="agtab-x" data-act="close" data-id="${esc(id)}" tabindex="-1" aria-hidden="true" aria-label="${esc(t("ag.detachName", { id: w.name }))}" title="${esc(t("ag.detach"))}">×</button>` +
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
    delete box.dataset.ws;
    const view = st.data ? viewWorkspaces() : [];
    box.innerHTML = `<div>${esc(PAGE === "terminal" ? t("tm.empty") : view.length === 1 && view[0] !== SERVER_WS ? t("ag.pickIn", { ws: view[0] }) : t("ag.empty"))}</div>`;
    return;
  }
  const layout = shownLayout();
  const shown = visibleIds();
  box.className = `agp n${Math.max(1, shown.length)}${layout === "tabs" ? " tabs" : ""}`;
  box.dataset.layout = layout;
  // The front agent's workspace: ⌘K lists it first (0.4.17).
  const front = rowOf(st.cur)?.workspace;
  if (front) box.dataset.ws = front;
  else delete box.dataset.ws;
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
 * D40: put the keyboard in pane `id`'s terminal once it can take keys: now
 * when its socket is open, else when it opens (connect). Never a pane
 * whose session ended.
 */
function focusTerm(id, claim = true, { ifIdle = false } = {}) {
  const p = st.panes.get(id);
  if (!p || p.exited || p.closed) return;
  st.claimOnOpen = claim;
  st.focusIfIdle = ifIdle;
  if (p.term && p.sock?.readyState === WebSocket.OPEN && p.heardSession) {
    st.focusOnOpen = null;
    // After the click that picked it has finished with the row; never
    // over a field the person went to since (a double-click's rename).
    const idle = st.focusIfIdle;
    st.focusIfIdle = false;
    st.focusSoon = id;
    requestAnimationFrame(() => {
      if (st.focusSoon !== id) return;
      st.focusSoon = null;
      if (p.closed || p.exited || inField()) return;
      // D58: a link's focus is only for a keyboard that went nowhere yet.
      if (idle && !keyboardIdle()) return;
      p.term?.focus();
    });
  } else st.focusOnOpen = id;
}

/** Double-click a tab: its name becomes an input (Enter saves, Esc doesn't). */
/** Whether the keyboard is still on nothing (the page as it loaded). */
function keyboardIdle() {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

/** Whether the keyboard is in a field on the page (not a terminal's). */
function inField() {
  const a = document.activeElement;
  return !!a?.matches?.(
    'input, select, textarea:not(.xterm-helper-textarea), [contenteditable="true"]',
  );
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
  // busy-ok: the layout is drawn at once; the save follows in the background
  api("POST", "/api/settings", { agents_layout: layout }).catch((err) =>
    window.denShell?.errorToast?.(err),
  );
}

/**
 * Open (or bring forward) the session of a row the person clicked, as the
 * layout says: Focus replaces the pane (`add`: Shift- or ⌘-click, one
 * alongside), Tabs opens a tab, Tile adds a tile. D40: a pick (not an add)
 * puts the keyboard in its terminal; an add keeps it where it was, when
 * that pane is still in sight.
 */
async function pick(id, add) {
  st.picked = true;
  const layout = shownLayout();
  if (layout === "focus" && !add) {
    st.side.clear();
    for (const other of [...st.open])
      if (other !== id) closePane(other, { quiet: true });
  } else if (layout === "focus" && add && st.cur && st.cur !== id)
    st.side.add(id);
  if (!(layout === "focus" && add)) st.cur = id;
  // An add: the keyboard goes back to the terminal that had it (the click
  // on the row took it).
  const back = add && st.keyPane !== id ? st.keyPane : null;
  // A stopped agent's pane (its last output) never takes the keyboard.
  const live = !isStopped(rowOf(id) ?? {});
  if (!add) {
    st.focusOnOpen = live ? id : null;
    st.claimOnOpen = live;
    st.deliberate =
      live && !st.panes.has(id) && (navigator.userActivation?.isActive ?? true)
        ? { id, at: Date.now() }
        : null;
  } else if (st.focusOnOpen === id) st.focusOnOpen = null;
  if (st.panes.has(id)) {
    markOpened(id);
    paintLayout();
    paintList();
    if (!add) {
      if (live) focusTerm(id);
    } else addFocus(back, id);
    return;
  }
  await openPane(id, { front: !(layout === "focus" && add) });
  if (add) addFocus(back, id);
}

/**
 * After an add, the keyboard goes back to the pane that had it, if that
 * pane is still in sight. Where only one pane shows (tabs, a phone) the
 * added one is in front, so the keyboard goes there.
 */
function addFocus(back, id) {
  const shown = visibleIds();
  if (back && shown.includes(back)) focusTerm(back);
  else if (shown.includes(id)) focusTerm(id);
}

function renameTab(tab) {
  const id = tab.dataset.id;
  const r = rowOf(id);
  if (r?.kind !== "agent" || tab.querySelector("input")) return;
  // D58: the clicks of this double-click picked the tab: their terminal
  // focus, still to come, is for this field now.
  if (st.focusOnOpen === id) st.focusOnOpen = null;
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
        // busy-ok: the tab's own field saves on Enter or blur; no button waits
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

export { addFocus, csrf, cssVar, focusTerm, inField, keyboardIdle, loadXterm, paintLayout, paintSwitch, paintTabs, pick, renameTab, setLayout, tabWords, termTheme };
