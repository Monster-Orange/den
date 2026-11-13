/**
 * Den's own settings (R21, 0.3.0-dev.19): every setting Den has, as rows
 * of the SETTINGS registry in shell.js (window.denShell.registerSetting).
 * The Settings page (/settings, settings-page.js) draws only what the
 * registry holds; no row is written anywhere else. A distribution or a
 * plugin adds its own the same way (through window.denShellQueue).
 *
 * A category: { id, label, order, description?, from? }.
 * A row: { id, category, label, description, keywords, scope, control,
 *   read(ctx), write?(value, ctx), keys? }
 *   scope    "user" (config/local/user.yml), "workspace" (the workspace's
 *            entry in config/local/workspaces.yml) or "distribution" (the
 *            distribution's tracked config: read-only, so no write).
 *   control  { type: seg | radio | select | number | toggle | langmap |
 *            theme | navlist | pins | workspace-editor | readonly |
 *            custom, … } (settings-page.js draws each)
 *   keys     the /api/settings keys the row stores; every key POST
 *            /api/settings accepts has a row (settings-inventory.test.ts)
 *
 * ctx (settings-page.js): { data (GET /api/settings), appearance (the
 * themes and your prefs), scope (GET /api/scope), workspace (the one the
 * Workspace rows are about), wsSettings, shell (denShell), post(body),
 * setAppearance(patch), saveWorkspace(body) }.
 *
 * Writes go only to per-user, gitignored state: POST /api/settings
 * (config/local/user.yml) and POST /api/workspaces/settings
 * (config/local/workspaces.yml). Nothing here writes the distribution's
 * config.
 */
import { themeNotice, themeOptions } from "./appearance.js";
import { qrSvg } from "./qr.js";
import { renderPersonasSettings } from "./persona-ui.js";
import { comboHtml, wireCombo } from "./combobox.js";
import { restartDen } from "./restart-den.js";

export const DEN_SETTING_CATEGORIES = [
  {
    id: "appearance",
    label: "Appearance",
    order: 10,
    description: "Mode follows your system unless you pick one.",
  },
  {
    id: "editor",
    label: "Editor & terminal",
    order: 20,
    description:
      "Where ↗ opens a repository and >_ opens a terminal to a service.",
  },
  {
    id: "navigation",
    label: "Navigation",
    order: 30,
    description:
      "Hide pages you never use and choose their order. Pins sit at the top of the rail.",
  },
  {
    id: "graph",
    label: "Graph",
    order: 40,
    description:
      "How the graph is laid out, and how the Projects page shows its projects. The pages' own controls set these too.",
  },
  {
    id: "workspace",
    label: "Project setup",
    order: 50,
    description:
      "Settings for one project. They follow the project you view in the top bar.",
  },
  {
    id: "agents",
    label: "Agents",
    order: 55,
    description:
      "The runtimes agents run on, installed first. Paths you set are this machine's only: everywhere (config/local/user.yml) or for one project (config/local/workspaces.yml), which wins.",
  },
  {
    // SEC-2a: who may come in from other devices.
    id: "access",
    label: "Access",
    order: 57,
    description:
      "Reach this Den from your other devices: sign in with GitHub as its owner, or pair a device with a one-time link. On localhost nothing asks.",
  },
  {
    id: "secrets",
    label: "Secrets",
    order: 58,
    description:
      "Where this machine gets the credentials Den resolves secrets with. Per machine (config/local/user.yml); only the source is shown, never a secret.",
  },
  {
    // D64: the server this page talks to; Restart Den is always here.
    id: "server",
    label: "Server",
    order: 59,
    description:
      "The Den web server this page talks to. A restart keeps agents and services running.",
  },
  {
    id: "cli",
    label: "Command line",
    order: 60,
    description:
      "Also yours (config/local/user.yml), set from the command line: __DEN_CLI__ config <key>=<value>.",
  },
  {
    id: "distribution",
    label: "Distribution",
    order: 90,
    description:
      "What the distribution sets for everyone. Read-only here: it lives in the distribution's tracked config.",
  },
];

const seg = (options) => ({ type: "seg", options });
const graphRow = (key, label, description, keywords, control) => ({
  id: `graph.${key}`,
  category: "graph",
  label,
  description,
  keywords,
  scope: "user",
  control,
  keys: [`graph.${key}`],
  read: (ctx) => ctx.data.graph?.[key],
  write: (v, ctx) => ctx.post({ graph: { [key]: v } }),
});
const distRow = (id, label, description, keywords, value) => ({
  id: `distribution.${id}`,
  category: "distribution",
  label,
  description,
  keywords: ["distribution", "org", ...keywords],
  scope: "distribution",
  control: { type: "readonly" },
  read: (ctx) => value(ctx.data.distribution || {}),
});
const effective = (list, chosen) =>
  chosen ?? (list || []).find((e) => e.available)?.key ?? null;

// ── Access (SEC-2a) ──────────────────────────────────────────────────────
// What these rows draw, and the routes they use (github-routes.ts). Pure
// helpers are exported for tests.

