/**
 * The top bar's Workspace menu and the Switch actions (WS-6.5 to WS-6.8,
 * WS-6.10; 0.4.3). header.js feeds it (the workspaces on this machine, the
 * focus, every health row) and shell.js opens it from the Workspace part.
 * The Workspaces page's list is the same control (the same pick()).
 *
 *   pick(value)          set the focus ("all" or a workspace). It only
 *                        filters; then, per Settings › Workspaces, it shows
 *                        it, asks "Also start <ws>?" or switches.
 *   runSwitch(ws)        Switch: focus it and start its services that aren't
 *                        running. Nothing else stops; no confirmation.
 *   askStopSwitch(ws)    Stop & Switch (the [Switch | ▾] chevron): asks
 *                        first (unless "Don't ask"), lists what stops, what
 *                        starts and what keeps running, needs the lock (R8).
 *
 * A switch runs where its output can stream: the page's switch runner (the
 * Workspaces page sets one). Elsewhere the focus is set and the switch is
 * handed to the Workspaces page for this tab (sessionStorage), as the status
 * drawer's Start is (topbar.js runServiceAction).
 */
import {
  awayDown,
  focusLabel,
  menuRows,
  pickAction,
  pillClass,
  pillText,
  statusesOf,
  stopCount,
  summaryParts,
  summaryDownText,
  switchPlan,
  switchPrefs,
  wsDot,
  EN_FALLBACK,
} from "./workspace-status.js";

export { awayDown, focusLabel };

const SS_SWITCH = "__DEN_CLI__-pending-switch";

const sh = () => (typeof window !== "undefined" ? window.denShell : null);
function enT(key, vars) {
  return String(EN_FALLBACK[key] ?? key).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}
const t = (k, v) => (sh()?.t ? sh().t(k, v) : enT(k, v));
function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function toast(msg) {
  sh()?.toast?.(msg);
}

/** What the menu and the actions know: fed by header.js. */
const S = {
  names: [],
  focus: "all",
  rows: [],
  prefs: null,
  runner: null,
  onFocus: null,
  unlock: () => true,
};

/**
 * header.js: the workspaces on this machine, the focus, the health rows
 * (every workspace's, WS-6.4) and the lock rule (topbar.js requireUnlock).
 */
export function setWorkspaceState(patch) {
  Object.assign(S, patch || {});
  if (open?.kind === "ws") open.redraw();
}

/** The health rows the menu and the plans read (header.js, each paint). */
export function workspaceRows() {
  return S.rows;
}

/** The page's switch runner: fn(ws, { stopOthers, plan }) runs it there. */
export function setSwitchRunner(fn) {
  S.runner = typeof fn === "function" ? fn : null;
}

/**
 * The page's focus handler: fn(value) redraws it for the new focus in
 * place. Without one, a page reloads to show it.
 */
export function setFocusHandler(fn) {
  S.onFocus = typeof fn === "function" ? fn : null;
}

/** The switch another page handed to this one (once, if under a minute old). */
export function takePendingSwitch() {
  try {
    const raw = sessionStorage.getItem(SS_SWITCH);
    sessionStorage.removeItem(SS_SWITCH);
    const a = raw ? JSON.parse(raw) : null;
    if (!a || typeof a.ws !== "string" || Date.now() - a.at > 60_000)
      return null;
    return { ws: a.ws, stopOthers: a.stopOthers === true };
  } catch {
    return null;
  }
}

/** Settings › Workspaces (GET /api/settings `switching`), asked once. */
async function prefs() {
  if (S.prefs) return S.prefs;
  try {
    const r = await fetch("/api/settings");
    S.prefs = switchPrefs(r.ok ? (await r.json()).switching : null);
  } catch {
    S.prefs = switchPrefs(null);
  }
  return S.prefs;
}
async function savePrefs(patch) {
  S.prefs = { ...(await prefs()), ...patch };
  try {
    await sh()?.api?.("POST", "/api/settings", { switching: patch });
  } catch {
    /* the choice holds for this page */
  }
}

/** The sessions and agents (for what keeps running), or none. */
async function sessions() {
  try {
    const r = await fetch("/api/sessions");
    return r.ok ? ((await r.json()).sessions ?? []) : [];
  } catch {
    return [];
  }
}

// ── the menu (WS-6.6) ───────────────────────────────────────────────────────

