# Changelog

All notable changes to Den are documented here. Each release lists the
config and manifest changes a distribution must make to move to it under
**Migrations**.

## [0.3.0] - unreleased

### Added

- **The "What's new" pop-up shows the newest release only** (0.3.0-dev.16).
  A "Show all versions (N earlier)" button in its footer lists every
  earlier version in the same pop-up, and "Show latest only" collapses it
  again. It always opens collapsed, at the top.
- **Themes (`den.theme/v1`).** The contract is `schemas/den.theme.v1.json`:
  color tokens for dark and light, type, shape, a mark and self-hosted fonts.
  `<cli> theme add <repo>[/<subpath>]@<tag|commit>` validates a theme and
  vendors it into the distribution (`plugins/<id>/`, `plugins.lock.json`, shared with future plugin kinds). `theme add` never replaces a plugin dir it did not vendor (a local, unlocked plugin) or another kind's lock entry; `theme list` fails on a leftover 0.3.0-dev.0 `themes.lock.json`, naming it; `theme add` refuses a `file://` source (0.3.0-dev.7, below). A theme's and a font's `license` follow one rule: an SPDX expression, never UNLICENSED/NONE. `theme list` reports a theme that fails this Den's rules as "no longer valid" with the reasons, apart from "changed since it was added"; validate explains the license and CSS-value rules instead of printing "must NOT be valid". Local themes (the distribution's own, in `plugins/<id>/` with no lock entry) are listed as `local` and validated; `theme validate` with no argument checks every installed theme; `theme new <id>` starts a local theme from the built-in one;
  `theme list` checks themes against the lock; `theme validate` and `theme
  remove`. Contrast is checked per pair in both modes. A branch ref needs
  `--track`. Den bundles its own theme, `den` 2.0.0. The public set and the
  authoring guide: https://github.com/Monster-Orange/den-themes. See "Themes"
  in `docs/distributions.md`.
- **The web UI is themed (0.3.0-dev.5).** Every page draws its colors from
  the active theme, in dark or light: the engineer's choice (user.yml
  `appearance: { theme, mode }`, from the header's new Mode and Theme menus),
  else the org config's `brand.theme`, else `den`; an unknown or invalid id falls
  back with one server-log warning. The server serves `/theme.css`,
  `/theme/<id>/<file>` (only the files the manifest names) and `/api/themes`.
  Switching writes user.yml only (no edge, services or restart). No page,
  stylesheet or UI script hard-codes a color any more (a test holds that).
  The header's version pill shows the running build, prerelease suffix
  included (`v0.3.0-dev.5`, not the changelog's `v0.3.0`).
- **Plugins (`den.plugin/v1`, PL-1a and PL-2a, 0.3.0-dev.7).** The contract
  is `schemas/den.plugin.v1.json`: `id`, `name`, `version`, `license` (the
  theme schema's SPDX rule, by `$ref`), `den` (a version range, required),
  `maintainer`, `readme`, `provides` (one entry per extension point: `theme`
  with its `manifest`, `page` with its `entry` and `nav`, and the other kinds
  by name) and `capabilities` (a closed vocabulary: `ui.nav`, `api.read`,
  `api.actions:`, `secrets:`, `net:`, `exec:`, `send:`). A directory holding
  only a `den-theme.json` is an implicit theme plugin, so every theme keeps
  working. Every `plugins/<id>/` is a plugin: **local** when it has no lock
  entry (the distribution's own, any kind; being present is its approval),
  **added** when `plugin add` vendored it. A `plugins/<id>/` with neither
  manifest is an error in `plugin list` and `plugin validate`, never
  skipped, as are the id `den` and a directory name that is not an id.
  - `<cli> plugin list`: every plugin with its version, kinds and `local`
    or its source and ref; added ones are checked against the lock's hash
    (as `theme list` does).
  - `<cli> plugin validate [dir]`: every local and added plugin, or one dir
    (a plugin, a distribution, or a repo of `themes/<id>/` and
    `plugins/<id>/`). Admission rules: a `maintainer` (1); a browser- or
    server-tier plugin's README names its tier and says what it must never
    do (2; themes are exempt); an SPDX license and licensed fonts (3). A
    local plugin that declares `api.actions`, `secrets`, `exec`, `net` or
    `send` and has files git has not committed gets a warning (never an
    error): committing it is its review.
  - `<cli> plugin add <repo>[/<subpath>]@<tag|commit> [--track] [--yes]`,
    `plugin update <id> @<ref>` and `plugin remove <id>`. The lock entry's
    `kinds` and `approved_capabilities` come from the manifest; a plugin that
    asks for capabilities needs `--yes`, and `update` asks again only when the
    set grows. `remove` and `update` are for added plugins: a local one is
    edited or deleted in git. A den-plugin.json plugin is vendored whole
    (every file but dot-files); a theme still vendors only its named files,
    so existing lock hashes still match.
  - `add` and `update` refuse a `file://` source: "for your own plugin, put
    it in plugins/<id>/ as a local plugin; to try a published one before
    tagging, push a branch and use --track". This replaces 0.3.0-dev.2's
    warning.
  - `plugins.allow` in `den.yml` lists the `<host>/<owner>` pairs (or bare
    hosts) `add` may fetch from. Absent: any host. A malformed value is an
    error.
  - `theme add | list | validate | remove` are `plugin` filtered to kind
    theme, with the same output and exit codes; `theme new` is unchanged.
    The web UI also finds a theme a `den-plugin.json` provides.
  See "Plugins" in `docs/distributions.md`.
- **PL-SPEC draft-4 rulings (0.3.0-dev.8).**
  - Rule 1 covers themes: a bare `den-theme.json`'s `author` is its
    maintainer, and a theme plugin without one fails `plugin validate`.
    `theme new` sets the author to the brand's name.
  - The `den` range is checked (semver, prereleases included).
    `plugin validate` and `theme validate` fail a plugin whose range
    excludes the running Den, naming the range and the version. At load,
    the web UI skips such a theme, whether the range is in its
    `den-theme.json` or in the `den-plugin.json` that provides it, with one
    server-log notice, and draws with the next choice (yours, then
    `brand.theme`, then `den`). It never crashes. Den now depends on
    `semver` (pinned).
  - `plugin list` and `theme list` warn, never fail, about a lock entry
    with a `file://` source (from 0.3.0-dev.2), and say how to fix it.
- **`plugin validate <id>` and `theme validate <id>` mean `plugins/<id>/`**
  (0.3.0-dev.8). An id that names a dir in `plugins/` or a lock entry is
  never read as a cwd-relative path. A bare name that isn't an id (such as
  `x`) means `plugins/x/` when no such path exists. Anything else is a path,
  as before. `theme validate den` checks the built-in theme. `theme
  validate <id>` of a plugin that isn't a theme gives one ✗.
- **The theme reaches the type, the mark and links.** Every page draws text
  in `var(--sans)` / `var(--mono)` / `var(--display)` (no page names a font
  any more; a test holds that, like the color rule), so a theme's fonts
  apply; `/theme.css` ends a theme's stack with Den's when it has no generic
  family. The header shows the active theme's mark (SVG, `svg_dark` in dark
  mode, or text in its `shape`) and redraws it on a live switch; favicon.ico
  stays the favicon. Links in body content are underlined (subtly, in a tint
  of their own color), so a red accent never makes a link read as an error.
- **Back to the org default.** The Theme menu starts with "Org default
  (<name>)", which stores `appearance.theme: null`, so you keep following
  `brand.theme`. Picking a theme by name stores its id, even the theme that
  is the org default today (0.3.0-dev.11; dev.8 stored null for it): that
  is a pin, selected as itself and labelled "<name> (pinned)".
  `/api/themes` gives `org_default`. The popover's controls are named
  (Mode, Theme; the button is "Appearance" with `aria-expanded` and
  `aria-controls`); Escape closes it and returns focus to the button.

- **What fails `validate` never loads (0.3.0-dev.9).** The theme runtime's
  verdict is now `plugin validate`'s for the whole plugin. That covers a bare
  `den-theme.json`'s `author`, a `den-plugin.json`'s `maintainer`, README,
  capabilities and `den` range, and the theme contract. A theme that fails
  is left out of the Theme menu (even when it is your stored choice: you then
  follow the org default) and is skipped at load with one server-log notice.
  The fallback is the same as for the range: yours, then `brand.theme`, then
  `den`. `/api/themes` still lists it, with `ok: false` and the problem.
- **A prerelease Den explains a range without `-0` (0.3.0-dev.9).** When
  the running Den is a prerelease and only that keeps the range from
  matching, the refusal adds "prerelease builds need a -0 range, e.g.
  >=0.3.0-0", built from the range's own lower bound.
- **The left rail: grouped, pinnable, collapsible** (0.3.0-dev.17, R11,
  R11a, R12, R13, R14). Pages sit under Develop (Local Dev, Services, Logs),
  Verify (Tests) and Ship (Environments, Releases), with Settings at the
  foot. Groups and items come from one registry in `shell.js`;
  a distribution adds its own with `denShell.registerGroup({id, label,
  order, tag})` and `denShell.registerNav({group, id, label, href, icon,
  order, badge})`, and its labels with `denShell.addMessages(lang, {...})`.
  - **Pinned**: ☆ on a Services card or in the graph's details pins a repo
    or service to the top of the rail with its health dot ("Pinned shop");
    × or Delete on the pinned row unpins it.
  - **Badges**: Services shows how many services are down, live from the
    health row; Logs how many log streams are open.
  - **Collapse** (« at the foot) narrows the rail to its icons, 216 to 56px;
    the headings and labels stay for screen readers. Under 720px the rail is
    a drawer behind ☰.
  - Pins and collapse are stored in user.yml `shell` (`GET`/`POST
    /api/settings` `shell: {pins, collapsed}`); setting them changes nothing
    else (the theme-switch isolation test covers it).
- **The shell matches the prototype's sizes** (0.3.0-dev.17, R1, R2, R3,
  R9, R10): one 48px top bar with the brand, the workspace pill and Env as
  key + value buttons, the health row as a chip, "What's new" and the ◐ ▾
  menu (now with "All settings"); the rail's type, spacing and current-page
  bar. `scripts/shell-fidelity.mjs` measures the real pages against the
  prototype at 1440 and 1024 (1px, 0.5px for type) and lists any allowed
  difference with its reason.

- **The scope breadcrumb is three menus** (0.3.0-dev.18, R4): `/ ORG
  <org> ▾ / WORKSPACE <ws> ▾ / ENV <env> ▾`, each the prototype's `.ib`
  button with a `.pop` menu (✓ on the current entry). The menus are ARIA
  menus: ↓ or Enter opens one, ↑/↓, Home and End move, Enter picks,
  Escape (or Tab) closes it and gives focus back to its button, and a
  click outside closes it. They replace the workspace pill and its menu,
  the env select, the interim View select and Services' own workspace
  select. Below 860px the keys, separators and the org hide; below 720px
  the scope does (the narrow layout, R11b, comes later).
  - **Org:** one org is a static label with no ▾, as before (ORG-SPEC
    C4). `denShell.setOrgs([{ id, title, workspaces? }], current,
    onSelect?)` turns two or more into an Org ▾ menu; a pick calls
    `onSelect(id)` and fires `den:org` on window. Nothing feeds it a list
    yet: ORG-1b plugs `/api/orgs` in.
  - **Workspace:** the view scope. "All active (N)" (with two or more
    active) and each active workspace, the focused one tagged `focus`.
    Picking one stores the view (user.yml `view`, `POST /api/scope`) and
    reloads the page; it never moves the focus. A separate "Set <ws> as
    focus" item (when the workspace in view isn't the focus) does Local
    Dev's focus action, and "Manage workspaces…" opens Local Dev.
  - **Env:** the same envs, value and browser storage as the select it
    replaces; `#env-sel` stays (hidden) as the value pages read and the
    `change` event they listen for.
- **A view scope: all active workspaces, or one** (0.3.0-dev.18). The
  health row covered every active workspace while Services, Tests, Logs
  and `status` showed only the focused one, so the row above a page listed
  repos the page didn't. One source now says which repos are in view
  (`src/shared/environment-manager/scope.ts`), and the health row,
  `/api/services` (every page's list) and `<cli> status` all read it.
  - "All active" is the default: it is what the health row already showed,
    and with one active workspace it is the same view. A scope that is no
    longer active falls back to all, never to an empty page.
  - **The view is not the focus.** The focus stays the default target for
    commands; the view only filters what pages show. Switching it writes
    user.yml `view` and nothing else: no edge route, container, daemon or
    workspaces.yml change, and the server doesn't restart (the
    theme-switch isolation test covers it). `GET`/`POST /api/scope`.
  - **A shared service is listed once, with its owners**: a repo that two
    workspaces in view define shows one card (`shop · ws-a, ws-b`) and one
    health dot, its deps and auto-start from the first (focus first).
    `/api/services` rows carry `inWorkspaces`, `/api/health` rows carry
    `workspaces`.
  - **`<cli> status`** shows the same view and says so ("Scope: all active
    (a, b, c) · focus: a"). Use `--scope <workspace>` for one (`--all`
    already means `--verbose` there); `-w <workspace>` still checks that
    one workspace.
  - Local Dev edits one workspace at a time: it opens on the view's
    workspace when that is one, else the focus.
- **A ready path for distribution scripts** (0.3.0-dev.18). A script that
  loads before shell.js pushes functions onto `window.denShellQueue` (an
  array); each runs with `denShell` once the shell exists, and a later push
  runs at once. `den-shell:ready` fires on window when the shell is up.
- **`den:pins`** (0.3.0-dev.18): any pin change fires it on window
  (`detail.pins`), and every pin toggle on the page repaints from it.
- **`org.title_source`** in `/api/<cli>/config` (0.3.0-dev.18; added beside
  the existing fields, ORG-SPEC C3): `org.title`, `orgs`, or `id`.
- **A Settings page** (0.3.0-dev.19, R21): `/settings`, in the shell,
  with the prototype's page header, sections, rows, segmented buttons,
  swatches and navigation list, applied to every setting Den has.
  - **Categories** on the left (a nav; the current one `aria-current`),
    their rows on the right: Appearance, Editor & terminal, Navigation,
    Graph, Workspace, Command line, Distribution, then any a distribution
    or plugin registers (tagged with its `from`).
  - **Search** (`/` focuses it) filters rows by label, description and
    keywords; a match stays under its category's heading, empty
    categories hide, "No settings match" shows when nothing does, and the
    count is announced. The URL keeps `#<category>` and `?q=`, so a
    setting can be linked to; reload and back/forward work.
  - **Every row shows its scope**: User (config/local/user.yml),
    Workspace (that workspace in config/local/workspaces.yml) or
    Distribution (read-only). The Workspace rows follow the Workspace you
    view; with All active, the section asks which workspace.
  - **Writes go only to per-user, gitignored state**, as before:
    `POST /api/settings` (user.yml) and `POST /api/workspaces/settings`
    (workspaces.yml), with the same keys. Nothing writes except an
    explicit change: a control writes on its change (the per-workspace
    editor on Save, as before) and says "✓ Saved". Loading, searching,
    moving between categories and changing the hash or query write
    nothing. The page never writes the distribution's config.
  - **Distribution rows are read-only**: the product name, GitHub org, org
    labels, web port, environments, edge domain and the org default theme,
    each with "Set by the distribution in config/<file>.yml". Your own
    override of the same thing (your theme) is a separate User row.
    `GET /api/settings` gains `distribution` (read from the org config
    only), `user_web_port`, `local_dev` and `cli_tabs` (read-only).
  - **Today's settings moved in, unchanged in storage**: Default IDE,
    Per-language IDE and Default terminal (Local Dev's ⚙ panel); mode and
    theme (◐ ▾ stays as a shortcut, and both drive the same prefs and
    repaint each other); the graph prefs; the per-workspace editor (Local
    Dev's workspace Settings tab). `log_window_lines`, `local_dev`,
    `cli_tabs` and your `web.port` show read-only with the command that
    sets them.
  - **Navigation** (new): hide or show each rail page and move it within
    its group; reorder and unpin pins; collapse the rail. Stored in
    user.yml `shell` as `hidden` and `order` (page ids), beside `pins` and
    `collapsed`. A view preference only: no edge route, container, daemon,
    pid or restart changes (the theme-switch isolation test covers it).
  - **The old entry points land on the matching category**: Local Dev's
    ⚙ (`#editor`), its workspace Settings tab (`#workspace`, that
    workspace), `/local-dev?settings=1` (redirected to `#editor`), the
    rail's Settings item and "All settings" in ◐ ▾ (`#appearance`). The
    old panel is gone. Arriving at a category (a link, the hash,
    back/forward) marks it current and puts focus on its heading.
- **The SETTINGS registry** (0.3.0-dev.19, R21), beside NAV and GROUPS on
  `window.denShell` (and through `window.denShellQueue`):
  `registerSettingsCategory({ id, label, order, description?, from? })`
  and `registerSetting({ id, category, label, description, keywords,
  scope: user|workspace|distribution, control, read(ctx), write?(value,
  ctx), keys? })`; `settings()`, `settingsCategories()`; `den:settings`
  fires on any change. A distribution row with a `write` is refused.
  Controls: `seg`, `radio`, `select`, `number`, `toggle`, `text`,
  `readonly` and `custom` (`render(el, ctx, { value, save })`). Den's own
  rows are in `public/settings-registry.js`; a test fails if a key
  `POST /api/settings` accepts has no row.
- **`denShell.setNavPrefs({ hidden?, order? })`, `setPins(ids)`,
  `setCollapsed(bool)` and `orderedNav()`** (0.3.0-dev.19): the rail's
  Navigation prefs, saved to `/api/settings` `shell`.
- **The top bar's search, status, runs and lock** (0.3.0-dev.20, R5, R6,
  R7, R8, R10, R15, R17, R18). It ships together with the Settings page
  (dev.19, never released on its own): the palette finds every setting,
  and the user menu's "All settings" opens it. The bar now reads ☰, brand, scope, search,
  then the Status, Runs and lock chips, "What's new" and the ◐ ▾ menu, at
  the prototype's sizes (`scripts/shell-fidelity.mjs` measures it). The
  search field gives way first, so the scope's parts never run into each
  other; below 960px the scope's keys hide (860px in the prototype, whose
  chips are narrower), below 860px the chips keep only their dots and
  icons, and below 720px the scope hides and the search field is an icon.
  - **Search and the ⌘K palette.** "Search pages, services, actions…"
    (⌘K or Ctrl+K anywhere, or a click) opens a palette: pages, apps,
    services with their health dot, Restart and Logs for each service,
    Appearance (System, Dark, Light) and every installed theme. It ranks a
    label's prefix, then a word in it, then anywhere, then keywords and
    the kind, then the letters in order; every word must match. ↑/↓ move,
    Enter runs, Escape closes and gives focus back. It is a modal dialog
    with a combobox and a listbox (`aria-activedescendant`).
  - **`denShell.registerCommand({id, label, keywords, kind, run})`**
    (also from `window.denShellQueue`) adds a palette row; `kind` is
    `page`, `app`, `service`, `action` or `setting`. Every row of the
    SETTINGS registry (Den's, a distribution's or a plugin's) is a
    `setting` row on every page: "terminal" finds Default terminal, and
    Enter opens `/settings?q=<label>#<category>`.
    `unregisterCommand(id)` and `commands()` too. `denShell.openMenu(btn,
    items)` opens a `.pop` menu any script can use.
  - **The status chip** replaces the health dot row and its "+N" chip:
    "All N healthy", or "ok/N healthy · k down" with a bad border, from the
    same rollup as the rail's Services badge. It shows "Checking…" until
    the first cycle is in and paints once: no partial red on a cold load.
    A pending check is pending, never down.
  - **The status drawer** (the chip opens it): a right-hand modal panel,
    focus on ✕, Escape back to the chip. "Needs attention" has one card
    per down service, with what was checked, the error and when, and
    Start, Logs and Pin; "Everything" lists each application ok/N, each
    service with its time in ms. What the row's tooltips said is in each
    row's title.
  - **The Runs chip** counts the runs this page started (service and
    workspace commands, syncs, test runs, deploys; not log tails), with a
    pulse while one runs. Until the output dock (dev.21) it shows the
    page's own output pane (marked `data-den-output`), else links to the
    page of the last run.
  - **The lock chip** (🔒 Locked / 🔓 Unlocked) holds the admin-password
    form that was Local Dev's sudo banner, with Save to 1Password, in a
    popover: "Den asks once per session. Agents can't unlock." It is the
    one unlock on every page; the banner is gone. Local Dev still asks
    1Password for a stored password on load; other pages ask only when
    the popover opens. Start and Restart from the drawer or the palette
    follow the same lock rule, then run on Local Dev (which runs them on
    arrival when you are on another page).
  - **The user menu** (◐ ▾) is the prototype's `.pop`: Appearance, Theme
    and "All settings" (`/settings#appearance`), and a hidden slot for
    Language. Its ◐ ▾ glyphs are hidden from screen readers; its name is
    "Appearance". Opening any of these overlays writes
    nothing; switching appearance or theme from the menu or the palette
    writes user.yml `appearance` only (the theme-switch isolation test
    covers it).
  - `header.js` exports `requireUnlock`, `isUnlocked`, `onLockChange`,
    `setServiceRunner` and `takePendingAction` for pages.
  - **One h1 per page**: the brand title in the bar is a span now, not an
    h1, so a page's own heading is its one. A page with none (Services,
    Logs, …) gets a visually hidden h1 named from its title.
- **Raster theme marks** (0.3.0-dev.22): a mark can be a PNG or a WebP
  (`png` / `png_dark`, `webp` / `webp_dark`), for a mark that exists only
  as a raster. One image kind per mark (svg, png or webp): two fail
  validate, naming both. `theme validate` and `theme add` check each file's
  first bytes against its extension, a 64 KB cap and at least 44×44 px
  (twice the bar's 22px mark), reading the PNG or WebP header itself.
  `/theme/<id>/<file>` serves them as `image/png` and `image/webp`, still
  only the files the manifest names. The top bar draws one as an image at
  22px, clipped to the mark's `shape`, the dark file in dark mode. SVG and
  text marks are unchanged.
- **The browser tab shows the theme's icon** (0.3.0-dev.22): the theme's
  new optional `favicon` (`.png`, `.svg` or `.ico`, magic-byte checked, at
  most 64 KB), else its mark's file (the dark variant in dark mode), else
  Den's own icon. The shell sets it on every page (no page links
  `/favicon.ico` any more) and changes it with the theme and the mode,
  System following the OS included. Its URL,
  `/theme-favicon/<id>?mode=<mode>&v=<version>-<hash>`, changes with each,
  so a switch is never answered from cache. The built-in `den` theme names
  Den's icon as its `favicon`; `theme new` leaves it out, so a new theme's
  tab shows its own mark.

### Fixed

- **Settings keeps your pick marked while it scrolls** (0.3.0-dev.22, SA's
  dev.21 run): a click or Enter on a category no longer walks
  `aria-current` through every category the smooth scroll passes. Your
  pick holds until the scroll ends (`scrollend`, else once it is still,
  within about a second); then the scroll-spy takes over again.
- **Below 480px the top bar shows only the mark** (0.3.0-dev.22, SA's
  dev.21 run): the product name is visually hidden there and stays the
  brand link's accessible name; from 480px it truncates as in dev.21.
- **0.2.6 is in the 0.3 line** (0.3.0-dev.21): `type: container` health
  checks, the server identity check behind `web restart` and `web down`,
  the MCP server's identity, and `service install --plan`. See 0.2.6 below.
- **Settings marks the category you picked** (0.3.0-dev.21, SA's dev.20
  run): `/settings#distribution`, or a click on the last short section,
  marked the one before it as current, because the page could not scroll
  far enough for the section to reach the top. At the end of the page,
  your pick wins if it is in view.
- **"IDE for this workspace" saves on change** (0.3.0-dev.21), like every
  other row; its Save button is gone.
- **The top bar fits at 400px** (0.3.0-dev.21): a long product name
  truncates and the stale-server pill shows only its ⚠ (named "Stale
  server: restart"), so the page no longer scrolls sideways.
- **Status drawer rows are named by service, state and latency**
  (0.3.0-dev.21), e.g. "shop/db, healthy, 9 ms". What the check ran is
  the row's description and tooltip, not its name.
- **The rail's Settings item opens Settings** (0.3.0-dev.19): in dev.18 it
  went to `/local-dev?settings=1`, which nothing read, so it landed on
  Local Dev. It now goes to `/settings`, and the old URL redirects there.
  Plain `/settings` opens at the top, on the title and the search box; a
  link that names a category (`/settings#editor`) scrolls to it and puts
  focus on its heading.
- **The rail's × keeps focus in the rail** (0.3.0-dev.19, SA's dev.18
  run), as Delete does: the next pinned row, else the previous one, else
  the first item (Enter on "Unpin <id>" dropped focus to the top of the
  document). One function for both.
- **The narrow rail is a modal drawer** (0.3.0-dev.19, SA's dev.18 run).
  Below 720px, ☰ moves focus into the rail (the current page), makes the
  top bar and the page `inert` behind a scrim, and keeps Tab inside;
  Escape or a click on the scrim closes it, sets `aria-expanded` back and
  returns focus to ☰ (Escape did nothing before).
- **Names screen readers read** (0.3.0-dev.19, SA's dev.18 run): a rail
  group is named by its label alone (`aria-labelledby` points at the label,
  not the heading with its tag; Chrome read "XGlobex"); a tagged menu
  row reads "default, focus", not "defaultfocus"; the ✓ on a checked menu
  row is drawn with no alt text (`aria-checked` says it); ◐ ▾'s glyphs are
  hidden from readers. A scope button's `aria-controls` names its menu
  only while the menu is open.
- **A page registered before its group no longer warns** (0.3.0-dev.19,
  a consumer's dev.18 run). Queuing a page before its group is a legitimate
  order; the warning now waits until the queue has drained and a tick has
  passed after `den-shell:ready`, and fires only for a group that is still
  missing (the same for a setting and its category).
- **Opening a run's output no longer hides the lowest graph cards**
  (0.3.0-dev.19, a consumer's dev.18 run). Automatic fits (first draw, layout
  changes, and the re-fit as the output panel opens) now show the whole
  graph whenever it fits at 35% zoom, the Fit button's limit; only a graph
  too big for that starts at its top at 60%. The panel already had its
  own room below the graph: stopping the fit at 60% cut the lowest cards
  off at the graph's bottom edge, where the panel begins, so a click
  landed on the panel.
- **The ORG label is the org's name, not its id** (0.3.0-dev.18). With no
  `org.title` in the org config, the label was the id (`edge.org`). It is
  now `org.title`, then the `orgs:` label of `github_org` (the name the
  Environments page shows), then the id.
- **A pin toggle follows the rail** (0.3.0-dev.18). Unpinning from the rail
  (× or Delete) left the Services card's ☆ and the graph panel's reading
  "Unpin X" (`aria-pressed=true`) until a reload.
- **Delete on a pinned row keeps focus in the rail** (0.3.0-dev.18): on the
  next pinned row, else the previous one, else the first item (it fell to
  the top of the document).
- **A pinned row is named by its id** (0.3.0-dev.18), not "shop-web×":
  the × is its own control, out of the tab order, named "Unpin
  shop-web", its glyph hidden from screen readers; the row has
  `aria-keyshortcuts="Delete"`.
- **One main landmark per page** (0.3.0-dev.18). Every page's content is in
  `<main id="den-content">` (the skip link's target); the four pages that
  had a `<main>` of their own around part of it, and the two that had
  none, now have exactly one.
- **A distribution group is named once** (0.3.0-dev.18): its tag is hidden
  from screen readers and read as the group's description ("from globex"),
  not "Globex globex".
- **Registration mistakes warn** (0.3.0-dev.18): a non-number `order`, or
  a `registerNav` into a group not registered yet, logs a `console.warn`
  naming the field. The page waits for its group instead of being lost.
- **Local Dev's output panel no longer covers graph cards** (0.3.0-dev.18).
  When the panel opened (a run's tab), the graph's viewport shrank but the
  graph kept its fit, so the lower cards sat under the panel and couldn't
  be clicked. A viewport that changes size re-fits the graph unless you
  have panned or zoomed it yourself.

- **An app is never painted down before its checks have answered**
  (0.3.0-dev.17). One cold load in twenty painted an app red for ~100ms:
  only its one down service had answered, and as the only row it read as
  the entry service. A poll that overlapped the first one started from
  nothing and drew what had landed. Until every check of a repo has
  answered (a pending check has), the repo is unknown (neutral, "still
  checking"); a repo the last complete cycle described keeps its earlier
  answers meanwhile. The rail's Services badge and pinned dots read the same
  rollup, so they count only completed downs.
- **Shell accessibility** (0.3.0-dev.17): a "Skip to content" link comes
  first on every page; the rail is one tab stop (the current page) with
  ↑/↓, Home and End moving within it; the Logs link's name is "Logs" or
  "Logs, 2 open", not "Logs0"; the Tests page's title is "<title> · Tests".
- **"What's new" is a modal dialog, and reopens at the top** (0.3.0-dev.17).
  A reopen after scrolling kept the old position: the scroll was reset
  while the overlay was still hidden, where it doesn't stick; it is reset
  once the dialog shows. The box is `role="dialog"` with `aria-modal` and
  its heading as the label; it takes focus (the versions toggle, else Got
  it), keeps Tab inside, and gives focus back on close (to the version pill
  after a first-visit open). A browser test covers Escape, × and Got it,
  collapsed and expanded; CI installs Playwright's chromium for it.
- **One bar on Logs** (0.3.0-dev.17). The cols/rows toggle moved into the
  Logs toolbar from a band of its own.
- **One workspace control on Services** (0.3.0-dev.18). Services' own
  workspace select (beside the top bar's) is gone: the top bar's Workspace
  ▾ says what the page lists; its status moved to the Output bar.
- The appearance control (◐) sits at the header's far right on every page
  and never leaves the screen: the nav shrinks and scrolls and the health
  dots give way first (the Tests page's top bar overflowed at 1440 and 1024).
- Org colors from the config are no longer text: the graph's org frames and
  the panel's breadcrumb label in `--text` with the color as a dot (they read
  at 2.5:1 on a light ground), and the frame's ground is neutral. A test
  bans a config color as `color:`.
- The active workspace row in the Local Dev sidebar is a calm neutral tint
  in both modes (it was a loud accent tint in light mode).
- `plugin list` with broken dirs in `plugins/` (0.3.0-dev.8, reported by
  consumers on dev.7) prints exactly one row for every directory there, every
  time. Before, it crashed with no rows when `plugins.lock.json` couldn't be
  parsed, skipped a symlink, and hid a dir whose lock entry named another
  id. `plugin validate` reports each of these too. Nothing in a plugin dir
  makes either command throw.
- A dir name that isn't an id (such as `plugins/x/`) now gives the real
  rule: "2–40 characters: lowercase letters, digits or dashes, starting with
  a letter". A missing manifest is reported as well (0.3.0-dev.8).
- A dir with no manifest reads "local (plugins/scratch): no den-plugin.json
  or den-theme.json, so it isn't a plugin" in `plugin list`. "Not valid
  under this <cli>: …" is now kept for a recognized plugin that fails
  validation (0.3.0-dev.8).
- `theme list` still shows themes only, and still exits 0 when other plugin
  dirs are broken. It now adds one line, "N plugin dir(s) have errors: run
  `<cli> plugin list`" (0.3.0-dev.8).

- `theme list`'s footer counts every broken plugin dir, whether or not it
  is a row above, and gets the plural right: "1 plugin dir has errors" /
  "4 plugin dirs have errors: run `<cli> plugin list`" (0.3.0-dev.9; it
  counted only the hidden ones, as "N plugin dir(s)").
- `plugin validate` says the same as `plugin list` for a dir with no
  manifest: "no den-plugin.json or den-theme.json, so it isn't a plugin",
  from one constant. `plugin list`'s and `theme list`'s id column fits the
  longest id, so rows stay aligned with ids up to 40 characters
  (0.3.0-dev.9).
- **The header's health row no longer cuts repos off** (0.3.0-dev.9, a
  regression from the one-line header earlier in 0.3.0). The row was clipped
  silently: whole repos were hidden, a name could be cut mid-word, and a
  hidden repo that was down didn't show. It now:
  - orders problems first: down, then degraded, then healthy, then unknown
    (0.3.0-dev.11; dev.9 put unknown before healthy), within and across
    application boxes;
  - shows only items that fit whole;
  - ends with a "+N" chip for the rest, named "N more repos" and saying
    "+N · 1 down" when a hidden repo has a problem. The chip opens the full
    list; Escape closes it and returns focus to the chip.
  - fits again on resize, when fonts load, and when the rest of the header
    squeezes it.

  An interim fix until the slice-3 status chip. The new module is
  `public/health-fit.js`.

- **One repo health rule for the header, the chip, the graph and
  `<cli> status`** (0.3.0-dev.10). The header row and `status` read only
  the entry service, so a repo whose web answered but whose mailpit
  container was gone read healthy. It sorted with the healthy repos and
  never reached the chip's count, while the graph showed the down service.
  All four now use one function, `public/health-rollup.js`, typed for
  TypeScript in `src/shared/health/rollup.ts`. Only checked signals count:
  - **down**: the entry service (the manifest `entrypoint`, else the
    service named like the repo, else the only one) is down;
  - **degraded**: another checked service is down;
  - **ok**: at least one signal is checked and none fails;
  - **unknown**: nothing is checked. It is neutral, never green, and sorts
    last, after healthy (0.3.0-dev.11). A service not yet probed is
    unknown. `status` keeps the graph's order.

  A repo of 26 services with one probe is judged by that probe.
  - `status` prints one row per repo with its rolled-up state and names
    what is down, e.g. "degraded" with "mailpit down". It says "N not
    checked" when services aren't probed. An entrypoint-less repo is
    rolled up too, and `--verbose` still lists every service.
  - The graph's repo card shows degraded in `--warn`.
  - In the row, same-state repos sort the focused workspace's first, then
    by name. `/api/health` rows carry `focused`.
- **The health row no longer hides everything behind one big application
  box** (0.3.0-dev.10).
  - When the boxes don't all fit, the row shows repos one by one. It places
    every down or degraded repo that fits first, and a problem that is too
    wide never blocks a later one. Then it adds the rest, in order.
  - The chip shows the richest text that fits ("+9 · 1 down, 1 degraded",
    then "+9 · 1 down"). Its name and tooltip always carry the full count.
  - The row now takes the header's free space. Before, it shrank to its
    content, and the page's own spacer took half of what was left.
- **The health row is never an empty box on a cold load** (0.3.0-dev.11).
  Before the first health result (the application and editor lookups and
  the stream come first) the row painted nothing, and since dev.10 it takes
  the header's free space, so it read as a wide empty box with no refresh
  button. It now shows a neutral "…" and the refresh button at once. A fit
  that runs before the row or its items have a width keeps everything
  boxed and runs again next frame (`fitPlan` in `public/health-fit.js`).
  It fits again on the first data and when fonts load. The brand, version
  badge and pills beside the row never shrink for it.
- **The health row's fit, checked against a real 6+3 workspace**
  (0.3.0-dev.11). Measured names of 71 to 182px: all nine flat need about
  1070px, so a 1002px row shows 7 and "+2", and a 1282px row shows both
  boxes whole. The fit was right; these numbers are now a test, with an
  11-repo 7+3+1 case for the flat fallback.
- **The "+N" chip names a hidden problem in its text** (0.3.0-dev.12).
  With only room for the chip, a hidden degraded repo read "+11" with an
  amber ring, and "1 degraded" was only in its accessible name. The ladder
  is now "+11 · 1 down, 1 degraded", then the worst one alone ("+11 · 1
  down"), then compact ("+11 · ⚠2", 0.3.0-dev.13), down and degraded named
  the same way. Bare "+N" only when no
  hidden repo has a problem. The fit keeps room for that text
  (`fitPlan`'s `chipWidthOf`).
- **Escape from the chip's list returns focus to the chip, even after a
  re-fit** (0.3.0-dev.12). A health tick or a font load while the list was
  open laid the row out again with a new chip node, so focus fell to the
  page (the breadcrumb). The chip is now one node across re-fits, keeps its
  focus, and stays the list's anchor; when a re-fit drops the chip, focus
  moves to the row's refresh button.
- **The health row settles once on a fresh load** (0.3.0-dev.13). It
  reshuffled three or four times between 0.6s and 3.6s as streamed results
  arrived. Now a first cycle (a page load, an environment switch) keeps the
  "…" placeholder until the whole cycle is in (or 8s pass with a slow probe
  still out), then fits once. Later data repaints are debounced by 300ms;
  resize and font re-fits stay immediate (`paintGate` in
  `public/health-fit.js`).
- **The refresh button is never clipped** (0.3.0-dev.13). At 124px,
  "+11 · 1 degraded" pushed ⟳ out of the row. The chip's ladder ends in a
  compact form, "+11 · ⚠1" (every hidden problem counted), used before the
  problem would be dropped; its name and tooltip keep the full text. If
  even that doesn't fit, the chip's text gives way, not ⟳. The chip is
  measured at its natural width.
- **One shell for every page: a top bar and a left rail** (0.3.0-dev.14,
  shell slice 2). Every page had its own copy of the header, nav and header
  CSS (six copies; Environments loaded none of the header's behaviour).
  `public/shell.js` now draws one frame on every page, and the pages keep
  only their content:
  - **Top bar** (48px): the theme's mark and the title in the theme's
    display face (`var(--display)`; the pages had used the mono face), the
    version pill, the health row and chip (unchanged), the workspace focus
    pill, one env picker and ◐.
  - **Rail**: Local Dev, Services, Environments, Releases, Logs, Tests, the
    current page marked `aria-current="page"`. ↑/↓, Home and End move
    between pages; it collapses to icons below 1100px (labels stay for
    assistive tech). No horizontal page scroll at 1024.
  - **One env picker for the whole shell.** Tests, Services and Logs each
    had their own; the choice is now one control, remembered across pages.
    Local Dev and Releases keep checking local health whatever it says
    (`data-health-env`), and Releases' own selector is now labelled as the
    deploy target it is.
  - A page joins the shell with `<div id="den-shell" data-page="…">` and
    `<script src="/shell.js">`; `header.js` drives it (`envReady()`,
    `healthEnv()`).
- **Header fixes** (0.3.0-dev.14): a long workspace name ends in an
  ellipsis with the full name in its tooltip, and names in the bar never
  wrap mid-word; the Tests page's "ENV" label no longer collides with its
  select (the picker is the shell's).
- **Environments groups services under their org again** (0.3.0-dev.14).
  Every service showed under "no org": the page read each row's `org` from
  `/api/health`, which never sends one. It now takes each repo's org from
  `/api/orgs?repos=1`, like the graph.
- **The first health paint waits for the whole cycle** (0.3.0-dev.14). A
  stream that broke after its first results counted as a finished cycle,
  so a cold load could paint a partial row. Only the server's `done` ends
  a cycle now; a broken stream is completed from `/api/health` (or the 8s
  cap paints what landed, and a check with no result is never shown as
  down). `healthCycle` in `public/health-fit.js`.
- **The Theme menu says when your theme isn't in use** (0.3.0-dev.10). A
  stored theme that fails validation selects nothing, instead of looking
  like "Org default". One line explains: "Your theme <id> isn't valid
  (<first problem>), so <name> is in use", or "isn't installed". Picking
  any option replaces the stored choice.

### Migrations

- None. Optional: set `brand.theme: <id>` in the org config to give the
  distribution's web UI its own default theme.
- A `plugins/<id>/` with no `den-plugin.json` or `den-theme.json` now fails
  `plugin list` and `plugin validate`: give it a manifest or move it out of
  `plugins/`. A theme added from a `file://` path (0.3.0-dev.2 warned) stays
  listed, but re-add it from its published URL before committing the lock.
- 0.3.0-dev.20: the header's health row (`#health`) and Local Dev's
  `#sudo-banner` are gone, and so are `planRow`, `fitPlan`, `moreChip`,
  `mountMoreChip`, `openMoreList` and `closeMoreList` in
  `public/health-fit.js`. A distribution page that read them reads the
  `<cli>:health-update` event (unchanged) or the status chip (`#den-status`)
  instead, and unlocks with `requireUnlock()` from `/header.js`.
- 0.3.0-dev.8: a `den-theme.json` used as a plugin needs an `author`
  (`theme new` sets one). A plugin's `den` range is now enforced: write
  `>=0.3.0-0 <0.4.0` to admit Den's 0.3.0 prereleases, because `>=0.3.0`
  excludes them.

## [0.2.6] - 2026-11-04

### Fixed

- **`<cli> web restart` and `web down` act on our server from an older
  Den.** A server from before 0.2.6 (no `root` in `/api/server-info`) run
  from our root is ours, and 0.2.6-dev.0 classified it so, but stopping it
  then looked for our pids by command line only: the entry point of this
  engine, or one under the root. An older Den installed elsewhere, or a
  hand-started server, matched neither, so `web restart` printed "OK ... web
  is already running" and restarted nothing, and `web down` printed "OK ...
  web is not running" while the server stayed up and bound. A server the
  identity check finds ours is now stopped by the pid it reports, when that
  pid listens on the port: `restart` replaces it and `down` frees the port,
  with or without a `web.json` for it. web.json's root is compared after
  resolving symlinks (`/var` and `/private/var` are one root).
- **The MCP server serves nothing from another distribution's server.**
  It read from whatever answered on its port. Before a tool reads, it now
  checks `/api/server-info` as `web up` does; on another distribution's
  server every tool answers `port <N> is in use by <product> at <root>; not
  this distribution's server` and returns none of its data. A positive
  check is trusted for 30s and made again after a connection error, so a
  server that took over the port is noticed. A server that does not say
  whose it is within 5s is not read from either.
- **A mistyped `service` flag no longer installs.** `<cli> service install
  --anything` ignored the flag and installed; a `service` subcommand now
  refuses an argument it does not take, before running anything.
- **`<cli> web up` no longer trusts whatever answers on its port.** With
  `web.port` set to a port where another distribution's Den server ran
  (another root, an older Den), `web up` printed "OK ... web is already
  running" and stopped, and `web down` or `web restart` could SIGTERM that
  server: with a linked engine its command line looks like ours.
  `/api/server-info` now also returns `root` (the distribution root the
  server serves) and `product`. `web up`, `web down` and `web restart`
  compare both with their own, and on another distribution's server exit 1
  with `port <N> is in use by <product> at <root>` and a hint to pick
  another port (`--port`, or `web.port`). A server from before 0.2.6 has
  no `root`: it is ours when it runs from our root (its working
  directory), otherwise `port <N> is in use by another server (Den
  <version>)`; anything else is "a non-Den server". `web down` also no
  longer signals a process running from another root, even when the
  server does not answer. `<cli> mcp connect` refuses to point an agent at
  another distribution's server (and `mcp clients` names it), and `<cli>
  service install` no longer reports "running" when another
  distribution's server answers on the port.
- **A repeat `<cli> workspace seed` says "already seeded".** Seeding a
  workspace that already holds exactly the blueprint printed "Default
  workspace ready" as if it had seeded again; it now prints `✓ Default
  workspace already seeded — N repos (managed): nothing changed.` and
  writes nothing (multi blueprint: `✓ N workspaces already seeded (a, b)`).
  A seed over a workspace the user changed says it was "reset to the
  blueprint".
- **Counts read "1 repo", not "1 repos".** CLI output that counts repos,
  workspaces, systems, files, profiles and tools uses one plural helper
  (`src/shared/plural.ts`), also in place of "repo(s)".
- **Spinners no longer loop forever on a 0-column terminal.** On a pty that
  reports 0 columns (one nobody sized, as agent shells give), ora computed
  an infinite number of lines to clear and never finished. A spinner now
  animates only on a TTY with a known, non-zero width; otherwise it prints
  plain lines (its text on start, then the result).

### Added

- **Health type `container`.** `health: { type: container, project: <compose
  project>, service: <compose service> }` checks a compose container by its
  `com.docker.compose.project` / `com.docker.compose.service` labels, or
  `{ type: container, container_name: <name> }` any container by name. It
  is answered from the one `docker ps` per health cycle the compose checks
  already share (its format gains `{{.Names}}`, and it no longer filters to
  compose containers), so N container checks add no docker call, in the
  web health row and in `<cli> status` (22 checks, 17 compose and 5
  container: 1 docker call per cycle). A running container with a
  healthcheck is its health (healthy up, unhealthy down, starting
  pending), one without is up, and no matching container is down. When
  docker gives no listing it says what a compose check says, through the
  same code: a failed `docker ps` is unknown (`ok: null`, the reason in
  `error`) on every cycle, never down; a listing past its budget is
  pending (`pending: true`), down only when that repeats. Of several matches the best counts:
  healthy, then running. `/api/health` rows show it as `check: "container
  <project>/<service>"`. `<cli> validate` requires `project` + `service` or
  `container_name` (not both, not one of the pair alone, no other type's
  keys) and says which. See docs/distributions.md, "Health checks".
- **`<cli> service install --plan`.** Read-only: prints the label, the
  plist path, the log file, the roots, whose server answers on `web.port`
  (ours, free, or `port <N> is in use by <product> at <root>`) and the
  plist install would write; writes nothing and never calls launchctl.
  Exits 1 when the port is another distribution's. `<cli> service status`
  also names another distribution's server on the port.

### Migrations

- None required. Optional: a `type: shell` check that runs `docker ps` to
  find a container (`test -n "$(docker ps -q --filter
  label=com.docker.compose.project=X --filter
  label=com.docker.compose.service=Y)"`) can become `{ type: container,
  project: X, service: Y }`: no process or docker call of its own, and it
  reads the container's healthcheck.

## [0.2.5] - 2026-11-04

### Fixed

- **`<cli> web down` (any SIGTERM) shuts the web server down cleanly
  under load.** `<cli> web up` ran the server under the `tsx` CLI, a
  parent process that relays a signal to the server and, if the server has
  not acknowledged it within about 60ms, SIGKILLs it and exits 143. On a
  loaded machine the server missed that window, so it was killed without
  its shutdown. The server now runs as `node --import <tsx loader>`, one
  process that gets the signal itself, as the launchd service already did.
- **Compose-stack health no longer starts a CLI per check.** Den's own
  check for a compose repo was a `<cli> stack health <stack> --service X`
  process per manifest service, each a full CLI start running its own
  `docker ps`: 17-19 processes per health cycle for three stacks. On a
  loaded machine (load 35-55) they ran past their budget, and two such
  cycles in a row read every stack down. These checks are now answered
  in the web server and in `<cli> status` from one `docker ps` per cycle,
  shared by every check in it (17 checks: 17 CLI starts and 17 docker
  calls per cycle before, 0 and 1 now). The verdict is the one `stack
  health` gives. A distribution's own shell checks still run as shell
  commands, at most max(2, cpus/2) at a time; a queued check's budget
  starts when it starts.
- **The health row no longer shows healthy repos down on a cold poll.** A
  check that got no answer within its budget was sent as a finished
  `ok: false`: a compose stack's check (`<cli> stack health`, a full CLI
  start per service, 15-20 of them at once) past its 5s budget on a loaded
  machine, or an HTTP check past its 3s timeout. The row painted it red
  and the 8s health cache replayed that to the next page load, until the
  next poll corrected it. Now a check that has not answered is **pending**
  (`ok: null`, `pending: true`, the reason in `error`), never down. Only a
  check that completed and failed is `ok: false`. A timeout is down only
  when it repeats on the next cycle (`timeout (twice in a row)`), so a hung
  service still shows. `<cli> status` agrees: on a timeout it probes once
  more, and is down only when both probes time out. Health results have a
  new `pending` state (`health: "pending"`), which readiness waits on
  rather than skipping.
- **"Docker state unknown" is not "not running".** When docker does not
  answer, the health row and `<cli> status` report a compose stack as
  unknown (`ok: null`), not down, and so does `/api/stacks`. `<cli> stack
  health` exits 3 when it could not tell (docker did not answer, the stack
  config could not be read), 1 only when a stack is not healthy.
- **A health stream and a poll at once run each check once.** A stream
  started its own full run next to an in-flight `/api/health` (or another
  stream), doubling the shell checks' processes. It now joins the run in
  flight, replaying what has landed and then following it.
- The web header's dot for a multi-service repo without an entrypoint
  turned red when none of its checks were up yet, even with none down. It
  is red now only when a check completed and failed.

- **The default workspace is seeded only on a genuine fresh setup.** Any
  command that reads workspaces (`status`, `up`, `graph`, `logs`, …) seeded
  `default` from `defaults.workspace.repos` whenever `default` was empty,
  so moving every repo into per-project workspaces and deactivating
  `default` got it refilled with managed entries on the next command, ready
  to clone duplicates of repos you work on locally. Seeding now requires
  that no workspace but `default` exists and that `default` was never
  seeded (no `seeded_repos`). Declining the offer records that too, so it
  is no longer asked again.
- **No silent seeding without a TTY.** On a fresh setup a command without
  a TTY now prints a one-line hint to run `<cli> workspace seed` and
  changes nothing; on a TTY the offer stays. New: `<cli>
  workspace seed` seeds explicitly (as `<cli> init` in the root does).
- **Top-up no longer re-adds repos you moved or removed.** Top-up (adding
  repos that joined the blueprint after seeding) never runs once you have
  other workspaces, and skips a repo any workspace holds. Removing a
  blueprint repo from `default` in the web UI records it, so a `default`
  from before `seeded_repos` no longer gets it back on its one-time
  migration.

### Added

- **The "What's new" pop-up shows the newest release only** (from
  0.3.0-dev.16). A "Show all versions (N earlier)" button in its footer
  lists every earlier version in the same pop-up, and "Show latest only"
  collapses it again. It always opens collapsed, at the top: the scroll is
  reset once the pop-up is shown (a reset made while it was hidden did not
  stick, so a reopened pop-up kept its old scroll position). It is an
  accessible modal dialog (`role="dialog"`, `aria-modal`, labelled by its
  title). Opening moves focus to its heading, so a screen reader starts at
  the latest notes. Tab stays inside, and closing returns focus to what had
  it, which is the version pill after the first-visit auto-open. Each
  version is a heading (h4) for heading navigation, and the icon buttons
  have spoken names ("Close", "Copy v0.2.5 as Markdown").
- **The version pill names the running build** (`v0.2.5-dev.2`), not the
  newest changelog heading, so a prerelease under test says what it is.
- **Multi-workspace blueprint: `defaults.workspaces`.** `{ <name>: {
  repos, branch?, autostart_off?, focus? } }` in the org config. A fresh
  setup creates each workspace with its repos (managed), activates them
  all and focuses the one with `focus: true` (else the first). Setting
  both `defaults.workspace` and `defaults.workspaces` is an error, as is a
  malformed entry. See docs/distributions.md, "Workspace blueprint".

### Migrations

- None required.

## [0.2.4] - 2026-11-04

### Fixed

- **`GET /api/services` no longer blocks the web server.** It looked up
  each workspace checkout's branch with a synchronous `git rev-parse`, one
  after another (~40ms each), so with a dozen repos every request held the
  event loop for 0.5-1.5s and everything else waited behind it: the UI,
  the MCP server's reads, and `/api/server-info`, which `<cli> mcp connect`
  probes with a 1.5s timeout. The lookups now run as async child processes
  in parallel; concurrent requests (one per open tab) share one build, and
  a settled build is reused for 2s (`?refresh=1` forces a new one; any
  mutating request clears it). Concurrent `/api/health` polls also share
  one run instead of each starting its own.
- **`<cli> mcp connect` / `mcp clients` tell a slow web server from a
  stopped one.** A server that accepts the connection but does not answer
  within 1.5s is reported as "not answering within 1.5s", not "not
  running". When the org config sets `web.service` (the web UI runs as a
  launchd service), the advice is `<cli> service status` instead of
  `<cli> web up`.
- **Web server shutdown no longer leaks an unhandled rejection, or hangs.**
  On SIGTERM/SIGINT the server reads the running-services registry, whose
  path resolves the distribution root again; if that walk fails (the dist's
  den.yml moved or removed while the server ran), the async shutdown
  rejected unhandled ("unhandled rejection (continuing): Error: cannot
  locate the distribution root: walked up from
  <dist>/node_modules/@monster-orange/den/src/ui/server") and, its signal
  guard already set, the process never exited, so a service manager had to
  wait out its timeout and kill it. The shutdown now logs the failure and
  exits.
- **Deactivating a workspace no longer stops a service that moved to
  another workspace.** A daemon's owners were the workspaces recorded when
  it started, so a repo moved from `default` into `ws-b` while its daemon
  ran was still "owned" only by `default`, and `workspace deactivate
  default` stopped it. Release now re-derives the owners from the current
  workspaces.yml membership: a daemon is stopped only when no active
  workspace still lists its repo, and otherwise its recorded owners become
  the active workspaces that do.
- **`<cli> workspace --help` lists every subcommand**: activate,
  deactivate and focus were missing (and `workspace focus <name>` now
  exists in the CLI, as it did in the web UI). Deactivate's help and output
  say that it releases only the services Den tracks: compose stacks of the
  workspace's repos keep running, and the output names the running ones
  with `<cli> down <repo>` for each (from one `docker ps`; a generic line
  when docker can't be asked).
- **The first `/api/health/stream` (and `/api/health`) cycle no longer
  blocks the web server for a second.** Resolving the manifest of a repo
  without its own (a held manifest under `manifests/`) looked up the
  checkout's origin with a synchronous `git config --get
  remote.origin.url`, one repo after another (~40-100ms each), so a
  server's first health run held the event loop for 1-1.5s. The origin is
  now read from the checkout's git config file (worktrees and
  subdirectories included), never by spawning git. Parsed manifests are
  also reused while the file is unchanged: one request read the same
  manifests several times, and parsing them held the loop ~100-200ms per
  health run.
- **`GET /api/workspaces/available-repos` no longer blocks the web
  server.** It ran `git remote get-url origin` (and, for managed clones,
  `git rev-parse`) synchronously per checkout; the lookups are now async
  and in parallel, and concurrent requests share one walk (reused for 2s;
  `?refresh=1` forces a new one, any mutating request clears it).
- **`workspace deactivate` names the compose stacks a repo runs itself.**
  It only knew Den stacks (a manifest's `compose:` section, project
  `<stack>-<workspace>`), so a distribution whose repos start their own
  compose projects (`make up`) got no line at all. A running project now
  counts when Compose started it from inside one of the workspace's
  checkouts (its `com.docker.compose.project.working_dir` label), as well
  as when it is a Den stack's project.
- **`<cli> workspace <sub> --help`** prints that subcommand's help, not the
  whole `workspace` help.
- **No synchronous directory walks or spawns on the web server's hot
  request paths** (`/api/workspaces/available-repos`, the `/api/health`
  stream). On a loaded machine (load average ~50) the dev.1 fixes still
  left stalls of 1-5s; a CPU profile showed why:
  - available-repos recursed into every directory without a manifest file
    of its own, so in a distribution whose repos use held manifests it
    walked each repo's whole tree (to depth 4) with `readdirSync` /
    `existsSync`: seconds per call. It now never descends into a git
    checkout or `node_modules`, and the walk is `fs.promises`.
  - The distribution root (and so `product()`) was re-resolved on every
    call, a den.yml `existsSync` per `*_ROOT` variable each time, hundreds
    of times per request. It is now resolved once per set of inputs (the
    env vars and entry script it reads); the engine root likewise.
  - Manifests, the edge config and the derived graph order are reused
    across a request and the polls after it (5s; any mutating request
    clears them), and the graph order is recomputed after a request, never
    inside one.
  - HTTPS health checks built a TLS context from ~150 root certificates on
    every check; one context is built once, at startup.
  - The startup sweep of stale daemon records ran `docker ps` / `opctl
    container ls` synchronously; it is async now (concurrent callers share
    one call), and `/api/service/daemons` waits for it.
  A new test runs the server with a spy on every synchronous fs and
  child_process call and fails if either route makes a sync spawn or
  directory walk, or any sync call outside a short allowlist of single
  config-file reads.
- **The web UI service no longer runs at background priority.**
  `service install` wrote `ProcessType: Background` into the LaunchAgent,
  so macOS ran the UI server on efficiency cores with throttled I/O: on a
  busy machine its first requests stalled for 5-11s. It is now
  `Interactive`, and `service status` shows launchd's spawn type.
- **`workspace deactivate` never suggests stopping a stack another active
  workspace still holds.** Such a stack is listed as "in use by another
  workspace: <project> (still in <ws>)" instead of with a `down <repo>`
  command, and a repo with a stack still in use gets no `down` suggestion.

### Migrations

- Re-run `<cli> service install` to pick up the new LaunchAgent priority
  (`<cli> service status` should show `spawn type = interactive`).

## [0.2.3] - 2026-11-04

### Added

- **`secret_env`: secrets resolved by Den into a stack's or a service's env**
  (R16), so a consumer no longer wraps `<provider> run -- <cli> restart
  <repo>` by hand, and a plain restart no longer drops a key. In a manifest,
  `compose.secret_env` (for the docker compose process: the compose file's
  `${VAR}` or pass-through `environment:` entries) and
  `services.<svc>.secret_env` (for that service's own up/restart command)
  map an env var to a fully qualified ref, `<vault>/<item>/<field>`. For
  Doppler that is `<project>/<config>/<key>`; for 1Password vault / item /
  field; for `env` the field is the env var to read. Existing refs (the
  engine's named secrets, test users) are unchanged. Resolved through the
  configured `secrets.provider` at `up` and `restart` (also the in-place
  restart of one compose service), all or nothing, before anything stops or
  starts. A missing key fails that target, exit 1, naming the key, ref and
  provider. Values go only into the spawned process's env: never into the
  compose override, logs, activity records, MCP output or messages. A dry
  run (`-n`) never asks the provider; it lists the key names it would
  inject. A CLI-tabs start of a service with `secret_env` runs as a daemon,
  so the values stay out of the tab's shell. `validate` rejects a ref that
  is not exactly three non-empty parts, and a key that is not an env var
  name. See "Secrets in a target's env" in `docs/distributions.md`.

### Fixed

- **`<cli> mcp connect` for Claude Code failed whenever the server has env**
  ("Invalid environment variable format: <name>"): `claude mcp add`'s `-e`
  takes several values, so the server name after the env pairs was read as
  one more. The name now comes right after `add`.
- **The up/restart secrets check said the backend was "not ready" when it
  was signed in with no default scope.** `secret_env` refs name their own
  scope, so they still resolve; it now says "signed in, no default scope
  set" instead of warning.

### Migrations

- None required.

## [0.2.2] - 2026-11-04

### Added

- **`<cli> service install | status | print | uninstall`**: the web UI's
  launchd service, over `service/install.sh`, so a distribution no longer
  wraps the script in its Makefile. The label and log directory are
  `web.service: { label, logs }` in the org config; the defaults are the
  script's own (`local.<distribution dir name>.web`,
  `~/Library/Logs/<distribution dir name>`), so an existing install keeps its
  label. A bad label, a non-path `logs` or an unknown key under `web.service`
  is an error. `install` (which also restarts) says `running` only once
  `/api/server-info` answers with JSON, and after 30s without an answer says
  `installed but not answering yet: check <logs dir>` and exits 1. `print`
  writes the plist only, on any OS. See "Running the web UI as a service" in
  `docs/distributions.md`.
- **`<cli> mcp --call <tool> ['<json args>']` and `<cli> mcp --list`.** One
  tool call from a shell, through the same tool layer as the MCP server
  (registered tools only, so actions only as named in `mcp.actions`; every
  guard; redaction; audit headers), against the running web server. Prints
  the tool's text to stdout and exits 1 when the tool reports an error.
  `--list` prints the tool names.
- **Service aliases.** `up`, `down`, `restart` and `logs` (and every caller
  of the service resolver, so `/api/service/exec` too) accept a service's
  manifest key or a compose stack's name, when it names exactly one service
  in the workspace: `<cli> restart indexer` restarts the repo whose service
  or stack is `indexer`. Repo names and listed addresses win over an alias.
  An ambiguous alias is an error naming the candidates (`"worker" is
  ambiguous in workspace "default": one/worker, two/worker`). See "Naming a
  service" in `docs/distributions.md`.
- **`validate` flags a redundant held manifest.** When a repo carries its own
  manifest and the distribution still holds `manifests/<repo>.<name>.yml`,
  `validate` warns (never an error) that the held file is not used and can be
  deleted, or turned into `manifests/<repo>.override.yml`.

### Fixed

- **`-n`/`--dry-run` and `--plan` run nothing on every path.** Given a
  `repo/service` address or an alias, `up` and `down` ignored them and
  really ran the service (and its dependencies); they now print the order
  they would run and stop. `restart` accepts `-n`/`--dry-run` too. Tested
  for each way to name a target: the cwd repo, a repo, an address, an alias,
  a compose stack name and an app.
- **A dry run says what the real run does**, per target: the same command
  lookup (own command, restart as down + up, a repo-started service's
  repo up, nothing to stop, not found), so a dry run fails where the real
  run would. Every dry run names its targets (`Would down: …`).
- **`down` and `restart` on named services act on those services only.**
  They took the services' dependencies down (or restarted them) too, even
  ones other running services still use. `up` still starts dependencies;
  `down <repo>` still stops the repo's closure, naming what else depends on
  it.
- **`down <repo>` stops that repo only.** It stopped the repo's whole
  derived closure, so `down api` took down stacks it sits on that other
  running systems use. `--with-deps` keeps the old behaviour (naming what
  else uses them); `down -a` still stops everything.
- **Plans show remote services as skipped, with the reason**
  (`core (remote, skipped): core runs in dev; …`), and a named remote target
  fails with the real run's reason.
- **A compose sub-service restarts on its own**: `restart <repo>/<svc>` runs
  `docker compose restart <svc>` in its stack (`<cli> stack restart <stack>
  --service <svc>`): the same container and env, nothing recreated. Up and
  down stay the stack's.
- **A service its repo starts**: `down` on it says it is stopped by the
  repo's down and names the command (exit 0, so a workspace Down that sends
  every service stays clean); `restart` fails the same way, exit 1.
- **`down` of a remote repo no longer warns about its dependents**: it stops
  nothing, so nothing is at risk. Only targets that really stop here count.
- **A failed or unknown target exits 1.** `up`, `down` and `restart` exited 0
  when a named service failed or did not exist.
- **A service with no commands of its own** (its repo's up starts it): `up`
  runs the repo's up and says so, instead of `command "up" not found`; other
  commands point at the repo, since they would reach its other services.
- **`service status`** no longer prints launchctl's errors when the service
  is not loaded.

### Migrations

- None required.
- `down <repo/service>` and `restart <repo/service>` no longer touch the
  service's dependencies; stop or restart those by name.
- `down <repo>` (and a bare `down` in a repo) stops only that repo; add
  `--with-deps` for its closure.
- A Makefile target that runs `service/install.sh` with `DEN_SERVICE_LABEL`
  and `DEN_SERVICE_LOGS` can become `<cli> service install`; put a non-default
  label or log directory in `web.service` first, since the CLI reads the
  config, not those env vars.
- Delete held manifests `validate` now reports as unused.

## [0.2.1] - 2026-11-04

### Fixed

- **MCP `service_restart` on a service with only `up` and `down`.**
  `/api/service/exec` now runs `up`, `down` and `restart` (env local) through
  the service runner, as `<cli> up|down|restart` do, instead of looking up
  and executing the manifest's command itself. So, for the web UI's panel and
  for MCP alike: `restart` with no declared `restart` is `down` then `up`;
  `up` on a service that is already healthy starts nothing and says
  `already up (healthy)`; `up` attaches to a running shared instance; `down`
  honours workspace ownership. The panel offers Restart whenever a service has
  `up` and `down`.
- **A detached start says when it is ready.** `/api/service/exec` sends a
  `ready` event once a detached `up` or `restart` is up: its health check
  passes (`checked: true`; for a restart, only after the old instance went
  down or 5s passed), or, with no health check, its launcher is still running
  after 5s (`checked: false`). MCP `service_up` and `service_restart` return
  at `ready` (`"ready": true` in the result) instead of waiting for a
  launcher that runs in the foreground (a dev server) to exit, which ran
  into the 180s timeout and reported a false failure. A restart of a running
  shared instance now says `restarting the running instance`, not
  `already running`, and the log path is printed once. An MCP action's
  `ended` reads `ready` or `handed-off` for a detached start, never
  `stopped`.
- **MCP actions report failure.** `service_up|down|restart`, `run_tests` and
  `workspace_sync` return `isError` with `"failed": true` in the result when
  the command exits non-zero, a detached service's launcher exits non-zero,
  or the call times out. They used to come back ok with `exitCode: 1` inside.
- **`<cli> up|down|restart <remote service>` exits 1.** Naming a remote
  service (or its repo) directly is a refused command. A remote service
  reached through a workspace, `-a` or `-A <app>` run is still said and
  skipped, exit 0.
- **Refusals name the command.** `runs in dev (AWS); nothing to restart here`
  (and `stop`, `start`, `run "<cmd>" on`), not `start` for everything.

### Added

- **`<cli> mcp connect`: register the MCP server with your agents.**
  `mcp clients` lists the agents installed here (Claude Code, Codex, Cursor,
  VS Code, Claude Desktop, Windsurf, Gemini CLI) and whether each is
  connected. `mcp connect <client>...|--all` registers the distribution's
  server at user scope through each client's own CLI or config file, and
  `--project [dir]` writes a project's config instead. `--dry-run` shows the
  change, `mcp disconnect` removes it, and `mcp config` prints JSON for any
  other client. The registration pins `PATH` to the running node so GUI
  agents can launch it. See "Connecting your agents" in
  `docs/distributions.md`.
- **Refused attempts are in the activity trail.** `/api/activity` entries may
  carry `outcome: "refused"` and a `reason`: a refused or unresolvable
  `/api/service/exec`, and any MCP action a guard refused before it reached
  the web server. Agents report the latter to `POST /api/activity` (agent
  audit header required; it appends one sanitised entry and nothing else).
  The panel's Activity tab shows them as refused. An attempt that named only
  the repo shows for the repo and for each of its services.
- **`target.expect` in placement.** `/api/services` and `/api/health` rows'
  `target` now carry `expect` (as declared) when the manifest's target has its
  own `url`.

### Migrations

- None required. Two additive API changes a contract probe may see:
  `target.expect` on `/api/services` and `/api/health` rows, and
  `outcome`/`reason` on `/api/activity` entries.
- Scripts that relied on `<cli> restart|down <remote service>` exiting 0
  should expect 1.

## [0.2.0] - 2026-11-04

### Added

- **Manifest overrides.** An optional `manifests/<repo>.override.yml` in the
  distribution is deep-merged onto the repo's base manifest (its own, or the
  held one): maps merge by key, lists and scalars replace, and an explicit
  `null` deletes a key. An override may only name services and keys the base
  has, and an override with no base is an error. See "Overriding a manifest"
  in `docs/distributions.md`.
- **Manifest layers are visible.** `/api/services` returns `manifestLayers`
  per service (`["repo"]`, `["held", "override"]`, …) and the Services cards
  show them; `GET /api/manifest/validate?path=<repo dir>` returns each layer's
  result.
- **`validate` checks each layer.** For a repo folder it validates the base
  and the override separately, each error naming its file, then the merged
  result.
- **`<cli> mcp`: an MCP server over stdio** for agents, a thin client of the
  running web server (it never starts it, and says how when it is down). Read
  tools are always on, including the new `stacks` and `edge_status`; the
  actions `service_up`, `service_down`, `service_restart`, `workspace_sync`
  and `run_tests` are opt-in per org with `mcp.actions`. Guards: lifecycle
  commands and env=local only, locally run services only, `run_tests` limited
  to `mcp.run_tests.envs` (default `[local]`, never production), security runs
  must pass the owned-host plan and `full` is local only, log tools read
  local sources unless `mcp.logs.remote: true`, and all text returned is
  secret-redacted. No deploy tool. Pinned `@modelcontextprotocol/sdk` 1.32.1.
  See "MCP server" in `docs/distributions.md`.
- **Agent audit trail.** Every service exec, test run and sync is recorded
  with who asked: an agent's actions carry actor `agent`, the MCP client's
  self-reported name and version, and the MCP pid and session id, and show as
  `[agent]` lines in the web server log on the Logs page.
- **Read-only status endpoints:** `/api/stacks` (what `stack ls/health` show),
  `/api/edge` (what `edge status` shows) and `/api/security/plan` (the
  security CLI's own dry run). `stack ls` and `edge status` now print from the
  same code.
- **Graph: cards and a details panel.** The Local Dev graph is laid out by
  ELK (layered, compound org or application › repo › service, orthogonal
  edges; elkjs vendored and served by Den, so it works offline). Cards are
  full size (detailed or compact) on a canvas you pan and zoom; Fit zooms out
  to 35%. A card shows status, name, repo, placement and health, and its main
  actions on hover. Clicking a card or a repo opens a side panel: one primary
  action (Start when down, Open when up, else Logs), two common ones, and More
  (manifest commands, tools, and careful actions that confirm on a second
  click); tabs Overview, Logs (live tail), Config and Activity (the audit
  trail, yours and agents'). ⤢ pops the panel out as a dialog. Layout
  direction, grouping, card density and panel width are remembered per user
  (`/api/settings` `graph`). Find highlights and centres on matches. The
  panel is built from registries (actions, tabs, sections) a distribution or
  later release can add to.
- `GET /api/activity`: the audit trail, filtered by service or repo.
- **One secret redactor** (`src/shared/redact.ts`), shared by the journeys and
  security pillars and the MCP server.
- **Placement (R13): what runs here and what runs in the cloud.** A
  manifest's service may say `runs: { local: remote, dev: remote }` (per env,
  `local` or `remote`) and `target: { env, account?, url?, expect? }`.
  Without `runs`, a service is local when it or any service of its repo has
  local commands (or the repo is a compose stack), remote when it has only an
  HTTP health URL and nothing in its repo runs here, and otherwise has no
  placement. `/api/services`
  and `/api/health` rows carry `runs` and `target`; `/api/applications`
  carries `placements` per service address, and per application `placement`
  (`local | remote | hybrid | none`) and a `summary`
  (`shop-frontend local · shop-core remote (dev)`). `<cli> status`,
  `services` and `apps` suffix remote services `☁ remote (dev)`, and
  `<cli> graph` marks remote and hybrid nodes. See "Placement" in
  `docs/distributions.md`.
- **Remote health.** A remote service is checked by the health declared for
  its `target.env`; only when there is none does Den GET `target.url`, up when
  the status is one of `target.expect` (a code or a list, 100–599; default
  any 2xx). Its health row's label names the target (`dev · AWS`).
- **`production_envs`** in the org config: the envs that count as production
  (default `[prod, production]`).

### Changed

- **`/api/health` rows: `url` is only ever a URL.** A shell health check's
  command (a compose stack's `<cli> stack health …`, or any declared shell
  check) is now in a new `check` field and `url` is null; the UI shows the
  same tooltips as before. Clients that read the command from `url` should
  read `check`.
- `/api/server-info` returns Den's `version`.
- **Nothing runs a command on a remote service.** `/api/service/exec`,
  `<cli> up|down|restart`, workspace up and down, and `<cli> up`'s plan refuse
  it (`runs in dev (AWS); nothing to start here`; a `down` succeeds with
  nothing to stop). The MCP guard `runsLocally()` reads `runs`. Security
  `auto_targets` excludes remote services explicitly, a remote service is
  never scanned as if it were local, and one whose `target.env` counts as
  production is never scanned at all.
- **Overrides may add placement.** `runs` and `target` are the one thing a
  `manifests/<repo>.override.yml` may add to a service its base has.
- `validate` checks env names: a `runs` key or `target.env` that is not one of
  the org's `environments` is an error.
- `<cli> status` keeps a hybrid repo's remote service as its own row instead
  of rolling it into the entrypoint.

### Fixed

- **Logs of compose-stack services.** The live tail (`/api/service/taillog`,
  so the UI's log view and `logs_tail`), log history and search
  (`logs_search`) and `<cli> logs` now find a stack service's container,
  `<stack>-<workspace>-<service>-1`, through the stacks naming helpers. They
  looked only for opctl containers, so they fell back to the startup log
  ("container log unavailable") or found nothing.
- **`<cli> mcp` against an older web server.** A tool whose route the web
  server predates (`stacks`, `edge_status`, a security `run_tests`) now says
  `web server is Den <x>; <tool> needs >= <y>: run <cli> web restart`
  instead of a bare 404; other 404s name the tool and the route.
- Sync never touches a dev-managed checkout: a managed entry whose path is,
  holds or sits inside one is refused with the reason, and naming a
  dev-managed repo says so instead of doing nothing.
- The What's new dialog showed every changelog bullet cut off mid-sentence.
- With nothing run yet, the empty output pane no longer takes 200px from the
  Local Dev page.
- A security run's mode chosen on the Tests page (`api`, `full`) now reaches
  the scan; it always ran `baseline` before.

### Security

- Dependency advisories: `npm audit fix` plus `@cursor/sdk` 1.0.23 → 1.0.40
  (drops its `undici` 5 / `zod` 3 tree) clear every critical and high
  advisory. Left: a `minimatch` ReDoS under `openapi-typescript` (only fix is
  a downgrade to 6.x; it matches local config globs only) and dev-only
  tooling (jest, eslint) moderates.

### Migrations

- None required: with no override files, manifests resolve as in 0.1.0.
- To let agents act through `<cli> mcp`, add `mcp.actions` to the org config.
- Placement needs no change: without `runs`, services keep working as
  before. A service with an HTTP health URL, no commands, and nothing else
  in its repo that runs here now shows as remote; add `runs: { local: local }`
  if it is really on this machine. To
  mark more envs as production than `prod` and `production`, set
  `production_envs`.


## [0.1.0] - 2026-11-04

The first Den release: one engine for local development, tests and releases
across an organisation's repos, shipped as `@monster-orange/den` and used
through thin distributions that pin an exact version.

### Added

- **`den create <name> [dir]`** (also `npx @monster-orange/den create`)
  scaffolds a distribution: `den.yml`, a `package.json` pinning this exact
  Den, a `bin/<cli>` shim, a Makefile including `make/den.mk`, an org config
  with a brand, and empty `manifests/` and `tests/pillars/`.
  `examples/distribution/` is its output for `acme`. See
  `docs/distributions.md`.
- **Den runs as an installed package.** Den's own files resolve from the
  engine root (`node_modules/@monster-orange/den`), the distribution's from
  its root; scripts run with Den's tsx, never through `npx` or the current
  directory. The package ships `src/` and runs it with tsx (a dependency
  now); CI proves it with `scripts/dist-smoke.sh`.
- **Org > Application > Repo > Services.** Declared applications (config
  `applications:` or a manifest's `application:`) group repos; the Local Dev
  graph boxes each one inside its org's frame, next to the connected groups of
  repos that are their own application.
- **Security scans keep a latest record.** Every run writes
  `reports/security/<env>/latest-<mode>.json`; the Tests page shows it, with
  findings marked new since the previous run.
- **Repo suites** (`tests:` in a manifest) run from the Tests page and CLI.
- **Edge opt-ins**: a project CA and route certificates are opt-in; with none
  set, the rendered edge is unchanged.

- **launchd service from a distribution.** `service/install.sh` ships in the
  package and runs from `DEN_ROOT`; `DEN_SERVICE_LABEL` and `DEN_SERVICE_LOGS`
  keep an existing label and log folder; `print` shows the plist.

### Migrations

From the engine this release was generalised from:

- Run Den from the package: a `bin/<cli>` shim that sets `DEN_ROOT` to the
  distribution and execs `node_modules/@monster-orange/den/bin/den`, and a
  Makefile that does `include node_modules/@monster-orange/den/make/den.mk`
  (`den create` writes both; `docs/distributions.md` shows them).
- Add `den.yml` at the distribution root with `product: { name: <your name> }`.
  Env vars, the config and manifest file names, the state, managed-clone and
  workspace directories all derive from that name, so an existing install
  keeps every on-disk and env name by naming itself as before.
- Workspace mode `<name>-managed` is now `managed`. Old values are still
  read, and rewritten on the next save.
- The CLI command `use-<name>` is now `use-managed`.
- `github_org` has no default: set it in the org config.
- The shared local-infra repo is configuration: `graph.infra: { repo,
  signals }`. Without it no infra edges are derived. The default-workspace
  entry repo is `defaults.workspace.entry`.
- Perf suites come from the distribution (`tests/pillars/perf/<module>/test.js`)
  or from repo manifests; Den ships none.
- Service and setup make targets are `<prefix>-up`, `-status`, … where the
  prefix is `DEN_TARGET_PREFIX` (set before including `make/den.mk`; `den
  create` sets it to the CLI name, so `make <name>-up` keeps working).
- `service_env` has no built-in entries: a shared-infra secrets file is
  configured as `service_env: { <KEY>: "{repo:<infra repo>}/<path>" }`.
- The smoke and browser make targets have no default repo: pass `repo=<repo>`.