function escHtml(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/**
 * A built-in word in the page's language (0.4.45): the catalog's when its
 * en is `en` word for word (denShell.tr), else `en` (and in a unit test,
 * where there is no shell). {name} placeholders filled from `vars`.
 */
function L(key, en, vars) {
  const sh = typeof window !== "undefined" ? window.denShell : null;
  const s = sh && typeof sh.tr === "function" ? sh.tr(key, en) : en;
  return String(s).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

/** "3 min ago", "2 h ago", "5 d ago", or "just now"; `now` for tests. */
export function seenAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return L("set.ui.justNow", "just now");
  if (s < 5400)
    return L("set.ui.minAgo", "{n} min ago", { n: Math.round(s / 60) });
  if (s < 129600)
    return L("set.ui.hAgo", "{n} h ago", { n: Math.round(s / 3600) });
  return L("set.ui.dAgo", "{n} d ago", { n: Math.round(s / 86400) });
}

/**
 * One linked device's line (SEC-2a: every sign-in, whatever the method):
 * its browser and OS, "This device" for this browser, then how it signed
 * in, when, from where (the client address and the browser), and when it
 * was last seen.
 */
export function deviceLine(d, now = Date.now()) {
  const how =
    d.via === "github"
      ? d.login
        ? L("set.ui.viaGithubAs", "signed in with GitHub (@{login})", {
            login: d.login,
          })
        : L("set.ui.viaGithub", "signed in with GitHub")
      : d.via === "code"
        ? L("set.ui.viaCode", "approved with a code")
        : d.via === "claim"
          ? L("set.ui.viaClaim", "claimed with a setup link")
          : L("set.ui.viaLink", "signed in with a one-time link");
  const name = d.name || L("set.ui.unknownBrowser", "Unknown browser");
  const from = d.client || d.host;
  return {
    title: name,
    current: !!d.current,
    detail: [
      how,
      L("set.ui.created", "created {ago}", { ago: seenAgo(d.createdAt, now) }),
      from ? L("set.ui.fromAt", "from {from} ({name})", { from, name }) : "",
      L("set.ui.lastSeen", "last seen {ago}", {
        ago: seenAgo(d.lastSeenAt, now),
      }),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

const ROW_STYLE =
  "display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;padding:6px 0;border-top:1px solid var(--border)";
const CODE_STYLE =
  "font:22px/1.4 var(--mono);letter-spacing:0.12em;padding:6px 12px;border:1px solid var(--border);border-radius:var(--radius-button);background:var(--sunken)";

/** Linking the owner in the page: start, show the code, poll the server. */
function drawOwner(host, ctx) {
  const api = (m, p, b) => ctx.shell.api(m, p, b);
  let timer = null;
  const draw = (o) => {
    clearTimeout(timer);
    if (o.owner) {
      host.innerHTML =
        `<output class="set-ro" id="set-owner">${escHtml(L("set.ui.ownerIs", "Owner:"))} <b>@${escHtml(o.owner.login)}</b> <span class="set-note">(${escHtml(o.owner.id)})</span></output> ` +
        `<button type="button" class="btn" id="set-owner-unlink">${escHtml(L("set.ui.unlink", "Unlink"))}</button>`;
      host.querySelector("#set-owner-unlink").addEventListener("click", () =>
        api("POST", "/api/web/owner/unlink", {})
          .then(load)
          .catch((e) => fail(e.message)),
      );
      return;
    }
    host.innerHTML =
      `<output class="set-ro" id="set-owner">${escHtml(L("set.ui.noOwner", "This Den has no owner identity yet."))}</output> ` +
      (o.clientId
        ? `<button type="button" class="btn primary" id="set-owner-link">${escHtml(L("set.ui.linkGithub", "Link your GitHub account"))}</button>`
        : `<span class="set-note" id="set-owner-noclient" style="flex-basis:100%">${L(
            "set.ui.noClient",
            "Linking needs a GitHub App client id, and none is configured: set {key} in config/local/user.yml, then restart the server.", // words-ok: moved word for word into the catalog (0.4.45)
            { key: "<code>web.github_client_id</code>" },
          )}</span>`) +
      '<div id="set-owner-flow" style="flex-basis:100%" aria-live="polite"></div>';
    host.querySelector("#set-owner-link")?.addEventListener("click", startLink);
  };
  const fail = (text) => {
    const box = host.querySelector("#set-owner-flow");
    if (box)
      box.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(text)}</span>`;
    const b = host.querySelector("#set-owner-link");
    if (b) b.disabled = false;
  };
  const poll = (id) =>
    fetch(`/api/web/owner/link/${encodeURIComponent(id)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((b) => {
        if (b.state === "pending") {
          timer = setTimeout(() => poll(id), 1500);
          return;
        }
        if (b.state === "ok") return load();
        fail(b.error || L("set.ui.linkFailed", "Linking failed. Try again."));
      })
      .catch(
        () =>
          fail(L("set.ui.noAnswer", "The server didn't answer. Try again.")), // words-ok: moved word for word into the catalog (0.4.45)
      );
  function startLink() {
    const b = host.querySelector("#set-owner-link");
    if (b) b.disabled = true;
    api("POST", "/api/web/owner/link", {})
      .then((f) => {
        const box = host.querySelector("#set-owner-flow");
        const url = f.verificationUri || "https://github.com/login/device";
        box.innerHTML =
          `<p class="set-note" style="margin:8px 0">${L(
            "set.ui.enterCode",
            "Enter this code at {link} and approve the app. It asks for no permissions.",
            {
              link: `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(url.replace(/^https:\/\//, ""))}</a>`,
            },
          )}</p>` +
          `<span id="set-owner-code" style="${CODE_STYLE}">${escHtml(f.userCode)}</span> ` +
          `<a class="btn" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(L("set.ui.openGithub", "Open GitHub"))}</a>` +
          `<p class="set-note" style="margin:8px 0 0">${escHtml(L("set.ui.waitingGithub", "Waiting for GitHub…"))}</p>`;
        timer = setTimeout(() => poll(f.id), 1500);
      })
      .catch((e) => fail(e.message));
  }
  function load() {
    fetch("/api/web/owner", { cache: "no-store" })
      .then((r) => r.json())
      .then(draw)
      .catch(() => {
        host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.ownerSignedIn", "The owner can only be shown signed in."))}</output>`;
      });
  }
  load();
}

function drawDevices(host, ctx) {
  const load = () =>
    fetch("/api/web/sessions", { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then((b) => {
        const list = b.sessions || [];
        if (!list.length) {
          host.innerHTML = `<output class="set-ro" id="set-devices">${escHtml(L("set.ui.noDevices", "No linked devices. A browser that signs in with GitHub, is approved with a code, or opens a one-time link appears here."))}</output>`;
          return;
        }
        const now = Date.now();
        host.innerHTML =
          '<div id="set-devices" style="width:100%">' +
          list
            .map((d) => {
              const l = deviceLine(d, now);
              return (
                `<div class="set-device" data-id="${escHtml(d.id)}" style="${ROW_STYLE}">` +
                `<div style="flex:1 1 220px;min-width:0"><div>${escHtml(l.title)}` +
                (l.current
                  ? ` <b class="set-this-device" style="font-weight:600">· ${escHtml(L("set.ui.thisDevice", "This device"))}</b>`
                  : "") +
                `</div>` +
                `<div class="set-note" style="overflow-wrap:anywhere">${escHtml(l.detail)}</div></div>` +
                `<button type="button" class="btn" data-revoke="${escHtml(d.id)}">${escHtml(L("set.ui.revoke", "Revoke"))}</button></div>`
              );
            })
            .join("") +
          "</div>";
        host.querySelectorAll("[data-revoke]").forEach((btn) =>
          btn.addEventListener("click", () => {
            btn.disabled = true;
            ctx.shell
              .api("POST", "/api/web/logout", { id: btn.dataset.revoke })
              .then(load)
              .catch(() => {
                btn.disabled = false;
              });
          }),
        );
      })
      .catch(() => {
        host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.devicesSignedIn", "The devices can only be listed signed in."))}</output>`;
      });
  load();
}

/** One waiting device's line: its code, browser and OS, address, age. */
export function waitingLine(w, now = Date.now()) {
  return {
    title: `${w.code} · ${w.device || L("set.ui.unknownBrowser", "Unknown browser")}`,
    detail: [
      w.client,
      L("set.ui.asked", "asked {ago}", { ago: seenAgo(w.createdAt, now) }),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * Waiting devices (SEC-2a): the computers whose signed-out page shows a
 * code, with Approve and Deny. Approving signs that page in by itself.
 */
function drawWaiting(host, ctx) {
  let timer = null;
  const load = () => {
    clearTimeout(timer);
    if (!host.isConnected && timer !== null) return;
    fetch("/api/web/waiting", { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then((b) => {
        const list = b.waiting || [];
        const now = Date.now();
        host.innerHTML = list.length
          ? '<div id="set-waiting" style="width:100%">' +
            list
              .map((w) => {
                const l = waitingLine(w, now);
                return (
                  `<div class="set-waiting" data-code="${escHtml(w.code)}" style="${ROW_STYLE}">` +
                  `<div style="flex:1 1 220px;min-width:0"><div class="mono">${escHtml(l.title)}</div>` +
                  `<div class="set-note" style="overflow-wrap:anywhere">${escHtml(l.detail)}</div></div>` +
                  `<button type="button" class="btn primary" data-approve="${escHtml(w.code)}">${escHtml(L("set.ui.approve", "Approve"))}</button>` +
                  `<button type="button" class="btn" data-deny="${escHtml(w.code)}">${escHtml(L("set.ui.deny", "Deny"))}</button></div>`
                );
              })
              .join("") +
            '</div><div id="set-waiting-out" style="flex-basis:100%" aria-live="polite"></div>'
          : `<output class="set-ro" id="set-waiting">${escHtml(L("set.ui.noWaiting", "No computers are waiting. A signed-out page on another computer shows a code; it appears here to approve."))}</output>`;
        const act = (btn, path, code) => {
          btn.disabled = true;
          ctx.shell
            .api("POST", path, { code })
            .then(load)
            .catch((e) => {
              btn.disabled = false;
              const out = host.querySelector("#set-waiting-out");
              if (out)
                out.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(e.message)}</span>`;
            });
        };
        host
          .querySelectorAll("[data-approve]")
          .forEach((b) =>
            b.addEventListener("click", () =>
              act(b, "/api/web/approve", b.dataset.approve),
            ),
          );
        host
          .querySelectorAll("[data-deny]")
          .forEach((b) =>
            b.addEventListener("click", () =>
              act(b, "/api/web/deny", b.dataset.deny),
            ),
          );
        // A new request shows up without a reload.
        timer = setTimeout(load, 5000);
      })
      .catch(() => {
        host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.waitingSignedIn", "Waiting devices can only be listed signed in, or on this machine."))}</output>`;
      });
  };
  load();
}

function drawPair(host, ctx) {
  let timer = null;
  fetch("/api/web/pair", { cache: "no-store" })
    .then((r) => r.json())
    .then((b) => {
      const hosts = b.hosts || [];
      if (!hosts.length) {
        host.innerHTML = `<output class="set-ro" id="set-pair">${L(
          "set.ui.noPairHost",
          "No edge hostname routes to this server, so there is no address another device could open. Add one to the config's edge block (edge.aliases for a VPN name), then {cmd}.", // words-ok: moved word for word into the catalog (0.4.45)
          { cmd: "<code>__DEN_CLI__ edge up</code>" },
        )}</output>`;
        return;
      }
      host.innerHTML =
        `<select id="set-pair-host" aria-label="${escHtml(L("set.ui.edgeHost", "Edge hostname"))}">` +
        hosts
          .map((h) => `<option value="${escHtml(h)}">${escHtml(h)}</option>`)
          .join("") +
        "</select> " +
        `<button type="button" class="btn primary" id="set-pair-go">${escHtml(L("set.access.pair", "Pair a device"))}</button>` +
        '<div id="set-pair-out" style="flex-basis:100%" aria-live="polite"></div>';
      const out = host.querySelector("#set-pair-out");
      const go = () => {
        clearTimeout(timer);
        ctx.shell
          .api("POST", "/api/web/pair", {
            host: host.querySelector("#set-pair-host").value,
          })
          .then((p) => {
            out.innerHTML =
              `<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;margin-top:8px">` +
              `<div id="set-pair-qr" style="line-height:0">${qrSvg(p.url, { scale: 4, margin: 4 })}</div>` +
              `<div style="flex:1 1 220px;min-width:0"><p class="set-note" style="margin:0 0 8px">${escHtml(L("set.ui.pairScan", "Scan it with the other device, or open the link there. It works once, until it expires (below), and signs that browser in for good."))}</p>` +
              `<a id="set-pair-link" href="${escHtml(p.url)}" style="font:12px var(--mono);overflow-wrap:anywhere">${escHtml(p.url)}</a>` +
              `<p class="set-note" id="set-pair-left" style="margin:8px 0 0"></p></div></div>`;
            const until = Date.parse(p.expiresAt);
            const left = out.querySelector("#set-pair-left");
            const tick = () => {
              const s = Math.max(0, Math.round((until - Date.now()) / 1000));
              left.textContent = s
                ? L("set.ui.expiresIn", "Expires in {s} s.", { s })
                : L(
                    "set.ui.pairExpired",
                    "This link expired. Pair again for a new one.",
                  );
              if (s) timer = setTimeout(tick, 1000);
            };
            tick();
          })
          .catch((e) => {
            out.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(e.message)}</span>`;
          });
      };
      host.querySelector("#set-pair-go").addEventListener("click", go);
    })
    .catch(() => {
      host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.pairSignedIn", "Pairing works only signed in."))}</output>`;
    });
}

const ACCESS_ROWS = [
  {
    id: "access.owner",
    category: "access",
    label: "Owner",
    description:
      "The GitHub account this Den belongs to. Linking stores only its id (the token is thrown away), and from then on that account can sign in from any device. __DEN_CLI__ web owner link does the same from the command line.",
    keywords: ["owner", "github", "identity", "link", "account"],
    scope: "user",
    control: { type: "custom", render: drawOwner },
    read: () => null,
  },
  {
    id: "access.devices",
    category: "access",
    label: "Linked devices",
    description:
      "The browsers signed in to this Den. Revoke ends one at once. __DEN_CLI__ web logout --all ends them all.",
    keywords: ["devices", "sessions", "revoke", "browsers", "signed in"],
    scope: "user",
    control: { type: "custom", render: drawDevices },
    read: () => null,
  },
  {
    id: "access.waiting",
    category: "access",
    label: "Waiting devices",
    description:
      "Computers whose signed-out page shows a code. Approve one and its page signs in by itself; the code lasts 10 minutes. __DEN_CLI__ web approve <code> does the same from the command line.",
    keywords: ["waiting", "approve", "code", "pair", "device", "deny"],
    scope: "user",
    control: { type: "custom", render: drawWaiting },
    read: () => null,
  },
  {
    id: "access.machine_name",
    category: "access",
    label: "Machine name",
    description:
      'What the signed-out page calls this machine ("runs on <name>"), so people on other computers know where to run a command. Empty: its short hostname.',
    keywords: ["machine", "name", "hostname", "host", "signed out"],
    scope: "user",
    control: { type: "text" },
    keys: ["machine_name"],
    read: (ctx) => ctx.data.machine_name ?? "",
    write: (v, ctx) =>
      ctx.post({ machine_name: String(v ?? "").trim() || null }),
  },
  {
    id: "access.pair",
    category: "access",
    label: "Pair a device",
    description:
      "Without GitHub, or offline: a one-time link and QR code for one edge hostname (__DEN_CLI__ web login --host <name>).",
    keywords: ["pair", "qr", "device", "link", "phone", "edge"],
    scope: "user",
    control: { type: "custom", render: drawPair },
    read: () => null,
  },
];

/** D64: Settings › Server's Restart Den button. */
function drawRestart(host) {
  const label = window.denShell?.t?.("rd.setButton") ?? "Restart Den";
  host.innerHTML = `<button type="button" class="btn sm" id="set-restart-den">${escR(label)}</button>`;
  host
    .querySelector("#set-restart-den")
    .addEventListener("click", () => void restartDen());
}

export const DEN_SETTINGS = [
  {
    id: "server.restart",
    category: "server",
    label: "Restart Den",
    description:
      "Restarts the web server on the same port. Agents, services and deploys keep running; this page reconnects in place. Same as __DEN_CLI__ web restart.",
    keywords: ["restart", "server", "reload", "web", "den"],
    scope: "user",
    control: { type: "custom", render: drawRestart },
    read: () => null,
  },
  // ── Appearance ─────────────────────────────────────────────────────────
  {
    id: "appearance.mode",
    category: "appearance",
    label: "Mode",
    description: "System follows your computer's light or dark setting.",
    keywords: ["dark", "light", "system", "color scheme", "theme"],
    scope: "user",
    control: seg([
      { value: "system", label: "System" },
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
    ]),
    keys: ["appearance.mode"],
    read: (ctx) => ctx.appearance.mode,
    write: (v, ctx) => ctx.setAppearance({ mode: v }),
  },
  {
    id: "appearance.theme",
    category: "appearance",
    label: "Theme",
    description:
      "Org default follows the distribution's theme. Picking a theme by name keeps it, even when the distribution changes its own.",
    keywords: [
      "theme",
      "brand",
      "colors",
      "palette",
      "swatches",
      "org default",
    ],
    scope: "user",
    control: {
      type: "theme",
      options: (ctx) =>
        themeOptions(
          ctx.appearance.themes,
          ctx.appearance.prefsTheme,
          ctx.appearance.orgDefault,
        ),
      notice: (ctx) =>
        themeNotice(
          ctx.appearance.themes,
          ctx.appearance.prefsTheme,
          ctx.appearance.active,
        ),
    },
    keys: ["appearance.theme"],
    read: (ctx) => ctx.appearance.prefsTheme || "",
    write: (v, ctx) => ctx.setAppearance({ theme: v || null }),
  },
  // The UI's language (R19, R21; 0.3.0-dev.39): a user pref, `language`
  // in user.yml. Each is named in itself. A change reloads the page, which
  // the server then serves with that language's catalog.
  {
    id: "language",
    category: "appearance",
    label: "Language",
    description:
      "The language of Den's own words. Names, logs and command output stay as they are. Changing it reloads the page.",
    keywords: [
      "language",
      "locale",
      "translation",
      "english",
      "japanese",
      "spanish",
      "日本語",
      "español",
    ],
    scope: "user",
    control: {
      type: "seg",
      options: (ctx) =>
        (ctx.shell?.languages?.() ?? []).map((l) => ({
          value: l.id,
          label: l.name,
        })),
    },
    keys: ["language"],
    read: (ctx) => ctx.data.language ?? ctx.shell?.lang?.() ?? "en",
    write: (v, ctx) => ctx.shell.setLanguage(v),
  },
  {
    id: "appearance.org-theme",
    category: "appearance",
    label: "Org default theme",
    description: "The theme everyone gets until they pick one (brand.theme).",
    keywords: ["theme", "brand", "org default", "distribution"],
    scope: "distribution",
    control: { type: "readonly" },
    read: (ctx) => {
      const d = ctx.data.distribution || {};
      const org = ctx.appearance.orgDefault;
      if (d.theme) return org ? `${org.name} (${d.theme})` : d.theme;
      return org
        ? L("set.ui.themeUnset", "{name} (not set: Den's own)", {
            name: org.name,
          })
        : L("set.ui.notSet", "not set");
    },
  },

  // ── Editor & terminal ──────────────────────────────────────────────────
  {
    id: "editor",
    category: "editor",
    label: "Default IDE",
    description:
      "__DEN_TITLE__ opens repositories in this editor when you click ↗.",
    keywords: ["editor", "ide", "open", "code", "vscode", "cursor"],
    scope: "user",
    control: {
      type: "radio",
      options: (ctx) =>
        (ctx.data.editors || []).map((e) => ({
          value: e.key,
          label: e.name,
          disabled: !e.available,
          tags: [
            e.terminal ? L("set.ui.terminalTag", "terminal") : null,
            e.available ? null : L("set.ui.notFound", "not found"),
          ],
        })),
    },
    keys: ["editor"],
    read: (ctx) => effective(ctx.data.editors, ctx.data.editor),
    write: (v, ctx) => ctx.post({ editor: v || null }),
  },
  {
    id: "editor.open",
    category: "editor",
    label: "Open file links in",
    description:
      "⌘-click (Ctrl-click on Windows and Linux) on a file path in an agent's pane opens it here, at the line. None copies the path instead.",
    keywords: [
      "editor",
      "link",
      "path",
      "file",
      "agents",
      "vscode",
      "cursor",
      "zed",
    ],
    scope: "user",
    control: seg([
      { value: "vscode", label: "VS Code" },
      { value: "cursor", label: "Cursor" },
      { value: "zed", label: "Zed" },
      { value: "none", label: "None (copy)" },
    ]),
    keys: ["editor_open"],
    read: (ctx) => ctx.data.editor_open ?? "none",
    write: (v, ctx) => ctx.post({ editor_open: v }),
  },
  {
    id: "editor_overrides",
    category: "editor",
    label: "Per-language IDE",
    description:
      "For repos whose stack.yml names a language, open this editor instead of the default.",
    keywords: [
      "language",
      "override",
      "editor",
      "ide",
      "go",
      "python",
      "stack",
    ],
    scope: "user",
    control: {
      type: "langmap",
      languages: (ctx) => ctx.data.languages || [],
      options: (ctx) =>
        (ctx.data.editors || [])
          .filter((e) => e.available)
          .map((e) => ({ value: e.key, label: e.name })),
    },
    keys: ["editor_overrides"],
    read: (ctx) => ctx.data.editor_overrides || {},
    write: (map, ctx) =>
      ctx.post({
        editor_overrides: Object.keys(map).length > 0 ? map : null,
      }),
  },
  {
    id: "terminal",
    category: "editor",
    label: "Default terminal",
    description:
      "__DEN_TITLE__ opens a terminal to the service directory when you click >_.",
    keywords: ["terminal", "shell", "iterm", "ghostty", "console"],
    scope: "user",
    control: {
      type: "radio",
      options: (ctx) =>
        (ctx.data.terminals || []).map((t) => ({
          value: t.key,
          label: t.name,
          disabled: !t.available,
          tags: [t.available ? null : L("set.ui.notFound", "not found")],
        })),
    },
    keys: ["terminal"],
    read: (ctx) => effective(ctx.data.terminals, ctx.data.terminal),
    write: (v, ctx) => ctx.post({ terminal: v || null }),
  },

  // ── Navigation ─────────────────────────────────────────────────────────
  {
    id: "shell.pages",
    category: "navigation",
    label: "Pages",
    description: "Show or hide each page, and move it within its group.",
    keywords: ["rail", "sidebar", "hide", "order", "reorder", "pages", "menu"],
    scope: "user",
    control: { type: "navlist" },
    keys: ["shell.hidden", "shell.order"],
    read: (ctx) => {
      const s = ctx.shell.getState();
      return { hidden: s.hidden || [], order: s.order || [] };
    },
    write: (v, ctx) => ctx.shell.setNavPrefs(v),
  },
  {
    // 0.4.45: this person's project order (Manage projects); never Hub's.
    id: "shell.projectOrder",
    category: "navigation",
    label: "Project order",
    description:
      "The order of projects in the header's picker and Manage projects. A to Z by the name shown unless you move them in Manage projects. Yours only: never shared and never sent to Hub.",
    keywords: ["project", "order", "sort", "reorder", "picker", "a to z"],
    scope: "user",
    control: { type: "custom", render: renderProjectOrder },
    keys: ["shell.projectOrder"],
    read: (ctx) => ctx.data?.shell?.projectOrder ?? [],
    // null is A to Z (Reset).
    write: (v, ctx) =>
      ctx.post({ shell: { projectOrder: v && v.length ? v : null } }),
  },
  {
    id: "shell.pins",
    category: "navigation",
    label: "Pinned",
    description:
      "Services and repos at the top of the rail. Pin them from Services, the graph or the health row.",
    keywords: ["pin", "pins", "pinned", "favorite", "rail"],
    scope: "user",
    control: { type: "pins" },
    keys: ["shell.pins"],
    read: (ctx) => ctx.shell.getState().pins || [],
    write: (v, ctx) => ctx.shell.setPins(v),
  },
  {
    id: "shell.collapsed",
    category: "navigation",
    label: "Collapse the rail",
    description:
      "Icons only. The rail's own button at the bottom does the same.",
    keywords: ["rail", "collapse", "icons", "sidebar", "compact"],
    scope: "user",
    control: { type: "toggle" },
    keys: ["shell.collapsed"],
    read: (ctx) => ctx.shell.getState().collapsed === true,
    write: (v, ctx) => ctx.shell.setCollapsed(v),
  },
  {
    id: "shell.dock",
    category: "navigation",
    label: "Open the runs dock",
    description:
      "The output of runs, at the foot of every page. Off, it is just its bar: a run's tab appears and the Runs chip pulses, and you open it. Drag its top edge to resize it, up to half the window.",
    keywords: ["runs", "dock", "output", "log", "panel", "console", "height"],
    scope: "user",
    control: { type: "toggle" },
    keys: ["shell.dock", "shell.dockHeight"],
    read: (ctx) => ctx.shell.getState().dock === true,
    write: (v, ctx) => ctx.shell.setDock(v),
  },

  // ── Graph ──────────────────────────────────────────────────────────────
  graphRow(
    "workspaces",
    "Project list",
    "The Projects page's project list, open or collapsed to a strip so the table gets the width.",
    ["workspaces", "list", "sidebar", "collapse", "strip", "local dev"],
    seg([
      { value: "open", label: "Open" },
      { value: "collapsed", label: "Collapsed" },
    ]),
  ),
  graphRow(
    "groupBy",
    "Group repos by",
    "The Projects page's repo table: one list, or grouped by application (as __DEN_CLI__ apps) or by company.",
    [
      "workspaces",
      "group",
      "application",
      "apps",
      "org",
      "company",
      "table",
      "local dev",
    ],
    seg([
      { value: "none", label: "None" },
      { value: "app", label: "Application" },
      { value: "org", label: "Company" },
    ]),
  ),
  graphRow(
    "direction",
    "Direction",
    "Lay the graph out top-down or left to right.",
    ["layout", "direction", "orientation", "horizontal", "vertical"],
    seg([
      { value: "down", label: "Top-down" },
      { value: "right", label: "Left to right" },
    ]),
  ),
  graphRow(
    "group",
    "Frames",
    "The outer frames: by company or by application.",
    ["group", "frames", "org", "company", "application", "cluster"],
    seg([
      { value: "org", label: "By company" },
      { value: "app", label: "By application" },
    ]),
  ),
  graphRow(
    "density",
    "Cards",
    "Detailed cards show more; compact ones fit more on screen.",
    ["density", "cards", "compact", "detailed", "size"],
    seg([
      { value: "detailed", label: "Detailed" },
      { value: "compact", label: "Compact" },
    ]),
  ),
  graphRow(
    "panelWidth",
    "Details panel",
    "The width of the graph's details panel, in pixels (360 to 760).",
    ["panel", "width", "details", "sidebar"],
    { type: "number", min: 360, max: 760, step: 10, unit: "px" },
  ),

  // ── Workspace ──────────────────────────────────────────────────────────
  {
    // 0.4.45 project names v5: Hub's name when linked, else its own.
    id: "workspace.name",
    category: "workspace",
    label: "Name",
    description:
      "The name Den shows for this project in the header, lists and pages. Linked to a Hub project, it is Hub's name. The slug never changes.",
    // Mock v6: one help line on screen, the state's own (the control
    // draws it); this one is for search and screen readers.
    helpInControl: true,
    keywords: ["name", "rename", "project", "hub", "slug", "title"],
    scope: "workspace",
    control: { type: "custom", render: renderProjectName },
    read: () => null,
  },
  {
    id: "workspace.editor",
    category: "workspace",
    label: "IDE for this project",
    description:
      "Opening this project, or a repo in it without a per-language override, uses this editor instead of your default.",
    keywords: ["workspace", "editor", "ide", "override"],
    scope: "workspace",
    control: { type: "workspace-editor" },
    read: (ctx) => ctx.wsSettings?.editor ?? "",
    write: (v, ctx) => ctx.saveWorkspace({ editor: v || null }),
  },

  {
    // H5: the Hub project this project's agents file their Hub work in.
    id: "workspace.hub",
    category: "workspace",
    label: "Hub project",
    description:
      "The Hub project this project's agents file their Hub work in: docs, mocks, comments. Den never links on its own: Hub suggests one with the same repos or name, and you confirm. Not linked, Hub files the work in Unfiled. __DEN_CLI__ hub link -p <project>",
    keywords: ["hub", "hub project", "link", "unfiled", "company", "project"],
    scope: "workspace",
    control: { type: "custom", render: renderHubProject },
    read: () => null,
  },

  // ── Agents ─────────────────────────────────────────────────────────────
  {
    id: "agents.layout",
    category: "agents",
    label: "Agents tab layout",
    description:
      "Focus shows one agent, Tabs shows one with a tab for each, Tile shows up to four in a grid. The Agents tab's switch, ⌃⇧1, ⌃⇧2, ⌃⇧3 and ⌘K set it too.",
    keywords: ["agents", "layout", "focus", "tabs", "tile", "grid", "panes"],
    scope: "user",
    control: seg([
      { value: "focus", label: "Focus" },
      { value: "tabs", label: "Tabs" },
      { value: "tile", label: "Tile" },
    ]),
    keys: ["agents_layout"],
    read: (ctx) => ctx.data.agents_layout ?? "focus",
    write: (v, ctx) => ctx.post({ agents_layout: v }),
  },
  {
    id: "agents.runtimes",
    category: "agents",
    label: "Runtimes",
    description:
      "Each runtime's status and version, the path in use and where it came from. Set path… runs its version command first and refuses a path that isn't that runtime.",
    keywords: [
      "runtime",
      "claude",
      "codex",
      "gemini",
      "grok",
      "path",
      "bin",
      "cli",
      "agent",
    ],
    scope: "user",
    control: { type: "custom", render: renderRuntimes },
    read: () => null,
  },

  {
    id: "agents.rotation",
    category: "agents",
    label: "Rotation",
    description:
      "When an agent's conversation has compacted this many times (or its pull request merged), Den starts it again from its handoff: a fresh conversation, the same name, persona, project and folder. Auto asks the agent for its handoff when it is idle, then relaunches it by itself; Ask shows buttons on the agent; Off does nothing. Overrides win over this install's value: agent, persona in a project, persona, project, service. __DEN_CLI__ agents rotate",
    keywords: [
      "rotation",
      "rotate",
      "relaunch",
      "handoff",
      "compaction",
      "compactions",
      "context",
      "restart",
      "agent",
    ],
    scope: "user",
    control: { type: "custom", render: renderRotation },
    read: () => null,
  },

  {
    id: "agents.hub",
    category: "agents",
    label: "Hub",
    description:
      "Connect this install to your company's Hub: sign in there and approve it. Every agent then gets Hub's tools: search Hub, publish docs and mocks there. Its company comes from this install's token, its Hub project from Project setup › Hub project.",
    keywords: [
      "hub",
      "den hub",
      "connect",
      "disconnect",
      "mcp",
      "team",
      "company",
      "token",
      "docs",
      "mocks",
    ],
    scope: "user",
    control: { type: "custom", render: renderHub },
    keys: ["hub_allow_tools"],
    read: () => null,
    write: (v, ctx) => ctx.post({ hub_allow_tools: v }),
  },

  {
    id: "agents.hub_link_all",
    category: "agents",
    label: "Link projects to Hub",
    description:
      "Every project here with Hub's suggestion for it (the same repos, or the same name). Tick the ones to link and link them in one go; each one can still be changed in Project setup › Hub project.",
    keywords: ["hub", "link", "projects", "suggested", "all", "bulk"],
    scope: "user",
    control: { type: "custom", render: renderHubLinkAll },
    read: () => null,
  },

  {
    id: "agents.hub_github",
    category: "agents",
    label: "Den Hub's GitHub access",
    description:
      "How many of your company's GitHub repos Den Hub can read, asked live from Hub, with GitHub's link to give it access or change its repos.",
    keywords: ["hub", "github", "access", "app", "install", "repos"],
    scope: "user",
    control: { type: "custom", render: renderHubGithub },
    read: () => null,
  },

  {
    id: "agents.personas",
    category: "agents",
    label: "Personas",
    description:
      "Agent setups you can start from. Built-in ones ship with Den, distribution ones with your distribution, and yours live on this machine. View or Edit, Duplicate, + New persona; only your own can be edited or deleted.",
    keywords: [
      "persona",
      "role",
      "agent",
      "model",
      "version",
      "permission",
      "allowed commands",
      "instructions",
    ],
    scope: "user",
    control: { type: "custom", render: renderPersonasSettings },
    read: () => null,
  },

  // ── Command line ───────────────────────────────────────────────────────
  {
    id: "cli.local_dev",
    category: "cli",
    label: "Local environment",
    description:
      "Off hides Projects and the project APIs for you. __DEN_CLI__ config local_dev=false",
    keywords: ["local", "local dev", "environment", "disable"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) =>
      ctx.data.local_dev === false
        ? L("set.ui.off", "Off")
        : L("set.ui.on", "On"),
  },
  {
    id: "cli.cli_tabs",
    category: "cli",
    label: "Terminal tabs",
    description:
      "Whether up and restart open terminal tabs by default. __DEN_CLI__ config cli_tabs=true",
    keywords: ["tabs", "terminal", "up", "restart", "cli"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) =>
      ctx.data.cli_tabs ? L("set.ui.on", "On") : L("set.ui.off", "Off"),
  },
  {
    id: "cli.log_window_lines",
    category: "cli",
    label: "Log pane lines",
    description:
      "How many lines a Logs pane keeps loaded; full-history search is unaffected. __DEN_CLI__ config log_window_lines=50000",
    keywords: ["logs", "lines", "window", "history", "buffer"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) =>
      L("set.ui.nLines", "{n} lines", {
        n: Number(ctx.data.log_window_lines ?? 20000).toLocaleString(),
      }),
  },
  {
    id: "cli.web_port",
    category: "cli",
    label: "Your web port",
    description:
      "web.port in config/local/user.yml overrides the distribution's. It applies when the web server next starts.",
    keywords: ["port", "web", "server", "url"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) =>
      ctx.data.user_web_port != null
        ? String(ctx.data.user_web_port)
        : L("set.ui.portUnset", "Not set: the distribution's applies"),
  },
  {
    // SEC-1b: whether this browser is signed in, and Sign out. Signing in
    // is the CLI's (`web login` prints a one-time link): no form here.
    id: "cli.signin",
    category: "cli",
    label: "Browser sign-in",
    description:
      "On localhost nothing asks for a sign-in. Through the edge, a browser signs in unless the edge shows it is this machine (web.edge_unattested: local counts one it can't place as local), and from another machine it always does: Sign in with GitHub, or a one-time link (__DEN_CLI__ web login). Settings › Access lists the signed-in browsers.",
    keywords: ["sign in", "sign out", "login", "logout", "session", "browser"],
    scope: "user",
    control: {
      type: "custom",
      render(host, ctx) {
        const draw = (signedIn) => {
          host.innerHTML = signedIn
            ? `<output class="set-ro">${escR(L("set.ui.signedIn", "Signed in"))}</output> ` +
              `<button type="button" class="btn" id="set-signout">${escR(L("set.ui.signOut", "Sign out"))}</button>`
            : `<output class="set-ro">${L("set.ui.notSignedIn", "Not signed in: run {cmd}", { cmd: "<code>__DEN_CLI__ web login</code>" })}</output>`;
          host.querySelector("#set-signout")?.addEventListener("click", () =>
            ctx.shell
              .api("POST", "/api/session/logout", {})
              .then(() => draw(false))
              .catch(() => {}),
          );
        };
        fetch("/api/session", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((b) => draw(b?.signedIn === true))
          .catch(() => draw(false));
      },
    },
    read: () => null,
  },
  {
    // R8, LK-0: the admin password is for sudo, and nothing else. Den asks
    // for it only when a command it runs needs sudo; here is whether it is
    // saved, and Forget. Reading never wakes the vault.
    id: "cli.sudo",
    category: "cli",
    label: "Admin password",
    description:
      "Used only when a command Den runs needs sudo, and asked for only then. It is no sign-in: nothing else needs it.",
    keywords: ["admin", "password", "sudo", "forget", "vault", "1password"],
    scope: "user",
    control: {
      type: "custom",
      render(host, ctx) {
        const draw = (st) => {
          const saved = st?.saved;
          const where =
            saved === "vault"
              ? L("set.ui.savedIn", "Saved in {vault}", {
                  vault: st.vault?.label || L("set.ui.theVault", "the vault"),
                })
              : saved === "session"
                ? L("set.ui.savedMemory", "Held in memory until Den restarts")
                : L("set.ui.notSaved", "Not saved");
          host.innerHTML =
            '<output class="set-ro" id="set-sudo"></output>' +
            (saved
              ? ` <button type="button" class="btn" id="set-sudo-forget">${escR(L("set.ui.forget", "Forget"))}</button>`
              : "");
          host.querySelector("output").textContent = where;
          host
            .querySelector("#set-sudo-forget")
            ?.addEventListener("click", () =>
              ctx.shell
                .api("POST", "/api/sudo-password/forget", {})
                .then(load)
                .catch(load),
            );
        };
        const load = () =>
          fetch("/api/sudo-password/status", { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then(draw)
            .catch(() => draw(null));
        void load();
      },
    },
    read: () => null,
  },

  {
    // 1Password for a Den running as a service: where its service-account
    // token comes from (secrets.onepassword.token in user.yml). The source
    // only, never the token.
    id: "cli.op_token",
    category: "secrets",
    label: "1Password token source",
    description:
      "Where this machine's 1Password service-account token comes from, for a Den running as a service. Set secrets.onepassword.token in config/local/user.yml: keychain:<service>, file:<path> or env:<VAR>. The token itself is never shown.",
    keywords: ["secrets", "1password", "op", "service account", "token"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) =>
      ctx.data.op_token_source && ctx.data.op_token_source !== "not set"
        ? ctx.data.op_token_source
        : L("set.ui.notSet", "not set"),
  },

  ...ACCESS_ROWS,

  // ── Distribution (read-only) ───────────────────────────────────────────
  distRow(
    "brand",
    "Product name",
    "brand.name: the name on pages, the CLI banner and help.",
    ["brand", "name", "product", "title"],
    (d) => d.brand || L("set.ui.notSet", "not set"),
  ),
  distRow(
    "github_org",
    "GitHub org",
    "github_org: the org whose repos Den clones and lists.",
    ["github", "repos", "clone"],
    (d) => d.github_org || L("set.ui.notSet", "not set"),
  ),
  {
    // H5: how much of the org Den Hub's GitHub App can read, live from Hub.
    id: "distribution.hub_github",
    category: "distribution",
    label: "Den Hub's GitHub access",
    description:
      "How many of your company's GitHub repos Den Hub can read, asked live from Hub. Den Hub reads a repo only through your company's GitHub App install; the button opens GitHub to install it or change its repos. When you come back, Den sends its projects to Hub again and the repos link by themselves.",
    keywords: [
      "distribution",
      "github",
      "hub",
      "access",
      "app",
      "install",
      "repos",
    ],
    scope: "distribution",
    control: { type: "custom", render: renderHubGithub },
    read: () => null,
  },
  distRow(
    "orgs",
    "Org labels",
    "orgs: display names for the GitHub orgs repos belong to.",
    ["orgs", "labels", "names"],
    (d) => {
      const e = Object.entries(d.orgs || {});
      return e.length
        ? e.map(([id, l]) => `${id}: ${l}`).join(", ")
        : L("set.ui.none", "none");
    },
  ),
  distRow(
    "web_port",
    "Web port",
    "web.port: the port the web UI listens on, unless yours overrides it.",
    ["port", "web", "server", "url"],
    (d) =>
      d.web_port != null
        ? String(d.web_port)
        : L("set.ui.portDefault", "not set ({port})", { port: 7777 }),
  ),
  distRow(
    "environments",
    "Environments",
    "environments: the envs the Env menu offers.",
    ["environments", "env", "local", "dev", "prod"],
    (d) =>
      d.environments
        ? d.environments.join(", ")
        : L("set.ui.envsAll", "not set: all"),
  ),
  distRow(
    "domain",
    "Edge domain",
    "edge.domain: services are served at https://<service>.<domain>.",
    ["edge", "domain", "https", "routes"],
    (d) => d.domain || L("set.ui.notSet", "not set"),
  ),
];

// ── Settings › Agents › Runtimes (AG-0.5) ────────────────────────────────

const escR = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Where a runtime's path came from, as the row says it (en; see rtSource). */
export const RUNTIME_SOURCE = {
  workspace: "project",
  setting: "global",
  "login-shell": "detected · login shell",
  PATH: "detected · PATH",
  "well-known": "detected · install directory",
  "interactive-shell": "detected · interactive shell",
};

/** Where a runtime's path came from, in the page's language. */
const rtSource = (src) =>
  RUNTIME_SOURCE[src]
    ? L(`set.ui.rt.src.${src}`, RUNTIME_SOURCE[src])
    : src || "";

/** One runtime's row (r: GET /api/agents/runtimes' entry). */
export function runtimeRowHtml(r, scopeWs) {
  const id = escR(r.id);
  // A runtime's and its maker's names are names (translate="no").
  const name =
    `<b translate="no">${escR(r.label || r.id)}</b>` +
    (r.vendor
      ? ` <span class="rt-v" translate="no">${escR(r.vendor)}</span>`
      : "") +
    (r.denTools === false
      ? ` <span class="set-tag" data-den-tools="coming">${escR(L("set.ui.rt.toolsComing", "Den tools: coming"))}</span>`
      : "");
  const set = r.source === "workspace" || r.source === "setting";
  const status = r.available
    ? `<span class="rt-ok">✓ ${escR(r.version ? r.version : L("set.ui.rt.installed", "installed"))}</span>`
    : `<span class="rt-bad">${escR(set ? r.why : L("set.ui.rt.notInstalled", "Not installed"))}</span>`;
  const where = r.path
    ? `<span class="den-mono rt-p">${escR(r.path)}</span> <span class="set-tag" data-src="${escR(r.source || "")}">${escR(rtSource(r.source))}</span>`
    : set
      ? `<span class="set-tag" data-src="${escR(r.source)}">${escR(rtSource(r.source))}</span>`
      : "";
  // A path set at the scope shown can be cleared from here.
  const mine = scopeWs ? r.source === "workspace" : r.source === "setting";
  return (
    `<div class="rt" data-runtime="${id}" data-available="${r.available ? "true" : "false"}">` +
    `<div class="rt-n">${name}</div>` +
    `<div class="rt-s">${status}</div>` +
    `<div class="rt-w">${where}</div>` +
    `<div class="rt-a"><button type="button" class="btn sm" data-set-path="${id}">${escR(L("set.ui.rt.setPath", "Set path…"))}</button>` +
    (mine
      ? ` <button type="button" class="btn sm" data-clear-path="${id}">${escR(L("set.ui.rt.clear", "Clear"))}</button>`
      : "") +
    `</div>` +
    `<form class="rt-f" data-path-form="${id}" hidden>` +
    `<label class="rt-fl" for="rt-in-${id}">${escR(scopeWs ? L("set.ui.rt.pathToIn", "Path to {name} for {ws}", { name: r.label || r.id, ws: scopeWs }) : L("set.ui.rt.pathToAll", "Path to {name} (every project)", { name: r.label || r.id }))}</label>` +
    `<input type="text" id="rt-in-${id}" class="den-mono" spellcheck="false" autocomplete="off" placeholder="/absolute/path/to/${escR(r.id === "den-claude" ? "claude" : r.id)}" value="${escR(mine ? r.path || "" : "")}">` +
    `<button type="submit" class="btn sm primary">${escR(L("set.ui.rt.save", "Save"))}</button> <button type="button" class="btn sm" data-cancel-path>${escR(L("set.ui.rt.cancel", "Cancel"))}</button>` +
    `<div class="rt-err" role="alert" hidden></div></form>` +
    `</div>`
  );
}

/** The Runtimes row: the list, a workspace selector, Set path… and Clear. */
function renderRuntimes(host, ctx) {
  const wss = ctx.workspaces || [];
  let ws = "";
  const draw = (rows, note) => {
    host.innerHTML =
      `<div class="rt-scope"><label for="rt-ws">${escR(L("set.ui.rt.pathsFor", "Paths for"))}</label> <select id="rt-ws" data-focus-key="rt-ws">` +
      `<option value="">${escR(L("set.ui.rt.everyProject", "every project (user.yml)"))}</option>` +
      wss
        .map(
          (w) =>
            `<option value="${escR(w)}"${w === ws ? " selected" : ""}>${escR(w)} (workspaces.yml)</option>`,
        )
        .join("") +
      `</select></div>` +
      (note ? `<div class="set-note">${escR(note)}</div>` : "") +
      `<div class="rt-list" role="list">${rows.map((r) => runtimeRowHtml(r, ws)).join("")}</div>`;
  };
  const load = () => {
    // Under an invalid config the runtimes answer 422: say why, ask nothing.
    if (ctx.shell?.configInvalid?.() === true)
      return draw(
        [],
        L(
          "set.ui.rt.fixConfig",
          "Fix the config first: the runtimes are read from it.",
        ),
      );
    return ctx.shell
      .api(
        "GET",
        `/api/agents/runtimes${ws ? `?workspace=${encodeURIComponent(ws)}` : ""}`,
      )
      .then((b) =>
        // Only what has a CLI to find: generic is the persona's argv.
        draw((b?.runtimes || []).filter((r) => r.setting)),
      )
      .catch((e) =>
        draw(
          [],
          e?.message || L("set.ui.rt.noLoad", "The runtimes did not load."),
        ),
      );
  };
  host.addEventListener("change", (e) => {
    if (e.target.id !== "rt-ws") return;
    ws = e.target.value;
    void load();
  });
  host.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const row = b.closest(".rt");
    const form = row?.querySelector(".rt-f");
    if (b.dataset.setPath && form) {
      form.hidden = false;
      form.querySelector("input").focus();
    } else if (b.hasAttribute("data-cancel-path") && form) {
      form.hidden = true;
    } else if (b.dataset.clearPath) {
      await savePath(b.dataset.clearPath, null, form);
    }
  });
  host.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target.closest(".rt-f");
    if (!form) return;
    const bin = form.querySelector("input").value.trim();
    if (!bin) return;
    await savePath(form.dataset.pathForm, bin, form);
  });
  async function savePath(id, bin, form) {
    const err = form?.querySelector(".rt-err");
    const btns = form ? [...form.querySelectorAll("button")] : [];
    btns.forEach((x) => (x.disabled = true));
    try {
      await ctx.shell.api(
        "POST",
        `/api/agents/runtimes/${encodeURIComponent(id)}/path`,
        {
          scope: ws ? "workspace" : "global",
          ...(ws ? { workspace: ws } : {}),
          bin,
        },
      );
      await load();
    } catch (x) {
      // Its refusal is shown here, under the field, not as a toast.
      if (err) {
        err.textContent = x?.message || L("set.ui.notSaved", "Not saved");
        err.hidden = false;
      }
    } finally {
      btns.forEach((x) => (x.disabled = false));
    }
  }
  void load();
}

/** "an agent", "a persona": the article for a lowercase noun. */
export const withArticle = (w) => `${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`;

const ROT_SCOPES = [
  ["agent", "Agent", "agent id"],
  ["persona-workspace", "Persona in a project", "persona@project"],
  ["persona", "Persona", "persona id"],
  ["workspace", "Project", "project"],
  ["service", "Service", "service, as the project names it"],
];
const ROT_KEYS = [
  ["after_compactions", "After compactions", "a number, or never"],
  ["on_due", "When due", "auto, ask or off"],
  ["on_pr_merged", "When its PR merges", "true or false"],
];
const rotVal = (v) => (v === undefined ? "" : String(v));
/** A rotation scope's or setting's name in the page's language (0.4.45). */
const rotScope = (v) => {
  const x = ROT_SCOPES.find((r) => r[0] === v);
  return x ? L(`set.ui.rot.scope.${v}`, x[1]) : v;
};
const rotKey = (k) => {
  const x = ROT_KEYS.find((r) => r[0] === k);
  return x ? L(`set.ui.rot.key.${k}`, x[1]) : k;
};
const rotAuto = () => L("set.ui.rot.auto", "Auto");
const rotAsk = () => L("set.ui.rot.ask", "Ask");
const rotOff = () => L("set.ui.off", "Off");
const rotRelaunch = () => L("set.ui.rot.relaunch", "Relaunch");
const rotKeep = () => L("set.ui.rot.keep", "Keep going");
/** A value as a person reads it (D30): "never", "Auto", "Relaunch". */
function rotValText(k, v) {
  if (k === "on_due")
    return { auto: rotAuto, ask: rotAsk, off: rotOff }[v]?.() ?? rotVal(v);
  if (k === "on_pr_merged")
    return v === true ? rotRelaunch() : v === false ? rotKeep() : rotVal(v);
  return rotVal(v);
}

/**
 * D30: an override's target as a name, from the pickers' choices. One that
 * no longer exists: its id, and gone.
 */
export function rotTargetName(scope, target, c = {}) {
  const find = (list, id) => (list || []).find((x) => x.id === id);
  if (scope === "agent") {
    const a = find(c.agents, target);
    return a
      ? { name: a.workspace ? `${a.name} (${a.workspace})` : a.name }
      : { name: target, gone: true };
  }
  if (scope === "persona-workspace") {
    const [pid, ws] = String(target).split("@");
    const p = find(c.personas, pid);
    const w = find(c.workspaces, ws);
    return p && w
      ? { name: `${p.name} in ${w.name}` }
      : { name: target, gone: true };
  }
  const list =
    scope === "persona"
      ? c.personas
      : scope === "workspace"
        ? c.workspaces
        : c.services;
  const x = find(list, target);
  return x ? { name: x.name } : { name: target, gone: true };
}

/** D30: each picker's rows, from GET /api/agents/rotation?choices=1. */
export function rotPickItems(kind, c = {}) {
  if (kind === "agent")
    return (c.agents || []).map((a) => ({
      id: a.id,
      label: a.name,
      sub: [a.workspace, a.state].filter(Boolean).join(" · "),
    }));
  if (kind === "persona")
    return (c.personas || []).map((p) => ({
      id: p.id,
      label: p.name,
      sub: p.category,
    }));
  if (kind === "workspace")
    return (c.workspaces || []).map((w) => ({ id: w.id, label: w.name }));
  return (c.services || []).map((x) => ({
    id: x.id,
    label: x.name,
    sub: x.workspace,
  }));
}

/** A value typed in the overrides form, as the key takes it. */
export function rotationValue(key, raw) {
  const v = String(raw ?? "").trim();
  if (key === "after_compactions")
    return v === "never" || v === "0"
      ? "never"
      : /^\d+$/.test(v)
        ? Number(v)
        : v;
  if (key === "on_pr_merged")
    return v === "true" ? true : v === "false" ? false : v;
  return v;
}

/** The Rotation row's HTML (b: GET /api/agents/rotation). */
export function rotationHtml(b) {
  const inherited = (k) =>
    b.org?.[k] !== undefined
      ? L("set.ui.rot.org", "org config: {v}", { v: rotVal(b.org[k]) }) // words-ok: moved word for word into the catalog (0.4.45)
      : L("set.ui.rot.default", "default: {v}", {
          v: rotVal(b.defaults?.[k]),
        });
  const inst = b.install || {};
  const after = inst.after_compactions;
  const field = (k, control) =>
    `<div class="rot-f" data-rot-key="${k}"><label for="rot-${k}">${escR(rotKey(k))}</label>${control}<span class="set-tag" data-rot-src>${escR(inst[k] !== undefined ? L("set.ui.rot.install", "this install") : inherited(k))}</span></div>`;
  const sel = (k, opts) =>
    `<select id="rot-${k}" data-focus-key="rot-${k}"><option value=""${inst[k] === undefined ? " selected" : ""}>${escR(L("set.ui.rot.inherit", "inherit ({v})", { v: rotVal(b.org?.[k] !== undefined ? b.org[k] : b.defaults?.[k]) }))}</option>` +
    opts
      .map(
        ([v, l]) =>
          `<option value="${escR(v)}"${rotVal(inst[k]) === v ? " selected" : ""}>${escR(l)}</option>`,
      )
      .join("") +
    `</select>`;
  const rows = [];
  for (const [scope, byTarget] of Object.entries(b.overrides || {}))
    for (const [target, vals] of Object.entries(byTarget || {}))
      for (const [k, v] of Object.entries(vals || {})) {
        const who = rotTargetName(scope, target, b.choices);
        const setting = rotKey(k);
        rows.push(
          `<tr data-rot-row${who.gone ? " data-rot-gone" : ""}><td data-l="${escR(L("set.ui.rot.thScope", "Scope"))}">${escR(rotScope(scope))}</td>` +
            `<td data-l="${escR(L("set.ui.rot.thFor", "For"))}"${who.gone ? ' class="rot-gone"' : ""}>${who.gone ? L("set.ui.rot.gone", "{name} (gone)", { name: `<span class="den-mono">${escR(who.name)}</span>` }) : escR(who.name)}</td>` +
            `<td data-l="${escR(L("set.ui.rot.thSetting", "Setting"))}">${escR(setting)}</td><td data-l="${escR(L("set.ui.rot.thValue", "Value"))}">${escR(rotValText(k, v))}</td>` +
            `<td class="rot-act"><button type="button" class="btn sm" data-rot-clear data-scope="${escR(scope)}" data-target="${escR(target)}" data-key="${escR(k)}" aria-label="${escR(L(who.gone ? "set.ui.rot.removeX" : "set.ui.rot.clearX", who.gone ? "Remove {setting} for {name}" : "Clear {setting} for {name}", { setting, name: who.name }))}">${escR(who.gone ? L("set.ui.rot.remove", "Remove") : L("set.ui.rot.clear", "Clear"))}</button></td></tr>`,
        );
      }
  return (
    `<div class="rot" data-rotation-settings>` +
    `<div class="rot-inst">` +
    field(
      "after_compactions",
      `<input type="text" id="rot-after_compactions" data-focus-key="rot-after_compactions" inputmode="numeric" spellcheck="false" autocomplete="off" placeholder="${escR(inherited("after_compactions"))}" value="${escR(after === undefined ? "" : rotVal(after))}"> <button type="button" class="btn sm" data-rot-save-after>${escR(L("set.ui.save", "Save"))}</button>`,
    ) +
    field(
      "on_due",
      sel("on_due", [
        ["auto", rotAuto()],
        ["ask", rotAsk()],
        ["off", rotOff()],
      ]),
    ) +
    field(
      "on_pr_merged",
      sel("on_pr_merged", [
        ["true", rotRelaunch()],
        ["false", rotKeep()],
      ]),
    ) +
    `</div>` +
    `<div class="tablewrap"><table class="svc rot-ov"><caption>${escR(L("set.ui.rot.caption", "Overrides (the most specific wins)"))}</caption><thead><tr><th scope="col">${escR(L("set.ui.rot.thScope", "Scope"))}</th><th scope="col">${escR(L("set.ui.rot.thFor", "For"))}</th><th scope="col">${escR(L("set.ui.rot.thSetting", "Setting"))}</th><th scope="col">${escR(L("set.ui.rot.thValue", "Value"))}</th><th scope="col" aria-label="${escR(L("set.ui.rot.thActions", "Actions"))}"></th></tr></thead><tbody>` +
    (rows.length
      ? rows.join("")
      : `<tr><td colspan="5" class="set-note">${escR(L("set.ui.rot.none", "No overrides: every agent uses this install's values."))}</td></tr>`) +
    `</tbody></table></div>` +
    `<form class="rot-add" data-rot-add>` +
    `<span class="rot-pick"><label for="rot-a-scope">${escR(L("set.ui.rot.thScope", "Scope"))}</label> <select id="rot-a-scope">${ROT_SCOPES.map(([v]) => `<option value="${v}">${escR(rotScope(v))}</option>`).join("")}</select></span>` +
    // The target: picked by name, never typed as an id (D30).
    `<span class="rot-pick" data-for="agent">${comboHtml({ id: "rot-a-agent", label: rotScope("agent"), placeholder: L("set.ui.rot.findAgent", "Type to find an agent") })}</span>` +
    `<span class="rot-pick" data-for="persona persona-workspace" hidden>${comboHtml({ id: "rot-a-persona", label: rotScope("persona"), placeholder: L("set.ui.rot.findPersona", "Type to find a persona") })}</span>` +
    `<span class="rot-pick" data-for="workspace persona-workspace" hidden>${comboHtml({ id: "rot-a-ws", label: rotScope("workspace"), placeholder: L("set.ui.rot.findProject", "Type to find a project") })}</span>` +
    `<span class="rot-pick" data-for="service" hidden>${comboHtml({ id: "rot-a-service", label: rotScope("service"), placeholder: L("set.ui.rot.findService", "Type to find a service") })}</span>` +
    `<span class="rot-pick"><label for="rot-a-key">${escR(L("set.ui.rot.thSetting", "Setting"))}</label> <select id="rot-a-key">${ROT_KEYS.map(([v]) => `<option value="${v}">${escR(rotKey(v))}</option>`).join("")}</select></span>` +
    `<span class="rot-pick" data-val="after_compactions"><label for="rot-a-n">${escR(L("set.ui.rot.thValue", "Value"))}</label> <input type="number" id="rot-a-n" min="1" max="100" step="1" value="3"> <label class="rot-never"><input type="checkbox" id="rot-a-never"> ${escR(L("set.ui.rot.never", "never"))}</label></span>` +
    `<span class="rot-pick" data-val="on_due" hidden><label for="rot-a-due">${escR(L("set.ui.rot.thValue", "Value"))}</label> <select id="rot-a-due"><option value="auto">${escR(rotAuto())}</option><option value="ask">${escR(rotAsk())}</option><option value="off">${escR(rotOff())}</option></select></span>` +
    `<span class="rot-pick" data-val="on_pr_merged" hidden><label for="rot-a-pr">${escR(L("set.ui.rot.thValue", "Value"))}</label> <select id="rot-a-pr"><option value="true">${escR(rotRelaunch())}</option><option value="false">${escR(rotKeep())}</option></select></span>` +
    `<button type="submit" class="btn sm primary">${escR(L("set.ui.rot.add", "Add override"))}</button></form>` +
    `<div class="rt-err" role="alert" hidden></div>` +
    `</div>`
  );
}

/** HUB-1.7: what came back from Hub's redirect (?hub=…), when the server has no words for it. */
const HUB_FLASH = {
  connected: [true, "Connected to Hub."],
  denied: [false, "Not connected: the request was declined on Hub."],
  expired: [
    false,
    "That connect link was used or too old: press Connect again.",
  ],
  failed: [false, "Connect didn't finish: press Connect again."],
};

/**
 * HUB-1.5/1.7: Settings › Agents › Hub (b: GET /api/hub; flash: what the
 * last Connect came to). Not connected: Hub's address and Connect.
 * Connected: the company (a link), role, who signed in, this install,
 * Disconnect. A token Hub refuses offers Reconnect; a role that no longer
 * may connect says to ask an admin (never a retry).
 */
export function hubHtml(b, flash, t = (k) => k) {
  b = b || { configured: false };
  const state = b.configured
    ? b.state || (b.connected ? "connected" : "no_token")
    : "no_token";
  const note = (t, attr) => `<p class="set-note" ${attr}>${escR(t)}</p>`;
  const flashHtml = flash
    ? `<p class="set-note hub-flash ${flash.ok ? "ok" : "warn"}" role="status" data-hub-flash="${flash.ok ? "ok" : "failed"}">${escR(flash.message)}</p>`
    : "";
  if (state === "bad_config")
    return (
      flashHtml +
      note(
        b.problem || L("set.ui.hub.badConfig", "hub in user.yml is not valid"),
        "data-hub-problem",
      )
    );
  if (state === "no_token")
    return (
      flashHtml +
      `<form class="hub-connect" data-hub-connect>` +
      `<label for="hub-url">${escR(L("set.ui.hub.address", "Hub's address"))}</label> ` +
      `<input type="url" id="hub-url" class="den-mono" spellcheck="false" autocomplete="url" placeholder="https://hub.example.com" value="${escR(b.url || "")}">` +
      ` <button type="submit" class="btn sm primary" data-hub-action="connect">${escR(L("set.ui.hub.connect", "Connect"))}</button>` +
      `</form>` +
      `<p class="set-note">${escR(L("set.ui.hub.connectNote", "Connect opens Hub. Sign in there and approve this install; you come back here connected. The token is kept in this install's secrets store, never shown."))}</p>` +
      (b.problem && b.url && !/^not connected yet/.test(b.problem)
        ? note(b.problem, "data-hub-problem")
        : "") +
      `<div class="rt-err" role="alert" hidden></div>`
    );
  const status = {
    connected: ["ok", L("set.ui.hub.connected", "Connected")],
    rejected: ["warn", L("set.ui.hub.rejected", "Token not accepted")],
    forbidden: ["warn", L("set.ui.hub.forbidden", "Not allowed")],
    unreachable: ["warn", L("set.ui.hub.unreachable", "Can't reach Hub")],
  }[state] || ["warn", L("set.ui.hub.notConnected", "Not connected")];
  const team = b.team
    ? b.teamUrl && /^https?:\/\//i.test(b.teamUrl)
      ? // D51: Den → Hub is a plain link, in this tab (⌘-click: a new one).
        `<a href="${escR(b.teamUrl)}">${escR(b.team)}</a>`
      : escR(b.team)
    : "";
  const rows = [
    ["Hub", `<span class="den-mono">${escR(b.url || "")}</span>`],
    [
      L("set.ui.hub.status", "Status"),
      `<span class="set-tag ${status[0]}" data-hub-state="${escR(state)}">${escR(status[1])}</span>`,
    ],
    ...(team ? [[L("set.ui.hub.company", "Company"), team]] : []),
    ...(b.role ? [[L("set.ui.hub.role", "Role"), escR(b.role)]] : []),
    ...(b.login
      ? [[L("set.ui.hub.signedInAs", "Signed in as"), escR(b.login)]]
      : []),
    ...(b.label
      ? [[L("set.ui.hub.thisInstall", "This install"), escR(b.label)]]
      : []),
  ];
  const why =
    state === "rejected"
      ? L(
          "set.ui.hub.whyRejected",
          "Hub no longer accepts this install's token (revoked or expired). Reconnect signs you in again.",
        )
      : state === "forbidden"
        ? L(
            "set.ui.hub.whyForbidden",
            "Your role on Hub no longer allows connecting installs. Ask a Hub admin to change your role, then Reconnect.",
          )
        : state === "unreachable"
          ? b.problem || L("set.ui.hub.noAnswer", "Hub didn't answer.")
          : // #71: a token Den can't replace itself; Reconnect moves it over.
            b.legacy
            ? t("hub.legacy")
            : "";
  const tools =
    `<label class="hub-tools"><input type="checkbox" id="hub-allow-tools"${b.allowTools !== false ? " checked" : ""}> ${escR(L("set.ui.hub.tools", "Agents use Hub's tools without asking"))}</label>` +
    `<p class="set-note" data-hub-tools-note>${escR(
      b.allowTools !== false
        ? L(
            "set.ui.hub.toolsOn",
            "Agents can publish and comment in Hub without asking; writes are versioned and stay in this install's team.", // words-ok: moved word for word into the catalog (0.4.45)
          )
        : L("set.ui.hub.toolsOff", "Agents ask before each Hub tool runs."),
    )}</p>`;
  return (
    flashHtml +
    `<dl class="hub-st" data-hub>` +
    rows.map(([k, v]) => `<dt>${escR(k)}</dt><dd>${v}</dd>`).join("") +
    `</dl>` +
    (why ? note(why, "data-hub-problem") : "") +
    `<div class="hub-acts">` +
    (state === "rejected" || b.legacy
      ? `<button type="button" class="btn sm primary" data-hub-action="connect">${escR(t("hub.reconnect"))}</button> `
      : "") +
    `<button type="button" class="btn sm" data-hub-action="disconnect">${escR(L("set.ui.hub.disconnect", "Disconnect"))}</button>` +
    `</div>` +
    // Disconnect asks first, saying what it does (Hub revokes the key).
    `<div class="hub-confirm" data-hub-confirm hidden>` +
    `<p class="set-note set-warn">${escR(L("set.ui.hub.disconnectWarn", "This revokes this Den's Hub key on Hub. Agents lose Hub until you Connect again."))}</p>` +
    `<button type="button" class="btn sm primary" data-hub-action="disconnect-yes">${escR(L("set.ui.hub.disconnect", "Disconnect"))}</button> ` +
    `<button type="button" class="btn sm" data-hub-action="disconnect-no">${escR(L("set.ui.cancel", "Cancel"))}</button>` +
    `</div>` +
    `<div class="rt-err" role="alert" hidden></div>` +
    tools
  );
}

/**
 * D44: running agents whose tools predate Hub's Connect or Disconnect
 * (from GET /api/agents/stale), and the offer to restart them at their
 * next idle, each keeping its conversation. "" when there are none.
 */
export function restartOfferHtml(agents) {
  const n = Array.isArray(agents) ? agents.length : 0;
  if (!n) return "";
  const adds = agents.some((a) => a?.stale?.adds?.length);
  const who = n === 1 ? "1 agent" : `${n} agents`;
  const what = adds
    ? `${who} started before Hub was connected, so ${n === 1 ? "it doesn't" : "they don't"} have Hub's tools yet.`
    : `${who} started while Hub was connected, so ${n === 1 ? "it still lists" : "they still list"} Hub's tools.`;
  return (
    `<div class="hub-restart" data-hub-restart="${n}">` +
    `<p class="set-note">${escR(what)} A restart keeps each conversation and never cuts a turn.</p>` +
    `<button type="button" class="btn sm primary" data-hub-action="restart-stale">Restart ${escR(who)} at ${n === 1 ? "its" : "their"} next idle</button>` +
    `</div>`
  );
}

function offerRestart(host, ctx, fresh) {
  return ctx.shell
    .api("GET", `/api/agents/stale${fresh ? "?fresh=1" : ""}`)
    .then((r) => {
      const html = restartOfferHtml(r?.agents);
      if (!html) return;
      host.insertAdjacentHTML("beforeend", html);
      const box = host.querySelector("[data-hub-restart]");
      const btn = box?.querySelector('[data-hub-action="restart-stale"]');
      btn?.addEventListener("click", () => {
        btn.disabled = true;
        ctx.shell
          .api("POST", "/api/agents/restart-stale", {})
          .then((x) => {
            const k = Array.isArray(x?.pending) ? x.pending.length : 0;
            box.innerHTML = `<p class="set-note" role="status" data-hub-restarting="${k}">${escR(
              k === 1
                ? "1 agent restarts at its next idle, in the same conversation."
                : `${k} agents restart at their next idle, each in the same conversation.`,
            )}</p>`;
          })
          .catch((e) => {
            btn.disabled = false;
            box.insertAdjacentHTML(
              "beforeend",
              `<p class="set-note set-warn" role="alert">${escR(e?.message || "Not restarted")}</p>`,
            );
          });
      });
    })
    .catch(() => undefined);
}

/** Read and clear ?hub=… (set by Hub's redirect back through /hub/callback). */
function takeHubFlash() {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get("hub");
    if (!v) return null;
    u.searchParams.delete("hub");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    return v;
  } catch {
    return null;
  }
}

/** HUB-1.5/1.7: the Hub row: always shown, so a person can Connect. */
/**
 * H5: Settings › Project setup › Hub project. Linked: its name, Change and
 * Unlink. Not linked: says so, with Hub's suggestions first in the list
 * and the first one picked; nothing is linked until the person presses
 * Link. Not connected to Hub: says where to connect.
 */
function renderHubProject(host, ctx) {
  const ws = ctx.workspace;
  if (!ws || ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  const url = `/api/workspaces/${encodeURIComponent(ws)}/hub-project`;
  const name = (p) =>
    p.name === p.slug ? escR(p.slug) : `${escR(p.name)} (${escR(p.slug)})`;
  return ctx.shell
    .api("GET", url)
    .then((b) => {
      host.innerHTML = hubProjectHtml(b, t, name);
      wireHubProject(host, ctx, url, t);
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note" data-hubp-error>${escR(e?.message || t("hubp.failed"))}</p>`;
    });
}

/** 0.4.45: Navigation › Project order: its state, Reset, and where to move. */
export function projectOrderHtml(custom, t, href = "/local-dev") {
  return (
    `<div data-porder data-porder-state="${custom ? "mine" : "az"}">` +
    `<p class="set-status">${escR(t(custom ? "ws.order.mine" : "ws.order.az"))}</p>` +
    (custom
      ? `<button type="button" class="btn sm" data-porder-reset>${escR(t("ws.order.reset"))}</button> `
      : "") +
    `<a href="${escR(href)}">${escR(t("ws.manage"))}</a>` +
    `<div class="rt-err" role="alert" hidden></div></div>`
  );
}

function renderProjectOrder(host, ctx) {
  const t = (k, v) => ctx.shell.t(k, v);
  const custom =
    Array.isArray(ctx.data?.shell?.projectOrder) &&
    ctx.data.shell.projectOrder.length > 0;
  host.innerHTML = projectOrderHtml(custom, t);
  host.querySelector("[data-porder-reset]")?.addEventListener("click", () =>
    Promise.resolve(ctx.post({ shell: { projectOrder: null } }))
      .then((ok) => {
        if (!ok) throw new Error(t("pname.failed"));
        if (ctx.data?.shell) ctx.data.shell.projectOrder = [];
        return renderProjectOrder(host, ctx);
      })
      .catch((e) => {
        const err = host.querySelector(".rt-err");
        if (err) {
          err.hidden = false;
          err.textContent = e?.message || t("pname.failed");
        }
      }),
  );
  return Promise.resolve();
}

/** The longest project name Settings takes (mock v5). */
const PNAME_MAX = 60;

/**
 * 0.4.45: a typed project name, checked: trimmed, 1 to 60 characters, and
 * not the name it has now.
 */
export function projectNameCheck(raw, current) {
  const name = String(raw ?? "").trim();
  if (!name) return { ok: false, why: "empty" };
  if (name.length > PNAME_MAX) return { ok: false, why: "long" };
  if (name === String(current ?? "").trim()) return { ok: false, why: "same" };
  return { ok: true, name };
}

/**
 * 0.4.45 Settings › Project setup › Name (mock v5 A1, A4). `p` is
 * { slug, cfg } with cfg the project's workspaces.yml entry. Linked to Hub:
 * Hub's name, read-only, "Named in Hub" in words. Not linked: an input and
 * Save name, off until the name changed.
 */
export function projectNameHtml(p, t) {
  const hub = p?.cfg?.hub_project?.name;
  if (typeof hub === "string" && hub.trim())
    return (
      `<div data-pname data-pname-state="hub">` +
      `<p class="set-status"><strong data-pname-value>${escR(hub.trim())}</strong> ` +
      `<span class="pname-chip" data-pname-chip><i aria-hidden="true"></i>${escR(t("pname.hubChip"))}</span></p>` +
      `<p class="set-note">${escR(t("pname.hubHelp"))}</p></div>`
    );
  const own =
    typeof p?.cfg?.name === "string" && p.cfg.name.trim()
      ? p.cfg.name.trim()
      : String(p?.slug ?? "");
  return (
    `<form data-pname data-pname-state="local" class="pname-form">` +
    `<input id="pname-in" type="text" aria-label="${escR(t("pname.label"))}" data-pname-input value="${escR(own)}" maxlength="${PNAME_MAX}" autocomplete="off"> ` +
    `<button type="submit" class="btn sm primary" data-pname-save disabled>${escR(t("pname.save"))}</button>` +
    `<p class="set-note">${escR(t("pname.localHelp"))}</p>` +
    `<div class="rt-err" role="alert" data-pname-err hidden></div>` +
    `<p class="set-note" role="status" data-pname-ok hidden>${escR(t("pname.saved"))}</p></form>`
  );
}

function renderProjectName(host, ctx) {
  const ws = ctx.workspace;
  if (!ws || ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  return ctx.shell
    .api("GET", "/api/workspaces")
    .then((b) => {
      const cfg = b?.workspaces?.[ws] ?? {};
      host.innerHTML = projectNameHtml({ slug: ws, cfg }, t);
      const form = host.querySelector("form[data-pname]");
      if (!form) return;
      const input = form.querySelector("[data-pname-input]");
      const save = form.querySelector("[data-pname-save]");
      const err = form.querySelector("[data-pname-err]");
      const ok = form.querySelector("[data-pname-ok]");
      const start = input.value;
      const say = (msg) => {
        err.hidden = !msg;
        err.textContent = msg || "";
      };
      input.addEventListener("input", () => {
        const c = projectNameCheck(input.value, start);
        save.disabled = !c.ok;
        ok.hidden = true;
        say(c.why === "empty" ? t("pname.empty") : "");
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          input.value = start;
          save.disabled = true;
          say("");
        }
      });
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const c = projectNameCheck(input.value, start);
        if (!c.ok) {
          say(c.why === "empty" ? t("pname.empty") : "");
          return;
        }
        save.disabled = true;
        ctx.shell
          .api("POST", "/api/workspaces/rename", {
            oldName: ws,
            newName: c.name,
          })
          .then(() => renderProjectName(host, ctx))
          .then(() => {
            const done = host.querySelector("[data-pname-ok]");
            if (done) done.hidden = false;
          })
          .catch((x) => {
            save.disabled = false;
            say(x?.message || t("pname.failed"));
          });
      });
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note">${escR(e?.message || t("pname.failed"))}</p>`;
    });
}

/** H5: repos Den Hub can't see, with one button per org. */
export function hubUncoveredHtml(list, t) {
  const un = Array.isArray(list) ? list : [];
  if (!un.length) return "";
  const orgs = [...new Set(un.map((u) => u.org))];
  return (
    `<div data-hubp-uncovered>` +
    un
      .map(
        (u) =>
          `<p class="set-status" data-hubp-unseen="${escR(u.repo)}"><span class="rt-dot warn"></span> ${escR(t("hubp.cantSee", { repo: u.repo }))}</p>`,
      )
      .join("") +
    orgs
      .map((org) => {
        const href = un.find((u) => u.org === org && u.installUrl)?.installUrl;
        return href && /^https:\/\/github\.com\//.test(href)
          ? `<a class="btn sm primary" data-hubp-give="${escR(org)}" href="${escR(href)}" target="_blank" rel="noopener noreferrer">${escR(t("hubp.giveAccess", { org }))}</a> `
          : "";
      })
      .join("") +
    `</div>`
  );
}

function hubProjectHtml(b, t, name) {
  if (!b.connected)
    return (
      `<div data-hubp data-hubp-state="offline">` +
      `<p class="set-note">${escR(t("hubp.offline"))} <a href="/settings#agents.hub">${escR(t("hubp.connect"))}</a></p></div>`
    );
  const linked = b.hub;
  const why = (w) => (w === "repo" ? t("hubp.whyRepo") : t("hubp.whyName"));
  const sugg = (b.suggestions || []).filter((p) => p.id !== linked?.id);
  const rest = (b.projects || []).filter(
    (p) => p.id !== linked?.id && !sugg.some((x) => x.id === p.id),
  );
  const opts =
    (sugg.length
      ? `<optgroup label="${escR(t("hubp.suggested"))}">${sugg
          .map(
            (p, i) =>
              `<option value="${escR(p.id)}"${!linked && i === 0 ? " selected" : ""}>${name(p)}: ${escR(why(p.why))}</option>`,
          )
          .join("")}</optgroup>`
      : "") +
    (rest.length
      ? `<optgroup label="${escR(t("hubp.others"))}">${rest
          .map((p) => `<option value="${escR(p.id)}">${name(p)}</option>`)
          .join("")}</optgroup>`
      : "");
  const status = linked
    ? `<p class="set-status"><span class="rt-dot ok"></span> ${t("hubp.linked", { name: `<strong data-hubp-name>${name(linked)}</strong>` })}</p>`
    : `<p class="set-status"><span class="rt-dot warn"></span> ${escR(t("hubp.unlinked"))}</p>`;
  const picker = opts
    ? `<form class="hubp-pick" data-hubp-form>` +
      `<label for="hubp-sel">${escR(t(linked ? "hubp.changeTo" : "hubp.linkTo"))}</label> ` +
      `<select id="hubp-sel">${opts}</select> ` +
      `<button type="submit" class="btn sm${linked ? "" : " primary"}" data-hubp-action="link">${escR(t(linked ? "hubp.change" : "hubp.link"))}</button>` +
      `</form>`
    : `<p class="set-note">${escR(t(linked ? "hubp.noOther" : "hubp.none"))}</p>`;
  const unlink = linked
    ? ` <button type="button" class="btn sm" data-hubp-action="unlink">${escR(t("hubp.unlink"))}</button>`
    : "";
  return (
    `<div data-hubp data-hubp-state="${linked ? "linked" : "unlinked"}">` +
    status +
    hubUncoveredHtml(b.uncovered, t) +
    (b.error ? `<p class="set-note">${escR(b.error)}</p>` : "") +
    picker +
    unlink +
    `<div class="rt-err" role="alert" hidden></div></div>`
  );
}

function wireHubProject(host, ctx, url, t) {
  const err = (msg) => {
    const e = host.querySelector(".rt-err");
    if (!e) return;
    e.hidden = !msg;
    e.textContent = msg || "";
  };
  const put = (hub) => {
    host.querySelectorAll("button, select").forEach((x) => (x.disabled = true));
    err("");
    return ctx.shell
      .api("PUT", url, { hub })
      .then(() => renderHubProject(host, ctx))
      .catch((e) => {
        host
          .querySelectorAll("button, select")
          .forEach((x) => (x.disabled = false));
        err(e?.message || t("hubp.failed"));
      });
  };
  host.querySelector("[data-hubp-form]")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = host.querySelector("#hubp-sel")?.value;
    if (v) put(v);
  });
  host
    .querySelector('[data-hubp-action="unlink"]')
    ?.addEventListener("click", () => put(null));
}

/**
 * #68: every project with Hub's suggestion; the unlinked ones with a
 * suggestion are ticked; Link ticked links them in one POST and says what
 * was skipped and why.
 */
export function hubLinkAllHtml(b, t) {
  if (!b || !b.connected)
    return (
      `<div data-hubla data-hubla-state="offline">` +
      `<p class="set-note">${escR(t("hubp.offline"))} <a href="/settings#agents.hub">${escR(t("hubp.connect"))}</a></p></div>`
    );
  const rows = Array.isArray(b.projects) ? b.projects : [];
  const name = (p) =>
    p.name === p.slug ? escR(p.slug) : `${escR(p.name)} (${escR(p.slug)})`;
  const why = (w) => (w === "repo" ? t("hubp.whyRepo") : t("hubp.whyName"));
  const todo = rows.filter((r) => !r.hub && r.suggestion);
  if (!rows.length)
    return `<div data-hubla data-hubla-state="none"><p class="set-note">${escR(t("hubla.noProjects"))}</p></div>`;
  const line = (r) => {
    if (r.hub)
      return `<li data-hubla-row="${escR(r.project)}" data-hubla-linked><span class="rt-dot ok"></span> ${escR(r.project)}: ${escR(t("hubla.linkedTo"))} ${name(r.hub)}</li>`;
    if (!r.suggestion)
      return `<li data-hubla-row="${escR(r.project)}"><span class="rt-dot warn"></span> ${escR(r.project)}: ${escR(t("hubla.noSuggestion"))}</li>`;
    const id = `hubla-${escR(r.project)}`;
    return (
      `<li data-hubla-row="${escR(r.project)}"><label for="${id}">` +
      `<input type="checkbox" id="${id}" data-hubla-pick="${escR(r.project)}" data-hubla-hub="${escR(r.suggestion.id)}" checked> ` +
      `${escR(r.project)} → ${name(r.suggestion)}` +
      (r.suggestion.why ? `: ${escR(why(r.suggestion.why))}` : "") +
      `</label></li>`
    );
  };
  return (
    `<div data-hubla data-hubla-state="${todo.length ? "todo" : "done"}">` +
    `<ul class="hubla-list">${rows.map(line).join("")}</ul>` +
    (todo.length
      ? `<button type="button" class="btn sm primary" data-hubla-action="link">${escR(t("hubla.linkTicked"))}</button>`
      : `<p class="set-note">${escR(t("hubla.nothing"))}</p>`) +
    `<div class="set-note" data-hubla-result hidden></div>` +
    `<div class="rt-err" role="alert" hidden></div></div>`
  );
}

function renderHubLinkAll(host, ctx) {
  return drawHubLinkAll(host, ctx, null);
}

/** `result`: the last Link ticked's answer, shown under the list. */
function drawHubLinkAll(host, ctx, result) {
  if (ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  const url = "/api/hub/link-suggestions";
  return ctx.shell
    .api("GET", url)
    .then((b) => {
      host.innerHTML = hubLinkAllHtml(b, t);
      const out = host.querySelector("[data-hubla-result]");
      if (out && result && Array.isArray(result.linked)) {
        const parts = [t("hubla.linked", { n: result.linked.length })];
        for (const s of result.skipped ?? [])
          parts.push(
            t("hubla.skipped", {
              project: s.project,
              why: t(`hubla.why.${s.code}`),
            }),
          );
        out.textContent = parts.join(" ");
        out.hidden = false;
      }
      const btn = host.querySelector('[data-hubla-action="link"]');
      btn?.addEventListener("click", () => {
        const links = [...host.querySelectorAll("[data-hubla-pick]")]
          .filter((c) => c.checked)
          .map((c) => ({
            project: c.dataset.hublaPick,
            hub: c.dataset.hublaHub,
          }));
        if (!links.length) return;
        host
          .querySelectorAll("button, input")
          .forEach((x) => (x.disabled = true));
        ctx.shell
          .api("POST", url, { links })
          .then((r) => drawHubLinkAll(host, ctx, r))
          .catch((e) => {
            host
              .querySelectorAll("button, input")
              .forEach((x) => (x.disabled = false));
            const err = host.querySelector(".rt-err");
            if (err) {
              err.hidden = false;
              err.textContent = e?.message || t("hubp.failed");
            }
          });
      });
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note" data-hubla data-hubla-state="error">${escR(e?.message || t("hubp.failed"))}</p>`;
    });
}

/**
 * H5: Den Hub's GitHub access, one line per org: all repos, N of M, or no
 * access, live from Hub, with GitHub's link (Hub gives only github.com
 * https links; the server drops anything else). Coming back to the window,
 * or to ?hub=installed, sends the projects to Hub again and redraws.
 */
export function hubGithubHtml(b, t) {
  if (!b || !b.connected)
    return `<p class="set-note" data-hubgh data-hubgh-state="offline">${escR(t("hubgh.offline"))}</p>`;
  if (b.error)
    return `<p class="set-note" data-hubgh data-hubgh-state="error">${escR(t("hubgh.failed"))} ${escR(b.error)}</p>`;
  const orgs = b.orgs || [];
  if (!orgs.length)
    return `<p class="set-note" data-hubgh data-hubgh-state="none">${escR(t("hubgh.noOrgs"))}</p>`;
  return (
    `<div data-hubgh data-hubgh-state="orgs">` +
    orgs
      .map((o) => {
        const what =
          o.access === "all"
            ? t("hubgh.all")
            : o.access === "some"
              ? t("hubgh.some", { n: o.covered, m: o.total })
              : t("hubgh.none");
        const href =
          o.access === "some"
            ? o.manageUrl || o.installUrl
            : o.access === "none"
              ? o.installUrl
              : null;
        const label = o.access === "none" ? t("hubgh.give") : t("hubgh.change");
        const dot = o.access === "all" ? "ok" : "warn";
        return (
          `<p class="set-status" data-hubgh-org="${escR(o.org)}" data-hubgh-access="${escR(o.access)}">` +
          `<span class="rt-dot ${dot}"></span> ${escR(t("hubgh.line", { org: o.org, what }))}` +
          (href && /^https:\/\/github\.com\//.test(href)
            ? ` <a class="btn sm${o.access === "none" ? " primary" : ""}" data-hubgh-open href="${escR(href)}" target="_blank" rel="noopener noreferrer">${escR(label)}</a>`
            : "") +
          `</p>`
        );
      })
      .join("") +
    `</div>`
  );
}

// ?hub=installed: back from GitHub's install, read once at load (the page
// rewrites its URL). One re-sync, shared by every row that shows access.
let hubBackFromInstall = (() => {
  try {
    return new URLSearchParams(location.search).get("hub") === "installed";
  } catch {
    return false;
  }
})();
let hubResync = null;

function renderHubGithub(host, ctx) {
  // A config Den can't read: no Hub to ask (its routes answer 422).
  if (ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  const draw = () =>
    ctx.shell
      .api("GET", "/api/hub/github")
      .then((b) => {
        host.innerHTML = hubGithubHtml(b, t);
        host.querySelectorAll("[data-hubgh-open]").forEach((a) =>
          a.addEventListener("click", () => {
            host.dataset.hubghAway = "1";
          }),
        );
      })
      .catch((e) => {
        host.innerHTML = `<p class="set-note" data-hubgh data-hubgh-state="error">${escR(e?.message || t("hubgh.failed"))}</p>`;
      });
  const resync = () => {
    hubResync ??= ctx.shell
      .api("POST", "/api/hub/sync", {})
      .catch(() => null)
      .finally(() => setTimeout(() => (hubResync = null), 2000));
    return hubResync.then(draw);
  };
  if (!host.dataset.hubghWired) {
    host.dataset.hubghWired = "1";
    window.addEventListener("focus", () => {
      if (host.isConnected && host.dataset.hubghAway === "1") {
        host.dataset.hubghAway = "";
        resync();
      }
    });
  }
  if (hubBackFromInstall || hubResync) {
    hubBackFromInstall = false;
    return resync();
  }
  return draw();
}

function renderHub(host, ctx) {
  return drawHub(host, ctx, takeHubFlash(), null);
}

/** Draw the row; `back` is ?hub=… from Hub's redirect, `flash` words to show. */
function drawHub(host, ctx, back, flash) {
  // Under an invalid config /api/hub answers 422: ask nothing, show nothing.
  if (ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  return ctx.shell
    .api("GET", "/api/hub")
    .then((b) => {
      let f = flash;
      if (!f && b && b.connect) f = b.connect;
      else if (!f && back && HUB_FLASH[back])
        f = { ok: HUB_FLASH[back][0], message: HUB_FLASH[back][1] };
      host.innerHTML = hubHtml(b, f, (k, v) => ctx.shell.t(k, v));
      wireHub(host, ctx);
      // D44: agents started before Hub changed keep their old tools.
      return offerRestart(host, ctx, Boolean(f || back));
    })
    .catch(() => {
      host.innerHTML = "";
    });
}

function wireHub(host, ctx) {
  const err = (msg, retry) => {
    const e = host.querySelector(".rt-err");
    if (!e) return;
    e.hidden = !msg;
    e.textContent = msg || "";
    if (retry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn sm";
      btn.dataset.hubAction = "force";
      btn.textContent = "Remove it here anyway";
      btn.addEventListener("click", () => disconnect(true, btn));
      e.append(" ", btn);
    }
  };
  const busy = (on) =>
    host.querySelectorAll("button, input").forEach((x) => (x.disabled = on));
  const connect = () => {
    const typed = host.querySelector("#hub-url");
    busy(true);
    err("");
    ctx.shell
      .api("POST", "/api/hub/connect", typed ? { url: typed.value } : {})
      .then((r) => {
        // Off to Hub: sign in and approve there; Hub sends the person back.
        location.assign(r.location);
      })
      .catch((e) => {
        busy(false);
        err(e?.message || "Connect didn't start");
      });
  };
  const disconnect = (force, btn) => {
    busy(true);
    err("");
    ctx.shell
      .api("POST", "/api/hub/disconnect", force ? { force: true } : {})
      .then((r) => drawHub(host, ctx, null, { ok: true, message: r.message }))
      .catch((e) => {
        busy(false);
        if (btn) btn.remove();
        err(e?.message || "Not disconnected", !force);
      });
  };
  const form = host.querySelector("[data-hub-connect]");
  if (form)
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      connect();
    });
  host
    .querySelectorAll('button[data-hub-action="connect"]')
    .forEach(
      (x) => x.type === "button" && x.addEventListener("click", connect),
    );
  const acts = host.querySelector(".hub-acts");
  const ask = host.querySelector("[data-hub-confirm]");
  const asking = (on) => {
    if (!acts || !ask) return;
    acts.hidden = on;
    ask.hidden = !on;
    host
      .querySelector(
        on
          ? '[data-hub-action="disconnect-no"]'
          : '[data-hub-action="disconnect"]',
      )
      ?.focus();
  };
  host
    .querySelector('[data-hub-action="disconnect"]')
    ?.addEventListener("click", () => asking(true));
  host
    .querySelector('[data-hub-action="disconnect-no"]')
    ?.addEventListener("click", () => asking(false));
  ask?.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      asking(false);
    }
  });
  host
    .querySelector('[data-hub-action="disconnect-yes"]')
    ?.addEventListener("click", () => {
      if (ask) ask.hidden = true;
      if (acts) acts.hidden = false;
      disconnect(false);
    });
  const box = host.querySelector("#hub-allow-tools");
  if (box)
    box.addEventListener("change", () => {
      box.disabled = true;
      ctx.shell
        .api("POST", "/api/settings", { hub_allow_tools: box.checked })
        .then(() => drawHub(host, ctx, null, null))
        .catch(() => {
          box.checked = !box.checked;
          box.disabled = false;
        });
    });
}

/** The Rotation row: this install's values, the overrides, + Add override. */
function renderRotation(host, ctx) {
  const err = () => host.querySelector(".rt-err");
  const fail = (x) => {
    const e = err();
    if (e) {
      e.textContent = x?.message || L("set.ui.notSaved", "Not saved");
      e.hidden = false;
    }
  };
  const load = () => {
    if (ctx.shell?.configInvalid?.() === true) {
      host.innerHTML = `<div class="set-note">${escR(L("set.ui.rot.fixConfig", "Fix the config first: the org's rotation is read from it."))}</div>`;
      return Promise.resolve();
    }
    return ctx.shell
      .api("GET", "/api/agents/rotation?choices=1")
      .then((b) => {
        host.innerHTML = rotationHtml(b || {});
        wireAdd(b?.choices || {});
      })
      .catch((x) => {
        host.innerHTML = `<div class="set-note">${escR(x?.message || L("set.ui.rot.loadFailed", "The rotation settings did not load."))}</div>`;
      });
  };
  // D30: the add form's pickers, filled from live data.
  let picks = {};
  const wireAdd = (c) => {
    picks = {};
    for (const [kind, id] of [
      ["agent", "rot-a-agent"],
      ["persona", "rot-a-persona"],
      ["workspace", "rot-a-ws"],
      ["service", "rot-a-service"],
    ])
      picks[kind] = wireCombo(host, id, { items: () => rotPickItems(kind, c) });
    showFor();
  };
  const showFor = () => {
    const scope = host.querySelector("#rot-a-scope")?.value;
    const key = host.querySelector("#rot-a-key")?.value;
    for (const el of host.querySelectorAll(".rot-add [data-for]"))
      el.hidden = !el.dataset.for.split(" ").includes(scope);
    for (const el of host.querySelectorAll(".rot-add [data-val]"))
      el.hidden = el.dataset.val !== key;
    const n = host.querySelector("#rot-a-n");
    const never = host.querySelector("#rot-a-never");
    if (n && never) n.disabled = never.checked;
  };
  const targetOf = (scope) => {
    const v = (k) => picks[k]?.value() || "";
    if (scope === "persona-workspace")
      return v("persona") && v("workspace")
        ? `${v("persona")}@${v("workspace")}`
        : "";
    return v(scope);
  };
  const valueOf = (key) => {
    if (key === "on_due") return host.querySelector("#rot-a-due").value;
    if (key === "on_pr_merged")
      return host.querySelector("#rot-a-pr").value === "true";
    if (host.querySelector("#rot-a-never").checked) return "never";
    return Number(host.querySelector("#rot-a-n").value);
  };
  const put = async (body) => {
    try {
      await ctx.shell.api("PUT", "/api/agents/rotation", body);
      await load();
    } catch (x) {
      fail(x);
    }
  };
  host.addEventListener("change", (e) => {
    const k = e.target.closest("[data-rot-key]")?.dataset.rotKey;
    if (
      ["rot-a-scope", "rot-a-key", "rot-a-never"].includes(e.target.id) ||
      e.target.closest?.(".rot-add")
    ) {
      showFor();
      return;
    }
    if (!k || k === "after_compactions" || e.target.tagName !== "SELECT")
      return;
    const v = e.target.value;
    void put({
      scope: "install",
      key: k,
      value: v === "" ? null : rotationValue(k, v),
    });
  });
  host.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-rot-save-after")) {
      const v = host.querySelector("#rot-after_compactions")?.value.trim();
      void put({
        scope: "install",
        key: "after_compactions",
        value: v ? rotationValue("after_compactions", v) : null,
      });
    } else if (b.hasAttribute("data-rot-clear"))
      void put({
        scope: b.dataset.scope,
        target: b.dataset.target,
        key: b.dataset.key,
        value: null,
      });
  });
  host.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-rot-add]");
    if (!f) return;
    e.preventDefault();
    const key = f.querySelector("#rot-a-key").value;
    const scope = f.querySelector("#rot-a-scope").value;
    const target = targetOf(scope);
    if (!target) {
      fail({
        message:
          scope === "persona-workspace"
            ? L("set.ui.rot.pickPW", "Pick a persona and a project.")
            : L(
                `set.ui.rot.pick.${scope}`,
                `Pick ${withArticle((ROT_SCOPES.find((x) => x[0] === scope) || [scope, scope])[1].toLowerCase())}.`,
              ),
      });
      return;
    }
    void put({ scope, target, key, value: valueOf(key) });
  });
  void load();
}

/** Register Den's categories and rows with the shell's SETTINGS registry. */
export function registerDenSettings(shell) {
  for (const c of DEN_SETTING_CATEGORIES) shell.registerSettingsCategory(c);
  for (const r of DEN_SETTINGS) shell.registerSetting(r);
}