const CHEV =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 10 5 5 5-5"/></svg>';

/** The split button [Switch | ▾] (WS-6.8): the same in every place. */
export function splitHtml(ws, { primary = false, sm = true } = {}) {
  const cls = `den-btn${sm ? " sm" : ""}${primary ? " primary" : ""}`;
  return (
    `<span class="den-split">` +
    `<button type="button" class="${cls}" data-switch="${esc(ws)}" title="${esc(t("ws.sw.p", { w: ws }))}">${esc(t("ws.sw"))}</button>` +
    `<button type="button" class="${cls} den-chev" data-swmenu="${esc(ws)}" aria-haspopup="menu" aria-label="${esc(t("ws.swMore", { w: ws }))}" title="${esc(t("ws.swMore", { w: ws }))}">${CHEV}</button>` +
    `</span>`
  );
}

/** A status pill (WS-6.3). */
export function pillHtml(st) {
  return `<span class="den-wsp ${pillClass(st)}">${esc(pillText(st, t))}</span>`;
}

/** "n down" in red, or "". */
export function downHtml(st) {
  return st.down
    ? `<span class="den-downn">${esc(t("ws.down", { n: st.down }))}</span>`
    : "";
}

/** "2 running · 1 partial · 1 stopped · services down: 1" for All workspaces. */
export function summaryHtml(statuses) {
  const s = summaryParts(statuses, t);
  return (
    esc(s.text) +
    (s.down
      ? ` · <span class="den-downn">${esc(summaryDownText(s.down, t))}</span>`
      : "")
  );
}

function menuHtml() {
  const sts = statusesOf(S.rows, S.names);
  const row = (r) => {
    const on = r.checked;
    if (r.value === "all")
      return (
        `<div class="den-wsrow"><button type="button" class="den-mi" role="menuitemradio" tabindex="-1" data-focus="all" aria-checked="${on}">` +
        `<span class="den-ck" aria-hidden="true">${on ? "✓" : ""}</span>` +
        `<span class="den-nm">${esc(t("ws.all"))}</span>` +
        `<span class="den-wsum">${summaryHtml(sts)}</span></button></div>`
      );
    const st = sts[r.value];
    return (
      `<div class="den-wsrow"><button type="button" class="den-mi" role="menuitemradio" tabindex="-1" data-focus="${esc(r.value)}" aria-checked="${on}">` +
      `<span class="den-ck" aria-hidden="true">${on ? "✓" : ""}</span>` +
      `<span class="den-dot ${wsDot(st)}" aria-hidden="true"></span>` +
      `<span class="den-nm">${esc(r.value)}</span>${downHtml(st)}${pillHtml(st)}</button>` +
      splitHtml(r.value) +
      `</div>` +
      (r.sep ? '<div class="den-hr" role="separator"></div>' : "")
    );
  };
  return (
    `<div class="den-ml" aria-hidden="true">${esc(t("k.ws"))}</div>` +
    (S.names.length
      ? menuRows(S.focus, S.names).map(row).join("")
      : `<p class="den-mnote">${esc(t("ws.none"))}</p>`) +
    '<div class="den-hr" role="separator"></div>' +
    `<div class="den-foot2">${esc(t("ws.menuFoot"))} <a href="/settings#workspaces" data-pref>${esc(t("ws.pref"))}</a></div>`
  );
}

/** The one popover open (the menu, or the chevron menu over it). */
let open = null;
let sub = null;

function place(pop, anchor, alignRight) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = alignRight ? r.right - w : r.left;
  pop.style.left =
    Math.max(8, Math.min(left, window.innerWidth - w - 8)) + "px";
  const below = r.bottom + (alignRight ? 4 : 6);
  pop.style.top =
    (alignRight && below + h > window.innerHeight
      ? Math.max(8, r.top - h - 4)
      : below) + "px";
}

function closeSub(refocus) {
  if (!sub) return;
  const s = sub;
  sub = null;
  s.el.remove();
  s.anchor.setAttribute("aria-expanded", "false");
  if (refocus && s.anchor.isConnected) s.anchor.focus();
}

