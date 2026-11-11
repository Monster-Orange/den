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
      "How the graph is laid out, and how the Workspaces page shows its workspaces. The pages' own controls set these too.",
  },
  {
    id: "workspace",
    label: "Workspace",
    order: 50,
    description:
      "Settings for one workspace. They follow the Workspace you view in the top bar.",
  },
  {
    id: "agents",
    label: "Agents",
    order: 55,
    description:
      "The runtimes agents run on, installed first. Paths you set are this machine's only: everywhere (config/local/user.yml) or for one workspace (config/local/workspaces.yml), which wins.",
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

/** "3 min ago", "2 h ago", "5 d ago", or "just now"; `now` for tests. */
export function seenAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
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
      ? `signed in with GitHub${d.login ? ` (@${d.login})` : ""}`
      : d.via === "code"
        ? "approved with a code"
        : d.via === "claim"
          ? "claimed with a setup link"
          : "signed in with a one-time link";
  const name = d.name || "Unknown browser";
  const from = d.client || d.host;
  return {
    title: name,
    current: !!d.current,
    detail: [
      how,
      `created ${seenAgo(d.createdAt, now)}`,
      from ? `from ${from} (${name})` : "",
      `last seen ${seenAgo(d.lastSeenAt, now)}`,
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
        `<output class="set-ro" id="set-owner">Owner: <b>@${escHtml(o.owner.login)}</b> <span class="set-note">(${escHtml(o.owner.id)})</span></output> ` +
        '<button type="button" class="btn" id="set-owner-unlink">Unlink</button>';
      host.querySelector("#set-owner-unlink").addEventListener("click", () =>
        api("POST", "/api/web/owner/unlink", {})
          .then(load)
          .catch((e) => fail(e.message)),
      );
      return;
    }
    host.innerHTML =
      '<output class="set-ro" id="set-owner">This Den has no owner identity yet.</output> ' +
      (o.clientId
        ? '<button type="button" class="btn primary" id="set-owner-link">Link your GitHub account</button>'
        : '<span class="set-note" id="set-owner-noclient" style="flex-basis:100%">Linking needs a GitHub App client id, and none is configured: set <code>web.github_client_id</code> in config/local/user.yml, then restart the server.</span>') +
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
        fail(b.error || "Linking failed. Try again.");
      })
      .catch(() => fail("The server didn't answer. Try again."));
  function startLink() {
    const b = host.querySelector("#set-owner-link");
    if (b) b.disabled = true;
    api("POST", "/api/web/owner/link", {})
      .then((f) => {
        const box = host.querySelector("#set-owner-flow");
        const url = f.verificationUri || "https://github.com/login/device";
        box.innerHTML =
          `<p class="set-note" style="margin:8px 0">Enter this code at <a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(url.replace(/^https:\/\//, ""))}</a> and approve the app. It asks for no permissions.</p>` +
          `<span id="set-owner-code" style="${CODE_STYLE}">${escHtml(f.userCode)}</span> ` +
          `<a class="btn" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">Open GitHub</a>` +
          '<p class="set-note" style="margin:8px 0 0">Waiting for GitHub…</p>';
        timer = setTimeout(() => poll(f.id), 1500);
      })
      .catch((e) => fail(e.message));
  }
  function load() {
    fetch("/api/web/owner", { cache: "no-store" })
      .then((r) => r.json())
      .then(draw)
      .catch(() => {
        host.innerHTML =
          '<output class="set-ro">The owner can only be shown signed in.</output>';
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
          host.innerHTML =
            '<output class="set-ro" id="set-devices">No linked devices. A browser that signs in with GitHub, is approved with a code, or opens a one-time link appears here.</output>';
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
                  ? ' <b class="set-this-device" style="font-weight:600">· This device</b>'
                  : "") +
                `</div>` +
                `<div class="set-note" style="overflow-wrap:anywhere">${escHtml(l.detail)}</div></div>` +
                `<button type="button" class="btn" data-revoke="${escHtml(d.id)}">Revoke</button></div>`
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
        host.innerHTML =
          '<output class="set-ro">The devices can only be listed signed in.</output>';
      });
  load();
}

