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
 * Issue 746: a held write's item (a lapsed request) keeps its action and
 * params: `what` in the page's language, as the Allow dialog words it
 * (shell.js apWhat). An item from before, or a page without apWhat, keeps
 * the stored English `what`.
 */
function heldWhat(vars) {
  const words = window.denApWhat;
  if (typeof vars?.action !== "string" || typeof words !== "function")
    return vars;
  let params = {};
  try {
    params = vars.params ? JSON.parse(String(vars.params)) : {};
  } catch {
    params = {};
  }
  return {
    ...vars,
    what: words({ action: vars.action, params, summary: vars.what }),
  };
}

/** Issue 746: a Needs you entry's request in the page's words. */
function allowWhat(w) {
  const words = window.denApWhat;
  return typeof words === "function"
    ? String(words({ action: w.action, params: w.params, summary: w.what }))
    : String(w.what ?? w.action ?? "");
}

/**
 * What a row says: Den's own items in the page's language (their key and
 * values), else the stored text (Hub's, or an item from before keys).
 */
export function noteText(n) {
  const m = n?.msg;
  if (m && typeof m.key === "string" && /^bell\.m\./.test(m.key)) {
    const said = tr(m.key, heldWhat(localVars(m.vars ?? {})));
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
  // Issue 581: Hub's "shared with you".
  shared: "shared",
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
    // Issue 187: a row that opens on a click looks it (the pointer).
    `<div class="den-bell-row${n.read ? " read" : ""}${fold?.rep ? " rep" : ""}${link ? " opens" : ""}" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}" data-read="${n.read ? "true" : "false"}"${alert ? ' role="alert"' : ""}>` +
    `<span class="den-dot ${n.read ? "off" : n.kind === "waiting" || alert ? "warn" : "ok"}" aria-hidden="true"></span>` +
    // den#93: the row opens on a click anywhere (its link holds the text,
    // two lines at most for a long question); no separate Open link.
    (link
      ? `<a href="${esc(link)}" data-bell="open"${long ? ' class="den-bell-tw"' : ""}>${long ? `<span class="den-bell-t long">${esc(text)}</span>` : esc(text)}${sub ? `<span class="den-bell-sub">${esc(sub)}</span>` : ""}</a>`
      : `<span class="den-bell-t${long ? " long" : ""}">${esc(text)}</span>`) +
    (fold?.count > 1
      ? `<button type="button" class="den-bell-x" data-bell="fold" data-key="${esc(fold.key)}" aria-expanded="${fold.open}" aria-label="${esc(tr("bell.rep", { n: fold.count - 1 }))}">×${fold.count}</button>`
      : "") +
    // Issue 1371 Part 2: a setting an agent changed without asking.
    (n.undo?.approval
      ? `<button type="button" class="den-btn" data-bell="setting-undo" data-ap="${esc(n.undo.approval)}">${esc(tr("bell.undo"))}</button>`
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
  if (w.coach && typeof w.coach === "object") return coachRowHtml(w);
  const what = allowWhat(w);
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
      `<div class="den-bell-det" data-ap-det id="${esc(det)}"${open ? "" : " hidden"}>` +
      lines
        .map((l) => `<div class="den-bell-detl" data-ap-line>${esc(l)}</div>`)
        .join("") +
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

/**
 * Issue 110 (mock v3, in Hub, Den project): a Coach Apply's held write is
 * one card: who asks, the finding it came from, Change, Why, whether it is
 * reversible, then the bell's own Allow and Deny. Every word is a key, its
 * numbers the finding's (Den's, from the stored finding: never an agent's).
 */
function coachRowHtml(w) {
  const c = w.coach;
  const kind = String(c.kind ?? "");
  const vars = { ...(c.vars ?? {}), persona: c.persona ?? "" };
  const row = (label, text) =>
    `<div class="den-bell-cr"><dt>${esc(tr(label))}</dt><dd>${esc(text)}</dd></div>`;
  return (
    `<div class="den-bell-row den-bell-allow den-bell-coach" data-kind="allow" data-bell-coach data-ap-row="${esc(w.id)}">` +
    `<span class="den-dot warn" aria-hidden="true"></span>` +
    `<span class="den-bell-t"><b>${esc(tr("bell.coach.asks", { persona: vars.persona }))}</b>` +
    `<span class="den-bell-sub">${esc(tr("bell.coach.from", { title: tr(`co.f.${kind}.t`, vars) }))}</span>` +
    `<dl class="den-bell-cdl">` +
    row("bell.coach.change", tr(`co.ap.change.${kind}`, vars)) +
    row("bell.coach.why", tr(`co.f.${kind}.why`, vars)) +
    row("bell.coach.rev", tr(`co.ap.rev.${kind}`, vars)) +
    `</dl></span>` +
    `<span class="den-bell-cb">` +
    `<button type="button" class="den-btn primary" data-bell="allow" data-ap="${esc(w.id)}">${esc(tr("bell.ap.allow"))}</button>` +
    `<button type="button" class="den-btn" data-bell="deny" data-ap="${esc(w.id)}">${esc(tr("bell.ap.deny"))}</button>` +
    `</span></div>`
  );
}

/**
 * Issue 993: the gate slots held past the overrun multiple of their
 * estimate (`waiting` entries of kind "gate_overrun"), longest first.
 */
export function overrunsOf(b) {
  return (b?.waiting ?? []).filter(
    (w) => w && w.kind === "gate_overrun" && typeof w.id === "string" && w.id,
  );
}

/**
 * Issue 993: one overrun slot's row: who holds it, what it runs, since
 * when and its estimate, and End (the person-only end route).
 */
function overrunRowHtml(w) {
  const text = tr("bell.go.row", {
    who: String(w.who ?? ""),
    kind: String(w.slot ?? ""),
    label: String(w.label ?? ""),
  });
  const sub =
    typeof w.since === "string"
      ? tr("bell.go.sub", {
          time: formatTime(w.since),
          est: Number(w.estimateMin) || 0,
          over: Number(w.overMin) || 0,
        })
      : "";
  return (
    `<div class="den-bell-row den-bell-allow" data-kind="gate_overrun" data-go-row="${esc(w.id)}">` +
    `<span class="den-dot warn" aria-hidden="true"></span>` +
    `<span class="den-bell-t">${esc(text)}${sub ? `<span class="den-bell-sub">${esc(sub)}</span>` : ""}</span>` +
    `<button type="button" class="den-btn" data-bell="gate-end" data-slot="${esc(w.id)}" data-label="${esc(String(w.label ?? ""))}">${esc(tr("bell.go.end"))}</button>` +
    `</div>`
  );
}

/** Issue 993: the overrun slots' own group, in Needs you. */
function overrunsHtml(list) {
  if (!list.length) return "";
  return (
    `<section data-scope="gate_overrun"><div class="den-bell-sc"><span>${esc(tr("bell.go.h"))}</span></div>` +
    list.map(overrunRowHtml).join("") +
    `</section>`
  );
}

/**
 * Issue 993: End from the bell: the person-only POST /api/gate-slots/end
 * (it records who; an agent is refused there). A toast says what happened.
 */
async function endSlot(el) {
  const id = el.dataset.slot;
  if (!id) return;
  const shell = window.denShell;
  // BUSY-1: through the working pop-up, as the gate chip's End.
  const run = (headers) =>
    shell.api("POST", "/api/gate-slots/end", { id }, { headers });
  try {
    const j = shell?.busyAction
      ? await shell.busyAction("gate-end", run, {
          button: el,
          vars: { name: el.dataset.label ?? "" },
        })
      : await run({});
    if (j) shell?.toast?.(tr("bell.go.ended"));
  } catch (err) {
    shell?.errorToast?.(err);
  }
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
        // Issue 1339: while a Mark read runs, its button stays, held with
        // the kit's dots (data-bell-held, issue 1054), and the others wait.
        (!needs &&
        (ui?.busy === `scope:${g.scope}` ||
          g.subjects.some((s) => s.items.some((n) => !n.read)))
          ? `<button type="button" data-bell="scope" data-scope="${esc(g.scope)}"${ui?.busy === `scope:${g.scope}` ? " data-bell-held" : ui?.busy ? " disabled" : ""}>${esc(tr("bell.read"))}</button>`
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
    busy: ui.busy ?? null,
  };
  // Issue 746: what waits for the person's Allow leads Needs you.
  const allows = allowsOf(b);
  const groups = withoutAllowed(b?.groups ?? [], allows);
  const older = b?.older ?? { count: 0, groups: [] };
  const updates = b?.updates ?? { count: 0, unread: 0, groups: [] };
  const all = [...groups, ...(older.groups ?? []), ...(updates.groups ?? [])];
  // Issue 1339: while its POST runs, the button stays, held with the
  // kit's dots (data-bell-held: paint holds it, issue 1054), and the other
  // one waits too.
  const attr = (what) =>
    u.busy === what ? " data-bell-held" : u.busy ? " disabled" : "";
  const actions =
    (u.busy === "all" || b?.unread || updates.unread
      ? `<button type="button" data-bell="all"${attr("all")}>${esc(tr("bell.markAll"))}</button>`
      : "") +
    (u.busy === "clear" ||
    all.some((g) => g.subjects.some((s) => s.items.some((n) => n.read)))
      ? `<button type="button" data-bell="clear"${attr("clear")}>${esc(tr("bell.clearRead"))}</button>`
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
  if (
    !allows.length &&
    !overrunsOf(b).length &&
    !groups.length &&
    !older.count &&
    !updates.count
  )
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
      needs:
        allowsHtml(allows, u.reviews) +
        overrunsHtml(overrunsOf(b)) +
        groupsHtml(groups, u, true),
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

/** POST; false (after an error toast) when it failed. */
/**
 * Issue 1371 Part 2: Undo, the person-only POST /api/settings/undo: the
 * setting goes back to its value before. Busy shows in the button.
 */
async function undoSetting(el) {
  const approval = el.dataset.ap;
  if (!approval) return;
  const shell = window.denShell;
  const run = (headers) =>
    shell.api("POST", "/api/settings/undo", { approval }, { headers });
  try {
    if (shell?.busyAction)
      await shell.busyAction("setting-undo", run, { button: el, vars: {} });
    else await run({});
  } catch (err) {
    shell?.errorToast?.(err);
  }
}

async function post(path, body) {
  try {
    // busy-ok: Mark read and Clear hold their button in paint()
    // (data-bell-held); Stop's ask closes on Yes; Undo is a toast's.
    await window.denShell?.api?.("POST", path, body);
    return true;
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return false;
  }
}

/**
 * Issue 1339: a project's Mark read: the server marks its items read in
 * every list (Needs you, Updates, Older); the unread counts drop to match.
 */
function scopeRead(b, scope) {
  let marked = 0;
  const f = (n) => {
    // The server's rule (notifications.ts, matches): the item's own scope.
    if (n.scope !== scope || n.read) return n;
    marked++;
    return { ...n, read: true };
  };
  const taken = () => {
    const k = marked;
    marked = 0;
    return k;
  };
  const groups = eachItem(b.groups, f);
  const fromNeeds = taken();
  const upd = b.updates ?? { count: 0, unread: 0, groups: [] };
  const updGroups = eachItem(upd.groups, f);
  const fromUpdates = taken();
  const old = b.older ?? { count: 0, groups: [] };
  return {
    ...b,
    unread: Math.max(0, (b.unread ?? 0) - fromNeeds),
    groups,
    updates: {
      ...upd,
      groups: updGroups,
      unread: Math.max(0, (upd.unread ?? 0) - fromUpdates),
    },
    older: { ...old, groups: eachItem(old.groups, f) },
  };
}

/** Each group's items through `f(n, g)` (null drops it); empty groups go. */
function eachItem(groups, f) {
  return (groups ?? [])
    .map((g) => ({
      ...g,
      subjects: g.subjects
        .map((sub) => ({
          ...sub,
          items: sub.items.map((n) => f(n, g)).filter(Boolean),
        }))
        .filter((sub) => sub.items.length),
    }))
    .filter((g) => g.subjects.length);
}

/**
 * Issue 1339: the bell as it will be once "Mark all read" (`all`), "Clear
 * read" (`clear`) or a project's Mark read (`scope`, with its scope) is
 * done, to show at once while the POST runs.
 */
export function bellAfter(b, what, scope) {
  if (!b) return b;
  if (what === "scope") return scopeRead(b, scope);
  const f =
    what === "all"
      ? (n) => (n.read ? n : { ...n, read: true })
      : (n) => (n.read ? null : n);
  const count = (gs) =>
    gs.reduce(
      (k, g) => k + g.subjects.reduce((j, sub) => j + sub.items.length, 0),
      0,
    );
  const groups = eachItem(b.groups, f);
  const upd = b.updates ?? { count: 0, unread: 0, groups: [] };
  const updGroups = eachItem(upd.groups, f);
  const old = b.older ?? { count: 0, groups: [] };
  const oldGroups = eachItem(old.groups, f);
  return {
    ...b,
    unread: what === "all" ? 0 : b.unread,
    groups,
    updates: {
      ...upd,
      groups: updGroups,
      unread: what === "all" ? 0 : upd.unread,
      count: what === "clear" ? count(updGroups) : upd.count,
    },
    older: {
      ...old,
      groups: oldGroups,
      count: what === "clear" ? count(oldGroups) : old.count,
    },
  };
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
      ? await shell.busyAction(`decide-${decision}`, run, {
          button: el,
          toastFast: false,
        })
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
    busy: null,
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
  // Issue 1054: the button held with the kit's dots, and how to let it go.
  let heldBtn = null;
  let letGo = null;
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
    // Issue 1054: the pressed button holds the kit's dots while its POST
    // runs. A paint keeps it when the button is the same one (issue 1024
    // patches in place), holds the new one when it isn't, and lets go of
    // the old: none is left held once the answer is in.
    const b = ui.busy ? pop.querySelector("[data-bell-held]") : null;
    // Issue 1524: the patch takes the drawn attributes and children, so a
    // repaint takes the hold off the same button too (aria-busy, disabled,
    // the dots): it is let go and held again. Letting go first keeps the
    // kit's order: its release runs before the new hold.
    const dropped =
      b && b === heldBtn && b.getAttribute("aria-busy") !== "true";
    if (b !== heldBtn || dropped) {
      letGo?.();
      heldBtn = b;
      letGo = b ? (window.denShell?.holdDots?.(b) ?? null) : null;
    }
    if (keep) pop.querySelector(keep)?.focus?.();
  };
  const refresh = async () => {
    const b = await load();
    // Issue 1339: a refresh while Mark all read or Clear read runs would
    // put back what the person just saw go.
    if (!b || ui.busy) return;
    last = b;
    // Issue 993: an overrun slot counts until it ends (it has no item).
    bell.setCount((b?.unread ?? 0) + overrunsOf(b).length);
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
      // busy-ok: marked read in the background as the link opens
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
    if (what === "gate-end") {
      await endSlot(el);
      await refresh();
      return;
    }
    if (what === "setting-undo") {
      await undoSetting(el);
      await refresh();
      return;
    }
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
    if (what === "all" || what === "clear" || what === "scope") {
      // Issue 1339: the rows change at once, the button shows busy in
      // itself, and an error puts the rows back (with its toast).
      if (ui.busy || !last) return;
      const before = last;
      const scope = el.dataset.scope;
      ui.busy = what === "scope" ? `scope:${scope}` : what;
      last = bellAfter(last, what, scope);
      bell.setCount((last.unread ?? 0) + overrunsOf(last).length);
      paint();
      const ok = await post(
        what === "clear"
          ? "/api/notifications/clear"
          : "/api/notifications/read",
        what === "all" ? { all: true } : what === "scope" ? { scope } : {},
      );
      ui.busy = null;
      if (!ok) {
        last = before;
        bell.setCount((last.unread ?? 0) + overrunsOf(last).length);
      }
      paint();
      if (ok) await refresh();
      return;
    } else if (what === "fold" || what === "older" || what === "updates") {
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
        undefined, // the kit's Undo time (issue 559)
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