/** Close the menu (and its chevron menu). */
export function closeWorkspaceMenu(refocus) {
  closeSub(false);
  if (!open) return;
  const o = open;
  open = null;
  o.el.remove();
  o.anchor.setAttribute("aria-expanded", "false");
  o.anchor.removeAttribute("aria-controls");
  document.removeEventListener("mousedown", o.outside, true);
  window.removeEventListener("resize", o.resize);
  if (refocus && o.anchor.isConnected) o.anchor.focus();
}

function focusables(pop) {
  return [...pop.querySelectorAll("button, a[href]")];
}
function arrowKeys(e, pop, onEscape) {
  const list = focusables(pop);
  const i = list.indexOf(document.activeElement);
  const next =
    e.key === "ArrowDown"
      ? (i + 1) % list.length
      : e.key === "ArrowUp"
        ? (i - 1 + list.length) % list.length
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? list.length - 1
            : -1;
  if (next >= 0 && list.length) {
    e.preventDefault();
    list[next].focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    onEscape();
  }
}

/** Open the Workspace menu under `anchor` (shell.js's Workspace part). */
export function openWorkspaceMenu(anchor) {
  if (open && open.anchor === anchor) return closeWorkspaceMenu(true);
  closeWorkspaceMenu(false);
  const pop = document.createElement("div");
  pop.className = "den-pop den-wsmenu";
  pop.id = "den-pop-ws";
  pop.tabIndex = -1;
  pop.setAttribute("role", "menu");
  pop.setAttribute("aria-label", t("k.ws"));
  pop.innerHTML = menuHtml();
  document.body.appendChild(pop);
  place(pop, anchor, false);
  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", pop.id);
  const outside = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    if (sub && sub.el.contains(e.target)) return;
    closeWorkspaceMenu(false);
  };
  const resize = () => closeWorkspaceMenu(false);
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("resize", resize);
  open = {
    kind: "ws",
    el: pop,
    anchor,
    outside,
    resize,
    redraw() {
      const keep = document.activeElement?.dataset?.focus;
      pop.innerHTML = menuHtml();
      if (keep)
        pop.querySelector(`[data-focus="${CSS.escape(keep)}"]`)?.focus();
    },
  };
  pop.addEventListener("click", onClick);
  pop.addEventListener("keydown", (e) =>
    arrowKeys(e, pop, () => closeWorkspaceMenu(true)),
  );
  (
    pop.querySelector('.den-mi[aria-checked="true"]') ||
    pop.querySelector(".den-mi")
  )?.focus();
  return pop;
}

/** The chevron's menu: Switch, and Stop & Switch. Opens over the menu. */
export function openSwitchMenu(ws, anchor) {
  closeSub(false);
  const pop = document.createElement("div");
  pop.className = "den-pop den-swm";
  pop.setAttribute("role", "menu");
  pop.setAttribute("aria-label", t("ws.swMore", { w: ws }));
  pop.innerHTML =
    `<button type="button" class="den-mi" role="menuitem" data-switch="${esc(ws)}"><b>${esc(t("ws.sw"))}</b><small>${esc(t("ws.sw.p", { w: ws }))}</small></button>` +
    `<button type="button" class="den-mi" role="menuitem" data-stopswitch="${esc(ws)}"><b>${esc(t("ws.ss"))}</b><small>${esc(t("ws.ss.p", { w: ws }))}</small></button>`;
  document.body.appendChild(pop);
  place(pop, anchor, true);
  anchor.setAttribute("aria-expanded", "true");
  sub = { el: pop, anchor };
  const outside = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    document.removeEventListener("mousedown", outside, true);
    if (sub?.el === pop) closeSub(false);
  };
  document.addEventListener("mousedown", outside, true);
  pop.addEventListener("click", onClick);
  pop.addEventListener("keydown", (e) =>
    arrowKeys(e, pop, () => closeSub(true)),
  );
  pop.querySelector("button")?.focus();
  return pop;
}

/**
 * Clicks on [data-focus], [data-switch], [data-swmenu] and
 * [data-stopswitch], wherever they are (the menu, the Workspaces page).
 */
export function onClick(e) {
  const el = e.target.closest?.(
    "[data-focus],[data-switch],[data-swmenu],[data-stopswitch],[data-pref]",
  );
  if (!el) return;
  const d = el.dataset;
  if (d.pref !== undefined) {
    closeWorkspaceMenu(false);
    return; // the link navigates
  }
  e.preventDefault();
  e.stopPropagation();
  if (d.swmenu !== undefined) {
    if (sub && sub.anchor === el) return closeSub(true);
    return void openSwitchMenu(d.swmenu, el);
  }
  closeWorkspaceMenu(false);
  if (d.focus !== undefined) return void pick(d.focus);
  if (d.switch !== undefined) return void runSwitch(d.switch, false);
  if (d.stopswitch !== undefined) return void askStopSwitch(d.stopswitch);
}

