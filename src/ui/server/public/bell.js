/**
 * NT-3: the bell in the top bar (shell.js draws #den-bell; header.js
 * calls initBell on every page). It reads GET /api/notifications every
 * 5 s and on focus, shows the unread count, and opens a panel grouped by
 * project, then agent, newest first (a waiting agent first). A row opens
 * the agent (its link) and marks it read. Mark all read, Clear read, per
 * project Mark read. Esc or a click outside closes it; focus goes back to
 * the bell.
 *
 * Bell v6 (0.4.45): only the kinds the person has on (Settings ›
 * Notifications) show, and the badge counts only those. Repeats of a kind
 * from one agent fold into one row with ×N; items older than the fold
 * days fold into one "Older than N days" row. A row's ⊘ asks once, then
 * stops showing its kind, with Undo and a link to the settings.
 */
const POLL_MS = 5000;

const tr = (k, v) => window.denShell?.t?.(k, v) ?? k;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** "now", "3 min", "2 h", or the date. */
export function bellAgo(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return tr("bell.now");
  if (m < 60) return tr("bell.min", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return tr("bell.h", { n: h });
  return iso.slice(0, 10);
}

/**
 * A scope's heading: a project's name, Server, or "Hub · <project>" (the
 * name Hub sends, else its slug).
 */
function scopeLabel(scope, name) {
  if (scope === "workspace/den-server") return tr("bell.server");
  if (scope.startsWith("workspace/")) return scope.slice("workspace/".length);
  if (scope.startsWith("hub/")) {
    // NT-6: Hub's scope is "hub/<project>/<space>": the project names it.
    const project = name || scope.slice("hub/".length).split("/")[0];
    return project ? tr("bell.hub", { project }) : tr("bell.hubAll");
  }
  return scope;
}

/** The name Hub gave a group's project, from any of its items. */
const groupName = (g) =>
  g.subjects
    ?.flatMap((s) => s.items ?? [])
    .find((n) => typeof n.scopeName === "string" && n.scopeName)?.scopeName ??
  "";

/**
 * What a row says: Den's own items in the page's language (their key and
 * values), else the stored text (Hub's, or an item from before keys).
 */
export function noteText(n) {
  const m = n?.msg;
  if (m && typeof m.key === "string" && /^bell\.m\./.test(m.key)) {
    const said = tr(m.key, m.vars ?? {});
    if (said && said !== m.key) return said;
  }
  return n?.text ?? "";
}

/** The switch a kind is shown by (src/shared/notifications.ts switchOf). */
const KIND_SWITCH = {
  waiting: "waiting",
  finished: "finished",
  answer: "hub",
  mention: "hub",
  decision: "pick",
  service: "release",
};
export const switchOf = (kind) => KIND_SWITCH[kind] ?? "release";
/** A switch's name: its Settings › Notifications label. */
const switchName = (sw) => tr(`set.notifications.${sw}`);
const SETTINGS = "/settings#notifications";
/** An asked question this long shows two lines and an Open link. */
const LONG = 90;

/** Only Den's own pages, or http(s): a row's link. */
const safeLink = (l) =>
  typeof l === "string" && (/^\/(?!\/)/.test(l) || /^https?:\/\//.test(l))
    ? l
    : "";

/** One item's row; `fold` is its ×N toggle and ⊘, on a kind's first. */
function rowHtml(n, fold) {
  const link = safeLink(n.link);
  const text = noteText(n);
  const long = n.msg?.key === "bell.m.asked" && text.length > LONG;
  const sw = switchOf(n.kind);
  return (
    `<div class="den-bell-row${n.read ? " read" : ""}${fold?.rep ? " rep" : ""}" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}">` +
    `<span class="den-dot ${n.read ? "off" : n.kind === "waiting" ? "warn" : "ok"}" aria-hidden="true"></span>` +
    (link && !long
      ? `<a href="${esc(link)}" data-bell="open">${esc(text)}</a>`
      : `<span class="den-bell-t${long ? " long" : ""}">${esc(text)}` +
        (long && link
          ? ` <a href="${esc(link)}" data-bell="open" class="den-bell-open">${esc(tr("bell.open"))}</a>`
          : "") +
        `</span>`) +
    (fold?.count > 1
      ? `<button type="button" class="den-bell-x" data-bell="fold" data-key="${esc(fold.key)}" aria-expanded="${fold.open}" aria-label="${esc(tr("bell.rep", { n: fold.count - 1 }))}">×${fold.count}</button>`
      : "") +
    `<time datetime="${esc(n.at)}">${esc(bellAgo(n.at))}</time>` +
    (fold && !fold.rep && sw !== "waiting"
      ? `<button type="button" class="den-ib" data-bell="stop" data-sw="${esc(sw)}" title="${esc(tr("bell.stop"))}" aria-label="${esc(tr("bell.stop"))}">⊘</button>`
      : "") +
    `</div>`
  );
}

/** A subject's items: each kind's newest, its repeats folded under ×N. */
function subjectHtml(scope, s, ui) {
  const runs = new Map();
  for (const n of s.items) {
    const r = runs.get(n.kind);
    if (r) r.push(n);
    else runs.set(n.kind, [n]);
  }
  return [...runs.entries()]
    .map(([kind, items]) => {
      const key = JSON.stringify([scope, s.subject, kind]);
      const open = ui.folds.has(key);
      return (
        rowHtml(items[0], { key, count: items.length, open }) +
        (open
          ? items
              .slice(1)
              .map((n) => rowHtml(n, { rep: true }))
              .join("")
          : "")
      );
    })
    .join("");
}

function groupsHtml(groups, ui) {
  return groups
    .map(
      (g) =>
        `<section data-scope="${esc(g.scope)}"><div class="den-bell-sc"><span>${esc(scopeLabel(g.scope, groupName(g)))}</span>` +
        (g.subjects.some((s) => s.items.some((n) => !n.read))
          ? `<button type="button" data-bell="scope" data-scope="${esc(g.scope)}">${esc(tr("bell.read"))}</button>`
          : "") +
        `</div>` +
        g.subjects.map((s) => subjectHtml(g.scope, s, ui)).join("") +
        `</section>`,
    )
    .join("");
}

/** The ⊘'s one question, in the panel. */
function askHtml(sw) {
  const kind = switchName(sw);
  return (
    `<div class="den-bell-ask" role="alertdialog" aria-labelledby="den-bell-askt" aria-describedby="den-bell-askb">` +
    `<p id="den-bell-askt"><b>${esc(tr("bell.askT", { kind }))}</b></p>` +
    `<p id="den-bell-askb">${esc(tr("bell.askB"))}</p>` +
    `<div><button type="button" class="den-btn primary" data-bell="ask-yes" data-sw="${esc(sw)}">${esc(tr("bell.askYes"))}</button>` +
    `<button type="button" class="den-btn" data-bell="ask-no">${esc(tr("bell.cancel"))}</button></div></div>`
  );
}

/**
 * The panel's HTML for GET /api/notifications's answer. `ui`: the ×N
 * folds open, whether Older is open, and the ⊘ being asked about.
 */
export function bellHtml(b, ui = {}) {
  const u = { folds: ui.folds ?? new Set(), older: !!ui.older, ask: ui.ask };
  const groups = b?.groups ?? [];
  const older = b?.older ?? { count: 0, groups: [] };
  const all = [...groups, ...(older.groups ?? [])];
  const head =
    `<div class="den-bell-hd"><h2 id="den-bell-h">${esc(tr("bell.title"))}</h2>` +
    (b?.unread
      ? `<button type="button" data-bell="all">${esc(tr("bell.markAll"))}</button>`
      : "") +
    (all.some((g) => g.subjects.some((s) => s.items.some((n) => n.read)))
      ? `<button type="button" data-bell="clear">${esc(tr("bell.clearRead"))}</button>`
      : "") +
    `</div>` +
    (u.ask ? askHtml(u.ask) : "");
  const off = (b?.off ?? []).map(switchName);
  if (!groups.length && !older.count)
    return (
      head +
      `<div class="den-bell-empty"><p>${esc(tr("bell.empty"))}</p>` +
      (off.length
        ? `<p>${esc(tr("bell.notShown", { kinds: off.join(tr("bell.sep")) }))}</p>`
        : "") +
      `<p><a href="${SETTINGS}" data-bell="settings">${esc(tr("bell.settings"))}</a></p></div>`
    );
  return (
    head +
    groupsHtml(groups, u) +
    (older.count
      ? `<button type="button" class="den-bell-older" data-bell="older" aria-expanded="${u.older}">${esc(tr("bell.older", { d: b.foldDays ?? 7, n: older.count }))}</button>` +
        (u.older ? groupsHtml(older.groups ?? [], u) : "")
      : "")
  );
}

let last = null;

async function load() {
  try {
    const r = await fetch("/api/notifications", {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function paintCount(btn, b) {
  const n = btn.querySelector(".den-bell-n");
  const unread = b?.unread ?? 0;
  if (n) {
    n.hidden = !unread;
    n.textContent = unread > 99 ? "99+" : String(unread);
  }
  btn.setAttribute(
    "aria-label",
    unread ? tr("bell.n", { n: unread }) : tr("bell.title"),
  );
}

async function post(path, body) {
  try {
    await window.denShell?.api?.("POST", path, body);
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
}

/** Wire the bell on this page; a page without #den-bell does nothing. */
export function initBell(doc = document) {
  const btn = doc.getElementById("den-bell");
  if (!btn || btn.dataset.wired) return;
  // SEC-1b: a refusal page (421, signed out) makes no /api call.
  if (window.denShell?.apiOff?.() === true) {
    btn.hidden = true;
    return;
  }
  btn.dataset.wired = "1";
  const pop = doc.createElement("div");
  pop.className = "den-bell-pop";
  pop.id = "den-bell-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", "den-bell-h");
  pop.hidden = true;
  doc.body.appendChild(pop);
  btn.setAttribute("aria-controls", pop.id);

  // In memory only: a reload starts with every fold closed.
  const ui = { folds: new Set(), older: false, ask: null };
  const paint = () => {
    const at = doc.activeElement;
    const keep =
      at && pop.contains(at) && at.dataset?.bell
        ? `[data-bell="${at.dataset.bell}"]` +
          (at.dataset.key ? `[data-key="${CSS.escape(at.dataset.key)}"]` : "") +
          (at.dataset.sw ? `[data-sw="${at.dataset.sw}"]` : "") +
          (at.dataset.scope
            ? `[data-scope="${CSS.escape(at.dataset.scope)}"]`
            : "")
        : "";
    pop.innerHTML = bellHtml(last ?? { groups: [], unread: 0 }, ui);
    if (keep) pop.querySelector(keep)?.focus?.();
  };
  const refresh = async () => {
    const b = await load();
    if (!b) return;
    last = b;
    paintCount(btn, b);
    if (!pop.hidden) paint();
  };
  const close = (focus = true) => {
    if (pop.hidden) return;
    pop.hidden = true;
    ui.ask = null;
    btn.setAttribute("aria-expanded", "false");
    if (focus) btn.focus();
  };
  const open = async () => {
    paint();
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    (pop.querySelector("a, button") ?? pop).focus?.();
    await refresh();
  };
  btn.addEventListener("click", () => (pop.hidden ? open() : close()));
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || pop.hidden) return;
    // Esc in the ⊘'s question cancels it; the panel stays.
    if (ui.ask) {
      const sw = ui.ask;
      ui.ask = null;
      paint();
      pop.querySelector(`[data-bell="stop"][data-sw="${sw}"]`)?.focus?.();
      return;
    }
    close();
  });
  doc.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target))
      close(false);
  });
  pop.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-bell]");
    if (!el) return;
    const what = el.dataset.bell;
    if (what === "settings") return;
    if (what === "open") {
      const id = el.closest("[data-id]")?.dataset.id;
      // Marked read first; the link then opens the agent.
      if (id)
        void fetch("/api/notifications/read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          keepalive: true,
        }).catch(() => {});
      return;
    }
    e.preventDefault();
    if (what === "all") await post("/api/notifications/read", { all: true });
    else if (what === "clear") await post("/api/notifications/clear", {});
    else if (what === "scope")
      await post("/api/notifications/read", { scope: el.dataset.scope });
    else if (what === "fold" || what === "older") {
      if (what === "older") ui.older = !ui.older;
      else if (!ui.folds.delete(el.dataset.key)) ui.folds.add(el.dataset.key);
      paint();
      return;
    } else if (what === "stop") {
      ui.ask = el.dataset.sw;
      paint();
      pop.querySelector('[data-bell="ask-yes"]')?.focus?.();
      return;
    } else if (what === "ask-no") {
      const sw = ui.ask;
      ui.ask = null;
      paint();
      pop.querySelector(`[data-bell="stop"][data-sw="${sw}"]`)?.focus?.();
      return;
    } else if (what === "ask-yes") {
      const sw = el.dataset.sw;
      ui.ask = null;
      await post("/api/settings", { bell_kinds: { [sw]: false } });
      const kind = switchName(sw);
      window.denShell?.toastAction?.(
        tr("bell.undoMsg", { kind }),
        tr("bell.undo"),
        async () => {
          await post("/api/settings", { bell_kinds: { [sw]: true } });
          await refresh();
        },
        10000,
        { href: SETTINGS, label: tr("bell.settings") },
      );
      btn.focus();
    }
    await refresh();
  });
  void refresh();
  const timer = setInterval(() => {
    if (doc.visibilityState !== "hidden") void refresh();
  }, POLL_MS);
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pagehide", () => clearInterval(timer));
}
