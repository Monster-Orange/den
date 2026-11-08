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
              `<div style="flex:1 1 220px;min-width:0"><p class="set-note" style="margin:0 0 8px">Scan it with the other device, or open the link there. It works once, within 60 seconds, and signs that browser in for good.</p>` +
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

/** Register Den's categories and rows with the shell's SETTINGS registry. */
export function registerDenSettings(shell) {
  for (const c of DEN_SETTING_CATEGORIES) shell.registerSettingsCategory(c);
  for (const r of DEN_SETTINGS) shell.registerSetting(r);
}