// ── dialogs ─────────────────────────────────────────────────────────────────

let dlg = null;
function closeDialog() {
  if (!dlg) return;
  const d = dlg;
  dlg = null;
  d.wrap.remove();
  if (d.back?.isConnected) d.back.focus();
}

/** A modal dialog (.den-dlg): html, then wire(el) hooks its buttons. */
export function dialog(html, wire) {
  closeDialog();
  const back = document.activeElement;
  const wrap = document.createElement("div");
  wrap.className = "den-dlg-wrap";
  wrap.innerHTML = `<div class="den-dlg" role="dialog" aria-modal="true" aria-labelledby="den-dlg-h">${html}</div>`;
  wrap.addEventListener("mousedown", (e) => {
    if (e.target === wrap) closeDialog();
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDialog();
    } else if (e.key === "Tab") {
      const f = focusables(wrap).concat([...wrap.querySelectorAll("input")]);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  document.body.appendChild(wrap);
  dlg = { wrap, back };
  wire(wrap, closeDialog);
  (
    wrap.querySelector(".den-btn.primary") || wrap.querySelector("button")
  )?.focus();
  return wrap;
}

/** The plan as the Stop & Switch dialog lists it: Stops, Starts, Keeps running. */
export function planListHtml(plan) {
  const li = (s) => `<li>${s}</li>`;
  const k = (s) => `<li class="den-k">${esc(s)}</li>`;
  const out = [];
  if (plan.stops.length) {
    out.push(k(t("sw.stops")));
    for (const s of plan.stops)
      out.push(
        li(
          esc(
            t("sw.svcIn", { n: s.addresses.length, w: s.workspace }) +
              ` (${s.repos.join(", ")})`,
          ),
        ),
      );
  }
  if (plan.starts.length) {
    out.push(k(t("sw.starts")));
    out.push(li(esc(t("sw.svcIn", { n: plan.starts.length, w: plan.target }))));
  }
  if (plan.keeps.length || plan.agents.length) {
    out.push(k(t("sw.keeps")));
    for (const r of plan.keeps)
      out.push(
        li(
          `<span class="den-mono">${esc(r.repo)}</span> ${esc(t("sw.shared", { w: r.with.join(", ") }))}`,
        ),
      );
    for (const a of plan.agents)
      out.push(li(esc(t("sw.agents", { n: a.n, w: a.workspace }))));
  }
  return `<ul>${out.join("")}</ul>`;
}

// ── the actions ─────────────────────────────────────────────────────────────

/** Store the focus (POST /api/scope). False when the server said no. */
export async function writeFocus(value) {
  try {
    await sh()?.api?.("POST", "/api/scope", { focus: value });
  } catch (err) {
    if (err?.denApi) {
      err.message = t("ws.viewFailed", { msg: err.message });
      sh()?.errorToast?.(err);
    } else toast(t("ws.viewFailed", { msg: err?.message ?? String(err) }));
    return false;
  }
  S.focus = value;
  try {
    window.dispatchEvent(new CustomEvent("den:focus", { detail: { value } }));
  } catch {
    /* no CustomEvent */
  }
  return true;
}

/** After the focus moved: the page redraws in place, or reloads. */
function shown(value) {
  if (S.onFocus) return S.onFocus(value);
  // The pages whose ?ws= wins (Graph, Agents) name the workspace in the
  // URL, or drop it for All; elsewhere a ?ws= follows too.
  const u = new URL(location.href);
  const urlPage = /^\/(graph|agents)$/.test(u.pathname);
  if (u.searchParams.has("ws") || urlPage) {
    if (value === "all") u.searchParams.delete("ws");
    else u.searchParams.set("ws", value);
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  }
  location.reload();
}

/**
 * Pick a workspace (or All): the focus only (WS-6.1). Then Settings ›
 * Workspaces decides: just show it, ask "Also start <ws>?", or switch.
 */
export async function pick(value) {
  if (value === S.focus) return;
  const plan = switchPlan(value, S.rows, []);
  const act = pickAction((await prefs()).on_pick, plan.starts.length, value);
  // The focus moves first, whatever follows: picking always shows it,
  // even when the switch then waits for the lock.
  if (!(await writeFocus(value))) return;
  if (act === "switch") return runSwitch(value, false, { focused: true });
  if (act === "show") return shown(value);
  dialog(
    `<h2 id="den-dlg-h">${esc(t("ask.title", { w: value }))}</h2>` +
      `<p>${esc(t("ask.p", { w: value }))}</p>` +
      `<ul><li class="den-k">${esc(t("sw.starts"))}</li><li>${esc(t("sw.svcIn", { n: plan.starts.length, w: value }))}</li></ul>` +
      `<div class="den-btns"><label><input type="checkbox" data-x="rem"> ${esc(t("ask.remember"))}</label>` +
      `<button type="button" class="den-btn" data-x="just">${esc(t("ask.just"))}</button>` +
      `<button type="button" class="den-btn primary" data-x="go">${esc(t("ask.go"))}</button></div>`,
    (w, close) => {
      const rem = () => w.querySelector('[data-x="rem"]').checked;
      w.querySelector('[data-x="just"]').onclick = async () => {
        if (rem()) await savePrefs({ on_pick: "show" });
        close();
        shown(value);
      };
      w.querySelector('[data-x="go"]').onclick = async () => {
        if (rem()) await savePrefs({ on_pick: "switch" });
        close();
        runSwitch(value, false);
      };
    },
  );
}

/**
 * Switch (WS-6.7), or Stop & Switch with `stopOthers` (WS-6.8, once it is
 * confirmed): the lock first (R8), then the page's runner, else handed to
 * the Workspaces page.
 */
export async function runSwitch(ws, stopOthers, { focused = false } = {}) {
  const plan = switchPlan(ws, S.rows, stopOthers ? await sessions() : []);
  const nothing = stopOthers
    ? !plan.starts.length && !stopCount(plan)
    : !plan.starts.length;
  if (nothing) {
    if (!(await writeFocus(ws))) return;
    toast(t(stopOthers ? "sw.nothing" : "sw.already", { w: ws }));
    return shown(ws);
  }
  if (!S.unlock()) {
    // Locked: nothing runs (R8). A pick has moved the focus: show it in
    // place (a reload would close the lock popover).
    if (focused && S.onFocus) S.onFocus(ws);
    return;
  }
  if (S.runner) return S.runner(ws, { stopOthers, plan });
  if (!focused && !(await writeFocus(ws))) return;
  try {
    sessionStorage.setItem(
      SS_SWITCH,
      JSON.stringify({ ws, stopOthers, at: Date.now() }),
    );
  } catch {
    toast(t("toast.openWs"));
    return;
  }
  location.assign(`/local-dev?ws=${encodeURIComponent(ws)}`);
}

/** Stop & Switch (the chevron): asks first, unless "Don't ask". */
export async function askStopSwitch(ws) {
  const p = await prefs();
  const plan = switchPlan(ws, S.rows, await sessions());
  if (!plan.starts.length && !stopCount(plan)) return runSwitch(ws, true);
  if (!p.confirm_stop_switch) return runSwitch(ws, true);
  const locked = S.unlocked ? !S.unlocked() : false;
  dialog(
    `<h2 id="den-dlg-h">${esc(t("sw.title", { w: ws }))}</h2>` +
      `<p>${esc(t("sw.p", { w: ws }))}</p>` +
      planListHtml(plan) +
      (locked ? `<p>🔒 ${esc(t("sw.lock"))}</p>` : "") +
      `<div class="den-btns"><label><input type="checkbox" data-x="noask"> ${esc(t("sw.noask"))}</label>` +
      `<button type="button" class="den-btn" data-x="cancel">${esc(t("sw.cancel"))}</button>` +
      `<button type="button" class="den-btn primary" data-x="go">${esc(t("sw.go"))}</button></div>`,
    (w, close) => {
      w.querySelector('[data-x="cancel"]').onclick = close;
      w.querySelector('[data-x="go"]').onclick = async () => {
        if (w.querySelector('[data-x="noask"]').checked)
          await savePrefs({ confirm_stop_switch: false });
        close();
        runSwitch(ws, true);
      };
    },
  );
}
