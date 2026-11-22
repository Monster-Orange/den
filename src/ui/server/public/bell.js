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
 *
 * ATTN-5 (den#142): only what needs the person (an agent waiting, a
 * decision, a mention) shows open and counts on the badge. The rest
 * (finished, answers, releases and checks) folds into one Updates row;
 * opening the agent clears its updates.
 */
import { formatTime, formatTitle } from "/kit/time.js";
// den-ui 0.7.0: the bell, its badge and its panel are the kit's; Den
// gives what is in it and what a row does.
import { bellPanelHtml } from "/kit/shell-html.js";
import { hydrateBell } from "/kit/shell-client.js";

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

/** "now", "3 min", "2 h", or the date in the person's zone (issue 206). */
export function bellAgo(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return tr("bell.now");
  if (m < 60) return tr("bell.min", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return tr("bell.h", { n: h });
  return formatTime(iso, { style: "date", now });
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

/**
 * Issue 168: a project's group heading carries its colour, a dot beside its
 * name (the shell knows the colours: denShell.projectColour); "" for the
 * server, Hub and anything else.
 */
function scopeDot(scope) {
  if (!scope.startsWith("workspace/")) return "";
  const pc =
    typeof window !== "undefined"
      ? window.denShell?.projectColour?.(scope.slice("workspace/".length))
      : null;
  return pc
    ? `<i class="den-pc" data-pc="${esc(pc)}" aria-hidden="true"></i>`
    : "";
}

/** The name Hub gave a group's project, from any of its items. */
const groupName = (g) =>
  g.subjects
    ?.flatMap((s) => s.items ?? [])
    .find((n) => typeof n.scopeName === "string" && n.scopeName)?.scopeName ??
  "";

/**
 * Issue 327: a `since` value (an ISO time) reads in the person's chosen
 * zone and the page's language, the kit's way (issue 668); anything else
 * as given.
 */
function localVars(vars) {
  const since = vars?.since;
  if (typeof since !== "string" || Number.isNaN(Date.parse(since))) return vars;
  return { ...vars, since: formatTime(since) };
}

/**
 * What a row says: Den's own items in the page's language (their key and
 * values), else the stored text (Hub's, or an item from before keys).
 */
export function noteText(n) {
  const m = n?.msg;
  if (m && typeof m.key === "string" && /^bell\.m\./.test(m.key)) {
    const said = tr(m.key, localVars(m.vars ?? {}));
    if (said && said !== m.key) return said;
  }
  return n?.text ?? "";
}

/**
 * Issue 167 (mock v6 B3): a line under an item's title that says what it
 * is about; only the pick item has one.
 */
export function noteSub(n) {
  const m = n?.msg;
  if (m?.key !== "bell.m.pick") return "";
  const said = tr("bell.pickBody", { n: m.vars?.n ?? 0 });
  return said && said !== "bell.pickBody" ? said : "";
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
/** An asked question this long shows two lines (its row opens it). */
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
  const sub = noteSub(n);
  const long = n.msg?.key === "bell.m.asked" && text.length > LONG;
  const sw = switchOf(n.kind);
  // Issue 214: a failed scheduled run is an alert while it is unread.
  const alert = !n.read && n.msg?.key === "bell.m.vschedFail";
  return (
    `<div class="den-bell-row${n.read ? " read" : ""}${fold?.rep ? " rep" : ""}" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}"${alert ? ' role="alert"' : ""}>` +
    `<span class="den-dot ${n.read ? "off" : n.kind === "waiting" || alert ? "warn" : "ok"}" aria-hidden="true"></span>` +
    // den#93: the row opens on a click anywhere (its link holds the text,
    // two lines at most for a long question); no separate Open link.
    (link
      ? `<a href="${esc(link)}" data-bell="open"${long ? ' class="den-bell-tw"' : ""}>${long ? `<span class="den-bell-t long">${esc(text)}</span>` : esc(text)}${sub ? `<span class="den-bell-sub">${esc(sub)}</span>` : ""}</a>`
      : `<span class="den-bell-t${long ? " long" : ""}">${esc(text)}</span>`) +
    (fold?.count > 1
      ? `<button type="button" class="den-bell-x" data-bell="fold" data-key="${esc(fold.key)}" aria-expanded="${fold.open}" aria-label="${esc(tr("bell.rep", { n: fold.count - 1 }))}">×${fold.count}</button>`
      : "") +
    // issue 206: the full local date-time on hover.
    `<time datetime="${esc(n.at)}" title="${esc(formatTitle(n.at))}">${esc(bellAgo(n.at))}</time>` +
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

/**
 * Issue 746: the held writes waiting for the person's Allow (`waiting`
 * entries of kind "allow"), oldest first.
 */
export function allowsOf(b) {
  return (b?.waiting ?? []).filter(
    (w) => w && w.kind === "allow" && typeof w.id === "string" && w.id,
  );
}

/**
 * Issue 746: one held write's row, first in Needs you: what it is, who
 * asked, how long it has waited and when it expires, and Allow and Deny.
 * Review opens its details lines under it, the approval dialog's own
 * (shell.js's denApDetailLines). `open`: Review is open.
 */
function allowRowHtml(w, open) {
  const what = String(w.what ?? w.action ?? "");
  const text = w.agent
    ? tr("bell.ap.row", { name: w.agent, what })
    : tr("bell.ap.rowAsk", { what });
  const waits =
    typeof w.since === "string" && typeof w.expiresAt === "string"
      ? tr("bell.ap.waits", {
          ago: bellAgo(w.since),
          time: formatTime(w.expiresAt),
        })
      : "";
  const lines = window.denApDetailLines?.(w) ?? [];
  const det = `den-bell-det-${w.id}`;
  const review = lines.length
    ? `<button type="button" class="den-bell-rv" data-bell="review" data-ap="${esc(w.id)}" aria-expanded="${open ? "true" : "false"}" aria-controls="${esc(det)}">${esc(tr(open ? "ap.hide" : "ap.review"))}</button>` +
      `<div class="den-bell-det" id="${esc(det)}"${open ? "" : " hidden"}>` +
      lines.map((l) => `<div class="den-bell-detl">${esc(l)}</div>`).join("") +
      `</div>`
    : "";
  return (
    `<div class="den-bell-row den-bell-allow" data-kind="allow" data-ap-row="${esc(w.id)}">` +
    `<span class="den-dot warn" aria-hidden="true"></span>` +
    `<span class="den-bell-t">${esc(text)}${waits ? `<span class="den-bell-sub">${esc(waits)}</span>` : ""}${review}</span>` +
    `<button type="button" class="den-btn primary" data-bell="allow" data-ap="${esc(w.id)}">${esc(tr("bell.ap.allow"))}</button>` +
    `<button type="button" class="den-btn" data-bell="deny" data-ap="${esc(w.id)}">${esc(tr("bell.ap.deny"))}</button>` +
    `</div>`
  );
}

/** Issue 746: the Allow rows' own group, heading Needs you. */
function allowsHtml(allows, reviews = new Set()) {
  if (!allows.length) return "";
  return (
    `<section data-scope="allow"><div class="den-bell-sc"><span>${esc(tr("bell.ap.h"))}</span></div>` +
    allows.map((w) => allowRowHtml(w, reviews.has(w.id))).join("") +
    `</section>`
  );
}

/** Issue 746: groups without the held items an Allow row already shows. */
function withoutAllowed(groups, allows) {
  if (!allows.length) return groups;
  const shown = new Set(allows.map((w) => `record:held-${w.id}`));
  return groups
    .map((g) => ({
      ...g,
      subjects: (g.subjects ?? []).filter((s) => !shown.has(s.subject)),
    }))
    .filter((g) => g.subjects.length);
}

/** `needs`: issue 101, a Needs you group has no Mark read. */
function groupsHtml(groups, ui, needs = false) {
  return groups
    .map(
      (g) =>
        `<section data-scope="${esc(g.scope)}"><div class="den-bell-sc"><span>${scopeDot(g.scope)}${esc(scopeLabel(g.scope, groupName(g)))}</span>` +
        (!needs && g.subjects.some((s) => s.items.some((n) => !n.read))
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
 * What the kit's panel shows for GET /api/notifications's answer
 * (bellPanelHtml's options): the heading's buttons, the ⊘'s question, the
 * rows or the empty state, then Updates and Older. `ui`: the ×N folds
 * open, whether Older is open, and the ⊘ being asked about.
 */
export function bellPanel(b, ui = {}) {
  const u = {
    folds: ui.folds ?? new Set(),
    reviews: ui.reviews ?? new Set(),
    older: !!ui.older,
    updates: !!ui.updates,
    ask: ui.ask,
  };
  // Issue 746: what waits for the person's Allow leads Needs you.
  const allows = allowsOf(b);
  const groups = withoutAllowed(b?.groups ?? [], allows);
  const older = b?.older ?? { count: 0, groups: [] };
  const updates = b?.updates ?? { count: 0, unread: 0, groups: [] };
  const all = [...groups, ...(older.groups ?? []), ...(updates.groups ?? [])];
  const actions =
    (b?.unread || updates.unread
      ? `<button type="button" data-bell="all">${esc(tr("bell.markAll"))}</button>`
      : "") +
    (all.some((g) => g.subjects.some((s) => s.items.some((n) => n.read)))
      ? `<button type="button" data-bell="clear">${esc(tr("bell.clearRead"))}</button>`
      : "");
  const panel = {
    title: tr("bell.title"),
    titleId: "den-bell-h",
    actions,
    lead: u.ask ? askHtml(u.ask) : "",
  };
  const off = (b?.off ?? []).map(switchName);
  // ATTN-5: what doesn't need the person folds into one Updates row.
  const updatesHtml = updates.count
    ? `<button type="button" class="den-bell-older den-bell-updates" data-bell="updates" aria-expanded="${u.updates}">${esc(tr("bell.updates", { n: updates.count }))}</button>` +
      (u.updates ? groupsHtml(updates.groups ?? [], u) : "")
    : "";
  if (!allows.length && !groups.length && !older.count && !updates.count)
    return {
      ...panel,
      items: [],
      empty: {
        text: tr("bell.empty"),
        more:
          (off.length
            ? `<p>${esc(tr("bell.notShown", { kinds: off.join(tr("bell.sep")) }))}</p>`
            : "") +
          `<p><a href="${SETTINGS}" data-bell="settings">${esc(tr("bell.settings"))}</a></p>`,
      },
    };
  // Issue 101: the kit heads the two sections; Den gives their rows.
  // Needs you (first, no Mark read: a row stays while the agent waits),
  // then Earlier: Updates and Older, as before.
  return {
    ...panel,
    sections: {
      needs: allowsHtml(allows, u.reviews) + groupsHtml(groups, u, true),
      earlier:
        updatesHtml +
        (older.count
          ? `<button type="button" class="den-bell-older" data-bell="older" aria-expanded="${u.older}">${esc(tr("bell.older", { d: b.foldDays ?? 7, n: older.count }))}</button>` +
            (u.older ? groupsHtml(older.groups ?? [], u) : "")
          : ""),
    },
  };
}

/** The panel's HTML (the kit's bellPanelHtml of bellPanel). */
export function bellHtml(b, ui = {}) {
  return bellPanelHtml(bellPanel(b, ui));
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

async function post(path, body) {
  try {
    await window.denShell?.api?.("POST", path, body);
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
}

/**
 * Issue 746: Allow or Deny from a Needs you row, through the same decide
 * route as the Allow dialog (the page's fetch adds the session's CSRF
 * token and approval key). A toast says what happened.
 */
async function decideHeld(el, decision) {
  const id = el.dataset.ap;
  if (!id) return;
  const btns = el
    .closest(".den-bell-row")
    ?.querySelectorAll("button[data-ap]") ?? [el];
  for (const b of btns) b.disabled = true;
  const again = () => {
    for (const b of btns) b.disabled = false;
  };
  const shell = window.denShell;
  // BUSY-1: the write goes through the working pop-up, which shows a
  // refusal itself and resolves null then.
  const path = `/api/approvals/${encodeURIComponent(id)}/decide`;
  const run = (headers) => shell.api("POST", path, { decision }, { headers });
  let j = null;
  try {
    j = shell?.busyAction
      ? await shell.busyAction(`decide-${decision}`, run, { button: el })
      : await run({});
  } catch (err) {
    shell?.errorToast?.(err);
    again();
    return;
  }
  if (!j) return again();
  const res = j.result;
  if (decision === "allow" && res && res.ok === false)
    shell?.toast?.(tr("bell.ap.failed", { error: res.error || "?" }));
  else
    shell?.toast?.(
      tr(decision === "allow" ? "bell.ap.done" : "bell.ap.denied", {
        what: j.summary ?? "",
      }),
    );
  // The page that asked hears what ran, as from the Allow dialog.
  if (decision === "allow" && res && res.ok !== false)
    window.dispatchEvent(
      new CustomEvent("den:approval-done", {
        detail: { id, action: j.action, result: res },
      }),
    );
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
  // In memory only: a reload starts with every fold closed.
  const ui = {
    folds: new Set(),
    reviews: new Set(),
    older: false,
    updates: false,
    ask: null,
  };
  // The kit's bell (den-ui 0.7.0): its panel on <body>, a click toggles
  // it, Esc or a click outside closes it, focus back on the bell.
  const bell = hydrateBell(btn, {
    lang: () => window.denShell?.lang?.() ?? "en",
    // den#143: its Report footer drawn with it, so a repaint (every
    // refresh while open) doesn't wipe it for a frame.
    panel: () => ({
      ...bellPanel(last ?? { groups: [], unread: 0 }, ui),
      foot: doc.defaultView?.denShell?.reportFoot?.() ?? "",
    }),
    onOpen: () => void refresh(),
    onClose: () => {
      ui.ask = null;
    },
    // Esc in the ⊘'s question cancels it; the panel stays.
    onEscape: () => {
      if (!ui.ask) return false;
      const sw = ui.ask;
      ui.ask = null;
      paint();
      pop.querySelector(`[data-bell="stop"][data-sw="${sw}"]`)?.focus?.();
      return true;
    },
  });
  const pop = bell.el;
  const paint = () => {
    const at = doc.activeElement;
    const keep =
      at && pop.contains(at) && at.dataset?.bell
        ? `[data-bell="${at.dataset.bell}"]` +
          (at.dataset.key ? `[data-key="${CSS.escape(at.dataset.key)}"]` : "") +
          (at.dataset.sw ? `[data-sw="${at.dataset.sw}"]` : "") +
          (at.dataset.ap ? `[data-ap="${CSS.escape(at.dataset.ap)}"]` : "") +
          (at.dataset.scope
            ? `[data-scope="${CSS.escape(at.dataset.scope)}"]`
            : "")
        : "";
    bell.paint();
    if (keep) pop.querySelector(keep)?.focus?.();
  };
  const refresh = async () => {
    const b = await load();
    if (!b) return;
    last = b;
    bell.setCount(b?.unread ?? 0);
    if (bell.isOpen()) paint();
  };
  pop.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-bell]");
    if (!el) {
      // den#93: anywhere else on a row with a link (its dot, its time, the
      // space between) opens it as its link does.
      const a = e.target
        .closest(".den-bell-row")
        ?.querySelector('a[data-bell="open"]');
      if (a) a.click();
      return;
    }
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
    if (what === "review") {
      // Issue 746: a tap opens the held write's lines; another closes them.
      const id = el.dataset.ap;
      if (id && !ui.reviews.delete(id)) ui.reviews.add(id);
      paint();
      return;
    }
    if (what === "allow" || what === "deny") {
      await decideHeld(el, what);
      await refresh();
      return;
    }
    if (what === "all") await post("/api/notifications/read", { all: true });
    else if (what === "clear") await post("/api/notifications/clear", {});
    else if (what === "scope")
      await post("/api/notifications/read", { scope: el.dataset.scope });
    else if (what === "fold" || what === "older" || what === "updates") {
      if (what === "older") ui.older = !ui.older;
      else if (what === "updates") ui.updates = !ui.updates;
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
  // issue 206: a new time zone pick (Settings) redraws the open panel.
  if (typeof MutationObserver === "function")
    new MutationObserver(() => {
      if (bell.isOpen()) paint();
    }).observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["data-den-tz"],
    });
  // Issue 168: a project's colour changed: the open panel's headings.
  window.addEventListener("den:project-colours-shown", () => {
    if (bell.isOpen()) paint();
  });
  void refresh();
  const timer = setInterval(() => {
    if (doc.visibilityState !== "hidden") void refresh();
  }, POLL_MS);
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pagehide", () => clearInterval(timer));
}
