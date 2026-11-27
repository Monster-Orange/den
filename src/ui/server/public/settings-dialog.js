import {
  DIALOG_NAV_WORDS,
  dialogNavHtml,
  hydrateDialogNav,
} from "/kit/dialog-nav.js";
import * as appearance from "/appearance.js";
import { registerDenSettings } from "/settings-registry.js";
import { localizeCategory, localizeRow, sections } from "/settings-page.js";
import { drawRows, helpHtml, settingsCtx } from "/settings-rows.js";

export const SETTINGS_GROUPS = [
  {
    id: "you",
    panes: ["appearance", "editor", "navigation", "graph"],
  },
  { id: "work", panes: ["workspace", "agents", "hub"] },
  { id: "access", panes: ["access", "embed", "secrets"] },
  { id: "den", panes: ["server", "cli", "distribution"] },
];

export const PANE_CHECKS = { person: "person" };

export const PANES = Object.fromEntries(
  SETTINGS_GROUPS.flatMap((g) =>
    g.panes.map((id) => [id, { group: g.id, check: PANE_CHECKS.person }]),
  ),
);

const ACCOUNT_ROWS = new Set(["cli.signin", "access.devices", "access.pair"]);
export const inAccount = (row) =>
  ACCOUNT_ROWS.has(row.id) ||
  String(row.id).startsWith("notifications.") ||
  row.category === "notifications";

export const ACCOUNT_LINKS = {
  access: { pane: "devices", text: "setd.toAccount.devices" },
  cli: { pane: "profile", text: "setd.toAccount.profile" },
};

export const SUBS = {};

SUBS.embed = {
  apps: [
    "app_keys",
    "origins",
    "context_max_kb",
    "key_minutes",
    "app_key_audit",
    "paste_max_kb",
    "url_max",
  ],
  feeds: [
    "feed_max_streams",
    "feed_event_max_kb",
    "feed_events_per_minute",
    "feed_keep_events",
    "feed_read_max_kb",
    "feed_list_timeout",
    "feed_list_max_mb",
  ],
};

SUBS.server = {
  restarts: [
    "crash_loop",
    "crash_loop_minutes",
    "crash_loop_wait",
    "self_update",
    "update_check",
    "restart",
    "install_mode",
    "restore_services",
  ],
  address: [
    "address_check_timeout",
    "address_check_retries",
    "address_check_cache",
    "address_check_drop_after",
    "address_unknown_keep",
    "bridge_listen",
    "bridge_probe",
    "address",
  ],
  terminals: [
    "sessions_max",
    "sessions_close_grace",
    "sessions_size_claim_grace",
    "sessions_size_leave_grace",
    "sessions_pty_close",
    "sessions_pty_warn",
    "sessions_pty_machine",
  ],
  logs: [
    "report_screenshot_days",
    "server_log_max",
    "slow_request_ms",
    "event_loop_lag_ms",
    "report_screenshot_max",
    "report_screenshot_hub_max",
    "report_screenshot_hub_wait",
    "report_visibility_cache",
    "report_visibility_wait",
    "report_visibility_retry",
  ],
  checks: [
    "lookup_first",
    "lookup_retry",
    "menu_load_timeout",
    "owner_name_timeout",
    "ready_probe",
    "start_wait",
    "tools_probe",
    "health_poll",
    "health_poll_hidden",
    "git_reads",
  ],
  github: [
    "github_watch_interval",
    "github_watch_max_interval",
    "github_api_budget_floor",
    "github_watches_max",
    "github_watch_stale",
    "github_watch_max_open",
    "github_rerun_look",
  ],
  gate: [
    "gate_cpu",
    "gate_cpu_beside",
    "gate_cpu_beside_release",
    "gate_load_hold_per_core",
    "gate_memory_free_min_percent",
    "gate_swap_hold_gb",
    "gate_memory_reading_keep_seconds",
    "gate_vm_memory_share",
    "gate_cpu_hold_load",
    "gate_max_start_load",
    "gate_max_start_wait_minutes",
    "gate_reap_grace_seconds",
    "gate_local_browser",
    "gate_overrun",
    "gate_overrun_bell",
    "gate_remote_renew",
    "gate_remote_lapse",
    "gate_remote_slots",
    "gate_remote_asks",
    "gate_priority_max",
    "gate_priority_pass",
    "gate_release_pass_other",
    "gate_priority_agents",
    "gate_priority_runners",
    "gate_browser_container",
    "gate_claim",
    "gate_mcp_renew",
    "gate_mcp_lapse",
    "gate_mcp_grace",
    "gate_waiter_return",
    "gate_class_order",
    "gate_class_map",
    "gate_class_windows",
    "gate_runners",
    "gate_boxes",
    "gate_runner_entries",
    "gate_box_check",
    "gate_box_recheck",
    "gate_box_default",
    "gate_host_only",
    "gate_route_agents",
    "gate_route_commands",
    "gate_throwaway_sweep",
    "gate_outside",
  ],
};

