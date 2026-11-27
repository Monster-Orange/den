import {
  DIALOG_NAV_WORDS,
  dialogNavHtml,
  hydrateDialogNav,
} from "/kit/dialog-nav.js";
import * as appearance from "/appearance.js";
import { registerDenSettings } from "/settings-registry.js";
import { localizeCategory, localizeRow, sections } from "/settings-page.js";
import { drawRows, settingsCtx } from "/settings-rows.js";

export const SETTINGS_GROUPS = [
  {
    id: "you",
    panes: ["appearance", "editor", "navigation", "graph", "notifications"],
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
  notifications: {
    pane: "notifications",
    text: "setd.toAccount.notifications",
  },
  access: { pane: "devices", text: "setd.toAccount.devices" },
  cli: { pane: "profile", text: "setd.toAccount.profile" },
};

const SUBS = {
  workspace: {
    project: ["name", "colour", "editor"],
    hub: ["hub", "hub_delivery_loop", "hub_delivery_loop_extra"],
    agents: [
      "agents_max_per_project",
      "agents_mode",
      "approvals_policy",
      "approvals_watch",
      "approvals_critical",
    ],
    tools: ["mcp_servers", "event_feeds"],
  },
  agents: {
    approvals: [
      "approvals_policy",
      "settings_limits",
      "settings_look",
      "settings_integrations",
      "settings_network",
      "settings_agent_powers",
      "approvals_watch",
      "approvals_critical",
      "held_wait",
      "draft_hold_max",
    ],
    limits: [
      "max_concurrent",
      "max_per_project",
      "max_subagents",
      "subagents_respect_load_hold",
    ],
    startup: [
      "default_mode",
      "runtimes",
      "skill_packs",
      "skill_packs.pstack",
      "personas",
    ],
    resume: [
      "resume_batch",
      "resume_gap",
      "resume_load",
      "resume_max_wait",
      "pane_reconnect",
      "pane_reconnect_window",
      "pane_reconnect_wait",
      "keep_running",
    ],
    context: [
      "compaction_loop",
      "compaction_minutes",
      "compaction_pause",
      "instruction_share",
      "context_tokens",
      "rotation",
    ],
    issues: [
      "issue_writes",
      "issue_writes_per_hour",
      "issue_writes_visibility_minutes",
      "issue_writes_public",
      "hub_github",
    ],
    waits: [
      "list_host_wait",
      "shell_path_wait",
      "list_refresh_wait",
      "hook_wait",
      "hook_retries",
      "hook_backoff",
    ],
    page: ["layout", "coach_counts", "helpers_shown"],
  },
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

function drawSubs(host, pane, rows, ctx, shell) {
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

export const PANE_DRAW = {
  workspace: (host, rows, ctx, shell) =>
    drawSubs(host, "workspace", rows, ctx, shell),
  agents: (host, rows, ctx, shell) =>
    drawSubs(host, "agents", rows, ctx, shell),
};

export function paneOf(hash, rows) {
  const h = decodeURIComponent(String(hash || "").replace(/^#/, ""));
  if (!h) return { pane: null, at: null };
  if (PANES[h]) return { pane: h, at: null };
  const row = rows.find((r) => r.id === h);
  if (row && PANES[row.category]) return { pane: row.category, at: row.id };
  const cat = h.split(".")[0];
  return PANES[cat] ? { pane: cat, at: null } : { pane: null, at: null };
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
        desc: cats.get(id).description,
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
  const load = (pane, body) => {
    body.innerHTML = '<div class="setd-rows"></div>' + linkRow(shell, pane);
    const host = body.firstElementChild;
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
    else drawRows(host, own, ctx, { idPrefix: `setd-${pane}-` });
    mark();
  };
  const nav = hydrateDialogNav(dialog, {
    lang,
    words: DIALOG_NAV_WORDS[lang],
    load,
    onCross: (href) => location.assign(href),
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
  if (hash) ({ pane, at } = paneOf(hash, rows));
  nav.open(pane, at);
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
