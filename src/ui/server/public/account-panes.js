import { DEN_SETTINGS, seenAgo } from "/settings-registry.js";
import { drawRows, settingsCtx } from "/settings-rows.js";
import { localizeRow } from "/settings-page.js";
import { inAccount } from "/settings-dialog.js";
import {
  appearanceState,
  ensureAppearance,
  setAppearance,
} from "/appearance.js";

export const ACCOUNT_PANES = ["profile", "access", "devices", "notifications"];

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const kv = (label, valueHtml) =>
  `<div class="dn-kv"><span>${esc(label)}</span><span>${valueHtml}</span></div>`;

export function signedInWords(identity, t) {
  const id = identity ?? {};
  if (id.kind === "github")
    return id.login
      ? t("set.ui.viaGithubAs", { login: id.login })
      : t("set.ui.viaGithub");
  if (id.kind === "local") return t("account.viaLocal");
  if (id.via === "code") return t("account.viaCode");
  if (id.via === "link") return t("account.viaLink");
  return t("account.viaOther");
}

export function githubWords(owner, t, now = Date.now()) {
  if (!owner) return t("account.ghUnread");
  const o = owner.owner;
  if (!o?.login) return t("account.ghNone");
  return o.linkedAt
    ? t("account.ghLinkedAgo", {
        login: o.login,
        ago: seenAgo(o.linkedAt, now),
      })
    : t("account.ghLinked", { login: o.login });
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function accessHtml({ session, owner, account }, t) {
  return (
    kv(t("account.signedIn"), esc(signedInWords(session?.identity, t))) +
    kv("GitHub", esc(githubWords(owner, t))) +
    (account?.owner
      ? `<p class="dn-pane-d"><a href="?settings=access" data-dn-cross>${esc(t("account.toAccess"))}</a></p>`
      : "")
  );
}

export function whoOf(identity) {
  const id = identity ?? {};
  if (id.kind === "github") return { name: id.name, login: id.login };
  if (id.kind === "local" && id.owner)
    return { name: id.owner.name, login: id.owner.login, owner: true };
  return {};
}

function profileHtml({ session, account }, t) {
  const w = whoOf(session?.identity);
  const owner = w.owner || account?.owner;
  return (
    (w.name ? kv(t("account.name"), esc(w.name)) : "") +
    kv(
      "GitHub",
      w.login
        ? `<span translate="no">@${esc(w.login)}</span>`
        : esc(t("account.ghNone")),
    ) +
    (owner ? kv(t("account.role"), esc(t("acct.roleOwner"))) : "") +
    `<div data-acct-rows></div>` +
    `<p class="dn-pane-d"><a href="?account=devices" data-dn-hit="devices">${esc(t("account.toDevices"))}</a></p>`
  );
}

const localRows = (ids, shell) =>
  ids
    .map(registryRow)
    .filter(Boolean)
    .map((r) => localizeRow(r, shell.tr))
    .map((r) => (r.id === "cli.signin" ? { ...r, description: "" } : r));

const rowsCtx = (shell) =>
  settingsCtx({
    shell,
    appearance: { appearanceState, ensureAppearance, setAppearance },
  });

async function mountRows(host, ids, shell) {
  const ctx = await rowsCtx(shell);
  if (!ctx) return false;
  drawRows(host, localRows(ids, shell), ctx, {
    idPrefix: "acct-",
    scopeTag: false,
  });
  return true;
}

function linkStyles() {
  for (const href of ["/settings-rows.css", "/account-panes.css"]) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    document.head.append(l);
  }
}

const PANE_ROWS = {
  profile: ["cli.signin"],
  devices: ["access.devices", "access.pair"],
};

export const notificationRows = () => {
  const taken = new Set(Object.values(PANE_ROWS).flat());
  return DEN_SETTINGS.filter((r) => inAccount(r) && !taken.has(r.id));
};

export const registryRow = (id) =>
  DEN_SETTINGS.find((r) => r.id === id) ?? null;

export async function loadAccountPane(pane, body, deps) {
  const { t } = deps;
  linkStyles();
  body.classList.add("acct-pane");
  try {
    if (pane === "profile") {
      const [session, account] = await Promise.all([
        getJson("/api/session"),
        getJson("/api/account"),
      ]);
      body.innerHTML = profileHtml({ session, account }, t);
      const rows = body.querySelector("[data-acct-rows]");
      if (!(await mountRows(rows, PANE_ROWS.profile, deps.shell))) throw 0;
      return;
    }
    if (pane === "access") {
      const [session, owner, account] = await Promise.all([
        getJson("/api/session"),
        getJson("/api/web/owner").catch(() => null),
        getJson("/api/account"),
      ]);
      body.innerHTML = accessHtml({ session, owner, account }, t);
      return;
    }
    if (pane === "devices") {
      body.innerHTML = "";
      if (!(await mountRows(body, PANE_ROWS.devices, deps.shell))) throw 0;
      return;
    }
    if (pane === "notifications") {
      body.innerHTML = "";
      const ids = notificationRows().map((r) => r.id);
      if (!(await mountRows(body, ids, deps.shell))) throw 0;
      return;
    }
    body.innerHTML = `<p class="dn-pane-d">${esc(t("account.soon"))}</p>`;
  } catch {
    body.innerHTML = `<p class="dn-pane-d" role="alert">${esc(t("account.failed"))} <button type="button" class="den-btn sm" data-acct-retry>${esc(t("account.retry"))}</button></p>`;
    body
      .querySelector("[data-acct-retry]")
      ?.addEventListener("click", () => loadAccountPane(pane, body, deps));
  }
}
