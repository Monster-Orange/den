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
      "Signing in is needed only when this server is reached from another machine (through the edge, or a LAN address); on localhost, and through the edge from this machine, nothing asks for it. __DEN_CLI__ web login prints a sign-in link; __DEN_CLI__ web sessions lists signed-in browsers.",
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

/** Register Den's categories and rows with the shell's SETTINGS registry. */
export function registerDenSettings(shell) {
  for (const c of DEN_SETTING_CATEGORIES) shell.registerSettingsCategory(c);
  for (const r of DEN_SETTINGS) shell.registerSetting(r);
}
