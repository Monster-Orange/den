/**
 * The Account pop-up's panes (issue 1926's dialogs; the kit's dialog-nav,
 * DS #5): what belongs to the person, from what Den already keeps. Each
 * pane fills its body on open through the kit's `load(pane, body)`.
 *   profile        who you are, and the UI preferences that are yours
 *   access         how you signed in, and the GitHub link (read-only)
 *   devices        this browser, your linked browsers, pairing one
 *   notifications  the bell and alerts, the registry's rows
 * The owner's link/unlink flow and the sign-in policy stay in Settings.
 */
import { DEN_SETTINGS, seenAgo } from "/settings-registry.js";

export const ACCOUNT_PANES = ["profile", "access", "devices", "notifications"];

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** One read-only row: its label, then its value (HTML the caller escaped). */
const kv = (label, valueHtml) =>
  `<div class="dn-kv"><span>${esc(label)}</span><span>${valueHtml}</span></div>`;

/** How this browser is signed in, in words (GET /api/session's identity). */
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

/** The GitHub link's state, read-only (GET /api/web/owner). */
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

/** Who you are, from GET /api/session's identity: name, login, role. */
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
    `<div data-acct-row="cli.signin"></div>`
  );
}

/**
 * A registry row in a pane: its words (set.<id>, set.<id>.d) and its own
 * control. `draw` is the Settings dialog's drawRows when the host has it.
 */
function mountRows(body, ctx, t, draw) {
  for (const host of body.querySelectorAll("[data-acct-row]")) {
    const row = registryRow(host.dataset.acctRow);
    if (!row) continue;
    if (draw) {
      draw(host, [row], ctx);
      continue;
    }
    host.innerHTML = kv(t(`set.${row.id}`), "<span></span>");
    const d = t(`set.${row.id}.d`);
    if (d && d !== `set.${row.id}.d`)
      host.insertAdjacentHTML(
        "beforeend",
        `<p class="dn-pane-d">${esc(d)}</p>`,
      );
    row.control?.render?.(host.querySelector(".dn-kv > :last-child"), ctx);
  }
}

/** Account › Notifications: the bell's kinds (Hub's too) and the alerts. */
export const notificationRows = () =>
  DEN_SETTINGS.filter(
    (r) => r.id.startsWith("notifications.") || r.category === "notifications",
  );

/** A registry row by id (DEN_SETTINGS), or null. */
export const registryRow = (id) =>
  DEN_SETTINGS.find((r) => r.id === id) ?? null;

/**
 * Fill `body` with pane `pane`. `deps`: { t, shell, drawRows?, settingsCtx? } (the last two from
 * settings-rows.js, the Settings dialog's row drawing). A failed read says so
 * in the pane, with Try again; nothing is shown as empty that wasn't read.
 */
export async function loadAccountPane(pane, body, deps) {
  const { t } = deps;
  try {
    if (pane === "profile") {
      const [session, account] = await Promise.all([
        getJson("/api/session"),
        getJson("/api/account"),
      ]);
      body.innerHTML = profileHtml({ session, account }, t);
      mountRows(body, { shell: deps.shell, data: {} }, t, deps.drawRows);
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
      body.innerHTML =
        `<div data-acct-row="access.devices"></div>` +
        `<div data-acct-row="access.pair"></div>`;
      mountRows(body, { shell: deps.shell, data: {} }, t, deps.drawRows);
      return;
    }
    if (pane === "notifications") {
      if (!deps.drawRows || !deps.settingsCtx) {
        body.innerHTML = `<p class="dn-pane-d">${esc(t("account.soon"))}</p>`;
        return;
      }
      const ctx = await deps.settingsCtx({ shell: deps.shell });
      body.innerHTML = "";
      deps.drawRows(body, notificationRows(), ctx);
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