export function subsOf(pane, rows) {
  const plan = SUBS[pane];
  if (!plan) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = Object.entries(plan).map(([key, ids]) => ({
    key,
    rows: ids.map((id) => byId.get(`${pane}.${id}`)).filter(Boolean),
  }));
  const placed = new Set(out.flatMap((g) => g.rows));
  out.push({ key: "more", rows: rows.filter((r) => !placed.has(r)) });
  return out.filter((g) => g.rows.length);
}

export function drawSubs(host, pane, rows, ctx, shell) {
  for (const g of subsOf(pane, rows)) {
    const box = document.createElement("div");
    box.className = "setd-sub";
    box.innerHTML = `<h4 class="setd-subh">${esc(shell.t(g.key === "more" ? "setd.sub.more" : `setd.sub.${pane}.${g.key}`))}</h4><div class="setd-subrows"></div>`;
    host.append(box);
    const n = drawRows(box.lastElementChild, g.rows, ctx, {
      idPrefix: `setd-${pane}-${g.key}-`,
    });
    if (!n) box.hidden = true;
  }
}

export const PANE_DRAW = {};

export function paneOf(hash, rows) {
  const h = decodeURIComponent(String(hash || "").replace(/^#/, ""));
  if (!h) return { pane: null, at: null };
  if (PANES[h]) return { pane: h, at: null };
  const row = rows.find((r) => r.id === h);
  if (row && PANES[row.category]) return { pane: row.category, at: row.id };
  if (h === "notifications" || h.startsWith("notifications."))
    return { pane: null, at: null, account: "notifications" };
  const cat = h.split(".")[0];
  return PANES[cat] ? { pane: cat, at: null } : { pane: null, at: null };
}

export function settingsRedirect(loc, rows) {
  const q = new URLSearchParams(loc.search || "");
  const to = paneOf(loc.hash, rows);
  const search = q.get("q");
  q.delete("q");
  if (to.account) {
    q.set("account", to.account);
    return `/?${q}`;
  }
  q.set("settings", to.pane ?? "");
  if (to.at) q.set("at", to.at);
  if (search) q.set("sq", search);
  return `/?${q}`;
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export function indexHtml(rows) {
  return (
    '<ul class="setd-index" hidden>' +
    rows
      .map(
        (r) =>
          `<li data-entry="${esc(r.id)}" data-entry-en="${esc(r.labelEn ?? r.label)}">${esc(r.label)}</li>`,
      )
      .join("") +
    "</ul>"
  );
}

const accountWord = (shell) => {
  const lang = shell.lang?.() ?? "en";
  return (DIALOG_NAV_WORDS[lang] ?? DIALOG_NAV_WORDS.en).toAccount;
};

function linkRow(shell, pane) {
  const to = ACCOUNT_LINKS[pane];
  if (!to) return "";
  return (
    `<div class="set-row setd-link"><div class="row"><span class="l">${esc(shell.t(to.text))}</span>` +
    `<div class="ctl"><a class="den-btn sm" href="?account=${esc(to.pane)}" data-dn-cross>${esc(accountWord(shell))}</a></div></div></div>`
  );
}

let live = null;

async function build(shell) {
  if (!shell.settingsCategories().some((c) => c.id === "appearance"))
    registerDenSettings(shell);
  const [ctx, session] = await Promise.all([
    settingsCtx({ shell, appearance }),
    fetch("/api/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  const tr = shell.tr;
  const all = shell.settings().map((r) => ({
    ...localizeRow(r, tr),
    labelEn: r.label,
  }));
  const rows = all.filter((r) => !inAccount(r));
  const bySection = new Map(
    sections(
      shell.settingsCategories().map((c) => localizeCategory(c, tr)),
      rows,
      "",
    ).map((s) => [s.category.id, s]),
  );
  const cats = new Map(
    shell.settingsCategories().map((c) => [c.id, localizeCategory(c, tr)]),
  );
  const readOnly =
    session?.signedIn === true ? undefined : shell.t("setd.readOnly");
  const lang = shell.lang?.() ?? "en";
  const groups = SETTINGS_GROUPS.map((g) => ({
    label: shell.t(`setd.g.${g.id}`),
    panes: g.panes
      .filter((id) => cats.has(id))
      .map((id) => ({
        id,
        title: cats.get(id).label,
        lazy: true,
        readOnly: PANES[id].check === PANE_CHECKS.person ? readOnly : undefined,
      })),
  }));
  const holder = document.createElement("div");
  holder.innerHTML = dialogNavHtml({
    id: "den-settings",
    kind: "settings",
    title: shell.t("n.settings"),
    groups,
    cross: { href: "?account=profile" },
    lang,
    words: DIALOG_NAV_WORDS[lang],
    href: location.href,
    shown: false,
  });
  const dialog = holder.firstElementChild;
  dialog.classList.add("setd");
  for (const s of dialog.querySelectorAll("section[data-dn-pane]")) {
    const id = s.dataset.dnPane;
    s.querySelector(".dn-body").innerHTML = indexHtml(
      bySection.get(id)?.rows ?? [],
    );
  }
  document.body.append(dialog);
  const descOf = (pane) => {
    const d = cats.get(pane)?.description;
    const html = d && helpHtml(d, `setd-${pane}-desc`, "", (k) => shell.t(k));
    return d ? `<div class="setd-desc">${html}</div>` : "";
  };
  const load = (pane, body) => {
    body.innerHTML =
      descOf(pane) + '<div class="setd-rows"></div>' + linkRow(shell, pane);
    const host = body.querySelector(".setd-rows");
    const own = bySection.get(pane)?.rows ?? [];
    const mark = () => {
      for (const el of host.querySelectorAll(".set-row[data-setting]")) {
        const r = own.find((x) => x.id === el.dataset.setting);
        const label = el.querySelector(".l");
        if (!r || !label || label.dataset.entry) continue;
        label.dataset.entry = r.id;
        label.dataset.entryEn = r.labelEn;
        label.tabIndex = -1;
      }
    };
    new MutationObserver(mark).observe(host, {
      childList: true,
      subtree: true,
    });
    if (PANE_DRAW[pane]) PANE_DRAW[pane](host, own, ctx, shell);
    else if (SUBS[pane]) drawSubs(host, pane, own, ctx, shell);
    else drawRows(host, own, ctx, { idPrefix: `setd-${pane}-` });
    mark();
  };
  const nav = hydrateDialogNav(dialog, {
    lang,
    words: DIALOG_NAV_WORDS[lang],
    load,
    onCross: (href) => {
      const to = new URL(href, location.href).searchParams.get("account");
      if (to === null || !shell.openAccount) location.assign(href);
      else shell.openAccount(to || null);
    },
    onClose: () => {
      dialog.remove();
      live = null;
    },
  });
  return { nav, rows };
}

export async function openSettings(
  shell,
  { pane = null, at = null, hash = null } = {},
) {
  live ??= build(shell);
  const { nav, rows } = await live;
  if (hash) {
    const to = paneOf(hash, rows);
    if (to.account)
      return shell.openAccount
        ? shell.openAccount(to.account)
        : location.assign(`?account=${to.account}`);
    ({ pane, at } = to);
  }
  nav.open(pane, at);
  const sq = new URLSearchParams(location.search).get("sq");
  const box = sq && nav.element.querySelector("[data-dn-search]");
  if (box) {
    box.value = sq;
    box.dispatchEvent(new Event("input"));
  }
  nav.element
    .querySelector('a.dn-row[aria-current="true"]')
    ?.scrollIntoView({ block: "nearest" });
}

function fromHref(a) {
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || u.pathname !== "/settings") return null;
  return u;
}

export function initSettingsDialog(shell) {
  for (const href of [
    "/kit/dialog-nav.css",
    "/settings-rows.css",
    "/settings-dialog.css",
  ]) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest?.("a[href]");
      const u = a && fromHref(a);
      if (!u) return;
      e.preventDefault();
      void openSettings(shell, { hash: u.hash });
    },
    true,
  );
  const q = new URLSearchParams(location.search);
  if (q.has("settings"))
    void openSettings(shell, {
      pane: q.get("settings") || null,
      at: q.get("at"),
    });
}
