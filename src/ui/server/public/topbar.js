/**
 * The top bar's chips and overlays (0.3.0-dev.20): shell.js draws the bar,
 * this module drives it. header.js imports it on every page.
 *
 *   ⌘K search (R5)   #den-search, ⌘K or Ctrl+K: the command palette (R17)
 *   status (R6)       #den-status: "All N healthy" / "ok/N healthy · k down",
 *                     from the same rollup as the rail's Services badge; it
 *                     opens the status drawer (R15)
 *   Runs (R7)         #den-runs: a pulsing dot and "N running" while a run
 *                     streams. It shows and hides the runs dock (R16,
 *                     shell.js's denShell.runs, dev.30), where every page's
 *                     output lands; an empty dock links to the page that ran
 *                     the last run
 *   sudo (R8, LK-0)   #den-lock: shown only while a run waits for the admin
 *                     password because a command it runs needs sudo; it
 *                     opens the password prompt (in the top layer)
 *
 * Exports for pages (through header.js): askSudo(need) (the prompt for a
 * run's needs-sudo event: true once the password is set), sudoRun() (a
 * run's needs-sudo, then the action again after the password),
 * unlockWith(password), setServiceRunner(fn) (the page that runs Start
 * and Restart itself), takePendingAction().
 *
 * The admin password is for sudo, and nothing else (LK-0): no action asks
 * for it up front, and it is no access check. The server says when a
 * command is about to run sudo without it; then the page asks the server
 * again first (another tab or device may have set it, LK-2), then, when a
 * password is stored in the vault, loads it from there (LK-3; a page view
 * alone never wakes the vault), and only then shows the field. The prompt
 * is in the top layer (a popover, or its own modal <dialog> when a modal
 * is open), so no modal ever covers it (LK-1).
 *
 * The pure parts (statusSummary, statusChip, problemCards, drawerGroups,
 * checkLine, rankCommands, runOf) take plain data, so tests need no
 * browser. Opening the palette, the drawer or a popover only reads: no
 * route, container, daemon or server process changes. Start and Restart
 * are the explicit actions, through the page's own runner.
 */

// ── pure parts ──────────────────────────────────────────────────────────────

/**
 * The status chip's numbers from buildRow's row (health-fit.js), or null
 * before the first complete cycle. The rules are the rail badge's
 * (shellHealth): a service counts as down only once its repo's checks have
 * all answered (`down` is the rollup's), a pending check is never down, an
 * unchecked one is never a problem. `n` is the checked services.
 */
export function statusSummary(row) {
  if (!row || !Array.isArray(row.flat))
    return {
      state: "checking",
      n: 0,
      ok: 0,
      down: 0,
      unchecked: 0,
      pending: 0,
      awaiting: 0,
    };
  let n = 0;
  let ok = 0;
  let down = 0;
  let unchecked = 0;
  let pending = 0;
  let awaiting = 0;
  for (const r of row.flat) {
    if (r.rollup.awaiting) {
      awaiting++;
      continue;
    }
    down += r.rollup.down.length;
    for (const i of r.items) {
      if (i.awaiting) continue;
      if (i.ok === true) {
        n++;
        ok++;
      } else if (i.ok === false) n++;
      else if (i.pending) pending++;
      else unchecked++;
    }
  }
  const state = !row.flat.length
    ? "none"
    : n === 0
      ? awaiting || pending
        ? "checking"
        : "unchecked"
      : down > 0
        ? "bad"
        : "ok";
  return { state, n, ok, down, unchecked, pending, awaiting };
}

/**
 * What the chip shows for a summary: its dot, `bad` (the border tint),
 * `lead` (the part that hides below 860px), `text` and a title that says
 * what was and wasn't checked. `t` is the shell's message lookup.
 */
export function statusChip(sum, t = tr) {
  const extra = [
    sum.unchecked ? t("status.unchecked", { n: sum.unchecked }) : "",
    sum.pending ? t("status.pending", { n: sum.pending }) : "",
    sum.awaiting ? t("status.awaiting", { n: sum.awaiting }) : "",
  ].filter(Boolean);
  const title = [t("status.title", { n: sum.n }), ...extra].join(" · ");
  if (sum.state === "checking")
    return {
      dot: "off",
      bad: false,
      lead: "",
      text: t("status.checking"),
      title: t("status.checking"),
      busy: true,
    };
  if (sum.state === "none")
    return {
      dot: "off",
      bad: false,
      lead: "",
      text: t("status.none"),
      title: t("status.none"),
      busy: false,
    };
  if (sum.state === "unchecked")
    return {
      dot: "off",
      bad: false,
      lead: "",
      text: t("status.unchecked", { n: sum.unchecked }),
      title,
      busy: false,
    };
  if (sum.state === "bad")
    return {
      dot: "bad",
      bad: true,
      lead: `${t("status.some", { ok: sum.ok, n: sum.n })} · `,
      text: t("status.down", { n: sum.down }),
      title,
      busy: false,
    };
  return {
    dot: "",
    bad: false,
    lead: "",
    text: t("status.all", { n: sum.n }),
    title,
    busy: false,
  };
}

/**
 * The shell's catalog (shell.js MESSAGES, R19) does every lookup in a page.
 * These are the en strings of this module's pure exports, for where there
 * is no shell (a unit test, a script): the same text as shell.js's en
 * (i18n.test.ts holds them equal).
 */
