/**
 * The top bar's chips and overlays (0.3.0-dev.20): shell.js draws the bar,
 * this module drives it. header.js imports it on every page.
 *
 *   ⌘K search (R5)   #den-search, ⌘K or Ctrl+K: the command palette (R17)
 *   status (R6)       #den-status: "All N healthy" / "ok/N healthy · k down",
 *                     from the same rollup as the rail's Services badge; it
 *                     opens the status drawer (R15)
 *   Runs (R7)         #den-runs: a pulsing dot and "N running" while a run
 *                     streams. Until the runs dock (dev.21) it shows the
 *                     page's own output pane (an element marked
 *                     `data-den-output`); a page with none links to the page
 *                     that ran the last run
 *   lock (R8)         #den-lock: 🔒 Locked / 🔓 Unlocked, the admin-password
 *                     form in a popover (Local Dev's sudo banner, moved)
 *
 * Exports for pages (through header.js): requireUnlock() (Local Dev's lock
 * rule: true when unlocked, else the lock popover opens), isUnlocked(),
 * onLockChange(fn), setServiceRunner(fn) (the page that runs Start and
 * Restart itself), takePendingAction().
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
export function statusChip(sum, t = defaultT) {
  const extra = [
    sum.unchecked ? t("status.unchecked", { n: sum.unchecked }) : "",
    sum.pending ? `${sum.pending} pending` : "",
    sum.awaiting ? `${sum.awaiting} still checking` : "",
  ].filter(Boolean);
  const title = [`${sum.n} checked`, ...extra].join(" · ");
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

const EN = {
  "status.checking": "Checking…",
  "status.none": "No services",
  "status.unchecked": "{n} not checked",
  "status.all": "All {n} healthy",
  "status.some": "{ok}/{n} healthy",
  "status.down": "{n} down",
};
function defaultT(key, vars) {
  return String(EN[key] ?? key).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

/**
 * What a check said, for a tooltip or a card: "http://shop/healthz → 200",
 * "http://shop/healthz — connect ECONNREFUSED", "pending", "not checked".
 */