/** One waiting device's line: its code, browser and OS, address, age. */
export function waitingLine(w, now = Date.now()) {
  return {
    title: `${w.code} · ${w.device || "Unknown browser"}`,
    detail: [w.client, `asked ${seenAgo(w.createdAt, now)}`]
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
                  `<button type="button" class="btn primary" data-approve="${escHtml(w.code)}">Approve</button>` +
                  `<button type="button" class="btn" data-deny="${escHtml(w.code)}">Deny</button></div>`
                );
              })
              .join("") +
            '</div><div id="set-waiting-out" style="flex-basis:100%" aria-live="polite"></div>'
          : '<output class="set-ro" id="set-waiting">No computers are waiting. A signed-out page on another computer shows a code; it appears here to approve.</output>';
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
        host.innerHTML =
          '<output class="set-ro">Waiting devices can only be listed signed in, or on this machine.</output>';
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
        host.innerHTML =
          '<output class="set-ro" id="set-pair">No edge hostname routes to this server, so there is no address another device could open. Add one to the config\'s edge block (edge.aliases for a VPN name), then <code>__DEN_CLI__ edge up</code>.</output>';
        return;
      }
      host.innerHTML =
        '<select id="set-pair-host" aria-label="Edge hostname">' +
        hosts
          .map((h) => `<option value="${escHtml(h)}">${escHtml(h)}</option>`)
          .join("") +
        "</select> " +
        '<button type="button" class="btn primary" id="set-pair-go">Pair a device</button>' +
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
              `<div style="flex:1 1 220px;min-width:0"><p class="set-note" style="margin:0 0 8px">Scan it with the other device, or open the link there. It works once, until it expires (below), and signs that browser in for good.</p>` +
              `<a id="set-pair-link" href="${escHtml(p.url)}" style="font:12px var(--mono);overflow-wrap:anywhere">${escHtml(p.url)}</a>` +
              `<p class="set-note" id="set-pair-left" style="margin:8px 0 0"></p></div></div>`;
            const until = Date.parse(p.expiresAt);
            const left = out.querySelector("#set-pair-left");
            const tick = () => {
              const s = Math.max(0, Math.round((until - Date.now()) / 1000));
              left.textContent = s
                ? `Expires in ${s} s.`
                : "This link expired. Pair again for a new one.";
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
      host.innerHTML =
        '<output class="set-ro">Pairing works only signed in.</output>';
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

export const DEN_SETTINGS = [
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
      return org ? `${org.name} (not set: Den's own)` : "not set";
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
            e.terminal ? "terminal" : null,
            e.available ? null : "not found",
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
          tags: [t.available ? null : "not found"],
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
    "Workspace list",
    "The Workspaces page's workspace list, open or collapsed to a strip so the table gets the width.",
    ["workspaces", "list", "sidebar", "collapse", "strip", "local dev"],
    seg([
      { value: "open", label: "Open" },
      { value: "collapsed", label: "Collapsed" },
    ]),
  ),
  graphRow(
    "groupBy",
    "Group repos by",
    "The Workspaces page's repo table: one list, or grouped by application (as __DEN_CLI__ apps) or by org.",
    ["workspaces", "group", "application", "apps", "org", "table", "local dev"],
    seg([
      { value: "none", label: "None" },
      { value: "app", label: "Application" },
      { value: "org", label: "Org" },
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
    "The outer frames: by org or by application.",
    ["group", "frames", "org", "application", "cluster"],
    seg([
      { value: "org", label: "By org" },
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
    id: "workspace.editor",
    category: "workspace",
    label: "IDE for this workspace",
    description:
      "Opening this workspace, or a repo in it without a per-language override, uses this editor instead of your default.",
    keywords: ["workspace", "editor", "ide", "override"],
    scope: "workspace",
    control: { type: "workspace-editor" },
    read: (ctx) => ctx.wsSettings?.editor ?? "",
    write: (v, ctx) => ctx.saveWorkspace({ editor: v || null }),
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
      "When an agent's conversation has compacted this many times (or its pull request merged), Den starts it again from its handoff: a fresh conversation, the same name, persona, workspace and folder. Auto asks the agent for its handoff when it is idle, then relaunches it by itself; Ask shows buttons on the agent; Off does nothing. Overrides win over this install's value: agent, persona in a workspace, persona, workspace, service. __DEN_CLI__ agents rotate",
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
      "Connect this install to your company's Hub: sign in there and approve it. Every agent then gets Hub's tools: search Hub, publish docs and mocks there. Its team comes from this install's token, its project from the workspace's repos.",
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
      "Off hides Workspaces and the workspace APIs for you. __DEN_CLI__ config local_dev=false",
    keywords: ["local", "local dev", "environment", "disable"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) => (ctx.data.local_dev === false ? "Off" : "On"),
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
    read: (ctx) => (ctx.data.cli_tabs ? "On" : "Off"),
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
      `${Number(ctx.data.log_window_lines ?? 20000).toLocaleString()} lines`,
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
        : "Not set: the distribution's applies",
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
            ? '<output class="set-ro">Signed in</output> ' +
              '<button type="button" class="btn" id="set-signout">Sign out</button>'
            : '<output class="set-ro">Not signed in: run <code>__DEN_CLI__ web login</code></output>';
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
              ? `Saved in ${st.vault?.label || "the vault"}`
              : saved === "session"
                ? "Saved for this session"
                : "Not saved";
          host.innerHTML =
            '<output class="set-ro" id="set-sudo"></output>' +
            (saved
              ? ' <button type="button" class="btn" id="set-sudo-forget">Forget</button>'
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
    read: (ctx) => ctx.data.op_token_source ?? "not set",
  },

  ...ACCESS_ROWS,

  // ── Distribution (read-only) ───────────────────────────────────────────
  distRow(
    "brand",
    "Product name",
    "brand.name: the name on pages, the CLI banner and help.",
    ["brand", "name", "product", "title"],
    (d) => d.brand || "not set",
  ),
  distRow(
    "github_org",
    "GitHub org",
    "github_org: the org whose repos Den clones and lists.",
    ["github", "repos", "clone"],
    (d) => d.github_org || "not set",
  ),
  distRow(
    "orgs",
    "Org labels",
    "orgs: display names for the GitHub orgs repos belong to.",
    ["orgs", "labels", "names"],
    (d) => {
      const e = Object.entries(d.orgs || {});
      return e.length ? e.map(([id, l]) => `${id}: ${l}`).join(", ") : "none";
    },
  ),
  distRow(
    "web_port",
    "Web port",
    "web.port: the port the web UI listens on, unless yours overrides it.",
    ["port", "web", "server", "url"],
    (d) => (d.web_port != null ? String(d.web_port) : "not set (7777)"),
  ),
  distRow(
    "environments",
    "Environments",
    "environments: the envs the Env menu offers.",
    ["environments", "env", "local", "dev", "prod"],
    (d) => (d.environments ? d.environments.join(", ") : "not set: all"),
  ),
  distRow(
    "domain",
    "Edge domain",
    "edge.domain: services are served at https://<service>.<domain>.",
    ["edge", "domain", "https", "routes"],
    (d) => d.domain || "not set",
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

/** Where a runtime's path came from, as the row says it. */
export const RUNTIME_SOURCE = {
  workspace: "workspace",
  setting: "global",
  "login-shell": "detected · login shell",
  PATH: "detected · PATH",
  "well-known": "detected · install directory",
  "interactive-shell": "detected · interactive shell",
};

/** One runtime's row (r: GET /api/agents/runtimes' entry). */
export function runtimeRowHtml(r, scopeWs) {
  const id = escR(r.id);
  const name =
    `<b>${escR(r.label || r.id)}</b>` +
    (r.vendor ? ` <span class="rt-v">${escR(r.vendor)}</span>` : "") +
    (r.denTools === false
      ? ` <span class="set-tag" data-den-tools="coming">Den tools: coming</span>`
      : "");
  const set = r.source === "workspace" || r.source === "setting";
  const status = r.available
    ? `<span class="rt-ok">✓ ${escR(r.version ? r.version : "installed")}</span>`
    : `<span class="rt-bad">${escR(set ? r.why : "Not installed")}</span>`;
  const where = r.path
    ? `<span class="den-mono rt-p">${escR(r.path)}</span> <span class="set-tag" data-src="${escR(r.source || "")}">${escR(RUNTIME_SOURCE[r.source] || r.source || "")}</span>`
    : set
      ? `<span class="set-tag" data-src="${escR(r.source)}">${escR(RUNTIME_SOURCE[r.source])}</span>`
      : "";
  // A path set at the scope shown can be cleared from here.
  const mine = scopeWs ? r.source === "workspace" : r.source === "setting";
  return (
    `<div class="rt" data-runtime="${id}" data-available="${r.available ? "true" : "false"}">` +
    `<div class="rt-n">${name}</div>` +
    `<div class="rt-s">${status}</div>` +
    `<div class="rt-w">${where}</div>` +
    `<div class="rt-a"><button type="button" class="btn sm" data-set-path="${id}">Set path…</button>` +
    (mine
      ? ` <button type="button" class="btn sm" data-clear-path="${id}">Clear</button>`
      : "") +
    `</div>` +
    `<form class="rt-f" data-path-form="${id}" hidden>` +
    `<label class="rt-fl" for="rt-in-${id}">Path to ${escR(r.label || r.id)}${scopeWs ? ` for ${escR(scopeWs)}` : " (every workspace)"}</label>` +
    `<input type="text" id="rt-in-${id}" class="den-mono" spellcheck="false" autocomplete="off" placeholder="/absolute/path/to/${escR(r.id === "den-claude" ? "claude" : r.id)}" value="${escR(mine ? r.path || "" : "")}">` +
    `<button type="submit" class="btn sm primary">Save</button> <button type="button" class="btn sm" data-cancel-path>Cancel</button>` +
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
      `<div class="rt-scope"><label for="rt-ws">Paths for</label> <select id="rt-ws" data-focus-key="rt-ws">` +
      `<option value="">every workspace (user.yml)</option>` +
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
      return draw([], "Fix the config first: the runtimes are read from it.");
    return ctx.shell
      .api(
        "GET",
        `/api/agents/runtimes${ws ? `?workspace=${encodeURIComponent(ws)}` : ""}`,
      )
      .then((b) =>
        // Only what has a CLI to find: generic is the persona's argv.
        draw((b?.runtimes || []).filter((r) => r.setting)),
      )
      .catch((e) => draw([], e?.message || "The runtimes did not load."));
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
        err.textContent = x?.message || "Not saved";
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
  ["persona-workspace", "Persona in a workspace", "persona@workspace"],
  ["persona", "Persona", "persona id"],
  ["workspace", "Workspace", "workspace"],
  ["service", "Service", "service, as the workspace names it"],
];
const ROT_KEYS = [
  ["after_compactions", "After compactions", "a number, or never"],
  ["on_due", "When due", "auto, ask or off"],
  ["on_pr_merged", "When its PR merges", "true or false"],
];
const rotVal = (v) => (v === undefined ? "" : String(v));
/** A value as a person reads it (D30): "never", "Auto", "Relaunch". */
function rotValText(k, v) {
  if (k === "on_due")
    return { auto: "Auto", ask: "Ask", off: "Off" }[v] ?? rotVal(v);
  if (k === "on_pr_merged")
    return v === true ? "Relaunch" : v === false ? "Keep going" : rotVal(v);
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
      ? `org config: ${rotVal(b.org[k])}`
      : `default: ${rotVal(b.defaults?.[k])}`;
  const inst = b.install || {};
  const after = inst.after_compactions;
  const field = (k, control) =>
    `<div class="rot-f" data-rot-key="${k}"><label for="rot-${k}">${escR(ROT_KEYS.find((x) => x[0] === k)[1])}</label>${control}<span class="set-tag" data-rot-src>${escR(inst[k] !== undefined ? "this install" : inherited(k))}</span></div>`;
  const sel = (k, opts) =>
    `<select id="rot-${k}" data-focus-key="rot-${k}"><option value=""${inst[k] === undefined ? " selected" : ""}>inherit (${escR(rotVal(b.org?.[k] !== undefined ? b.org[k] : b.defaults?.[k]))})</option>` +
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
        const setting = (ROT_KEYS.find((x) => x[0] === k) || [k, k])[1];
        rows.push(
          `<tr data-rot-row${who.gone ? " data-rot-gone" : ""}><td data-l="Scope">${escR((ROT_SCOPES.find((x) => x[0] === scope) || [scope, scope])[1])}</td>` +
            `<td data-l="For"${who.gone ? ' class="rot-gone"' : ""}>${who.gone ? `<span class="den-mono">${escR(who.name)}</span> (gone)` : escR(who.name)}</td>` +
            `<td data-l="Setting">${escR(setting)}</td><td data-l="Value">${escR(rotValText(k, v))}</td>` +
            `<td class="rot-act"><button type="button" class="btn sm" data-rot-clear data-scope="${escR(scope)}" data-target="${escR(target)}" data-key="${escR(k)}" aria-label="${who.gone ? "Remove" : "Clear"} ${escR(setting)} for ${escR(who.name)}">${who.gone ? "Remove" : "Clear"}</button></td></tr>`,
        );
      }
  return (
    `<div class="rot" data-rotation-settings>` +
    `<div class="rot-inst">` +
    field(
      "after_compactions",
      `<input type="text" id="rot-after_compactions" data-focus-key="rot-after_compactions" inputmode="numeric" spellcheck="false" autocomplete="off" placeholder="${escR(inherited("after_compactions"))}" value="${escR(after === undefined ? "" : rotVal(after))}"> <button type="button" class="btn sm" data-rot-save-after>Save</button>`,
    ) +
    field(
      "on_due",
      sel("on_due", [
        ["auto", "Auto"],
        ["ask", "Ask"],
        ["off", "Off"],
      ]),
    ) +
    field(
      "on_pr_merged",
      sel("on_pr_merged", [
        ["true", "Relaunch"],
        ["false", "Keep going"],
      ]),
    ) +
    `</div>` +
    `<div class="tablewrap"><table class="svc rot-ov"><caption>Overrides (the most specific wins)</caption><thead><tr><th scope="col">Scope</th><th scope="col">For</th><th scope="col">Setting</th><th scope="col">Value</th><th scope="col" aria-label="Actions"></th></tr></thead><tbody>` +
    (rows.length
      ? rows.join("")
      : `<tr><td colspan="5" class="set-note">No overrides: every agent uses this install's values.</td></tr>`) +
    `</tbody></table></div>` +
    `<form class="rot-add" data-rot-add>` +
    `<span class="rot-pick"><label for="rot-a-scope">Scope</label> <select id="rot-a-scope">${ROT_SCOPES.map(([v, l]) => `<option value="${v}">${escR(l)}</option>`).join("")}</select></span>` +
    // The target: picked by name, never typed as an id (D30).
    `<span class="rot-pick" data-for="agent">${comboHtml({ id: "rot-a-agent", label: "Agent", placeholder: "Type to find an agent" })}</span>` +
    `<span class="rot-pick" data-for="persona persona-workspace" hidden>${comboHtml({ id: "rot-a-persona", label: "Persona", placeholder: "Type to find a persona" })}</span>` +
    `<span class="rot-pick" data-for="workspace persona-workspace" hidden>${comboHtml({ id: "rot-a-ws", label: "Workspace", placeholder: "Type to find a workspace" })}</span>` +
    `<span class="rot-pick" data-for="service" hidden>${comboHtml({ id: "rot-a-service", label: "Service", placeholder: "Type to find a service" })}</span>` +
    `<span class="rot-pick"><label for="rot-a-key">Setting</label> <select id="rot-a-key">${ROT_KEYS.map(([v, l]) => `<option value="${v}">${escR(l)}</option>`).join("")}</select></span>` +
    `<span class="rot-pick" data-val="after_compactions"><label for="rot-a-n">Value</label> <input type="number" id="rot-a-n" min="1" max="100" step="1" value="3"> <label class="rot-never"><input type="checkbox" id="rot-a-never"> never</label></span>` +
    `<span class="rot-pick" data-val="on_due" hidden><label for="rot-a-due">Value</label> <select id="rot-a-due"><option value="auto">Auto</option><option value="ask">Ask</option><option value="off">Off</option></select></span>` +
    `<span class="rot-pick" data-val="on_pr_merged" hidden><label for="rot-a-pr">Value</label> <select id="rot-a-pr"><option value="true">Relaunch</option><option value="false">Keep going</option></select></span>` +
    `<button type="submit" class="btn sm primary">Add override</button></form>` +
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
export function hubHtml(b, flash) {
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
      note(b.problem || "hub in user.yml is not valid", "data-hub-problem")
    );
  if (state === "no_token")
    return (
      flashHtml +
      `<form class="hub-connect" data-hub-connect>` +
      `<label for="hub-url">Hub's address</label> ` +
      `<input type="url" id="hub-url" class="den-mono" spellcheck="false" autocomplete="url" placeholder="https://hub.example.com" value="${escR(b.url || "")}">` +
      ` <button type="submit" class="btn sm primary" data-hub-action="connect">Connect</button>` +
      `</form>` +
      `<p class="set-note">Connect opens Hub. Sign in there and approve this install; you come back here connected. The token is kept in this install's secrets store, never shown.</p>` +
      (b.problem && b.url && !/^not connected yet/.test(b.problem)
        ? note(b.problem, "data-hub-problem")
        : "") +
      `<div class="rt-err" role="alert" hidden></div>`
    );
  const status = {
    connected: ["ok", "Connected"],
    rejected: ["warn", "Token not accepted"],
    forbidden: ["warn", "Not allowed"],
    unreachable: ["warn", "Can't reach Hub"],
  }[state] || ["warn", "Not connected"];
  const team = b.team
    ? b.teamUrl && /^https?:\/\//i.test(b.teamUrl)
      ? `<a href="${escR(b.teamUrl)}" target="_blank" rel="noopener noreferrer">${escR(b.team)}</a>`
      : escR(b.team)
    : "";
  const rows = [
    ["Hub", `<span class="den-mono">${escR(b.url || "")}</span>`],
    [
      "Status",
      `<span class="set-tag ${status[0]}" data-hub-state="${escR(state)}">${status[1]}</span>`,
    ],
    ...(team ? [["Company", team]] : []),
    ...(b.role ? [["Role", escR(b.role)]] : []),
    ...(b.login ? [["Signed in as", escR(b.login)]] : []),
    ...(b.label ? [["This install", escR(b.label)]] : []),
  ];
  const why =
    state === "rejected"
      ? "Hub no longer accepts this install's token (revoked or expired). Reconnect signs you in again."
      : state === "forbidden"
        ? "Your role on Hub no longer allows Den installs. Ask a Hub admin to change your role, then Reconnect."
        : state === "unreachable"
          ? b.problem || "Hub didn't answer."
          : "";
  const tools =
    `<label class="hub-tools"><input type="checkbox" id="hub-allow-tools"${b.allowTools !== false ? " checked" : ""}> Agents use Hub's tools without asking</label>` +
    `<p class="set-note" data-hub-tools-note>${
      b.allowTools !== false
        ? "Agents can publish and comment in Hub without asking; writes are versioned and stay in this install's team."
        : "Agents ask before each Hub tool runs."
    }</p>`;
  return (
    flashHtml +
    `<dl class="hub-st" data-hub>` +
    rows.map(([k, v]) => `<dt>${escR(k)}</dt><dd>${v}</dd>`).join("") +
    `</dl>` +
    (why ? note(why, "data-hub-problem") : "") +
    `<div class="hub-acts">` +
    (state === "rejected"
      ? `<button type="button" class="btn sm primary" data-hub-action="connect">Reconnect</button> `
      : "") +
    `<button type="button" class="btn sm" data-hub-action="disconnect">Disconnect</button>` +
    `</div>` +
    // Disconnect asks first, saying what it does (Hub revokes the key).
    `<div class="hub-confirm" data-hub-confirm hidden>` +
    `<p class="set-note set-warn">This revokes this Den's Hub key on Hub. Agents lose Hub until you Connect again.</p>` +
    `<button type="button" class="btn sm primary" data-hub-action="disconnect-yes">Disconnect</button> ` +
    `<button type="button" class="btn sm" data-hub-action="disconnect-no">Cancel</button>` +
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
      host.innerHTML = hubHtml(b, f);
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
      e.textContent = x?.message || "Not saved";
      e.hidden = false;
    }
  };
  const load = () => {
    if (ctx.shell?.configInvalid?.() === true) {
      host.innerHTML = `<div class="set-note">Fix the config first: the org's rotation is read from it.</div>`;
      return Promise.resolve();
    }
    return ctx.shell
      .api("GET", "/api/agents/rotation?choices=1")
      .then((b) => {
        host.innerHTML = rotationHtml(b || {});
        wireAdd(b?.choices || {});
      })
      .catch((x) => {
        host.innerHTML = `<div class="set-note">${escR(x?.message || "The rotation settings did not load.")}</div>`;
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
            ? "Pick a persona and a workspace."
            : `Pick ${withArticle((ROT_SCOPES.find((x) => x[0] === scope) || [scope, scope])[1].toLowerCase())}.`,
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