export const EN_FALLBACK = {
  "status.checking": "Checking…",
  "status.none": "No services",
  "status.unchecked": "{n} not checked",
  "status.all": "All {n} healthy",
  "status.some": "{ok}/{n} healthy",
  "status.down": "{n} down",
  "status.title": "{n} checked",
  "status.pending": "{n} pending",
  "status.awaiting": "{n} still checking",
  "status.unknown": "Status unknown",
  "status.unknownTip":
    "Den's server isn't responding, so service health is unknown",
  "chk.awaiting": "still checking",
  "chk.pending": "{what} — pending",
  "chk.check": "check",
  "chk.unchecked": "not checked",
  "chk.healthy": "healthy",
  "chk.down": "down",
  "chk.pendingWord": "pending",
  "chk.checking": "checking…",
  ms: "{n} ms",
  "fix.failedAt": "{line} · failed at {at}",
  "fix.start": "Start",
  "fix.startX": "Start {s}",
  "fix.logs": "Logs",
  "fix.logsX": "Logs of {s}",
  "row.name": "{id}, {state}",
  "row.nameMs": "{id}, {state}, {ms}",
};
/** t: the shell's, else the en fallback. */
function tr(key, vars) {
  const s = typeof window !== "undefined" ? window.denShell : null;
  if (s?.t) return s.t(key, vars);
  return String(EN_FALLBACK[key] ?? key).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

/**
 * What a check said, for a tooltip or a card: "http://shop/healthz → 200",
 * "http://shop/healthz — connect ECONNREFUSED", "pending", "not checked".
 */
export function checkLine(i) {
  const what = i.url ?? i.check ?? null;
  if (i.awaiting) return tr("chk.awaiting");
  if (i.ok == null)
    return i.pending
      ? tr("chk.pending", { what: what ?? tr("chk.check") })
      : tr("chk.unchecked");
  if (!what) return i.ok ? tr("chk.healthy") : (i.error ?? tr("chk.down"));
  if (i.error) return `${what} — ${i.error}`;
  return i.status != null ? `${what} → ${i.status}` : what;
}

/**
 * The drawer's "Needs attention": one card per down service, problem
 * repos first (row.flat's order), only repos whose checks have all
 * answered.
 */
export function problemCards(row) {
  if (!row || !row.flat) return [];
  const out = [];
  for (const r of row.flat) {
    if (r.rollup.awaiting || !r.rollup.down.length) continue;
    for (const i of r.items)
      if (i.ok === false && !i.awaiting)
        out.push({
          id: `${r.repo}/${i.service}`,
          repo: r.repo,
          service: i.service,
          entry: i.service === r.rollup.entry,
          line: checkLine(i),
          workspaces: i.workspaces ?? [],
        });
  }
  return out;
}

/**
 * What a problem card says and offers (R15), the one source for the status
 * drawer and the Workspaces table's problem rows (R24d): its text (what the
 * check said, when it failed) and its fix buttons, each with an accessible
 * name that names the service. `at` is the check's time, or "".
 */
export function problemFix(c, at = "") {
  return {
    text: at ? tr("fix.failedAt", { line: c.line, at }) : c.line,
    actions: [
      {
        act: "start",
        label: tr("fix.start"),
        name: tr("fix.startX", { s: c.id }),
        primary: true,
      },
      {
        act: "logs",
        label: tr("fix.logs"),
        name: tr("fix.logsX", { s: c.id }),
        primary: false,
      },
    ],
  };
}

/** A service's state in the drawer: ok, down, pending, unchecked or awaiting. */
function serviceState(r, i) {
  if (i.awaiting || r.rollup.awaiting) return "awaiting";
  if (i.ok === true) return "ok";
  if (i.ok === false) return "down";
  return i.pending ? "pending" : "unchecked";
}

/**
 * The drawer's "Everything": one group per application box (or per repo
 * outside one), each "ok/N" over its checked services and every service
 * with its state, ms and what its check said. `groups` is header.js's
 * groupReposByApplication output (`[{ app, repos: [name] }]`).
 */
export function drawerGroups(row, groups) {
  if (!row || !row.flat) return [];
  const byRepo = new Map(row.flat.map((r) => [r.repo, r]));
  const units = [];
  for (const g of groups && groups.length
    ? groups
    : [{ app: null, repos: row.flat.map((r) => r.repo) }]) {
    if (g.app) units.push({ title: g.app.title || g.app.name, repos: g.repos });
    else for (const repo of g.repos) units.push({ title: repo, repos: [repo] });
  }
  return units
    .map((u) => {
      const services = [];
      for (const repo of u.repos) {
        const r = byRepo.get(repo);
        if (!r) continue;
        for (const i of r.items) {
          if (i.awaiting) continue;
          services.push({
            id: `${r.repo}/${i.service}`,
            repo: r.repo,
            service: i.service,
            state: serviceState(r, i),
            ms: typeof i.ms === "number" ? i.ms : null,
            line: checkLine(i),
          });
        }
        if (r.rollup.awaiting && !r.items.some((i) => !i.awaiting))
          services.push({
            id: r.repo,
            repo: r.repo,
            service: null,
            state: "awaiting",
            ms: null,
            line: "still checking",
          });
      }
      const checked = services.filter(
        (s) => s.state === "ok" || s.state === "down",
      ).length;
      const ok = services.filter((s) => s.state === "ok").length;
      return { title: u.title, ok, checked, services };
    })
    .filter((u) => u.services.length);
}

/**
 * The palette's ranking: every word of the query must match a row's label,
 * keywords or kind; a label that starts with it ranks first, then a word
 * in the label, then anywhere in it, then keywords and kind, then a fuzzy
 * match (the letters in order). Ties keep the list's order. An empty
 * query lists the rows not marked `hideEmpty`, up to `emptyLimit`.
 */
export function rankCommands(items, query, opts = {}) {
  const { limit = 40, emptyLimit = 14 } = opts;
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!q)
    return items
      .filter((x) => !x.hideEmpty)
      .slice(0, emptyLimit)
      .map((x) => ({ ...x, score: 0 }));
  const words = q.split(/\s+/).filter(Boolean);
  const scored = [];
  items.forEach((x, idx) => {
    const label = String(x.label ?? "").toLowerCase();
    const keys = (x.keywords ?? []).map((k) => String(k).toLowerCase());
    const kind = String(x.kindLabel ?? x.kind ?? "").toLowerCase();
    let total = 0;
    for (const w of words) {
      const s = wordScore(w, label, keys, kind);
      if (!s) return;
      total += s;
    }
    scored.push({ ...x, score: total, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, limit).map(({ idx, ...x }) => x);
}

function wordScore(w, label, keys, kind) {
  if (label.startsWith(w)) return 100;
  if (new RegExp(`(^|[\\s/:._-])${escRe(w)}`).test(label)) return 80;
  if (label.includes(w)) return 60;
  if (keys.some((k) => k.startsWith(w))) return 45;
  if (keys.some((k) => k.includes(w))) return 40;
  if (kind.startsWith(w)) return 30;
  const f = fuzzy(w, label);
  return f ? 10 + f : 0;
}
function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** The letters of `w` in order in `s`: 1..9, tighter is higher; 0 if not. */
function fuzzy(w, s) {
  let at = -1;
  let first = -1;
  for (const ch of w) {
    at = s.indexOf(ch, at + 1);
    if (at < 0) return 0;
    if (first < 0) first = at;
  }
  const span = at - first + 1;
  return Math.max(1, 9 - Math.floor((span - w.length) / 2));
}

/** The run endpoints: a stream to one of these is a run (R7). */
const RUN_PATHS = [
  "/api/service/exec",
  "/api/workspace/exec",
  "/api/workspace/sync",
  "/api/run",
  "/api/release/deploy",
];

/**
 * A run's label from its stream URL ("restart shop/web", "sync billing",
 * "tests", "deploy"), or null when the URL is not a run (a log tail, the
 * health stream). `base` resolves a relative URL.
 */
export function runOf(url, base = "http://localhost/") {
  let u;
  try {
    u = new URL(String(url), base);
  } catch {
    return null;
  }
  if (!RUN_PATHS.includes(u.pathname)) return null;
  const q = u.searchParams;
  if (u.pathname === "/api/service/exec")
    return `${q.get("cmd") ?? "run"} ${q.get("repo") ?? "?"}/${q.get("service") ?? "?"}`;
  if (u.pathname === "/api/workspace/exec") {
    const what =
      q.get("addresses") || q.get("seed") || q.get("workspace") || "workspace";
    return `${q.get("cmd") ?? "run"} ${what}`;
  }
  if (u.pathname === "/api/workspace/sync")
    return `sync ${q.get("repo") ?? "workspace"}`;
  if (u.pathname === "/api/run") return `tests ${q.get("suite") ?? ""}`.trim();
  return "deploy";
}

// ── the UI ──────────────────────────────────────────────────────────────────

const LS_LAST_RUN = "__DEN_CLI__-last-run";
const SS_PENDING = "__DEN_CLI__-pending-action";
const KIND = ["page", "service", "app", "agent", "action", "setting"];
const kindLabel = (k) =>
  KIND.includes(k)
    ? t(`kind.${k}`)
    : String(k).charAt(0).toUpperCase() + String(k).slice(1);

const sh = () => (typeof window !== "undefined" ? window.denShell : null);
/** The locale for dates and times: the browser's for English, else the page's. */
function uiLocale() {
  const l = sh()?.lang?.();
  return l && l !== "en" ? l : undefined;
}
const t = tr;
const $ = (id) => document.getElementById(id);
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
function go(href) {
  window.location.assign(href);
}

/** What paintStatus last saw: the row, the application groups, the env. */
const health = { row: null, groups: [], env: "local", at: null };
let hooks = {};
let inited = false;

/** One overlay at a time: { kind, close(refocus) }. */
let overlay = null;
function closeOverlay(refocus = true) {
  if (!overlay) return;
  const o = overlay;
  overlay = null;
  o.close(refocus);
}

/** Tab and Shift+Tab stay inside `box` (a modal). */
function trapTab(e, box) {
  const stops = [
    ...box.querySelectorAll(
      "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    ),
  ].filter((el) => !el.disabled && !el.hidden && el.getClientRects().length);
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const at = document.activeElement;
  if (!stops.includes(at)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && at === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}

// ── status chip (R6) ────────────────────────────────────────────────────────

/**
 * Health data from header.js's poll, painted through its gate (a cold load
 * paints once, complete: no partial red, no flash). `row` is buildRow's,
 * `groups` the application grouping, `env` the env checked.
 */
export function paintStatus({ row, groups = [], env = "local" }) {
  health.row = row;
  health.groups = groups;
  health.env = env;
  health.at = new Date();
  paintChip();
  if (overlay?.kind === "drawer") renderDrawerBody();
  if (overlay?.kind === "palette") overlay.redraw?.();
}

/** The chip while a re-check runs (an env switch): neutral, never red. */
export function paintChecking() {
  health.row = null;
  paintChip();
}

/** R26d: the server isn't answering, so nothing about health is known. */
let serverDown = false;

function paintChip() {
  const chip = $("den-status");
  if (!chip) return;
  // R26d, and SEC-1b's refusal pages (421, signed out: sh().apiOff), where
  // no health is asked for: unknown, neutral, never "Checking…" forever.
  if (serverDown || sh()?.apiOff?.() === true) {
    chip.classList.remove("bad");
    chip.setAttribute("aria-busy", "false");
    chip.title = t("status.unknownTip");
    chip.innerHTML =
      `<span class="den-dot off" aria-hidden="true"></span>` +
      `<span class="den-n">${esc(t("status.unknown"))}</span>`;
    return;
  }
  const c = statusChip(statusSummary(health.row), t);
  chip.classList.toggle("bad", c.bad);
  chip.setAttribute("aria-busy", c.busy ? "true" : "false");
  chip.title = c.title;
  chip.innerHTML =
    `<span class="den-dot ${c.dot}" aria-hidden="true"></span>` +
    `<span class="den-n">${c.lead ? `<span class="den-lbl-l">${esc(c.lead)}</span>` : ""}${esc(c.text)}</span>`;
}

// ── status drawer (R15) ─────────────────────────────────────────────────────

function openDrawer() {
  if (overlay?.kind === "drawer") return;
  closeOverlay(false);
  sh()?.closeMenu?.();
  const chip = $("den-status");
  const back = chip;
  const scrim = document.createElement("div");
  scrim.className = "den-scrim";
  const d = document.createElement("aside");
  d.className = "den-drawer";
  d.id = "den-status-drawer";
  d.setAttribute("role", "dialog");
  d.setAttribute("aria-modal", "true");
  d.setAttribute("aria-labelledby", "den-drawer-title");
  d.innerHTML =
    `<div class="den-dh"><h2 id="den-drawer-title">${esc(t("drawer.title"))}</h2>` +
    `<button type="button" class="den-ib" data-refresh title="${esc(t("drawer.refresh"))}" aria-label="${esc(t("drawer.refresh"))}">⟳</button>` +
    `<button type="button" class="den-ib" data-close aria-label="${esc(t("drawer.close"))}">✕</button></div>` +
    '<div class="den-db"></div>';
  document.body.append(scrim, d);
  chip?.setAttribute("aria-expanded", "true");
  chip?.setAttribute("aria-controls", d.id);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay(true);
    } else if (e.key === "Tab") trapTab(e, d);
  };
  d.addEventListener("keydown", onKey);
  scrim.addEventListener("click", () => closeOverlay(true));
  d.addEventListener("click", onDrawerClick);
  const onPins = () => renderDrawerBody();
  window.addEventListener("den:pins", onPins);
  overlay = {
    kind: "drawer",
    close(refocus) {
      window.removeEventListener("den:pins", onPins);
      scrim.remove();
      d.remove();
      chip?.setAttribute("aria-expanded", "false");
      if (refocus && back?.isConnected) back.focus();
    },
  };
  renderDrawerBody();
  d.querySelector("[data-close]").focus();
}

function dotClass(state) {
  return state === "ok"
    ? ""
    : state === "down"
      ? "bad"
      : state === "pending" || state === "awaiting"
        ? "pending"
        : "off";
}
function msText(s) {
  if (s.state === "ok")
    return s.ms != null ? tr("ms", { n: s.ms }) : tr("chk.healthy");
  if (s.state === "down") return tr("chk.down");
  if (s.state === "pending") return tr("chk.pendingWord");
  if (s.state === "awaiting") return tr("chk.checking");
  return tr("chk.unchecked");
}

/**
 * A drawer row's accessible name: service, state and latency. What the
 * check ran (a URL, or a whole shell command) is its description, not its
 * name (SA's dev.20 run).
 */
export function rowName(s) {
  const word = s.state === "ok" ? tr("chk.healthy") : msText(s);
  return s.state === "ok" && s.ms != null
    ? tr("row.nameMs", { id: s.id, state: word, ms: tr("ms", { n: s.ms }) })
    : tr("row.name", { id: s.id, state: word });
}

function renderDrawerBody() {
  const d = $("den-status-drawer");
  const db = d?.querySelector(".den-db");
  if (!db) return;
  const keep = d.contains(document.activeElement)
    ? document.activeElement.dataset?.k
    : null;
  const row = health.row;
  const pinned = (id) => !!sh()?.isPinned?.(id);
  const at = health.at
    ? // English keeps the browser's own clock (12 or 24 hours); another
      // language's page reads its times in that language.
      new Intl.DateTimeFormat(uiLocale(), {
        hour: "2-digit",
        minute: "2-digit",
      }).format(health.at)
    : "";
  let html;
  if (!row) {
    html = `<p class="den-none" role="status">${esc(t("status.checking"))}</p>`;
  } else {
    const cards = problemCards(row);
    const groups = drawerGroups(row, health.groups);
    html =
      `<section aria-labelledby="den-dr-p"><h2 class="den-sec" id="den-dr-p">${esc(t("drawer.attention"))}</h2>` +
      (cards.length
        ? '<div class="den-cards">' +
          cards
            .map((c) => {
              const fix = problemFix(c, at);
              return (
                '<div class="den-prob-card">' +
                `<div class="den-t"><span class="den-dot bad" aria-hidden="true"></span>${esc(c.service)} <span class="den-mono">${esc(c.repo)}</span></div>` +
                `<div class="den-s">${esc(fix.text)}${c.workspaces.length > 1 ? ` · ${esc(c.workspaces.join(", "))}` : ""}</div>` +
                '<div class="den-a">' +
                fix.actions
                  .map(
                    (a) =>
                      `<button type="button" class="den-btn sm${a.primary ? " primary" : ""}" data-k="${a.act}:${esc(c.id)}" data-${a.act}="${esc(c.id)}" aria-label="${esc(a.name)}">${esc(a.label)}</button>`,
                  )
                  .join("") +
                `<button type="button" class="den-btn sm" data-k="pin:${esc(c.id)}" data-pin="${esc(c.id)}" aria-pressed="${pinned(c.id)}" aria-label="${esc(t(pinned(c.id) ? "act.unpinX" : "act.pinX", { s: c.id }))}">${esc(t(pinned(c.id) ? "act.unpin" : "act.pin"))}</button>` +
                "</div></div>"
              );
            })
            .join("") +
          "</div>"
        : `<p class="den-none">${esc(t("drawer.nothing"))}</p>`) +
      "</section>" +
      `<section aria-labelledby="den-dr-e"><h2 class="den-sec" id="den-dr-e">${esc(t("drawer.everything"))}</h2><div class="den-grps">` +
      groups
        .map(
          (g) =>
            '<div class="den-grp">' +
            `<h3><span>${esc(g.title)}</span><span title="${esc(t("drawer.okTip", { ok: g.ok, n: g.checked }))}">${g.ok}/${g.checked}</span></h3>` +
            '<div class="den-svl">' +
            g.services
              .map(
                (s) =>
                  `<button type="button" data-k="svc:${esc(s.id)}" data-svc="${esc(s.repo)}" title="${esc(s.line)}" aria-label="${esc(rowName(s))}" aria-description="${esc(s.line)}">` +
                  `<span class="den-dot ${dotClass(s.state)}" aria-hidden="true"></span>` +
                  `<span class="den-mono">${esc(s.id)}</span>` +
                  `<span class="den-ms">${esc(msText(s))}</span></button>`,
              )
              .join("") +
            "</div></div>",
        )
        .join("") +
      "</div></section>";
  }
  db.innerHTML = html;
  if (keep) db.querySelector(`[data-k="${CSS.escape(keep)}"]`)?.focus();
}

function svcOf(id) {
  for (const r of health.row?.flat ?? [])
    for (const i of r.items)
      if (`${r.repo}/${i.service}` === id)
        return {
          repo: r.repo,
          service: i.service,
          address: id,
          workspaces: i.workspaces ?? [],
        };
  const [repo, service] = String(id).split("/");
  return { repo, service, address: id, workspaces: [] };
}

function onDrawerClick(e) {
  const b = e.target.closest?.("button");
  if (!b) return;
  if (b.hasAttribute("data-close")) return closeOverlay(true);
  if (b.hasAttribute("data-refresh")) {
    hooks.refreshHealth?.(hooks.healthEnv?.() ?? health.env, { force: true });
    return;
  }
  if (b.dataset.start) {
    closeOverlay(false);
    return runServiceAction("up", svcOf(b.dataset.start));
  }
  if (b.dataset.logs) {
    closeOverlay(false);
    return openLogs(svcOf(b.dataset.logs));
  }
  if (b.dataset.pin) {
    const id = b.dataset.pin;
    if (sh()?.isPinned?.(id)) sh()?.unpin?.(id);
    else sh()?.pin?.(id);
    return;
  }
  if (b.dataset.svc) {
    closeOverlay(false);
    go(`/services#repo-${encodeURIComponent(b.dataset.svc)}`);
  }
}

// ── service actions: Start, Restart, Logs ───────────────────────────────────

let serviceRunner = null;

/**
 * The page that runs a service command itself (Local Dev: its runCmd, with
 * its output pane) registers `fn(cmd, svc)`; `svc` is
 * `{ repo, service, address, workspaces }`.
 */
export function setServiceRunner(fn) {
  serviceRunner = typeof fn === "function" ? fn : null;
}

/**
 * Start (`up`) or Restart from the drawer or the palette: an explicit
 * action. The page's runner does it where there is one. Elsewhere the
 * action is handed to Local Dev, where the command runs with its output
 * (and asks for the admin password only if it runs sudo, LK-0) (a run stops when its page
 * closes, so it can't run on a page that is about to be left): the page
 * stores it for this tab (sessionStorage, not a link anyone could open)
 * and Local Dev takes it once (takePendingAction).
 */
export function runServiceAction(cmd, svc) {
  if (serviceRunner) return serviceRunner(cmd, svc);
  try {
    sessionStorage.setItem(
      SS_PENDING,
      JSON.stringify({ cmd, address: svc.address, at: Date.now() }),
    );
  } catch {
    toast(t("toast.openWs"));
    return;
  }
  go("/local-dev");
}

/** The action another page handed to this one (once, if under a minute old). */
export function takePendingAction() {
  try {
    const raw = sessionStorage.getItem(SS_PENDING);
    sessionStorage.removeItem(SS_PENDING);
    const a = raw ? JSON.parse(raw) : null;
    if (!a || !a.cmd || !a.address || Date.now() - a.at > 60_000) return null;
    if (!["up", "restart", "down"].includes(a.cmd)) return null;
    return { cmd: a.cmd, address: a.address };
  } catch {
    return null;
  }
}

function openLogs(svc) {
  hooks.storeOpenLog?.(svc.repo, svc.service, hooks.healthEnv?.() ?? "local");
  go(`/logs?open=${encodeURIComponent(`${svc.repo}/${svc.service}`)}`);
}

// ── command palette (R17) ───────────────────────────────────────────────────

/**
 * The sessions and agents in view (GET /api/sessions), asked when the
 * palette opens: each is "Agents › <ws> / <name>", which opens its pane on
 * the Agents page (AG-4a-term).
 */
let palSessions = [];
function askPaletteSessions(redraw) {
  if (sh()?.apiOff?.()) return;
  fetch("/api/sessions")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      palSessions = Array.isArray(d?.sessions) ? d.sessions : [];
      redraw();
    })
    .catch(() => {
      /* no sessions to offer */
    });
}

/** Every palette row: pages, apps, services, their actions, then commands. */
function paletteItems() {
  const s = sh();
  const items = [];
  const st = s?.getState?.() ?? {};
  for (const n of s?.nav?.() ?? []) {
    if (n.when && !n.when(st)) continue;
    const label = s.t(n.label);
    items.push({
      key: `page:${n.id}`,
      kind: "page",
      label,
      keywords: [n.id, n.group, ...(n.keywords ?? [])],
      run: () => go(n.href),
    });
  }
  const settings = document.querySelector('.den-rail [data-nav="settings"]');
  if (settings)
    items.push({
      key: "page:settings",
      kind: "page",
      label: settings.getAttribute("title") || t("n.settings"),
      keywords: ["settings", "preferences"],
      run: () => go(settings.getAttribute("href")),
    });
  const row = health.row;
  for (const g of health.groups ?? [])
    if (g.app)
      items.push({
        key: `app:${g.app.name}`,
        kind: "app",
        label: g.app.title || g.app.name,
        sub: t("pal.repos", { n: g.repos.length }),
        keywords: [g.app.name, ...g.repos],
        run: () => go(`/services#repo-${encodeURIComponent(g.repos[0])}`),
      });
  const services = [];
  for (const r of row?.flat ?? [])
    for (const i of r.items)
      if (!i.awaiting) services.push({ r, i, id: `${r.repo}/${i.service}` });
  for (const { r, i, id } of services)
    items.push({
      key: `svc:${id}`,
      kind: "service",
      label: id,
      dot: dotClass(serviceState(r, i)),
      keywords: [r.repo, i.service],
      run: () => go(`/services#repo-${encodeURIComponent(r.repo)}`),
    });
  for (const { id } of services) {
    items.push({
      key: `restart:${id}`,
      kind: "action",
      label: t("pal.restart", { s: id }),
      keywords: ["restart"],
      hideEmpty: true,
      run: () => runServiceAction("restart", svcOf(id)),
    });
    items.push({
      key: `logs:${id}`,
      kind: "action",
      label: t("fix.logsX", { s: id }),
      keywords: ["logs", "tail"],
      hideEmpty: true,
      run: () => openLogs(svcOf(id)),
    });
  }
  for (const x of palSessions) {
    // AG-4b: the name a person gave the agent, else its persona.
    const name =
      x.kind === "agent" ? x.displayName || (x.persona ?? x.label) : x.label;
    items.push({
      key: `agent:${x.id}`,
      kind: "agent",
      label: t("ag.pal", { ws: x.workspace, name }),
      sub:
        x.kind === "agent" && (x.displayName || x.persona !== x.label)
          ? x.label
          : undefined,
      dot: x.waiting ? "warn" : x.state === "running" ? "" : "off",
      keywords: [
        x.workspace,
        x.label,
        x.persona ?? "",
        x.displayName ?? "",
        "agents",
        "terminal",
      ],
      run: () => go(`/agents?open=${encodeURIComponent(x.id)}`),
    });
  }
  if (s?.nav?.().some((n) => n.id === "agents"))
    items.push({
      key: "agent:start",
      kind: "action",
      label: t("ag.palStart"),
      keywords: ["agents", "start", "persona"],
      run: () => go("/agents?start=1"),
    });
  for (const c of s?.commands?.() ?? [])
    items.push({
      key: `cmd:${c.id}`,
      kind: c.kind,
      label: c.label,
      keywords: c.keywords,
      run: c.run,
    });
  return items.map((x) => ({ ...x, kindLabel: kindLabel(x.kind) }));
}

function openPalette() {
  if (overlay?.kind === "palette") {
    $("den-pal-q")?.focus();
    return;
  }
  const back =
    document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : $("den-search");
  closeOverlay(false);
  sh()?.closeMenu?.();
  const ph = t("search.ph");
  const wrap = document.createElement("div");
  wrap.className = "den-pal-wrap";
  wrap.innerHTML =
    `<div class="den-pal" role="dialog" aria-modal="true" aria-label="${esc(ph)}">` +
    `<input id="den-pal-q" role="combobox" aria-expanded="true" aria-controls="den-pal-list" aria-autocomplete="list" aria-label="${esc(ph)}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false">` +
    `<ul id="den-pal-list" role="listbox" aria-label="${esc(t("pal.results"))}"></ul>` +
    `<div class="den-foot" aria-hidden="true"><span>${esc(t("pal.move"))}</span><span>${esc(t("pal.open"))}</span><span>${esc(t("pal.close"))}</span></div>` +
    '<span class="den-sr" role="status" aria-live="polite" id="den-pal-count"></span></div>';
  document.body.appendChild(wrap);
  const input = $("den-pal-q");
  const ul = $("den-pal-list");
  let sel = 0;
  let list = [];
  const draw = () => {
    list = rankCommands(paletteItems(), input.value);
    sel = Math.min(sel, Math.max(0, list.length - 1));
    ul.innerHTML = list.length
      ? list
          .map(
            (x, i) =>
              `<li role="option" id="den-pal-o-${i}" data-i="${i}" aria-selected="${i === sel}">` +
              (x.dot != null
                ? `<span class="den-dot ${x.dot}" aria-hidden="true"></span>`
                : "") +
              `<span class="den-pal-l">${esc(x.label)}</span>` +
              (x.sub ? `<span class="den-sub">${esc(x.sub)}</span>` : "") +
              `<span class="den-kind">${esc(x.kindLabel)}</span></li>`,
          )
          .join("")
      : `<li class="den-pal-empty" role="presentation">${esc(t("pal.none"))}</li>`;
    if (list.length)
      input.setAttribute("aria-activedescendant", `den-pal-o-${sel}`);
    else input.removeAttribute("aria-activedescendant");
    $("den-pal-count").textContent = t("pal.count", { n: list.length });
    ul.querySelector('[aria-selected="true"]')?.scrollIntoView?.({
      block: "nearest",
    });
  };
  const pick = (x) => {
    if (!x) return;
    // Focus goes back first; then the row runs (it may navigate).
    closeOverlay(true);
    x.run();
  };
  input.addEventListener("input", () => {
    sel = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!list.length) return;
      sel =
        e.key === "ArrowDown"
          ? (sel + 1) % list.length
          : (sel - 1 + list.length) % list.length;
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(list[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay(true);
    } else if (e.key === "Tab") e.preventDefault();
  });
  ul.addEventListener("mousedown", (e) => e.preventDefault());
  ul.addEventListener("click", (e) => {
    const li = e.target.closest?.("li[data-i]");
    if (li) pick(list[+li.dataset.i]);
  });
  wrap.addEventListener("mousedown", (e) => {
    if (e.target === wrap) closeOverlay(true);
  });
  $("den-search")?.setAttribute("aria-expanded", "true");
  overlay = {
    kind: "palette",
    redraw: draw,
    close(refocus) {
      wrap.remove();
      $("den-search")?.setAttribute("aria-expanded", "false");
      if (refocus && back?.isConnected) back.focus();
    },
  };
  draw();
  input.focus();
  askPaletteSessions(() => {
    if (overlay?.kind === "palette") draw();
  });
}

// ── Runs chip (R7) ──────────────────────────────────────────────────────────

const running = new Map();
let runSeq = 0;

function lastRun() {
  try {
    return JSON.parse(sessionStorage.getItem(LS_LAST_RUN) || "null");
  } catch {
    return null;
  }
}

function runStarted(label) {
  const id = ++runSeq;
  running.set(id, label);
  try {
    sessionStorage.setItem(
      LS_LAST_RUN,
      JSON.stringify({
        label,
        page: location.pathname + location.search,
        at: Date.now(),
      }),
    );
  } catch {
    /* a convenience only */
  }
  paintRuns();
  return id;
}
function runEnded(id) {
  if (running.delete(id)) paintRuns();
}

/**
 * The chip's count: the runs dock's running tabs (R16) or the run streams
 * open on the page, whichever is more (a page registers each run in the dock;
 * a workspace-wide command is one stream feeding several tabs).
 */
function paintRuns() {
  const chip = $("den-runs");
  if (!chip) return;
  const dock = (sh()?.runs?.list?.() ?? []).filter((r) => r.running);
  const labels =
    dock.length >= running.size
      ? dock.map((r) => r.label)
      : [...running.values()];
  const n = labels.length;
  const last = lastRun();
  chip.title = n
    ? labels.join(", ")
    : last
      ? t("runs.last", { s: last.label })
      : t("runs.title");
  chip.setAttribute("aria-label", n ? t("runs.aria", { n }) : t("runs.title"));
  chip.innerHTML =
    `<span class="den-dot ${n ? "run" : "off"}" aria-hidden="true"></span>` +
    `<span class="den-n den-lbl-l">${esc(n ? t("runs.n", { n }) : t("runs.title"))}</span>`;
}

/**
 * The Runs chip shows and hides the runs dock (R16); returns whether it is
 * open now. Without the dock (no shell), a toast says where output goes.
 */
export function showRuns() {
  const runs = sh()?.runs;
  if (runs?.toggle) return runs.toggle() ? "open" : "closed";
  toast(t("runs.toast"));
  return "none";
}

/**
 * A run is an open stream to a run endpoint (RUN_PATHS): EventSource is
 * wrapped once, before any page script opens one (pages import header.js
 * first), and counts each run until the page closes it, the server says
 * "done", or the connection ends.
 */
function trackRuns() {
  const Native = window.EventSource;
  if (!Native || Native.__denRuns) return;
  class DenEventSource extends Native {
    constructor(url, init) {
      super(url, init);
      const label = runOf(url, location.href);
      if (!label) return;
      const id = runStarted(label);
      const end = () => runEnded(id);
      this.__denEnd = end;
      this.addEventListener("message", (e) => {
        try {
          if (JSON.parse(e.data)?.type === "done") end();
        } catch {
          /* not JSON: not the end */
        }
      });
      this.addEventListener("error", () => {
        if (this.readyState === 2) end();
      });
    }
    close() {
      this.__denEnd?.();
      super.close();
    }
  }
  DenEventSource.__denRuns = true;
  window.EventSource = DenEventSource;
}

// ── the admin password, for sudo (R8, LK-0) ───────────────────────────────

/*
 * LK-0 (Ward, 2026-11-06): the admin password is for sudo, and nothing
 * else. Nothing asks for it up front: a run that is about to run sudo
 * without it streams a `needs-sudo` event (the server decides), and only
 * then does the page ask, saying "<command> needs your admin password".
 * The chip (#den-lock) shows only while such an ask is waiting. Asking
 * goes: the server first (another tab or device may have set it, LK-2),
 * then the vault when a password is stored there (LK-3, Touch ID), then
 * the field, in the top layer (LK-1).
 */
const sudo = {
  vault: {
    backend: "none",
    label: "",
    backendAvailable: false,
    hasStored: false,
  },
  /** The ask that is waiting: { need, promise, resolve }, or null. */
  waiting: null,
};

/**
 * Set the admin password (the prompt's form): { ok, savedToVault?,
 * vaultError?, error? }. Never logs the password.
 */
export async function unlockWith(password, { saveToVault = false } = {}) {
  if (!password) return { ok: false, error: t("lock.wrong") };
  try {
    const r = await fetch("/api/sudo-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, saveToVault }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      // LK-4: a first save also wrote the ref, so it is configured now.
      if (data.savedToVault)
        sudo.vault = { ...sudo.vault, hasStored: true, configured: true };
      return {
        ok: true,
        savedToVault: !!data.savedToVault,
        ...(data.vaultError ? { vaultError: data.vaultError } : {}),
      };
    }
    // A wrong password is said in the page's language; another refusal
    // is the server's own message.
    return {
      ok: false,
      error: r.status === 401 || !data.error ? t("lock.wrong") : data.error,
    };
  } catch {
    return { ok: false, error: t("lock.reqFailed") };
  }
}

/** What needed sudo, for the prompt: the command, else the step. */
function needWhat(need) {
  return need?.command || need?.step || t("lock.cmd");
}

/**
 * The run's server said sudo needs the password (`need` is its needs-sudo
 * event: { command?, step? }). Resolves true once the password is set
 * (from another tab, the vault or the field), false when the person
 * closes the prompt. One ask at a time: a second need while one waits
 * shares it.
 */
export function askSudo(need = {}) {
  if (sudo.waiting) return sudo.waiting.promise;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  sudo.waiting = { need, promise, resolve };
  paintLock();
  void (async () => {
    const st = await getJson("/api/sudo-password/status", null);
    if (st?.set) return settleSudo(true);
    await checkVault();
    if (sudo.vault.backendAvailable && sudo.vault.hasStored) {
      const loaded = await getJson(
        "/api/sudo-password/load-from-vault",
        { ok: false },
        { method: "POST" },
      );
      if (loaded.ok) return settleSudo(true);
    }
    if (sudo.waiting) openLock();
  })();
  return promise;
}

function settleSudo(ok) {
  const w = sudo.waiting;
  if (!w) return;
  sudo.waiting = null;
  if (overlay?.kind === "lock") closeOverlay(false);
  paintLock();
  w.resolve(ok);
}

/**
 * For a page's run (an EventSource): `see(msg)` on every message (true
 * for a needs-sudo one, which starts the ask), and `done(retry)` when the
 * run ends: after the password, the action runs again (resolves to what
 * `retry()` returns; undefined when nothing needed sudo, or the person
 * said no).
 */
export function sudoRun() {
  let asked = null;
  return {
    see(msg) {
      if (msg?.type !== "needs-sudo") return false;
      asked ??= askSudo(msg);
      return true;
    },
    async done(retry) {
      const a = asked;
      asked = null;
      return a && (await a) ? retry() : undefined;
    },
  };
}

/** The chip: only while an ask is waiting (LK-0). */
function paintLock() {
  const chip = $("den-lock");
  if (!chip) return;
  const w = sudo.waiting;
  chip.hidden = !w;
  if (!w) {
    chip.removeAttribute("title");
    return;
  }
  const label = t("lock.waiting");
  chip.title = t("lock.needs", { cmd: needWhat(w.need) });
  chip.innerHTML =
    '<span class="den-lock-ic" aria-hidden="true">🔑</span>' +
    `<span class="den-lbl-l">${esc(label)}</span>`;
  chip.setAttribute("aria-label", label);
}

async function getJson(url, fallback, init) {
  try {
    const r = await fetch(url, init);
    return r.ok ? await r.json() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * What the secrets backend can do here (`backend`, `backendAvailable`,
 * `reason`): asked once a page, when sudo first needs the password (a
 * page view never wakes the vault), then kept. Not configured or
 * unavailable means no save option and no auto-load.
 */
let vaultAsked = null;
function checkVault() {
  // 0.4.1: it reads the config's secrets refs; an invalid one answers 422.
  if (window.denShell?.configInvalid?.() === true)
    return Promise.resolve(sudo.vault);
  vaultAsked ??= getJson("/api/sudo-password/vault-status", {
    backend: "none",
    label: "",
    backendAvailable: false,
    hasStored: false,
  }).then((v) => {
    sudo.vault = v;
    // Only the save option changes: what's typed stays.
    const label = document.querySelector("#den-lock-pop .den-lock-save");
    const save = saveLabel();
    if (label) {
      label.hidden = !save;
      label.querySelector("span").textContent = save ?? "";
    }
    const cfg = document.querySelector("#den-lock-pop .den-lock-cfg");
    if (cfg) {
      const note = notConfiguredNote();
      cfg.hidden = !note;
      cfg.textContent = note ?? "";
    }
  });
  return vaultAsked;
}

/**
 * Why there is no save option, when the sudo ref is not configured: the
 * server's reason, which names the distribution's real config file
 * (`configFile`, e.g. config/acme.yml), never a placeholder.
 */
function notConfiguredNote() {
  const v = sudo.vault;
  if (!v || v.configured !== false || !v.configFile) return null;
  // LK-4: saving writes the ref itself; nothing to edit.
  if (v.canSave === true) return null;
  return t("lock.cfg", { file: v.configFile });
}

function saveLabel() {
  if (!sudo.vault.backendAvailable || sudo.vault.canSave === false) return null;
  return sudo.vault.hasStored
    ? t("lock.update")
    : t("lock.saveTo", { s: sudo.vault.label || sudo.vault.backend });
}

/**
 * "<command> needs your admin password", one string (so a language can
 * put the command where it reads right), then the step it ran in.
 */
function needsHtml(need) {
  const step =
    need?.command && need?.step
      ? `<span class="den-note den-lock-step">${esc(need.step)}</span>`
      : "";
  return (
    `<b id="den-lock-t">${esc(t("lock.needs", { cmd: needWhat(need) }))}</b>` +
    step
  );
}

function lockFormHtml(need) {
  const save = saveLabel();
  const note = notConfiguredNote();
  return (
    `<form class="den-lock-form">${needsHtml(need)}` +
    `<input type="password" id="den-lock-pw" placeholder="${esc(t("lock.pw"))}" aria-label="${esc(t("lock.pw"))}" autocomplete="current-password">` +
    `<label class="den-lock-save"${save ? "" : " hidden"}><input type="checkbox" id="den-lock-vault"> <span>${esc(save ?? "")}</span></label>` +
    '<span class="den-lock-err" id="den-lock-err" role="alert" hidden></span>' +
    `<span class="den-note den-lock-cfg"${note ? "" : " hidden"}>${esc(note ?? "")}</span>` +
    `<button class="den-btn primary" type="submit" id="den-lock-go">${esc(t("lock.go"))}</button>` +
    `<span class="den-note">${esc(t("lock.note"))}</span></form>`
  );
}

function openLock() {
  const chip = $("den-lock");
  const w = sudo.waiting;
  if (!chip || !w) return;
  if (overlay?.kind === "lock") {
    overlay.el.querySelector("input,button")?.focus();
    return;
  }
  closeOverlay(false);
  sh()?.closeMenu?.();
  void checkVault();
  // LK-1: in the top layer, so no modal covers it. Under an open modal
  // <dialog> only another modal is reachable (a popover there is inert),
  // so it opens as its own modal; elsewhere it is a popover.
  const pop = document.createElement("dialog");
  pop.className = "den-pop den-lock-pop";
  pop.id = "den-lock-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", "den-lock-t");
  pop.innerHTML = lockFormHtml(w.need);
  const onSubmit = async (e) => {
    e.preventDefault();
    const input = $("den-lock-pw");
    const btn = $("den-lock-go");
    const err = $("den-lock-err");
    const saveCb = $("den-lock-vault");
    const pw = input.value;
    if (!pw) return;
    btn.textContent = t("lock.checking");
    btn.disabled = true;
    err.hidden = true;
    const saveToVault = !!(saveLabel() && saveCb?.checked);
    try {
      const res = await unlockWith(pw, { saveToVault });
      if (res.ok) {
        input.value = "";
        toast(
          saveToVault && res.vaultError
            ? t("lock.saveFailed", {
                s: sudo.vault.label || sudo.vault.backend,
                err: res.vaultError,
              })
            : t("lock.saved"),
        );
        settleSudo(true);
        return;
      }
      err.textContent = res.error;
      err.hidden = false;
      input.value = "";
      input.focus();
    } finally {
      if (btn.isConnected) {
        btn.textContent = t("lock.go");
        btn.disabled = false;
      }
    }
  };
  pop.querySelector("form").addEventListener("submit", onSubmit);
  document.body.appendChild(pop);
  const underModal = [...document.querySelectorAll("dialog")].some(
    (d) => d !== pop && d.open && d.matches(":modal"),
  );
  try {
    if (underModal) pop.showModal();
    else if (typeof pop.showPopover === "function") {
      pop.setAttribute("popover", "manual");
      pop.showPopover();
    } else pop.show();
  } catch {
    pop.setAttribute("open", "");
  }
  // Escape (or a modal's cancel) says no: the action doesn't run again
  // (its run already said why it failed), and the chip goes.
  const decline = () => {
    closeOverlay(true);
    settleSudo(false);
  };
  pop.addEventListener("cancel", (e) => {
    e.preventDefault();
    decline();
  });
  const r = chip.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  chip.setAttribute("aria-expanded", "true");
  chip.setAttribute("aria-controls", pop.id);
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      decline();
    }
  });
  overlay = {
    kind: "lock",
    el: pop,
    // Another overlay closing it leaves the ask waiting: the chip
    // stays, and opens the prompt again.
    close(refocus) {
      pop.remove();
      chip.setAttribute("aria-expanded", "false");
      if (refocus && chip.isConnected && !chip.hidden) chip.focus();
    },
  };
  (
    pop.querySelector("input:not([type='checkbox'])") ||
    pop.querySelector("button") ||
    pop
  ).focus();
}