export function checkLine(i) {
  const what = i.url ?? i.check ?? null;
  if (i.awaiting) return "still checking";
  if (i.ok == null)
    return i.pending ? `${what ?? "check"} — pending` : "not checked";
  if (!what) return i.ok ? "healthy" : (i.error ?? "down");
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
const LS_LOCK = "__DEN_CLI__-lock";
const SS_PENDING = "__DEN_CLI__-pending-action";
const KIND = {
  page: "Page",
  service: "Service",
  app: "App",
  action: "Action",
  setting: "Setting",
};
const kindLabel = (k) =>
  KIND[k] ?? String(k).charAt(0).toUpperCase() + String(k).slice(1);

const sh = () => (typeof window !== "undefined" ? window.denShell : null);
const t = (k, v) => (sh()?.t ? sh().t(k, v) : defaultT(k, v));
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

function paintChip() {
  const chip = $("den-status");
  if (!chip) return;
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
    '<div class="den-dh"><h2 id="den-drawer-title">Status</h2>' +
    '<button type="button" class="den-ib" data-refresh title="Check again" aria-label="Check again">⟳</button>' +
    '<button type="button" class="den-ib" data-close aria-label="Close">✕</button></div>' +
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
  if (s.state === "ok") return s.ms != null ? `${s.ms} ms` : "healthy";
  if (s.state === "down") return "down";
  if (s.state === "pending") return "pending";
  if (s.state === "awaiting") return "checking…";
  return "not checked";
}

/**
 * A drawer row's accessible name: service, state and latency. What the
 * check ran (a URL, or a whole shell command) is its description, not its
 * name (SA's dev.20 run).
 */
export function rowName(s) {
  const word = s.state === "ok" ? "healthy" : msText(s);
  return s.state === "ok" && s.ms != null
    ? `${s.id}, ${word}, ${s.ms} ms`
    : `${s.id}, ${word}`;
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
    ? new Intl.DateTimeFormat(undefined, {
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
      '<section aria-labelledby="den-dr-p"><h2 class="den-sec" id="den-dr-p">Needs attention</h2>' +
      (cards.length
        ? '<div class="den-cards">' +
          cards
            .map(
              (c) =>
                '<div class="den-prob-card">' +
                `<div class="den-t"><span class="den-dot bad" aria-hidden="true"></span>${esc(c.service)} <span class="den-mono">${esc(c.repo)}</span></div>` +
                `<div class="den-s">${esc(c.line)}${at ? ` · failed at ${esc(at)}` : ""}${c.workspaces.length > 1 ? ` · ${esc(c.workspaces.join(", "))}` : ""}</div>` +
                '<div class="den-a">' +
                `<button type="button" class="den-btn sm primary" data-k="start:${esc(c.id)}" data-start="${esc(c.id)}" aria-label="Start ${esc(c.id)}">Start</button>` +
                `<button type="button" class="den-btn sm" data-k="logs:${esc(c.id)}" data-logs="${esc(c.id)}" aria-label="Logs of ${esc(c.id)}">Logs</button>` +
                `<button type="button" class="den-btn sm" data-k="pin:${esc(c.id)}" data-pin="${esc(c.id)}" aria-pressed="${pinned(c.id)}" aria-label="${pinned(c.id) ? "Unpin" : "Pin"} ${esc(c.id)}">${pinned(c.id) ? "Unpin" : "Pin"}</button>` +
                "</div></div>",
            )
            .join("") +
          "</div>"
        : '<p class="den-none">Nothing needs attention.</p>') +
      "</section>" +
      '<section aria-labelledby="den-dr-e"><h2 class="den-sec" id="den-dr-e">Everything</h2><div class="den-grps">' +
      groups
        .map(
          (g) =>
            '<div class="den-grp">' +
            `<h3><span>${esc(g.title)}</span><span title="${g.ok} of ${g.checked} checked services healthy">${g.ok}/${g.checked}</span></h3>` +
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
 * its lock rule and its output pane) registers `fn(cmd, svc)`; `svc` is
 * `{ repo, service, address, workspaces }`.
 */
export function setServiceRunner(fn) {
  serviceRunner = typeof fn === "function" ? fn : null;
}

/**
 * Start (`up`) or Restart from the drawer or the palette: an explicit
 * action. The page's runner does it where there is one. Elsewhere the lock
 * rule applies first (requireUnlock), then the action is handed to Local
 * Dev, where the command runs with its output (a run stops when its page
 * closes, so it can't run on a page that is about to be left): the page
 * stores it for this tab (sessionStorage, not a link anyone could open)
 * and Local Dev takes it once (takePendingAction).
 */
export function runServiceAction(cmd, svc) {
  if (serviceRunner) return serviceRunner(cmd, svc);
  if (!requireUnlock()) return;
  try {
    sessionStorage.setItem(
      SS_PENDING,
      JSON.stringify({ cmd, address: svc.address, at: Date.now() }),
    );
  } catch {
    toast("Open Local Dev to run this");
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
      keywords: [n.id, n.group],
      run: () => go(n.href),
    });
  }
  const settings = document.querySelector('.den-rail [data-nav="settings"]');
  if (settings)
    items.push({
      key: "page:settings",
      kind: "page",
      label: settings.getAttribute("title") || "Settings",
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
        sub: `${g.repos.length} ${g.repos.length === 1 ? "repo" : "repos"}`,
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
      label: `Restart ${id}`,
      keywords: ["restart"],
      hideEmpty: true,
      run: () => runServiceAction("restart", svcOf(id)),
    });
    items.push({
      key: `logs:${id}`,
      kind: "action",
      label: `Logs of ${id}`,
      keywords: ["logs", "tail"],
      hideEmpty: true,
      run: () => openLogs(svcOf(id)),
    });
  }
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
    '<ul id="den-pal-list" role="listbox" aria-label="Results"></ul>' +
    '<div class="den-foot" aria-hidden="true"><span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span></div>' +
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
      : '<li class="den-pal-empty" role="presentation">No matches</li>';
    if (list.length)
      input.setAttribute("aria-activedescendant", `den-pal-o-${sel}`);
    else input.removeAttribute("aria-activedescendant");
    $("den-pal-count").textContent =
      `${list.length} ${list.length === 1 ? "result" : "results"}`;
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

function paintRuns() {
  const chip = $("den-runs");
  if (!chip) return;
  const n = running.size;
  const last = lastRun();
  chip.title = n
    ? [...running.values()].join(", ")
    : last
      ? `Last run: ${last.label}`
      : "Runs";
  chip.setAttribute("aria-label", n ? `Runs, ${n} running` : "Runs");
  chip.innerHTML =
    `<span class="den-dot ${n ? "run" : "off"}" aria-hidden="true"></span>` +
    `<span class="den-n den-lbl-l">${esc(n ? t("runs.n", { n }) : t("runs.title"))}</span>`;
}

/**
 * Until the runs dock (dev.21): the page's own output pane (the first
 * visible `[data-den-output]`, which gets `den:show-output` first so a page
 * can open it), else the page that ran the last run, else a toast.
 */
export function showRuns() {
  const panes = [...document.querySelectorAll("[data-den-output]")];
  for (const p of panes)
    p.dispatchEvent(new CustomEvent("den:show-output", { bubbles: true }));
  const pane = panes.find((p) => p.getClientRects().length > 0);
  if (pane) {
    if (!pane.hasAttribute("tabindex")) pane.tabIndex = -1;
    pane.scrollIntoView?.({ block: "nearest" });
    pane.focus({ preventScroll: true });
    return "pane";
  }
  const last = lastRun();
  const here = location.pathname + location.search;
  if (last?.page && last.page !== here) {
    go(last.page);
    return "link";
  }
  toast("Nothing has run yet. A page's output shows here.");
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

// ── lock chip (R8) ──────────────────────────────────────────────────────────

const lock = {
  known: false,
  unlocked: false,
  passwordless: false,
  vault: {
    backend: "none",
    label: "",
    backendAvailable: false,
    hasStored: false,
  },
  subs: new Set(),
};

export function isUnlocked() {
  return lock.unlocked;
}
/** fn(unlocked) on every change. */
export function onLockChange(fn) {
  lock.subs.add(fn);
  return () => lock.subs.delete(fn);
}

/**
 * Local Dev's lock rule, for every page: true when unlocked; otherwise the
 * lock popover opens on its password field and the action doesn't run.
 */
export function requireUnlock() {
  if (lock.unlocked) return true;
  openLock();
  return false;
}

function setUnlocked(unlocked, passwordless = false) {
  const changed = lock.unlocked !== unlocked || !lock.known;
  lock.known = true;
  lock.unlocked = unlocked;
  lock.passwordless = passwordless;
  try {
    sessionStorage.setItem(LS_LOCK, unlocked ? "1" : "0");
  } catch {
    /* a convenience only */
  }
  paintLock();
  if (overlay?.kind === "lock") overlay.redraw?.();
  if (changed) for (const fn of lock.subs) fn(unlocked);
}

function paintLock() {
  const chip = $("den-lock");
  if (!chip) return;
  chip.title = lock.unlocked
    ? lock.passwordless
      ? "Passwordless sudo (NOPASSWD): no admin password needed"
      : "Unlocked for this session"
    : t("lock.title");
  chip.innerHTML =
    `<span class="den-lock-ic" aria-hidden="true">${lock.unlocked ? "🔓" : "🔒"}</span>` +
    `<span class="den-lbl-l">${esc(lock.unlocked ? t("lock.unlocked") : t("lock.locked"))}</span>`;
  chip.setAttribute(
    "aria-label",
    lock.unlocked ? t("lock.unlocked") : t("lock.locked"),
  );
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
 * Local Dev's bootstrap, moved: the in-memory status first (fast), then,
 * when locked, the vault's stored password in the background (op can be
 * slow: Touch ID, a cold session) so nothing waits on it.
 */
/**
 * What the secrets backend can do here (`backend`, `backendAvailable`,
 * `reason`): asked once a page, then kept. Not configured or unavailable
 * means no save option and no auto-load.
 */
let vaultAsked = null;
function checkVault() {
  vaultAsked ??= getJson("/api/sudo-password/vault-status", {
    backend: "none",
    label: "",
    backendAvailable: false,
    hasStored: false,
  }).then((v) => {
    lock.vault = v;
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

async function initLock() {
  try {
    if (sessionStorage.getItem(LS_LOCK) === "1") {
      lock.unlocked = true;
      paintLock();
    }
  } catch {
    /* none */
  }
  const st = await getJson("/api/sudo-password/status", {
    set: false,
    passwordless: false,
  });
  if (st.set || st.passwordless) {
    setUnlocked(true, !!st.passwordless && !st.set);
    return;
  }
  setUnlocked(false);
  // The vault (op) only where Local Dev always asked it, on load; any
  // other page asks when the popover opens, so a page view never wakes op.
  if (location.pathname !== "/local-dev") return;
  await checkVault();
  if (!lock.vault.backendAvailable || !lock.vault.hasStored || lock.unlocked)
    return;
  const loaded = await getJson(
    "/api/sudo-password/load-from-vault",
    { ok: false },
    { method: "POST" },
  );
  if (loaded.ok && !lock.unlocked) setUnlocked(true);
}

/**
 * Why there is no save option, when the sudo ref is not configured: the
 * server's reason, which names the distribution's real config file
 * (`configFile`, e.g. config/acme.yml), never a placeholder.
 */
function notConfiguredNote() {
  const v = lock.vault;
  if (!v || v.configured !== false || !v.configFile) return null;
  return `Saving the password is off: set secrets.provider and secrets.refs.sudo in ${v.configFile}.`;
}

function saveLabel() {
  if (!lock.vault.backendAvailable) return null;
  return lock.vault.hasStored
    ? "Update stored password"
    : `Save to ${lock.vault.label || lock.vault.backend}`;
}

function lockFormHtml() {
  const save = saveLabel();
  const note = notConfiguredNote();
  return (
    `<form class="den-lock-form"><b id="den-lock-t">${esc(t("lock.title"))}</b>` +
    '<input type="password" id="den-lock-pw" placeholder="Admin password" aria-label="Admin password" autocomplete="current-password">' +
    `<label class="den-lock-save"${save ? "" : " hidden"}><input type="checkbox" id="den-lock-vault"> <span>${esc(save ?? "")}</span></label>` +
    '<span class="den-lock-err" id="den-lock-err" role="alert" hidden></span>' +
    `<span class="den-note den-lock-cfg"${note ? "" : " hidden"}>${esc(note ?? "")}</span>` +
    '<button class="den-btn primary" type="submit" id="den-lock-go">Unlock</button>' +
    `<span class="den-note">Den asks once per session. Agents can't unlock.</span></form>`
  );
}

function openLock() {
  const chip = $("den-lock");
  if (!chip) return;
  if (overlay?.kind === "lock") {
    overlay.el.querySelector("input,button")?.focus();
    return;
  }
  closeOverlay(false);
  sh()?.closeMenu?.();
  if (!lock.unlocked) void checkVault();
  const pop = document.createElement("div");
  pop.className = "den-pop den-lock-pop";
  pop.id = "den-lock-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", t("lock.title"));
  let forceForm = false;
  const draw = () => {
    if (!lock.unlocked || forceForm) pop.innerHTML = lockFormHtml();
    else
      pop.innerHTML =
        `<div class="den-ml">${esc(t("lock.unlocked"))}</div>` +
        `<div class="den-lock-desc">${esc(lock.passwordless ? "Passwordless sudo (NOPASSWD): no admin password needed." : "Unlocked for this session: start, stop and restart work on every page.")}</div>` +
        (lock.passwordless
          ? ""
          : '<button type="button" class="den-mi" data-reenter>Enter the password again…</button>');
    pop.querySelector("form")?.addEventListener("submit", onSubmit);
    pop.querySelector("[data-reenter]")?.addEventListener("click", () => {
      forceForm = true;
      draw();
      pop.querySelector("input")?.focus();
    });
  };
  const onSubmit = async (e) => {
    e.preventDefault();
    const input = $("den-lock-pw");
    const btn = $("den-lock-go");
    const err = $("den-lock-err");
    const saveCb = $("den-lock-vault");
    const pw = input.value;
    if (!pw) return;
    btn.textContent = "Checking…";
    btn.disabled = true;
    err.hidden = true;
    const saveToVault = !!(lock.vault.backendAvailable && saveCb?.checked);
    try {
      const r = await fetch("/api/sudo-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw, saveToVault }),
      });
      const data = await r.json();
      if (r.ok) {
        input.value = "";
        if (data.savedToVault) lock.vault.hasStored = true;
        forceForm = false;
        setUnlocked(true);
        closeOverlay(true);
        toast(
          saveToVault && data.vaultError
            ? `Unlocked, but saving to ${lock.vault.label || lock.vault.backend} failed: ${data.vaultError}`
            : "Unlocked for this session",
        );
        return;
      }
      err.textContent = data.error ?? "Incorrect password — try again";
      err.hidden = false;
      input.value = "";
      input.focus();
    } catch {
      err.textContent = "Request failed — is the server running?";
      err.hidden = false;
    } finally {
      if (btn.isConnected) {
        btn.textContent = "Unlock";
        btn.disabled = false;
      }
    }
  };
  draw();
  document.body.appendChild(pop);
  const r = chip.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  chip.setAttribute("aria-expanded", "true");
  chip.setAttribute("aria-controls", pop.id);
  const onDown = (e) => {
    if (!pop.contains(e.target) && !chip.contains(e.target))
      closeOverlay(false);
  };
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay(true);
    }
  });
  document.addEventListener("mousedown", onDown, true);
  overlay = {
    kind: "lock",
    el: pop,
    redraw: draw,
    close(refocus) {
      document.removeEventListener("mousedown", onDown, true);
      pop.remove();
      chip.setAttribute("aria-expanded", "false");
      if (refocus && chip.isConnected) chip.focus();
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
  paintChip();
  paintRuns();
  paintLock();
  $("den-search")?.addEventListener("click", openPalette);
  $("den-status")?.addEventListener("click", () =>
    overlay?.kind === "drawer" ? closeOverlay(true) : openDrawer(),
  );
  $("den-runs")?.addEventListener("click", () => showRuns());
  $("den-lock")?.addEventListener("click", () =>
    overlay?.kind === "lock" ? closeOverlay(true) : openLock(),
  );
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette();
    } else if (e.key === "Escape" && overlay && !e.defaultPrevented) {
      e.preventDefault();
      closeOverlay(true);
    }
  });
  void initLock();
}

/** For tests and plugins: open an overlay by name. */
export const overlays = {
  palette: () => openPalette(),
  drawer: () => openDrawer(),
  lock: () => openLock(),
  close: () => closeOverlay(true),
};