// ── wiring ──────────────────────────────────────────────────────────────────

/**
 * Wire the bar (once). `opts` are header.js's: refreshHealth(env, opts),
 * healthEnv() and storeOpenLog(repo, service, env).
 */
export function initTopbar(opts = {}) {
  hooks = { ...hooks, ...opts };
  if (inited || typeof document === "undefined") return;
  inited = true;
  trackRuns();
  // R26d: while the server doesn't answer, the chip reads unknown (never a
  // stale green); it repaints from the last health once it is back.
  serverDown = sh()?.serverUp ? !sh().serverUp() : false;
  window.addEventListener("den:server", (e) => {
    serverDown = e.detail?.up === false;
    paintChip();
  });
  paintChip();
  paintRuns();
  sh()?.runs?.onChange?.(paintRuns);
  paintLock();
  $("den-search")?.addEventListener("click", openPalette);
  $("den-status")?.addEventListener("click", () =>
    overlay?.kind === "drawer" ? closeOverlay(true) : openDrawer(),
  );
  $("den-runs")?.addEventListener("click", () => showRuns());
  $("den-lock")?.addEventListener("click", () =>
    overlay?.kind === "lock" ? closeOverlay(true) : openLock(),
  );
  // LK-2: back on this tab while an ask waits, the password may have
  // been given elsewhere (another tab or device): the action goes on.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !sudo.waiting) return;
    if (sh()?.apiOff?.() === true) return;
    void getJson("/api/sudo-password/status", null).then((st) => {
      if (st?.set) settleSudo(true);
    });
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette();
    } else if (e.key === "Escape" && overlay && !e.defaultPrevented) {
      e.preventDefault();
      closeOverlay(true);
    }
  });
}

/** For tests and plugins: open an overlay by name. */
export const overlays = {
  palette: () => openPalette(),
  drawer: () => openDrawer(),
  lock: () => openLock(),
  close: () => closeOverlay(true),
};
