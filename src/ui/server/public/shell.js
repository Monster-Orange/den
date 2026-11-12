/**
 * The shell (0.3.0-dev.14, rail rebuilt in 0.3.0-dev.17): one top bar and
 * one left rail, the same on every page. A page holds only its content;
 * its markup starts with
 *
 *   <div id="den-shell" data-page="<id>"></div>
 *   <script src="/shell.js"></script>
 *
 * A classic script, run where it stands: the frame is in the DOM before the
 * page's own scripts look for #health, #env-sel, #version-pill or #ws-pill.
 * header.js then drives it (health row, changelog, workspace and env
 * pickers); appearance.js adds ◐ at the end of the bar.
 *
 * The acceptance bar is the shell prototype (den-merge-notes/shell-proto/
 * den-shell.html): its sizes, weights, spacing and states are ported here
 * as they are, its colors mapped onto the theme tokens (--r-btn is
 * --radius-button, --bar-grad is --bar). scripts/shell-fidelity.mjs
 * measures the two side by side.
 *
 *   top bar  ☰ (narrow) · brand mark and title · the scope breadcrumb
 *            (R4, dev.18): / ORG <org> ▾ / WORKSPACE <ws> ▾ / ENV <env> ▾,
 *            each part an .ib button with a .pop menu (an ARIA menu: ↑/↓,
 *            Home, End, Enter; Escape and a click outside close it) ·
 *            the ⌘K search field (R5) · the status chip (R6) · the Runs
 *            chip (R7) · the sudo chip (R8, only while asked) · What's new · ◐ ▾ (R10).
 *            shell.js draws them; topbar.js (through header.js) drives the
 *            chips, the command palette (R17), the status drawer (R15) and
 *            the admin-password prompt; appearance.js the user menu (dev.20).
 *   rail     Pinned, then the NAV registry by GROUPS (Develop, Verify,
 *            Ship, a distribution's own), then Settings and the collapse
 *            toggle. One tab stop (the current page); ↑/↓, Home and End
 *            move within it, Delete unpins a pinned row. Collapsed: icons
 *            only, the headings kept for screen readers. Below 720px it is
 *            a drawer behind ☰.
 *
 * The registries and the scope (window.denShell, the spec's NAV and GROUPS):
 *   registerGroup({ id, label, order, from? })
 *   registerNav({ id, label, icon, group, order, href, badge?(state),
 *                 when?(state) })   a non-number order warns
 *                 (console.warn); a page whose group isn't registered
 *                 waits for it, and warns only if the group is still
 *                 missing a tick after the queue has drained
 *   registerSettingsCategory({ id, label, order, description?, from? })
 *   registerSetting({ id, category, label, description, keywords, scope,
 *                 control, read, write?, keys? })   the SETTINGS registry
 *                 (R21): the Settings page (/settings) draws every row
 *                 from it. scope is "user", "workspace" or "distribution";
 *                 a distribution row is read-only (no write). Any change
 *                 fires `den:settings` on window. Each row is also a ⌘K
 *                 palette command (kind "setting", id "setting:<id>"):
 *                 Enter opens /settings?q=<label>#<category>.
 *   settings(), settingsCategories()  the registry, categories by order
 *   setNavPrefs({ hidden?, order? }), setPins(ids), setCollapsed(bool)
 *                 Navigation (R21): the rail pages hidden, their order,
 *                 the pins; saved to /api/settings `shell`
 *   addMessages(lang, { key: text }), t(key, vars)
 *   setState(partial): health { repo|address: state }, openLogs, …
 *   pin(id), unpin(id), isPinned(id): pins are user prefs (/api/settings
 *   `shell.pins`), nothing else. Any change fires `den:pins` on window
 *   (detail { pins }), and every [data-pin-toggle] repaints from it.
 *   setOrg({ id, title })            one org: a static label, no menu (C4)
 *   setOrgs([{ id, title, workspaces? }], currentId, onSelect?)
 *                                    two or more: the Org ▾ menu; a pick
 *                                    calls onSelect(id), fires `den:org`
 *   setWorkspaces({ label, title, items, focus, names, onSelect })
 *                                    the Workspace ▾ menu (header.js)
 *   workspaceNames()                 every workspace's name, from it
 *   syncEnv()                        repaint Env ▾ from #env-sel
 *   registerCommand({ id, label, keywords?, kind?, run, href? })
 *     href: the page run() goes to, if any; ⌘K's ⌘/Ctrl-Enter opens it
 *     in a new tab (H4)
 *                                    a ⌘K palette row (R17, dev.20). label
 *                                    is a string or a function returning
 *                                    one; keywords a string or an array;
 *                                    kind "action" (the default), "setting"
 *                                    (the Settings registry's rows, dev.19)
 *                                    or any word, shown as the row's kind
 *                                    label. Pages, services and apps are
 *                                    added by the palette itself.
 *   unregisterCommand(id), commands()
 *   openMenu(anchor, menu)           a .pop menu below anchor (the scope
 *                                    parts' and the user menu's)
 *   topLayer.show(el, anchor, opts)  a page's own menu in the top layer
 *                                    (0.4.17), placed by anchor; hide(el)
 *
 * Loading before shell.js: push functions onto window.denShellQueue (an
 * array); each runs with denShell once it exists, and a later push runs at
 * once. `den-shell:ready` fires on window when the shell is up.
 *
 * Every page wraps its content in <main id="den-content">, its one main
 * landmark (the skip link's target). Its one h1 is the page's own (the
 * brand title is a span); a page without one gets a visually hidden h1
 * named from its <title>.
 *
 * data-health-env pins the health row's env on pages that are local by
 * nature (Workspaces, Releases), whatever the env picker says.
 *
 * Every color and font is a theme token.
 */
(function () {
  "use strict";
  // ── i18n (R19, 0.3.0-dev.39) ───────────────────────────────────────────
  // Every word the shell shows is a key in MESSAGES, looked up with
  // t(key, vars). en is here, the fallback for any key a catalog lacks;
  // every other language is a classic script, /i18n/<lang>.js, that the
  // server loads before this one for a page in that language (with
  // <html lang>, ui-language.ts), adding its table to window.denMessages.
  // A page, a plugin or a distribution adds its own keys with
  // denShell.addMessages(lang, table).
  //
  //   {name}       a var; a number is formatted by Intl.NumberFormat
  //   key.one      the plural form t(key, { n }) uses where Intl.PluralRules
  //                says "one" for n (any CLDR category works: key.few, …)
  //
  // Names (services, workspaces, repos, themes, languages), logs and
  // command output are never translated. tests/unit/server/i18n.test.ts
  // fails when a key is missing from any catalog.
  var MESSAGES = (window.denMessages = window.denMessages || {});
  MESSAGES.en = {
    "g.pinned": "Pinned",
    "g.develop": "Develop",
    "g.verify": "Verify",
    "g.ship": "Ship",
    "n.workspaces": "Workspaces",
    "n.graph": "Graph",
    "n.services": "Services",
    "n.logs": "Logs",
    "n.tests": "Tests",
    "n.environments": "Environments",
    "n.releases": "Releases",
    "n.edge": "Edge",
    "n.settings": "Settings",
    "k.org": "Org",
    "k.ws": "Workspace",
    "k.env": "Env",
    scope: "Scope",
    "org.title": "Org: {title}",
    "org.titleId": "Org: {title} ({id})",
    "ws.all": "All active",
    "ws.focus": "CLI default",
    "ws.focusTip":
      "CLI commands run here when you don't name a workspace. Picking a workspace in the top bar also makes it the CLI default.",
    "ws.pickTip":
      "Picking a workspace here also makes it the CLI default, so __DEN_CLI__ commands run there.",
    "ws.none": "No active workspaces",
    "ws.manage": "Manage workspaces…",
    "ws.allN": "All active ({n})",
    "ws.allTip":
      "Every active workspace; a service several define is listed once",
    "ws.noneLabel": "none",
    "ws.viewTitle":
      "View: what every page shows ({ws}). A view filter only: it starts, stops and routes nothing.",
    "ws.viewTitleFocus":
      "View: what every page shows ({ws}). It starts, stops and routes nothing. CLI default: {focus}.",
    "ws.viewFailed": "Could not change the view: {msg}",
    "ws.focusFailed": "Could not change the CLI default: {msg}",
    // A count's singular is its .one (0.3.0-dev.40: en had none, so the org
    // menu said "1 workspaces").
    "org.n": "{n} workspaces",
    "org.n.one": "{n} workspace",
    from: "from {d}",
    "b.logs": "{n} open",
    "b.logs.one": "{n} open",
    "b.down": "{n} down",
    "b.down.one": "{n} down",
    "act.pin": "Pin",
    "act.unpin": "Unpin",
    "act.visit": "Visit",
    "act.visitX": "Visit {s} (opens a new tab)",
    "act.pinX": "Pin {s}",
    "act.unpinX": "Unpin {s}",
    "toast.pinned": "Pinned {s}",
    "toast.unpinned": "Unpinned {s}",
    // 0.4.18: the service panel (svc-panel.js) and Start's Folder.
    "svp.label": "{s}: quick panel",
    "svp.more": "Quick panel for {s}",
    "svp.notRunning": "Not running",
    "svp.up": "up {d}",
    "svp.upNow": "up",
    "svp.down": "down: {c}",
    "svp.downNone": "down",
    "svp.starting": "starting…",
    "svp.stopped": "stopped",
    "svp.noUrl": "No URL",
    "svp.start": "Start",
    "svp.stop": "Stop",
    "svp.restart": "Restart",
    "svp.logs": "Logs",
    "svp.stopping": "Stopping {s}",
    "svp.tests": "Last test run",
    "svp.testsOk": "✓ {t}",
    "svp.testsBad": "✗ failed {t}",
    "svp.testsRun": "running…",
    "svp.testsNone": "—",
    "svp.runTests": "Run tests",
    "svp.testsDone": "Tests passed: {s}",
    "svp.testsFailed": "Tests failed: {s}",
    "svp.agents": "Agents",
    "svp.noAgents": "No agents in this repo.",
    "svp.open": "Open",
    "svp.openAg": "Open {s}",
    "svp.startHere": "Start agent here",
    "svp.openSvc": "Open in Services",
    "svp.openGraph": "Open in Graph",
    "graph.outside": "{s} is in {ws}, outside this View.",
    "graph.showWs": "Show {ws}",
    "svp.close": "Close",
    "ag.new.folder": "Folder (optional)",
    "ag.new.folderHelp":
      "Inside the workspace's folder. Empty: the workspace's own.",
    collapse: "Collapse",
    expand: "Expand",
    menu: "Menu",
    skip: "Skip to content",
    pages: "Pages",
    // The top bar (dev.20): the prototype's strings.
    "search.ph": "Search pages, services, actions…",
    "status.checking": "Checking…",
    "status.none": "No services",
    "status.unchecked": "{n} not checked",
    "status.all": "All {n} healthy",
    "status.all.one": "{n} healthy",
    "status.some": "{ok}/{n} healthy",
    "status.down": "{n} down",
    "status.down.one": "{n} down",
    "status.title": "{n} checked",
    "status.title.one": "{n} checked",
    "status.pending": "{n} pending",
    "status.pending.one": "{n} pending",
    "status.awaiting": "{n} still checking",
    "status.unknown": "Status unknown",
    "status.unknownTip":
      "Den's server isn't responding, so service health is unknown",
    // What a check said (the words; the URL and the error are output).
    "chk.awaiting": "still checking",
    "chk.pending": "{what} — pending",
    "chk.check": "check",
    "chk.unchecked": "not checked",
    "chk.healthy": "healthy",
    "chk.down": "down",
    "chk.pendingWord": "pending",
    "chk.checking": "checking…",
    ms: "{n} ms",
    "fix.failedAt": "{line} · failed at {at}",
    "fix.start": "Start",
    "fix.startX": "Start {s}",
    "fix.logs": "Logs",
    "fix.logsX": "Logs of {s}",
    "row.name": "{id}, {state}",
    "row.nameMs": "{id}, {state}, {ms}",
    // The status drawer (R15).
    "drawer.title": "Status",
    "drawer.refresh": "Check again",
    "drawer.close": "Close",
    "drawer.attention": "Needs attention",
    "drawer.nothing": "Nothing needs attention.",
    "drawer.everything": "Everything",
    "drawer.okTip": "{ok} of {n} checked services healthy",
    "drawer.okTip.one": "{ok} of {n} checked service healthy",
    "toast.openWs": "Open Workspaces to run this",
    // The command palette (R17).
    "kind.page": "Page",
    "kind.service": "Service",
    "kind.app": "App",
    "kind.action": "Action",
    "kind.setting": "Setting",
    "kind.workspace": "Workspace",
    "pal.goWs": "Go to workspace {ws}",
    "pal.repos": "{n} repos",
    "pal.repos.one": "{n} repo",
    "pal.restart": "Restart {s}",
    "pal.results": "Results",
    "pal.move": "↑↓ to move",
    "pal.open": "↵ to open",
    "pal.newTab": "{mod}↵ new tab",
    "pal.close": "esc to close",
    "pal.none": "No matches",
    "pal.count": "{n} results",
    "pal.count.one": "{n} result",
    // The runs chip and dock (R7, R16).
    "runs.title": "Runs",
    "runs.n": "{n} running",
    "runs.aria": "Runs, {n} running",
    "runs.last": "Last run: {s}",
    "runs.none": "No runs",
    "runs.empty": "Nothing has run yet. Output from any page lands here.",
    "runs.toast": "Nothing has run yet. A page's output shows here.",
    "runs.all": "All runs",
    "runs.allTip": "Showing {ws}'s runs; press for every run",
    "runs.allOn": "Showing every run; press for {ws}'s only",
    "dock.done": "done in {s}s",
    "dock.failed": "failed in {s}s",
    "dock.close": "Hide runs",
    "dock.show": "Show runs",
    "dock.copy": "Copy",
    "dock.copied": "Copied!",
    "dock.clear": "Clear",
    "dock.closeRun": "Close {s}",
    "dock.err": "failed",
    "dock.last": "Last run: {s} ↗",
    "dock.resize": "Drag to resize",
    // The admin password, asked only when a command needs sudo (R8, LK-0).
    "lock.waiting": "Admin password needed",
    "lock.needs": "{cmd} needs your admin password",
    "lock.cmd": "A command",
    "lock.cfg":
      "Saving the password is off: set secrets.provider and secrets.refs.sudo in {file}.",
    "lock.update": "Update stored password",
    "lock.saveTo": "Save to {s}",
    "lock.pw": "Admin password",
    "lock.go": "Continue",
    "lock.checking": "Checking…",
    "lock.note": "Den uses it only for sudo. Agents can't enter it.",
    "lock.saved": "Admin password kept for this session",
    "lock.savedTo": "Admin password kept for this session and saved to {s}",
    "lock.saveFailed": "Kept for this session, but saving to {s} failed: {err}",
    "lock.wrong": "Incorrect password — try again",
    "lock.reqFailed": "Request failed — is the server running?",
    // What's new (R9) and the stale-server pill.
    "v.title": "View changelog",
    "cl.title": "What's new",
    "cl.close": "Close",
    "cl.gotIt": "Got it",
    "cl.none": "No entries found.",
    "cl.copyMd": "Copy as Markdown",
    "cl.copyMdX": "Copy v{v} as Markdown",
    "cl.copySlack": "Copy for Slack",
    "cl.copySlackX": "Copy v{v} for Slack",
    "cl.copyFailed": "Copy failed — try again",
    "cl.latest": "Show latest only",
    "cl.all": "Show all versions ({n} earlier)",
    "cl.all.one": "Show all versions ({n} earlier)",
    "stale.title":
      "This {cli} web server is running code older than your working tree — click to restart and pick up your changes. Running deploys continue on GitHub; an open deploy log reattaches after the reload.",
    "stale.aria": "Stale server: restart",
    "stale.label": "stale server",
    "stale.restart": "Restart",
    "restart.msg": "Restarting {cli} web…",
    "restart.hint": "Reconnecting — this page will reload automatically.",
    "restart.still":
      "Still restarting… if this persists, run {cmd} in a terminal, then reload.",
    // The user menu (R10) and its palette commands (R17).
    "um.label": "Appearance",
    "um.title": "Appearance and theme",
    "um.appearance": "Appearance",
    "um.system": "System",
    "um.dark": "Dark",
    "um.light": "Light",
    "um.theme": "Theme",
    "um.language": "Language",
    "um.all": "All settings",
    "cmd.appearance": "Appearance: {mode}",
    "cmd.theme": "Theme: {name}",
    "cmd.language": "Language: {name}",
    "theme.orgDefault": "Org default ({name})",
    "theme.pinned": "{name} (pinned)",
    "theme.notInstalled":
      "Your theme {id} isn't installed, so {inUse} is in use",
    "theme.invalid":
      "Your theme {id} isn't valid ({why}), so {inUse} is in use",
    "theme.invalidBare": "Your theme {id} isn't valid, so {inUse} is in use",
    // Errors (R26, 0.3.0-dev.38).
    "api.network": "Den's server didn't answer {what}",
    "api.failed": "{what} failed",
    "api.request": "Request {id}",
    "api.retry": "Retry",
    "api.copy": "Copy details",
    "api.copied": "Copied",
    "api.close": "Dismiss",
    "api.retried": "Done",
    "net.down": "Den's server isn't responding — retrying",
    "net.next": "next try in {s}s",
    "net.now": "Retry now",
    "engine.stale":
      "Den was updated to {onDisk}. This server is still running {loaded}. Restart it: {cli} web restart (or your service restart).",
    "engine.title": "Restart needed",
    // The error page (R26a, error-page.js).
    "err.404.title": "Page not found",
    "err.404.sub": "Nothing here at {path}",
    "err.404.lead": "There is no page at this address.",
    "err.404.mean": "Did you mean {page}?",
    "err.404.stale":
      "This page may be new in Den {onDisk}: the server is still running {loaded}.",
    "err.404.plugin":
      "This page belongs to the {name} plugin, which isn't installed in this distribution.",
    "err.404.pluginLocked":
      "This page belongs to the {name} plugin. It is in plugins.lock.json, but its files are missing.",
    "err.404.pluginNoPage":
      "The {name} plugin is installed, but it has no page here.",
    "err.404.workspaces": "Go to Workspaces",
    "err.404.search": "Search",
    "err.404.pages": "Pages",
    "err.500.title": "Something went wrong",
    "err.500.sub": "{what} failed on the server",
    "err.500.lead":
      "The server hit an error answering this page. Retry, or copy the details for a report: the server log has the full error under the same request id.",
    "err.500.what": "What failed",
    "err.500.time": "Time",
    "err.500.id": "Request id",
    "err.500.version": "Version",
    "err.421.title": "Wrong address",
    "err.421.lead":
      "This server answers only on its own addresses, so a page on another name can't reach it.",
    "err.421.open": "Open on localhost",
    "err.refused.title": "Request refused",
    "err.signin.terminal": "Sign in to use the terminal",
    "err.signin.agents": "Sign in to start agents",
    "err.signin.sub": "This browser isn't signed in",
    "err.signin.lead": "Run {cmd} and open the link.",
    "err.signin.expiredTitle": "Sign-in link expired",
    "err.signin.local":
      "A sign-in belongs to one address. This page is on {host}: open the same page on localhost, where this browser is signed in.",
    "err.signin.copy": "Copy command",
    "err.signin.title": "Sign in to {name}",
    "err.signin.where":
      "You're opening {name} from another computer. {name} runs on {host}, so it needs to know this is you.",
    "err.signin.ghStep1":
      "On {host}, run {cmd}, or use Settings › Access there.",
    "err.signin.ghStep2":
      "It shows a code. Enter it at github.com/login/device and approve.",
    "err.signin.ghStep3":
      "Then come back here and press Sign in with GitHub, with the same GitHub account.",
    "err.signin.ghOwner": "Owner: @{login}",
    "err.signin.ghOnly":
      "Only the owner's GitHub account can sign in this way. For anyone else, use Approve this computer.",
    "err.signin.ghLearn": "Learn more",
    "err.signin.claimTitle": "Connect your GitHub account",
    "err.signin.claimLead":
      "{name} has no owner yet. Connect your GitHub account to make it yours.",
    "err.signin.claimOrg":
      "Members of the {org} GitHub org can claim it, in a browser on {host}.",
    "err.signin.claimHere": "This is my computer: connect GitHub",
    "err.signin.claimHereOn": "On {host} itself: connect GitHub",
    "err.signin.claimOrgOnly":
      "Members of the {org} GitHub org can claim it, from a browser on {host}. Open this page on {host}, or set web.owner_github to sign in from anywhere.",
    "err.signin.claimAs": "Sign in as @{login}",
    "err.signin.claimChecking": "Checking this is {host}…",
    "err.signin.githubRefused":
      "@{login} isn't the owner of this {name}. Only the owner's account can use Sign in with GitHub. Use Approve this computer instead.",
    "err.signin.approveOr": "Or approve this computer",
    "err.signin.approve": "Approve this computer",
    "err.signin.step1": "On {host} (not this computer), run:",
    "err.signin.step1Or":
      "Or open {name} on {host} itself and go to Settings › Access › Waiting devices.",
    "err.signin.step2":
      "This page signs you in by itself once approved. The code expires in 10 minutes.",
    "err.signin.waiting": "Waiting for approval…",
    "err.signin.windowsSteps":
      "Open Windows Terminal or PowerShell, paste this, and press Enter.",
    "err.signin.nothingOpened":
      "Nothing opened? Copy the command below and paste it into your terminal app.",
    "err.signin.noTerminal":
      "Don't have a terminal on {host}? From this computer, run:",
    "err.signin.openTerminal": "Open Terminal",
    "err.signin.sshUserNote":
      "Log in with your {host} account ({user}) and its password, or an SSH key.",
    "err.signin.sshNote":
      "Open Terminal opens ssh://{target} in your terminal app. It needs SSH access to {target}.",
    "err.signin.whyTitle": "Why?",
    "err.signin.whyText":
      "{name} can start terminals and agents on {host}, so it only lets in people who prove they're the owner. You only do this once per computer: you stay signed in.",
    "err.signin.other": "Other ways (the one-time link with {cmd})",
    "err.signin.otherStep":
      "On {host} (not this computer), run this, then open the link it prints in this browser:",
    "err.signin.codeExpired": "This code expired.",
    "err.signin.codeDenied": "This computer was denied on {host}.",
    "err.signin.codeFailed": "{name} didn't give this page a code. Try again.",
    "err.signin.newCode": "Get a new code",
    "err.signin.youreIn": "You're in.",
    "err.signin.expiredLead":
      "That sign-in link expired or was used. Sign in again below.",
    "err.signin.confirmLead":
      "Enter the code that web login printed on {host}:",
    "err.signin.confirmGo": "Sign in",
    "err.signin.confirmWrong":
      "That code isn't right. Check what web login printed and try again.",
    "err.signin.confirmBusy": "Too many tries. Wait a minute and try again.",
    "err.signin.confirmGone":
      "This link no longer works. On {host}, run web login again for a new one.",
    "err.signin.confirmWhy":
      "The link alone isn't enough: it needs the code shown on {host} too, so a link someone else sees can't sign them in.",
    "err.signin.github": "Sign in with GitHub",
    "err.signin.githubEnter": "Enter this code at {url}:",
    "err.signin.githubOpen": "Open GitHub",
    "err.signin.githubWaiting": "Waiting for you to approve it on GitHub…",
    "err.signin.githubDone": "Signed in. Loading…",
    "err.signin.githubExpired": "The code expired before it was approved.",
    "err.signin.githubDenied": "The request was cancelled on GitHub.",
    "err.signin.githubBusy":
      "Too many sign-ins are in progress. Try again in a few minutes.",
    "err.signin.githubFailed": "GitHub couldn't be reached. Try again.",
    "err.signin.githubAgain": "Start again",
    "err.422.title": "Config is invalid",
    "err.422.sub": "The distribution config fails validation",
    "err.422.lead":
      "Pages that read the config wait until it validates. Fix each key below; Settings and Logs still work meanwhile.",
    "err.422.file": "File",
    "err.422.key": "Key",
    "err.422.problem": "Problem",
    "err.422.cmd": "To see the same in a terminal, run:",
    "err.422.reload": "Reload once fixed",
    "err.422.logs": "Open Logs",
    "err.422.settings": "Open Settings",
    // The Settings registry's built-in rows, as the palette shows them
    // (set.<row id>; settings-registry.js keeps the English label).
    "set.appearance.mode": "Mode",
    "set.appearance.theme": "Theme",
    "set.language": "Language",
    "set.appearance.org-theme": "Org default theme",
    "set.editor": "Default IDE",
    "set.editor.open": "Open file links in",
    "set.editor_overrides": "Per-language IDE",
    "set.terminal": "Default terminal",
    "set.shell.pages": "Pages",
    "set.shell.pins": "Pinned",
    "set.shell.collapsed": "Collapse the rail",
    "set.shell.dock": "Open the runs dock",
    "set.graph.workspaces": "Workspace list",
    "set.graph.groupBy": "Group repos by",
    "set.graph.direction": "Direction",
    "set.graph.group": "Frames",
    "set.graph.density": "Cards",
    "set.graph.panelWidth": "Details panel",
    "set.workspace.editor": "IDE for this workspace",
    "set.agents.runtimes": "Runtimes",
    "set.agents.layout": "Agents tab layout",
    "set.cli.local_dev": "Local environment",
    "set.cli.cli_tabs": "Terminal tabs",
    "set.cli.log_window_lines": "Log pane lines",
    "set.cli.web_port": "Your web port",
    "set.cli.signin": "Browser sign-in",
    "set.cli.sudo": "Admin password",
    "set.cli.op_token": "1Password token source",
    "set.access.owner": "Owner",
    "set.access.devices": "Linked devices",
    "ident.local": "Local",
    "ident.device": "Signed in · this device",
    "ident.toast": "This device is signed in to {name} on {host}",
    "set.access.waiting": "Waiting devices",
    "set.access.machine_name": "Machine name",
    "set.access.pair": "Pair a device",
    "set.distribution.brand": "Product name",
    "set.distribution.github_org": "GitHub org",
    "set.distribution.orgs": "Org labels",
    "set.distribution.web_port": "Web port",
    "set.distribution.environments": "Environments",
    "set.distribution.domain": "Edge domain",
    "err.retry": "Retry",
    "err.copy": "Copy details",
    "err.copied": "Copied",
    // The Workspaces page's Agents section (AG-4a, agents-section.js).
    "ag.title": "Agents",
    "ag.caption": "Agents in {ws}",
    "ag.count": "{n} agents",
    "ag.count.one": "{n} agent",
    "ag.col.agent": "Agent",
    "ag.col.runtime": "Runtime",
    "ag.col.state": "State",
    "ag.col.cwd": "Directory",
    "ag.col.started": "Started",
    "ag.col.actions": "Actions",
    "ag.loading": "Loading agents…",
    "ag.none": "No agents in this workspace yet",
    "ag.personaOf": "persona {persona}",
    "ag.state.running": "running",
    "ag.state.stopping": "stopping…",
    "ag.state.stopped": "stopped",
    "ag.state.ended": "ended",
    "ag.state.exited": "exited",
    "ag.state.exitedCode": "exited ({code})",
    "ag.stop": "Stop",
    "ag.resume": "Resume",
    "ag.stopName": "Stop {id}",
    "ag.resumeName": "Resume {id}",
    "ag.start": "+ Start agent",
    "ag.persona": "Persona",
    "ag.runtime": "Runtime",
    "ag.runtime.auto": "The persona's",
    "ag.runtime.default": "{name} (persona default)",
    "ag.unavailable": "unavailable",
    "ag.go": "Start",
    "ag.starting": "Starting…",
    "ag.cancel": "Cancel",
    "ag.started": "Started agent {id}",
    "ag.stopped": "Stopped agent {id}",
    "ag.stillStopping": "{id} is still stopping",
    "ag.resumedFresh": "{id}: nothing to resume yet; started fresh",
    "ag.inactive": "Workspace {ws} isn't active",
    "ag.switchWs": "Switch to {ws}",
    "ag.unknownWs": "(no workspace has that name)",
    "ag.resumed": "Resumed agent {id}",
    "ag.state.interrupted": "interrupted",
    "ag.why.stopped": "Stopped by you {time}",
    "ag.why.interrupted": "Interrupted: {name} restarted",
    "ag.why.exited": "Exited",
    "ag.why.exitedCode": "Exited (code {code})",
    "ag.fresh": "Start fresh",
    "ag.freshName": "Start {id} fresh",
    "ag.startedFresh": "Started {id} fresh",
    "ag.remove": "Remove",
    "ag.removed": "Removed {id}",
    "ag.removedMany": "Removed {n} stopped agents",
    "ag.removedMany.one": "Removed {n} stopped agent",
    "ag.undo": "Undo",
    "ag.restored": "Back in the list: {ids}",
    "ag.clear": "Clear stopped",
    "ag.noResume": "{runtime} can't resume a conversation",
    // Session rotation (den#4).
    "ag.rot.ready": "Ready to relaunch ({why})",
    "ag.rot.due": "Handoff due ({why})",
    "ag.rot.compactions": "{n} compactions",
    "ag.rot.compactions.one": "{n} compaction",
    "ag.rot.merged": "PR merged",
    "ag.rot.noHandoff":
      "Its session rotated ({why}), but it wrote no handoff.md. Resume it to write one, or start fresh.",
    "ag.rot.badHandoff":
      "Its session rotated ({why}), but its handoff.md is not complete. Resume it to fix it, or start fresh.",
    "ag.relaunch": "Relaunch now",
    "ag.relaunchName": "Relaunch {id} now",
    "ag.relaunched": "Relaunched {id} from its handoff",
    "ag.rc.autoAsk":
      "Due ({why}). Den asks it for its handoff when it is idle, then relaunches it.",
    "ag.rc.autoReady":
      "Due ({why}). Its handoff is ready: Den relaunches it when it is idle.",
    "ag.rc.ready": "Due ({why}). Its handoff is ready.",
    "ag.rc.missing": "Due ({why}). It has no handoff yet.",
    "ag.rc.bad": "Due ({why}). Its handoff is not complete.",
    "ag.rc.fellBack": "Due ({why}). It wrote no handoff after 2 asks.",
    "ag.rc.wanted":
      "Due ({why}). Den relaunches it once its handoff is written.",
    "ag.rc.write": "Write handoff",
    "ag.rc.writeName": "Ask {id} to write its handoff",
    "ag.rc.keep": "Keep this conversation",
    "ag.rc.keepName": "Keep {id}'s conversation",
    "ag.rc.never": "Don't ask again for this agent",
    "ag.rc.settings": "Settings",
    "ag.rc.from":
      "Rotates after {n} compactions ({src}); when due: {mode} ({src2})",
    "ag.rc.fellBackBad":
      "Due ({why}). Its handoff still fails the check after 2 asks.",
    "ag.rc.from.one":
      "Rotates after {n} compaction ({src}); when due: {mode} ({src2})",
    "ag.rc.fromNever": "Never rotates ({src}); when due: {mode} ({src2})",
    "ag.rc.midTurn": "{id} is mid-turn: ask again when its turn ends",
    "ag.rc.neverN": "never",
    "ag.rc.mode.auto": "relaunch by itself",
    "ag.rc.mode.ask": "ask",
    "ag.rc.mode.off": "nothing",
    "ag.rc.menu": "Rotation settings",
    "ag.rc.noState": "No rotation yet: it counts from its next start.",
    "ag.rc.asked": "Asked {id} for its handoff",
    "ag.rc.askedRelaunch":
      "Asked {id} for its handoff. Den relaunches it once it passes.",
    "ag.rc.askedResumed":
      "Resumed {id} to write its handoff. Den relaunches it once it passes.",
    "ag.rc.kept": "Kept {id}'s conversation: its count starts again",
    "ag.rc.keptNever": "Kept {id}'s conversation: it won't rotate again",
    "ag.rc.autoRelaunched":
      "Relaunched {id} from its handoff after {why}. The old conversation {old} is kept.",
    "ag.interrupted": "{n} agents were interrupted when {name} restarted",
    "ag.interrupted.one": "{n} agent was interrupted when {name} restarted",
    "ag.resumeAll": "Resume all",
    "ag.review": "Review",
    "ag.resumedAll": "Resumed {n} agents",
    "ag.resumedAll.one": "Resumed {n} agent",
    "pe.configFirst": "Fix the config first: the personas are read from it.",
    "ag.new.title": "Start an agent",
    "rt.missingLine": "Not found on this machine:",
    "rt.install": "Install…",
    // The Start dialog and personas (AG-10 to AG-13).
    "ag.new.what": "What's a persona?",
    "ag.new.details": "Details: {n}",
    "ag.new.hide": "Hide details",
    "ag.new.newP": "+ New persona",
    "ag.new.plain": "Plain session",
    "ag.new.plainP": "A terminal in the workspace folder. No agent.",
    "ag.new.task": "First instruction (optional)",
    "ag.new.name": "Name (optional)",
    "ag.new.as": "Starts as {id}",
    "ag.new.openRunning": "Open the running one",
    "ag.new.isRunning": "{id} is already running",
    "ag.new.openIt": "Open it",
    "ag.new.isStopped": "{id} is stopped",
    "ag.new.resumeIt": "Resume it",
    "ag.new.orNext": "or Start makes {id}",
    "ag.new.taskPh":
      "e.g. Take the empty-state story. Match the design and add a test.",
    "ag.new.adv": "Advanced: model and permissions",
    "ag.new.advNote":
      "Defaults come from the persona. Changes here apply to this session only, and the session is marked in the list.",
    "ag.new.model": "Model",
    "ag.new.modelDef": "Persona default ({m})",
    "ag.new.ver": "Version",
    "ag.new.verDef": "Persona default ({v})",
    // AG-17.1, Bring in.
    "ag.bring": "Bring in",
    "ag.bring.title": "Bring in a conversation",
    "ag.bring.conv": "Conversation",
    "ag.bring.help":
      "Conversations started outside Den in this workspace's folder or its repos' folders, newest first.",
    "ag.bring.none":
      "No conversations started outside Den in this workspace's folder or its repos' folders.",
    "ag.bring.untitled": "Untitled conversation",
    "ag.bring.open": "Open elsewhere",
    "ag.bring.openTip": "Still open in another terminal. Close it there first",
    "ag.bring.agent": "Agent {id}",
    "ag.bring.note":
      "Continues it in the folder it ran in, with Den's tools and guards from now on. It keeps running if you close the pane. Close it in any other terminal first: Den only sees a conversation as open if it was written in the last minute.",
    "ag.keep.model": "Keeps {m} from the conversation.",
    "ag.keep.modelNew": "Runs on {m} from now on.",
    "ag.keep.from":
      "From now on it works as {p}: its role, its permissions ({mode}), Den's tools and guards. Its history stays.",
    "ag.keep.lost":
      "It won't have: {s}. Den runs agents with Den's tools only.",
    "ag.keep.opt": "Keep {m}",
    "ag.keep.optNone": "Keep the model it runs",
    "ag.keep.advNote":
      "The model it runs stays unless you pick another here. Permissions come from the persona.",
    "ag.pc.item": "Change persona…",
    "ag.pc.title": "Change {id}'s persona",
    "ag.pc.note":
      "Den stops it and resumes the same conversation as the new persona. Its id, name, folder and tab stay.",
    "ag.pc.go": "Change persona",
    "ag.pc.going": "Changing…",
    "ag.pc.current": "current",
    "ag.pc.busy": "It's working. Change after this turn, or stop it now?",
    "ag.pc.after": "After this turn",
    "ag.pc.now": "Stop it now",
    "ag.pc.fresh":
      "{id} is now {p}: nothing to resume yet; started fresh (same conversation id, folder and scope)",
    "ag.freshLine":
      "Nothing to resume yet; started fresh (same conversation id, folder and scope)",
    "ag.pc.done": "{id} is now {p}",
    "ag.pc.pending": "{id} becomes {p} when this turn ends",
    "ag.more": "More for {id}",
    "ag.chip.stopped": "Stopped",
    "ag.chip.exited": "Exited",
    "ag.chip.interrupted": "Interrupted",
    "ag.link.none": "No agent {id} here. It may have been removed.",
    "ag.apiOnly": "API only: {names}",
    "ag.apiOnlyTip":
      "This agent reaches {names} only through its API. Den blocks docker exec into it, its volumes and its data, and logs each try. A guardrail, not a security boundary.",
    "ag.apiOnlyOff": "API-only not enforced",
    "ag.apiOnlyOffTip":
      "This runtime has no hook Den can use, so it isn't held to {names}' API. Use den-claude for agents that must be.",
    "ag.mcp.adds": "Hub tools arrive on restart",
    "ag.mcp.addsTip":
      "Hub was connected after this agent started, so it doesn't have Hub's tools yet. Restart keeps its conversation and waits for its turn to end.",
    "ag.mcp.drops": "Hub tools go on restart",
    "ag.mcp.dropsTip":
      "Hub was disconnected after this agent started; its Hub tools no longer work. Restart keeps its conversation and waits for its turn to end.",
    "ag.mcp.restart": "Restart",
    "ag.mcp.restartName": "Restart {id} at its next idle",
    "ag.mcp.restarting":
      "{id} restarts at its next idle, in the same conversation.",
    "ag.det.label": "Details for {id}",
    "ag.det.close": "Close",
    "ag.det.where": "Where",
    "ag.det.ended": "How it ended",
    "ag.det.lastLine": "Its last line",
    "ag.det.lastAsk": "Last ask",
    "ag.det.noAsk": "Nothing asked yet",
    "ag.det.reading": "Reading…",
    "ag.det.compactions": "{n} compactions in this conversation",
    "ag.det.output": "Show its output",
    "ag.det.handoffDue": "Handoff due ({why})",
    "ag.stoppedGroup": "Stopped ({n})",
    "ag.stoppedGroupTip":
      "Agents that aren't running. Open one for its details.",
    "ag.bring.go": "Bring in",
    "ag.bring.going": "Bringing in…",
    "ag.bring.done": "Brought in as {id}",
    "ag.bring.now": "just now",
    "ag.bring.min": "{n} min ago",
    "ag.bring.h": "{n} h ago",
    "ap.title": "{agent} wants to:",
    "ap.agent": "The {name} agent",
    "ap.noAgent": "Something on this machine (no agent identity)",
    "ap.noAgentWarn": "If you didn't ask an agent to do this, Deny.",
    "ap.signin.title": "Something is waiting for your approval.",
    "ap.signin": "Sign in to see it: run {cmd} and open the link.",
    "ap.do.workspace_create": 'Create the workspace "{name}"',
    "ap.do.repo_add": 'Add the repo at {path} to workspace "{workspace}"',
    "ap.do.repo_add.new":
      'Add the repo at {path} to a new workspace "{workspace}"',
    "ap.do.service_try": "Start {service}",
    "ap.do.service_try.activates":
      "Start {service} (this activates {workspace})",
    "ap.says": "Agent says:",
    "ap.review": "Review",
    "ap.hide": "Hide details",
    "ap.later": "Later",
    "ap.deny": "Deny",
    "ap.allow": "Allow",
    "ap.waits": "Nothing changes until you allow it. It waits until {time}.",
    "ap.more": "{n} more waiting",
    "ap.failed": "It ran, and failed: {error}",
    "ap.done": "Done: {what}",
    "ag.new.note":
      "Starts in the workspace folder. It keeps running if you close the pane.",
    "ag.new.started": "Started {p} in {w}",
    "pm.ask": "Ask for everything",
    "pm.edits": "Auto-approve edits in the worktree",
    "pm.all": "Auto-approve all",
    "pm.tag.ask": "asks for all",
    "pm.tag.edits": "auto-approve edits",
    "pm.tag.all": "auto-approve all",
    "ov.runtime": "runtime: {r}",
    "ov.model": "model: {m}",
    "ov.latest": "latest",
    "ov.tools": "custom tools",
    "pe.what":
      "A persona is a saved agent setup: a role, its instructions, a default runtime and model, and what it may do without asking. You can have several with the same role, each with its own name.",
    "pe.preset": "Role preset",
    "pe.extra": "Extra allowed commands",
    "pe.extraS": "extra",
    "pe.extraP":
      "Plain command prefixes, one per line. No patterns or regex. Den translates them for each runtime.",
    "pe.allows": "What this allows on {r}",
    "pe.ns": "not supported on {r}",
    "pe.nsMode": "{r} takes no permission mode from Den yet",
    "pe.nsModel": "{r} takes no model from Den",
    "pe.nsPat": "use a plain prefix, not a pattern",
    "pe.nsBad": "not a plain prefix",
    "pe.badCmd":
      '"{c}" isn\'t a plain command prefix: use letters, digits, single spaces and . _ / : = @ % + , -',
    "pe.raw": "Edit raw runtime config…",
    "pe.rawLater": "Opening a runtime's own config file is coming later.",
    "pe.vendor": "vendor-specific",
    "pe.instr": "Instructions",
    "pe.runtime": "Default runtime",
    "pe.model": "Model",
    "pe.ver": "Version",
    "pe.rtDefault": "the runtime's default",
    "pe.perms": "Permission mode",
    "pe.noneCmd": "none",
    "pe.loading": "Loading…",
    "pe.loadFail": "The personas did not load.",
    "pe.src.builtin": "built-in",
    "pe.src.distribution": "distribution",
    "pe.src.local": "mine",
    "pe.src.hub": "hub",
    "pe.src.builtin.p":
      "Ships with Den. Read-only here; duplicate it to customize.",
    "pe.src.distribution.p":
      "Ships with your distribution. Read-only here; duplicate it to customize.",
    "pe.src.local.p": "Yours, on this machine.",
    "pe.src.hub.p": "Shared through Den Hub. Read-only here.",
    "pe.new": "New persona",
    "pe.dupT": "Duplicate persona",
    "pe.edit": "Edit persona",
    "pe.dup": "Duplicate",
    "pe.editB": "Edit",
    "pe.view": "View",
    "pe.save": "Save persona",
    "pe.del": "Delete",
    "pe.deleted": "Deleted {n}",
    "pe.name": "Name",
    "pe.nameP": "e.g. Rita",
    "pe.role": "Role",
    "pe.roleHelp":
      "A role sets this persona's starting template and lets Den hand work to it. It adds nothing hidden to the instructions.",
    "pe.desc": "One-line description",
    "pe.cat": "Category",
    "pe.copy": "{n} (copy)",
    "pe.saved": "Saved {n}",
    "pe.ro": "Read-only here. Duplicate it to make a copy of your own.",
    "pf.search": "Search personas by name, role or description",
    "pf.cat": "Category",
    "pf.src": "Source",
    "pf.all": "All",
    "pf.none": "No persona matches. Clear the filters or create one.",
    "pf.clear": "Clear filters",
    "cat.engineering": "Engineering",
    "cat.design": "Design",
    "cat.product": "Product",
    "cat.marketing": "Marketing",
    "cat.operations": "Operations",
    "rt.installed": "Installed",
    "rt.missing": "Not installed",
    "rt.notInst": "{r} not installed",
    "rt.later": "later",
    "rt.fallback":
      "{p}'s default runtime, {r}, isn't installed here, so this starts on {f}.",
    "ver.latest": "latest",
    "ver.latestP": "Latest (tracks the newest release)",
    "ver.newer": "newer available",
    "ver.newerP":
      "A newer version of this model is out. This one stays pinned until you change it.",
    "ver.newerOf": "Newer: {v}",
    "ver.use": "Use latest",
    "ver.pinned": "pinned {v}",
    "ver.usedLatest": "{n} now tracks the latest version",
    "set.agents.personas": "Personas",
    "set.agents.rotation": "Rotation",
    "set.agents.hub": "Hub",
    // The Agents tab (AG-4a-term, agents-page.js).
    "n.agents": "Agents",
    "kind.agent": "Agent",
    "ag.sub": "{n} sessions · {w} waiting · {scope}",
    "ag.sub.one": "{n} session · {w} waiting · {scope}",
    "ag.all": "all workspaces",
    "ag.waiting": "waiting",
    "tx.asked": "Asked",
    "tx.result": "Result",
    "tx.error": "Error",
    "tx.omitted": "{n} earlier lines not shown",
    "tx.omitted.one": "{n} earlier line not shown",
    "tx.empty": "Nothing yet.",
    "tx.close": "Close",
    "tx.loading": "Loading…",
    "tx.failed": "Couldn't read it: {err}",
    "hp.title": "Helpers ({n})",
    "hp.bar": "Helpers: {n}",
    "hp.barRunning": "Helpers: {n}, {r} running",
    "hp.all": "All helpers ({n})",
    "hp.titlePlain": "Helpers",
    "hp.allPlain": "All helpers",
    "hp.rowRunning": "{n} helpers running",
    "hp.rowRunning.one": "{n} helper running",
    "hp.runningN": "{n} running",
    "hp.groupOf": "Helpers of {name}",
    "hp.open": "{what}, {status}: open its transcript",
    "hp.dlg": "{name}'s helpers",
    "hp.earlier": "Earlier conversations ({n})",
    "hp.none": "No helpers in this conversation.",
    "hp.clear": "Clear done",
    "hp.clearTip":
      "Hide every finished helper of {name} (done, failed or stopped). Running ones stay.",
    "hp.clearFailed": "Couldn't clear: {err}",
    "hp.cleared": "Show cleared ({n})",
    "hp.allCleared": "Every finished helper is cleared.",
    "hp.unsupported":
      "This agent's runtime can't tell which helpers it started.",
    "hp.workflow": "workflow {name}",
    "hp.note":
      "Helpers run inside this agent's own session, so Den shows them but can't stop or steer them. To change what they do, tell the agent.",
    "hp.st.running": "running",
    "hp.st.idle": "idle",
    "hp.st.done": "done",
    "hp.st.failed": "failed",
    "hp.st.stopped": "stopped",
    "b.helpers": "{n} helpers running",
    "b.helpers.one": "{n} helper running",
    "hub.rail": "Hub",
    "hub.railTip": "{team} on Hub",
    "hub.railTipPlain": "Open Hub",
    "hub.railUnread": "{n} waiting on you",
    "hub.railRejected":
      "Hub doesn't accept this install's token. Reconnect in Settings › Hub.",
    "hub.railForbidden":
      "Hub doesn't allow this install. Ask a Hub admin (Settings › Hub).",
    "hub.railNoToken": "Not connected to Hub yet. Connect in Settings › Hub.",
    "hub.railUnreachable": "Den can't reach Hub right now. See Settings › Hub.",
    "hub.railBadConfig":
      "Den's Hub settings have a problem. See Settings › Hub.",
    "hub.railBadUrl":
      "Hub's address isn't https, so Den won't open it. See Settings › Hub.",
    "ag.session": "session",
    "ag.empty":
      "Pick a session on the left to open its terminal. Open more to tile them (up to 4).",
    "ag.none.scope": "No sessions or agents in {scope} yet",
    "ag.detach": "Close pane",
    "ag.detachName": "Close {id}'s pane (it keeps running)",
    "ag.detached": "Closed {id}'s pane: it keeps running",
    "ag.open": "Open",
    "ag.openName": "Open {id} in Agents",
    "ws.openAgents": "Open in Agents →",
    "ag.signin": "Sign in to open terminals: run {cli} web login",
    "ag.revoked": "token revoked",
    "ag.revokedTip":
      "Its token was revoked (web logout --all): stop and resume it, or start it again, to give it a new one",
    "ag.ended":
      "This session has ended. Its record stays until it is resumed or removed.",
    "ag.switched": "Switched to {p}",
    "ag.exitedLine": "[the session exited{code}]",
    "ag.refusedUnknown": "the server refused the terminal",
    "ag.refusedStatus": "the server refused the terminal ({status})",
    "ag.goWs": "Open {ws} on Workspaces",
    "ag.lost": "[disconnected: {why}]",
    "ag.reconnect": "Reconnect",
    // AG-DROP: a file dropped, pasted or attached onto an agent's terminal.
    "ag.up.drop": "Drop to attach to {name}",
    "ag.up.sending": "sending…",
    "ag.up.pct": "{n}%",
    "ag.up.done": "attached",
    "ag.up.attach": "Attach",
    "ag.up.attachName": "Attach a file to {id}",
    "ag.up.attachTip":
      "Attach a file: it goes to the agent's machine and its path is typed here",
    "ag.noBackend":
      "Terminals need the optional PTY module (den-pty is unavailable): {cli} doctor says why",
    "ag.noHost": "No session host is running: nothing has started yet",
    "ag.ws": "Workspace",
    "ag.pal": "Agents › {ws} / {name}",
    "ag.palStart": "Start agent…",
    // ON-6: the server agent (server-agent-page.js, the rail, ⌘K).
    "n.serverAgent": "__DEN_TITLE__ agent",
    "ag.server": "Server",
    "pal.askServer": "Ask __DEN_TITLE__",
    "sa.sub.fresh":
      "Let's set up __DEN_TITLE__. It reads only until you allow a write.",
    "sa.sub":
      "For anything about this server: add a repo, fix a failing service, change a setting, or explain what's running.",
    "sa.login":
      "If Claude asks you to log in, log in here. Then {name} starts.",
    "sa.trust": "Claude asks whether to trust this folder. Choose Yes.",
    "sa.model": "Model",
    "sa.readsOnly":
      "It acts only through __DEN_TITLE__'s own tools. Each change asks you first, in this browser.",
    "sa.starting": "Starting the agent…",
    "sa.idle": "{name} isn't running.",
    "sa.start": "Start",
    "sa.failed": "It didn't start: {why}. {cli} agents doctor says more.",
    "sa.unread": "Couldn't read the agent's status. Is the web server running?",
    "sa.none.h": "No runtime can run the agent yet",
    "sa.none":
      "The agent runs on an agent CLI from the runtime catalog. Install one, log in to it once, then reload this page.",
    "sa.noTools": "can't use __DEN_TITLE__'s tools yet",
    "sa.manual.h": "Or set it up yourself",
    "sa.manual": "Every step the agent takes is also a command. In a terminal:",
    "sa.runsOn": "Runs on",
    "sa.openAgents": "Open in Agents",
    "sa.saved": "Saved. The agent uses it from its next start.",
    "ag.cap": "Up to 4 panes: {id}'s closed to make room (it keeps running)",
    // AG-4b: the Agents tab's layouts and named tabs.
    "ag.layout": "Layout",
    "ag.l.focus": "Focus",
    "ag.l.tabs": "Tabs",
    "ag.l.tile": "Tile",
    "ag.l.tip": "{name} ({key})",
    "ag.hint.keys":
      "⌃⇧1 / ⌃⇧2 / ⌃⇧3 switch layout. ⌘-click (Ctrl-click) opens a link or path.",
    "ag.pal.layout": "Layout: {name}",
    "ag.copied": "Copied",
    "ag.linkHint": "{key}-click to open",
    "ag.subagents": "subagents: {model}",
    "ag.subagents.inherit": "the runtime's",
    "ag.subagents.inheritFrom.persona":
      "Den sets no model for its subagents: its persona's subagent_model is inherit. Claude Code decides, so Explore may run on the agent's own model.",
    "ag.subagents.inheritFrom.org":
      "Den sets no model for its subagents: agents.subagents.model is inherit. Claude Code decides, so Explore may run on the agent's own model.",
    "ag.subagents.from.persona":
      "Its subagents (Explore too) run on {model}: its persona's subagent_model.",
    "ag.subagents.from.org":
      "Its subagents (Explore too) run on {model}: agents.subagents.model.",
    "ag.subagents.from.default":
      "Its subagents (Explore too) run on {model}: Den's default. agents.subagents.model or a persona's subagent_model changes it.",
    "ag.tabs": "Open sessions",
    "ag.hint.focus":
      "Click shows one session. Shift- or ⌘-click adds it alongside.",
    "ag.hint.tabs":
      "Click opens a session as a tab. Double-click a tab to rename it.",
    "ag.hint.tile": "Click adds a session as a tile, up to 4.",
    "ag.renameTip": "Double-click to rename",
    "ag.renameName": "Rename {id}",
    "ag.rn.item": "Rename…",
    "ag.rn.title": "Rename {id}",
    "ag.rn.name": "Name",
    "ag.rn.help":
      "Its tab, row and pane header show it; the id {id} never changes. Other sessions see it as {peer} from its next start or resume. Empty: back to {id}.",
    "ag.rn.go": "Rename",
    "ag.rn.cancel": "Cancel",
    "ag.where.logout": "Stops at logout",
    "ag.where.logoutTip":
      "It runs in the desktop login session, so logging out ends it. To keep agents running: {cli} service install --mode always (opt-in, not yet proven across a logout)",
    "ag.where.bg": "No GUI",
    "ag.where.bgTip":
      "It keeps running after logout, outside the desktop session: no login keychain and no GUI apps. 1Password uses the service-account token, browsers run headless, and protected folders need Full Disk Access ({cli} doctor).",
    "ag.rt.ready": "Starts {name} {version} from",
    "ag.rt.readyNoVer": "Starts {name} from",
    "ag.rt.notFound": "{name} not found.",
    "ag.rt.searched": "Searched:",
    "ag.rt.more": "and {n} more",
    "ag.rt.nowhere": "no directories",
    "ag.rt.refused": "{name} can't start: {why}.",
    "ag.rt.fix":
      "Install it, or set {key} to its path in {file}, or run {cmd}.",
    "ag.rt.unknown": "No runtime {id} here.",
    "ag.rt.denTools": "Den tools: coming",
    "ag.rt.ownCli":
      "It runs as its own CLI in the workspace: Den's tools and permission modes are coming for it.",
    "ag.rt.notInstalled": "not installed",
    "ag.rt.needsArgv": "the persona has no argv template",
  };
  // The languages the UI has a catalog for, each named in itself (a name is
  // never translated). The server's list is ui-language.ts's UI_LANGUAGES.
  var LANGUAGES = [
    { id: "en", name: "English" },
    { id: "ja", name: "日本語" },
    { id: "es", name: "Español" },
  ];
  // The page's language: <html lang>, when a catalog for it is loaded.
  var lang = (function () {
    var l = (document.documentElement && document.documentElement.lang) || "en";
    return MESSAGES[l] ? l : "en";
  })();
  function has(table, key) {
    return !!table && Object.prototype.hasOwnProperty.call(table, key);
  }
  var pluralRules = null;
  function pluralOf(n) {
    try {
      pluralRules = pluralRules || new Intl.PluralRules(lang);
      return pluralRules.select(n);
    } catch (e) {
      return n === 1 ? "one" : "other";
    }
  }
  /** A number in the page's language (Intl.NumberFormat, its options). */
  function num(n, opts) {
    try {
      return new Intl.NumberFormat(lang, opts).format(n);
    } catch (e) {
      return String(n);
    }
  }
  /** The catalog's text for key (its plural form for vars.n), or null. */
  function lookup(table, key, vars) {
    if (!has(table, key)) return null;
    if (vars && typeof vars.n === "number") {
      var form = key + "." + pluralOf(vars.n);
      if (has(table, form)) return table[form];
    }
    return table[key];
  }
  function t(key, vars) {
    var s = lookup(MESSAGES[lang], key, vars);
    if (s == null && lang !== "en") s = lookup(MESSAGES.en, key, vars);
    if (s == null) s = key;
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      if (!vars || vars[k] == null) return m;
      return typeof vars[k] === "number" ? num(vars[k]) : String(vars[k]);
    });
  }

  var host = document.getElementById("den-shell");
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = "1";
  var page = host.dataset.page || "";
  // The page id on the body (den-page-<id>), for CSS from first paint: the
  // Graph page is the Workspaces page's file at /graph (R22, 0.3.0-dev.32).
  if (/^[a-z0-9-]+$/.test(page) && document.body)
    document.body.classList.add("den-page-" + page);

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ── icons: the prototype's 24px line drawings ─────────────────────────
  var ICONS = {
    overview: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/>',
    graph:
      '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.2 7.2 15.6 8M7 8.4l1.6 7.2M16.4 10.2l-5.6 6"/>',
    services:
      '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01M8 17h.01"/>',
    logs: '<path d="M5 5h14M5 9h10M5 13h14M5 17h8"/>',
    tests:
      '<path d="M9 4h6M10 4v5l-5 9a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2l-5-9V4"/>',
    envs: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
    releases: '<path d="M12 3v12M7 10l5 5 5-5M5 20h14"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    page: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6M9 13h6"/>',
    // The prototype's Agents icon: a terminal window with a prompt.
    agents:
      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>',
    edge: '<path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z"/><path d="M8 12h8M12 8v8"/>',
    // ON-6: the server agent, a speech bubble with a spark.
    assistant:
      '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M12 8v4M10 10h4"/>',
    // Hub: a node joined to three (the company's shared place).
    hub: '<circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="20" r="2"/><path d="M6.6 7.2l3.5 3.2M17.4 7.2l-3.5 3.2M12 14.5V18"/>',
    // SEC-2a: who this browser is (the rail footer's identity chip).
    person:
      '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  };
  function icon(name) {
    var d = ICONS[name] || (/^</.test(name || "") ? name : ICONS.page);
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>";
  }

  // ── registries ─────────────────────────────────────────────────────────
  var GROUPS = [];
  var NAV = [];
  function upsert(list, item) {
    for (var i = 0; i < list.length; i++)
      if (list[i].id === item.id) {
        list[i] = item;
        return;
      }
    list.push(item);
  }
  function byOrder(a, b) {
    return (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1);
  }
  var ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
  /** A registration's `order`: a finite number, else 100 with a warning. */
  function orderOf(kind, x) {
    if (x.order === undefined) return 100;
    if (typeof x.order === "number" && isFinite(x.order)) return x.order;
    warn(
      kind +
        ' "' +
        x.id +
        '": order must be a number (got ' +
        JSON.stringify(x.order) +
        "); using 100",
    );
    return 100;
  }
  function warn(msg) {
    if (typeof console !== "undefined" && console.warn)
      console.warn("denShell: " + msg);
  }
  function hasGroup(id) {
    for (var i = 0; i < GROUPS.length; i++)
      if (GROUPS[i].id === id) return true;
    return false;
  }
  function registerGroup(g) {
    if (!g || !ID.test(g.id || "")) throw new Error("group needs an id");
    upsert(GROUPS, {
      id: g.id,
      label: g.label || g.id,
      order: orderOf("group", g),
      from: g.from || null,
    });
    renderRail();
  }
  function registerNav(n) {
    if (!n || !ID.test(n.id || "") || !n.href || !n.group)
      throw new Error("a page needs an id, an href and a group");
    // A page whose group isn't registered yet is kept, and shows when the
    // group arrives (registerGroup re-renders). Registering a page before
    // its group is a legitimate order (a queue, two scripts), so the
    // warning waits until the queue has drained and a tick has passed.
    upsert(NAV, {
      id: n.id,
      label: n.label || n.id,
      icon: n.icon || "page",
      group: n.group,
      order: orderOf("nav", n),
      href: n.href,
      badge: typeof n.badge === "function" ? n.badge : null,
      when: typeof n.when === "function" ? n.when : null,
      // Other names the palette finds it by (R24a: "Local Dev").
      keywords: Array.isArray(n.keywords) ? n.keywords.map(String) : [],
      from: n.from || null,
    });
    checkOrphansSoon();
    renderRail();
  }

  // ── orphans: a page or setting whose group or category never came ────
  var settled = false;
  var orphanTimer = null;
  var warnedOrphan = {};
  function checkOrphansSoon() {
    if (!settled || orphanTimer) return;
    orphanTimer = setTimeout(function () {
      orphanTimer = null;
      checkOrphans();
    }, 0);
  }
  function checkOrphans() {
    NAV.forEach(function (n) {
      var key = "nav:" + n.id + ":" + n.group;
      if (hasGroup(n.group) || warnedOrphan[key]) return;
      warnedOrphan[key] = true;
      warn(
        'nav "' +
          n.id +
          '": group "' +
          n.group +
          '" is not registered; the page shows once it is',
      );
    });
    SETTING_ROWS.forEach(function (r) {
      var key = "setting:" + r.id + ":" + r.category;
      if (hasCategory(r.category) || warnedOrphan[key]) return;
      warnedOrphan[key] = true;
      warn(
        'setting "' +
          r.id +
          '": category "' +
          r.category +
          '" is not registered; the row shows once it is',
      );
    });
  }

  // ── SETTINGS (R21): what the Settings page draws, row by row ──────────
  // A category: { id, label, order, description?, from? }. A row: { id,
  // category, label, description, keywords, scope: user|workspace|
  // distribution, control: { type, … }, read(ctx), write?(value, ctx),
  // keys? } (keys: the /api/settings keys it stores, for the inventory).
  var SETTING_CATS = [];
  var SETTING_ROWS = [];
  var SETTING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  var SCOPES = ["user", "workspace", "distribution"];
  function hasCategory(id) {
    for (var i = 0; i < SETTING_CATS.length; i++)
      if (SETTING_CATS[i].id === id) return true;
    return false;
  }
  function settingsChanged() {
    try {
      window.dispatchEvent(new CustomEvent("den:settings"));
    } catch (e) {
      /* no CustomEvent: the page re-reads on its own */
    }
  }
  function registerSettingsCategory(c) {
    if (!c || !ID.test(c.id || ""))
      throw new Error("a settings category needs an id");
    upsert(SETTING_CATS, {
      id: c.id,
      label: c.label || c.id,
      order: orderOf("settings category", c),
      description: c.description || "",
      from: c.from || null,
    });
    settingsChanged();
  }
  function registerSetting(r) {
    if (!r || !SETTING_ID.test(r.id || "") || !r.category || !r.label)
      throw new Error(
        'setting "' +
          (r && r.id) +
          '": a setting needs an id ([A-Za-z0-9._-]), a category and a label',
      );
    var scope = r.scope || "user";
    if (SCOPES.indexOf(scope) < 0)
      throw new Error(
        'setting "' + r.id + '": scope must be user, workspace or distribution',
      );
    if (typeof r.read !== "function")
      throw new Error('setting "' + r.id + '" needs read(ctx)');
    // The distribution's own config is tracked: shown, never written.
    if (scope === "distribution" && r.write)
      throw new Error(
        'setting "' +
          r.id +
          '": a distribution setting is read-only (no write)',
      );
    upsert(SETTING_ROWS, {
      id: r.id,
      category: r.category,
      label: r.label,
      description: r.description || "",
      keywords: Array.isArray(r.keywords) ? r.keywords.slice() : [],
      scope: scope,
      control: r.control || { type: "readonly" },
      read: r.read,
      write: typeof r.write === "function" ? r.write : null,
      keys: Array.isArray(r.keys) ? r.keys.slice() : [],
      order: orderOf("setting", r),
      from: r.from || null,
    });
    settingCommand(r);
    checkOrphansSoon();
    settingsChanged();
  }

  // ── the ⌘K palette's commands (R17, dev.20) ────────────────────────────
  // Pages, services and apps are the palette's own (topbar.js); this holds
  // what a page, a distribution or a plugin adds: actions, and the
  // Settings registry's rows (kind "setting", dev.19).
  var COMMANDS = [];
  function registerCommand(c) {
    if (!c || typeof c.id !== "string" || !c.id || typeof c.run !== "function")
      throw new Error("a command needs an id and a run()");
    if (c.label == null)
      throw new Error('command "' + c.id + '" needs a label');
    upsert(COMMANDS, {
      id: c.id,
      label: c.label,
      keywords: Array.isArray(c.keywords)
        ? c.keywords.slice()
        : c.keywords
          ? [String(c.keywords)]
          : [],
      kind: typeof c.kind === "string" && c.kind ? c.kind : "action",
      run: c.run,
      href: typeof c.href === "string" && c.href ? c.href : undefined,
      from: c.from || null,
    });
  }
  function unregisterCommand(id) {
    for (var i = COMMANDS.length - 1; i >= 0; i--)
      if (COMMANDS[i].id === id) COMMANDS.splice(i, 1);
  }
  /**
   * Every SETTINGS row is a palette row too (kind "setting"): Enter opens
   * the Settings page searched for it, at its category
   * (/settings?q=<label>#<category>).
   */
  function settingCommand(r) {
    var cat = r.category;
    // A built-in row's palette label is in the catalogs (set.<id>); a row
    // a distribution or a plugin adds shows its own label. The Settings
    // search (?q=) keeps the row's own label, which that page shows.
    var key = "set." + r.id;
    var href =
      "/settings?q=" +
      encodeURIComponent(r.label) +
      "#" +
      encodeURIComponent(cat);
    registerCommand({
      id: "setting:" + r.id,
      label:
        has(MESSAGES.en, key) && MESSAGES.en[key] === r.label
          ? function () {
              return t(key);
            }
          : r.label,
      keywords: (Array.isArray(r.keywords) ? r.keywords : []).concat([
        cat,
        "settings",
      ]),
      kind: "setting",
      href: href,
      run: function () {
        location.assign(href);
      },
      from: r.from || null,
    });
  }
  /** The registered commands, labels resolved (a label may be a function). */
  function commands() {
    return COMMANDS.map(function (c) {
      var label = c.label;
      if (typeof label === "function") {
        try {
          label = label();
        } catch (e) {
          label = c.id;
        }
      }
      return {
        id: c.id,
        label: String(label),
        keywords: c.keywords.slice(),
        kind: c.kind,
        run: c.run,
        href: c.href,
        from: c.from,
      };
    });
  }

  // ── state: what badges, when() and the pinned dots read ───────────────
  var LS = "__DEN_CLI__-shell";
  var state = {
    health: {},
    down: 0,
    openLogs: 0,
    helpersRunning: 0,
    // The rail's Hub link: GET /api/hub?rail=1, or null (not connected).
    hub: null,
    pins: [],
    collapsed: false,
    hidden: [],
    order: [],
    // The runs dock (R16a): open or collapsed to its bar, and its height
    // (0: the prototype's 170px). User prefs, like the pins.
    dock: false,
    dockHeight: 0,
    // Whether the edge is configured (the Edge page's when): null until
    // known, the last answer cached so the rail doesn't jump.
    edge: null,
    // SEC-2a: who this browser is (GET /api/session `identity`): local,
    // a signed-in device, or a GitHub login. Null until known.
    identity: null,
    // 0.4.18: each pin's URL (svc-panel.js, from the health feed) for its
    // Visit ↗, whether that Visit is off (down or starting: the panel's own
    // live state), and the pin whose service panel is open.
    pinUrls: {},
    pinOff: {},
    svpOpen: null,
  };
  try {
    var cached = JSON.parse(localStorage.getItem(LS) || "{}");
    if (typeof cached.edge === "boolean") state.edge = cached.edge;
    if (Array.isArray(cached.pins)) state.pins = cached.pins;
    state.collapsed = cached.collapsed === true;
    if (Array.isArray(cached.hidden)) state.hidden = cached.hidden;
    if (Array.isArray(cached.order)) state.order = cached.order;
    state.dock = cached.dock === true;
    if (typeof cached.dockHeight === "number")
      state.dockHeight = cached.dockHeight;
  } catch (e) {
    /* no storage: the server's copy arrives below */
  }
  function remember() {
    try {
      localStorage.setItem(
        LS,
        JSON.stringify({
          pins: state.pins,
          collapsed: state.collapsed,
          hidden: state.hidden,
          order: state.order,
          dock: state.dock,
          dockHeight: state.dockHeight,
          edge: state.edge,
        }),
      );
    } catch (e) {
      /* a convenience only */
    }
  }
  function setState(partial) {
    var before = state.pins.join("\n");
    for (var k in partial)
      if (Object.prototype.hasOwnProperty.call(partial, k))
        state[k] = partial[k];
    applyCollapsed();
    renderRail();
    if (state.pins.join("\n") !== before) pinsChanged();
  }
  /**
   * Any pin change (the rail's ×, Delete, a page's toggle, the server's
   * prefs arriving) is one event, `den:pins` on window, and every pin
   * toggle on the page ([data-pin-toggle]) repaints from it.
   */
  function pinsChanged() {
    if (typeof window.dispatchEvent !== "function") return;
    var detail = { pins: state.pins.slice() };
    var ev;
    try {
      ev = new CustomEvent("den:pins", { detail: detail });
    } catch (e) {
      return;
    }
    window.dispatchEvent(ev);
  }
  if (typeof window.addEventListener === "function")
    window.addEventListener("den:pins", function () {
      syncPinToggles(document);
    });
  /** A pin toggle's look for its id: ★ "Unpin x" pressed, or ☆ "Pin x". */
  function syncPinToggles(root) {
    if (!root || !root.querySelectorAll) return;
    var btns = root.querySelectorAll("[data-pin-toggle]");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var id = b.getAttribute("data-pin-toggle");
      var on = isPinned(id);
      var label = t(on ? "act.unpinX" : "act.pinX", { s: id });
      b.textContent = on ? "★" : "☆";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("aria-label", label);
      b.title = label;
    }
  }
  function saveShell(patch) {
    remember();
    if (typeof fetch !== "function") return Promise.resolve();
    return fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shell: patch }),
    })
      .then(function (r) {
        return r && r.ok !== false;
      })
      .catch(function () {
        return false;
      });
  }
  function isPinned(id) {
    return state.pins.indexOf(id) >= 0;
  }
  function pin(id) {
    if (isPinned(id)) return;
    setState({ pins: state.pins.concat([id]) });
    saveShell({ pins: state.pins });
    toast(t("toast.pinned", { s: id }));
  }
  function unpin(id) {
    if (!isPinned(id)) return;
    setState({
      pins: state.pins.filter(function (p) {
        return p !== id;
      }),
    });
    saveShell({ pins: state.pins });
    toast(t("toast.unpinned", { s: id }));
  }
  function ids(list) {
    return (Array.isArray(list) ? list : []).filter(function (x, i, all) {
      return typeof x === "string" && all.indexOf(x) === i;
    });
  }
  /** Navigation (R21): the pages the rail hides and their order. */
  function setNavPrefs(prefs) {
    var patch = {};
    if (prefs && prefs.hidden !== undefined) patch.hidden = ids(prefs.hidden);
    if (prefs && prefs.order !== undefined) patch.order = ids(prefs.order);
    setState(patch);
    return saveShell(patch);
  }
  /** The pins, in this order (the Settings page's Pinned row). */
  function setPins(list) {
    setState({ pins: ids(list) });
    return saveShell({ pins: state.pins });
  }
  function setCollapsed(on) {
    setState({ collapsed: !!on });
    return saveShell({ collapsed: state.collapsed });
  }
  /** The runs dock open or collapsed to its bar (R16a), remembered. */
  function setDock(on) {
    dockOpen = !!on;
    renderDock();
    return rememberDock();
  }
  /** NAV pages in the rail's order: groups by order, then yours, then theirs. */
  function orderedNav() {
    var rank = function (id) {
      var i = state.order.indexOf(id);
      return i < 0 ? Infinity : i;
    };
    var gs = GROUPS.slice().sort(byOrder);
    var out = [];
    gs.forEach(function (g) {
      NAV.filter(function (n) {
        return n.group === g.id;
      })
        .sort(function (a, b) {
          return rank(a.id) - rank(b.id) || byOrder(a, b);
        })
        .forEach(function (n) {
          out.push(n);
        });
    });
    return out;
  }
  var toastTimer = null;
  function toast(msg) {
    if (!document.body || !document.createElement) return;
    var old = document.querySelector && document.querySelector(".den-toast");
    if (old && old.remove) old.remove();
    var el = document.createElement("div");
    el.className = "den-toast";
    if (el.setAttribute) el.setAttribute("role", "status");
    el.textContent = msg;
    if (document.body.appendChild) document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (el.remove) el.remove();
    }, 2200);
  }
  /**
   * A toast with one action (AG-14.1b: Remove's Undo): the message and a
   * small button, for `ms` (default 10 s). The action runs once, and the
   * toast goes.
   */
  function toastAction(msg, label, onAction, ms) {
    if (!document.body || !document.createElement) return null;
    var old = document.querySelector && document.querySelector(".den-toast");
    if (old && old.remove) old.remove();
    var el = document.createElement("div");
    el.className = "den-toast den-toast-act";
    el.setAttribute("role", "status");
    var text = document.createElement("span");
    text.textContent = msg;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "den-tbtn";
    b.textContent = label;
    var done = false;
    b.addEventListener("click", function () {
      if (done) return;
      done = true;
      clearTimeout(toastTimer);
      el.remove();
      onAction();
    });
    el.appendChild(text);
    el.appendChild(b);
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      done = true;
      if (el.remove) el.remove();
    }, ms || 10000);
    return el;
  }

  // ── the top layer (0.4.17): one placement for every menu ─────────────
  // A menu shown with topShow is in the browser's top layer (a manual
  // popover), placed by its anchor: below it, above when there's more room
  // there, kept inside the window. No overflow or stacking ancestor can
  // clip or cover it, and it stays where it is in the page, so the page's
  // own click handlers still reach it. It closes when the page hides it
  // (display: none), its anchor goes, or topHide.
  var topOpen = [];
  var TOP_MARGIN = 8;
  function topSupported(el) {
    return typeof el.showPopover === "function";
  }
  function topPlace(el, anchor, opts) {
    var r = anchor.getBoundingClientRect();
    var gap = opts.gap != null ? opts.gap : 4;
    el.style.maxHeight = "";
    // 0.4.18: a bottom sheet is placed by its CSS (bottom: 0), not here.
    if (opts.sheet) {
      el.style.removeProperty("top");
      el.style.removeProperty("left");
      return;
    }
    // 0.4.18: beside the anchor (the rail), level with a row in it.
    if (opts.side === "right") {
      var row = typeof opts.row === "function" ? opts.row() : null;
      var rr = row ? row.getBoundingClientRect() : r;
      var bw = el.offsetWidth;
      var bh = el.offsetHeight;
      var bl = Math.min(r.right + gap, window.innerWidth - bw - TOP_MARGIN);
      var bt = Math.min(
        rr.top + (opts.dy || 0),
        window.innerHeight - bh - TOP_MARGIN,
      );
      el.style.setProperty("top", Math.max(TOP_MARGIN, bt) + "px", "important");
      el.style.setProperty(
        "left",
        Math.max(TOP_MARGIN, bl) + "px",
        "important",
      );
      return;
    }
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var below = vh - r.bottom - gap - TOP_MARGIN;
    var above = r.top - gap - TOP_MARGIN;
    var up = h > below && above > below;
    var room = Math.max(80, up ? above : below);
    if (h > room) {
      el.style.maxHeight = room + "px";
      h = room;
    }
    var top = up ? r.top - gap - h : r.bottom + gap;
    var left = opts.align === "right" ? r.right - w : r.left;
    left = Math.max(TOP_MARGIN, Math.min(left, vw - w - TOP_MARGIN));
    // Important, so no page or UA rule (a popover's inset) moves it.
    el.style.setProperty("top", Math.max(TOP_MARGIN, top) + "px", "important");
    el.style.setProperty("left", left + "px", "important");
  }
  function topIndex(el) {
    for (var i = 0; i < topOpen.length; i++) if (topOpen[i].el === el) return i;
    return -1;
  }
  function topShow(el, anchor, opts) {
    if (!el || !anchor) return;
    opts = opts || {};
    var i = topIndex(el);
    if (i >= 0) {
      topOpen[i].anchor = anchor;
      topOpen[i].opts = opts;
    } else {
      if (topSupported(el)) {
        if (!el.hasAttribute("popover")) {
          el.setAttribute("popover", "manual");
          el.setAttribute("data-den-top-added", "");
        }
        try {
          if (!el.matches(":popover-open")) el.showPopover();
        } catch (e) {
          /* not in the document yet: placed as fixed */
        }
      }
      var o = { el: el, anchor: anchor, opts: opts, mo: null };
      if (typeof MutationObserver === "function") {
        o.mo = new MutationObserver(function () {
          topCheck(o);
        });
        o.mo.observe(el, {
          attributes: true,
          attributeFilter: ["style", "class", "hidden"],
        });
      }
      topOpen.push(o);
    }
    el.classList.add("den-toplayer");
    topPlace(el, anchor, opts);
  }
  function topHide(el) {
    var i = topIndex(el);
    if (i < 0) return;
    var o = topOpen.splice(i, 1)[0];
    if (o.mo) o.mo.disconnect();
    try {
      if (el.matches && el.matches(":popover-open")) el.hidePopover();
    } catch (e) {
      /* already gone */
    }
    if (el.hasAttribute("data-den-top-added")) {
      el.removeAttribute("popover");
      el.removeAttribute("data-den-top-added");
    }
    el.classList.remove("den-toplayer");
    el.style.removeProperty("top");
    el.style.removeProperty("left");
  }
  /** The page hid it, or its anchor went: it's closed. */
  function topCheck(o) {
    if (
      !o.el.isConnected ||
      !o.anchor.isConnected ||
      o.el.hidden ||
      getComputedStyle(o.el).display === "none"
    )
      topHide(o.el);
  }
  function topReplace() {
    topOpen.slice().forEach(function (o) {
      topCheck(o);
      if (topIndex(o.el) >= 0) topPlace(o.el, o.anchor, o.opts);
    });
  }
  window.addEventListener("resize", topReplace);
  document.addEventListener("scroll", topReplace, true);

  // ── menus (.pop, R18): the scope parts' popovers ─────────────────────
  // A menu is { label, items: [{ heading } | { hr: true } | { label, tag?,
  // checked?, href?, onSelect? }] }. Rows with `checked` are radios (✓ when
  // checked). Keyboard: ↑/↓ (wrapping), Home and End move; Enter or Space
  // picks; Escape and Tab close and give focus back to the button; a click
  // outside closes.
  var openPop = null;
  function closeMenu(refocus) {
    if (!openPop) return;
    var o = openPop;
    openPop = null;
    topHide(o.el);
    if (o.el.remove) o.el.remove();
    o.anchor.setAttribute("aria-expanded", "false");
    // aria-controls names the menu only while it exists.
    o.anchor.removeAttribute("aria-controls");
    if (refocus && o.anchor.focus) o.anchor.focus();
  }
  function menuRows(pop) {
    return Array.prototype.slice.call(pop.querySelectorAll(".den-mi"));
  }
  function openMenu(anchor, menu) {
    var again = openPop && openPop.anchor === anchor;
    closeMenu(false);
    if (again || !menu) return;
    var pop = document.createElement("div");
    pop.className = "den-pop";
    pop.tabIndex = -1;
    pop.id = "den-pop-" + (anchor.dataset.scope || "menu");
    pop.setAttribute("role", "menu");
    pop.setAttribute("aria-label", menu.label);
    var html = "";
    var acts = [];
    (menu.items || []).forEach(function (it) {
      if (it.heading != null)
        html +=
          '<div class="den-ml" aria-hidden="true">' +
          esc(it.heading) +
          "</div>";
      else if (it.hr) html += '<div class="den-hr" role="separator"></div>';
      // A line of text (a notice), and an empty slot a later build fills
      // (the user menu's Language, dev.23).
      else if (it.note != null)
        html += '<p class="den-mnote" role="status">' + esc(it.note) + "</p>";
      else if (it.slot != null)
        html +=
          '<div class="den-mslot" data-slot="' +
          esc(it.slot) +
          '"' +
          (it.hidden ? " hidden" : "") +
          "></div>";
      else {
        var radio = it.checked != null;
        var tag = it.href ? "a" : "button";
        html +=
          "<" +
          tag +
          ' class="den-mi" tabindex="-1" data-i="' +
          acts.length +
          '" role="' +
          (radio ? "menuitemradio" : "menuitem") +
          '"' +
          (radio
            ? ' aria-checked="' + (it.checked ? "true" : "false") + '"'
            : "") +
          (it.href ? ' href="' + esc(it.href) + '"' : ' type="button"') +
          (it.title ? ' title="' + esc(it.title) + '"' : "") +
          // With a tag, the name is "default, focus" (the tag's text would
          // run into the label: "defaultfocus").
          (it.tag
            ? ' aria-label="' + esc(it.label + ", " + it.tag) + '"'
            : "") +
          '><span class="den-mi-l">' +
          esc(it.label) +
          "</span>" +
          (it.tag
            ? '<span class="den-mtag" aria-hidden="true">' +
              esc(it.tag) +
              "</span>"
            : "") +
          "</" +
          tag +
          ">";
        acts.push(it);
      }
    });
    pop.innerHTML = html;
    // Inside a modal, in it: anything outside a modal is inert.
    var host =
      (anchor.closest && anchor.closest("dialog[open]")) || document.body;
    host.appendChild(pop);
    openPop = { el: pop, anchor: anchor };
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", pop.id);
    topShow(pop, anchor, { gap: 6 });
    pop.addEventListener("click", function (e) {
      var row = e.target.closest ? e.target.closest(".den-mi") : null;
      if (!row) return;
      var it = acts[+row.getAttribute("data-i")];
      if (!it.href) e.preventDefault();
      closeMenu(true);
      if (it.onSelect) it.onSelect(it);
    });
    pop.addEventListener("keydown", function (e) {
      var rows = menuRows(pop);
      var i = rows.indexOf(document.activeElement);
      var next =
        e.key === "ArrowDown"
          ? (i + 1) % rows.length
          : e.key === "ArrowUp"
            ? (i - 1 + rows.length) % rows.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? rows.length - 1
                : -1;
      if (next >= 0 && rows.length) {
        e.preventDefault();
        rows[next].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      } else if (e.key === "Tab") closeMenu(true);
      else if (e.key === " " && rows[i] && rows[i].tagName === "A") {
        e.preventDefault();
        rows[i].click();
      }
    });
    var rows = menuRows(pop);
    var first = pop.querySelector('.den-mi[aria-checked="true"]') || rows[0];
    if (first) first.focus();
    else pop.focus();
  }
  document.addEventListener("mousedown", function (e) {
    if (!openPop) return;
    var tg = e.target;
    if (openPop.el.contains(tg) || openPop.anchor.contains(tg)) return;
    closeMenu(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openPop) closeMenu(true);
  });
  window.addEventListener("resize", function () {
    closeMenu(false);
  });

  /** A page's href from the NAV registry (Workspaces manages them). */
  function navHref(id) {
    for (var i = 0; i < NAV.length; i++)
      if (NAV[i].id === id) return NAV[i].href;
    return "/";
  }
  /** A scope part: <button class="den-ib"><k>Key</k> value ▾</button>. */
  function scopeButton(id, scope, key, value, hidden) {
    return (
      '<button type="button" id="' +
      id +
      '" class="den-ib den-scope-btn" data-scope="' +
      scope +
      '" aria-haspopup="menu" aria-expanded="false"' +
      (hidden ? " hidden" : "") +
      '><span class="den-k">' +
      esc(key) +
      '</span> <span class="den-v"><span class="den-vn">' +
      esc(value) +
      '</span> <span aria-hidden="true">▾</span></span></button>'
    );
  }

  // ── Den's own groups and pages ─────────────────────────────────────────
  [
    { id: "develop", label: "g.develop", order: 10 },
    { id: "verify", label: "g.verify", order: 20 },
    { id: "ship", label: "g.ship", order: 30 },
  ].forEach(function (g) {
    GROUPS.push({ id: g.id, label: g.label, order: g.order, from: null });
  });
  [
    // Workspaces (R24a, 0.3.0-dev.35; was Local Dev): run your workspaces.
    // Its id and route stay (prefs and links keep working); the palette
    // still finds it as "Local Dev".
    {
      id: "local-dev",
      label: "n.workspaces",
      icon: "overview",
      group: "develop",
      order: 10,
      href: "/local-dev",
      keywords: ["Local Dev", "workspaces"],
    },
    // The Graph page (R22, 0.3.0-dev.32, Ward 2026-11-05): the graph alone,
    // full width, after Workspaces as the prototype orders them.
    {
      id: "graph",
      label: "n.graph",
      icon: "graph",
      group: "develop",
      order: 15,
      href: "/graph",
    },
    // The Agents tab (AG-4a-term, AG spec §5d): sessions and terminal
    // panes, after Graph as the prototype orders them.
    {
      id: "agents",
      label: "n.agents",
      icon: "agents",
      group: "develop",
      order: 17,
      href: "/agents",
      keywords: ["sessions", "terminal"],
      // D32: helpers the agents started that run now.
      badge: function (s) {
        return s.helpersRunning > 0
          ? {
              n: s.helpersRunning,
              label: t("b.helpers", { n: s.helpersRunning }),
            }
          : null;
      },
    },
    // ON-6: the server agent, this Den's own: one click away, after Agents.
    {
      id: "server-agent",
      label: "n.serverAgent",
      icon: "assistant",
      group: "develop",
      order: 18,
      href: "/server-agent",
      keywords: ["server agent", "ask", "setup", "onboarding"],
    },
    {
      id: "services",
      label: "n.services",
      icon: "services",
      group: "develop",
      order: 20,
      href: "/services",
      // R13: down services, from the health row's rollup, live.
      badge: function (s) {
        return s.down > 0
          ? { n: s.down, bad: true, label: t("b.down", { n: s.down }) }
          : null;
      },
    },
    {
      id: "logs",
      label: "n.logs",
      icon: "logs",
      group: "develop",
      order: 30,
      href: "/logs",
      badge: function (s) {
        // Open log streams (Den keeps no new-lines count yet).
        return s.openLogs > 0
          ? { n: s.openLogs, label: t("b.logs", { n: s.openLogs }) }
          : null;
      },
    },
    {
      id: "tests",
      label: "n.tests",
      icon: "tests",
      group: "verify",
      order: 10,
      href: "/tests",
    },
    {
      id: "environments",
      label: "n.environments",
      icon: "envs",
      group: "ship",
      order: 10,
      href: "/environments",
    },
    {
      id: "release",
      label: "n.releases",
      icon: "releases",
      group: "ship",
      order: 20,
      href: "/release",
    },
    // The Edge page (PL-SPEC §10): only once /api/edge says the edge is
    // configured (state.edge, from /api/edge?probe=1 below).
    {
      id: "edge",
      label: "n.edge",
      icon: "edge",
      group: "ship",
      order: 30,
      href: "/edge",
      when: function (s) {
        return s.edge === true;
      },
    },
  ].forEach(function (n) {
    NAV.push({
      id: n.id,
      label: n.label,
      icon: n.icon,
      group: n.group,
      order: n.order,
      href: n.href,
      badge: n.badge || null,
      when: n.when || null,
      keywords: n.keywords || [],
      from: null,
    });
  });
  // The Settings page (R21): every setting, from the SETTINGS registry.
  var SETTINGS = {
    id: "settings",
    label: "n.settings",
    icon: "settings",
    href: "/settings",
  };

  // ── the frame ──────────────────────────────────────────────────────────
  // The top bar after the scope, in the prototype's order (dev.20): the ⌘K
  // search field (R5), then .chips: status (R6), Runs (R7), the sudo ask (R8),
  // What's new (R9) and ◐ ▾ (R10, appearance.js fills #den-user). The
  // chips start neutral ("Checking…", "Runs"; the sudo chip hidden) and topbar.js
  // paints them: a cold load never shows a partial red.
  var chips =
    '<button type="button" class="den-search" id="den-search" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" aria-label="' +
    esc(t("search.ph")) +
    '"><span class="den-search-ph">' +
    esc(t("search.ph")) +
    '</span><kbd aria-hidden="true">⌘K</kbd><span class="den-search-ic" aria-hidden="true">⌕</span></button>' +
    '<div class="den-chips">' +
    '<button type="button" class="den-chip" id="den-status" aria-haspopup="dialog" aria-expanded="false" aria-busy="true">' +
    '<span class="den-dot off" aria-hidden="true"></span><span class="den-n">' +
    esc(t("status.checking")) +
    "</span></button>" +
    '<button type="button" class="den-chip" id="den-runs">' +
    '<span class="den-dot off" aria-hidden="true"></span><span class="den-n den-lbl-l">' +
    esc(t("runs.title")) +
    "</span></button>" +
    // LK-0: shown only while a run waits for the admin password (topbar.js).
    '<button type="button" class="den-chip" id="den-lock" aria-haspopup="dialog" aria-expanded="false" hidden>' +
    '<span class="den-lock-ic" aria-hidden="true">🔑</span><span class="den-lbl-l">' +
    esc(t("lock.waiting")) +
    "</span></button>" +
    '<button class="den-ib v-pill" id="version-pill" onclick="openChangelog()" title="' +
    esc(t("v.title")) +
    '">' +
    '<span class="v-txt">v…</span><span class="v-pip" id="v-pip"></span></button>' +
    '<span class="den-user" id="den-user"></span>' +
    "</div>";
  host.className = "den-shell";
  host.innerHTML =
    '<a class="den-skip" href="#den-content">' +
    esc(t("skip")) +
    "</a>" +
    '<header class="den-top">' +
    '<button class="den-ib den-menu-btn" id="den-menu-btn" aria-label="' +
    esc(t("menu")) +
    '" aria-expanded="false" aria-controls="den-rail">☰</button>' +
    '<a class="den-brand" href="/" title="__DEN_TITLE__">' +
    '<span class="den-mark" id="den-mark" aria-hidden="true"></span>' +
    // The brand is a name, not a heading: the page's own h1 is its one.
    '<span class="den-title">__DEN_CLI__</span></a>' +
    // The prototype's scope breadcrumb (R4): / ORG <org> ▾ / WORKSPACE
    // <ws> ▾ / ENV <env> ▾. Each part is an .ib button with a .pop menu.
    // The org is a static label while there is one org (ORG-SPEC C4) and
    // hidden until header.js knows it; the workspace part is hidden until
    // header.js knows the workspaces. #env-sel stays as the env's value
    // (pages read it and listen for its change): the Env menu drives it.
    '<div class="den-scope" role="group" aria-label="' +
    esc(t("scope")) +
    '">' +
    '<span class="den-sep" aria-hidden="true">/</span>' +
    '<span id="org-crumb" class="den-ib den-org den-opt" hidden><span class="den-k">' +
    esc(t("k.org")) +
    '</span> <span class="den-org-name"></span></span>' +
    '<span class="den-sep den-org-sep" aria-hidden="true" hidden>/</span>' +
    scopeButton("ws-pill", "ws", t("k.ws"), "", true) +
    '<span class="den-sep den-ws-sep" aria-hidden="true" hidden>/</span>' +
    scopeButton("env-btn", "env", t("k.env"), "local", false) +
    '<select id="env-sel" hidden aria-hidden="true" tabindex="-1"><option value="local">local</option></select>' +
    "</div>" +
    chips +
    "</header>" +
    // The rail's box: no box of its own (display: contents). As ☰'s
    // drawer it is the modal dialog the rail sits in, so the rail stays a
    // nav (a <nav> may not be a dialog).
    '<div class="den-rail-box" id="den-rail-box">' +
    '<nav class="den-rail" id="den-rail" aria-label="' +
    esc(t("pages")) +
    '"></nav></div>';

  var nav = host.querySelector(".den-rail");
  var railBox = host.querySelector(".den-rail-box");

  // ── the scope parts (R4) ───────────────────────────────────────────────
  // Each part's menu comes from its model, set by header.js: setOrgs (the
  // org menu, only with two or more orgs), setWorkspaces (the view scope),
  // and the env from #env-sel's options. Choosing never starts, stops or
  // routes anything: the callbacks only store a preference.
  var scopeMenus = {
    org: null,
    ws: null,
    env: function () {
      var sel = document.getElementById("env-sel");
      if (!sel) return null;
      var items = [{ heading: t("k.env") }];
      Array.prototype.forEach.call(sel.options, function (o) {
        items.push({
          label: o.textContent,
          checked: o.value === sel.value,
          onSelect: function () {
            if (sel.value === o.value) return;
            sel.value = o.value;
            syncEnv();
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          },
        });
      });
      return { label: t("k.env"), items: items };
    },
  };
  function scopeMenu(kind) {
    var m = scopeMenus[kind];
    return typeof m === "function" ? m() : m;
  }
  host.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-scope]") : null;
    if (!b || b.tagName !== "BUTTON") return;
    openMenu(b, scopeMenu(b.dataset.scope));
  });
  host.addEventListener("keydown", function (e) {
    var b = e.target.closest ? e.target.closest("[data-scope]") : null;
    if (!b || b.tagName !== "BUTTON") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!openPop || openPop.anchor !== b)
        openMenu(b, scopeMenu(b.dataset.scope));
      if (e.key === "ArrowUp" && openPop) {
        var rows = menuRows(openPop.el);
        if (rows.length) rows[rows.length - 1].focus();
      }
    }
  });
  function setValue(btn, value, title) {
    if (!btn) return;
    btn.querySelector(".den-vn").textContent = value;
    if (title != null) btn.title = title;
  }
  /** The Env part's value: what #env-sel holds now. */
  function syncEnv() {
    var sel = document.getElementById("env-sel");
    if (sel) setValue(document.getElementById("env-btn"), sel.value);
  }
  var envSel = document.getElementById("env-sel");
  if (envSel) envSel.addEventListener("change", syncEnv);

  /** One org: "/ ORG <title>" as a static label, no ▾ (C4). */
  function setOrg(org) {
    var el = document.getElementById("org-crumb");
    if (!el || !org || !org.title) return false;
    if (el.tagName === "BUTTON") {
      var span = document.createElement("span");
      span.id = "org-crumb";
      span.className = "den-ib den-org den-opt";
      span.innerHTML =
        '<span class="den-k">' +
        esc(t("k.org")) +
        '</span> <span class="den-org-name"></span>';
      el.replaceWith(span);
      el = span;
    }
    scopeMenus.org = null;
    el.querySelector(".den-org-name").textContent = org.title;
    el.title = t(org.id ? "org.titleId" : "org.title", {
      title: org.title,
      id: org.id,
    });
    el.hidden = false;
    var sep = el.nextElementSibling;
    if (sep && sep.classList.contains("den-org-sep")) sep.hidden = false;
    return true;
  }
  /**
   * The orgs that own workspaces (ORG-1b plugs /api/orgs in here). Fewer
   * than two: the static label (C4). Two or more: an Org ▾ menu; picking
   * one calls onSelect(id) and fires `den:org` on window. No backend.
   */
  function setOrgs(orgs, current, onSelect) {
    var list = (Array.isArray(orgs) ? orgs : []).filter(function (o) {
      return o && o.id;
    });
    var cur = null;
    for (var i = 0; i < list.length; i++)
      if (list[i].id === current) cur = list[i];
    cur = cur || list[0];
    var title = function (o) {
      return o.title || o.label || o.id;
    };
    if (list.length < 2)
      return cur ? setOrg({ id: cur.id, title: title(cur) }) : false;
    var el = document.getElementById("org-crumb");
    if (!el) return false;
    if (el.tagName !== "BUTTON") {
      var tmp = document.createElement("span");
      tmp.innerHTML = scopeButton("org-crumb", "org", t("k.org"), "", false);
      var btn = tmp.firstChild;
      btn.className += " den-org den-opt";
      btn.querySelector(".den-vn").className += " den-org-name";
      el.replaceWith(btn);
      el = btn;
    }
    el.hidden = false;
    setValue(
      el,
      title(cur),
      t("org.titleId", { title: title(cur), id: cur.id }),
    );
    var sep = el.nextElementSibling;
    if (sep && sep.classList.contains("den-org-sep")) sep.hidden = false;
    scopeMenus.org = {
      label: t("k.org"),
      items: [{ heading: t("k.org") }].concat(
        list.map(function (o) {
          return {
            label: title(o),
            checked: o.id === cur.id,
            tag:
              typeof o.workspaces === "number"
                ? t("org.n", { n: o.workspaces })
                : null,
            onSelect: function () {
              if (o.id === cur.id) return;
              setOrgs(list, o.id, onSelect);
              if (typeof onSelect === "function") onSelect(o.id);
              try {
                window.dispatchEvent(
                  new CustomEvent("den:org", { detail: { id: o.id } }),
                );
              } catch (e) {
                /* no CustomEvent: the callback has it */
              }
            },
          };
        }),
      ),
    };
    return true;
  }
  /**
   * The Workspace part: { label, title, items: [{ value, label, checked,
   * focused, title? }], onSelect(value) }. "All active" and the active
   * workspaces, the focused one (model.focus, the CLI default) marked; then
   * a link to manage them. onSelect(value, focus): choosing a workspace
   * also makes it the CLI default (header.js).
   */
  // Every workspace's name, from the Workspace menu's model (header.js).
  var workspaceNameList = [];
  function workspaceNames() {
    return workspaceNameList.slice();
  }
  function setWorkspaces(model) {
    workspaceNameList =
      model && Array.isArray(model.names) ? model.names.slice() : [];
    var btn = document.getElementById("ws-pill");
    if (!btn) return;
    var sep = btn.nextElementSibling;
    if (!model) {
      btn.hidden = true;
      if (sep) sep.hidden = true;
      scopeMenus.ws = null;
      return;
    }
    setValue(btn, model.label, model.title || null);
    btn.hidden = false;
    if (sep) sep.hidden = false;
    var items = [{ heading: t("k.ws") }];
    if (!model.items || !model.items.length)
      items.push({ label: t("ws.none"), href: navHref("local-dev") });
    (model.items || []).forEach(function (it) {
      items.push({
        label: it.label,
        checked: !!it.checked,
        tag: it.focused ? t("ws.focus") : null,
        title: it.title || null,
        onSelect: function () {
          if (typeof model.onSelect !== "function") return;
          // The workspace in view still becomes the CLI default when it
          // isn't one; picking what is both already does nothing.
          if (it.checked && (it.value === "all" || it.value === model.focus))
            return;
          model.onSelect(it.value, model.focus || null, !!it.checked);
        },
      });
    });
    items.push({ hr: true });
    items.push({ label: t("ws.manage"), href: navHref("local-dev") });
    scopeMenus.ws = { label: t("k.ws"), items: items };
  }

  function healthDot(id) {
    var s = state.health[id];
    var cls =
      s === "down"
        ? " bad"
        : s === "degraded"
          ? " warn"
          : s === "ok"
            ? ""
            : " off";
    return '<span class="den-dot' + cls + '" aria-hidden="true"></span>';
  }
  /**
   * 0.4.18: a pin's Visit ↗: none without a URL, greyed out while it is
   * down. Down is the service panel's live state (pinOff), the same as its
   * dot, so it holds for a pin outside the View too; the rail's rollup
   * only without it.
   */
  function pinVisit(id) {
    var url = state.pinUrls && state.pinUrls[id];
    if (!url) return "";
    var off = state.pinOff || {};
    var down = Object.prototype.hasOwnProperty.call(off, id)
      ? !!off[id]
      : state.health[id] === "down";
    // D27: a real link (never popup-blocked, as window.open was in Safari).
    var live = !down && /^https?:\/\//i.test(url);
    return (
      '<a class="den-pvisit" tabindex="-1" data-visit="' +
      esc(id) +
      '" data-url="' +
      esc(url) +
      '"' +
      (live
        ? ' href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"'
        : ' role="link" aria-disabled="true"') +
      ' aria-label="' +
      esc(t("act.visitX", { s: id })) +
      '" title="' +
      esc(down ? t("svp.notRunning") : url) +
      '"><span aria-hidden="true">↗</span></a>'
    );
  }
  /** A pin's Visit ↗ clicked: true when the link opens by itself. */
  function visitPin(b) {
    if (b.getAttribute("aria-disabled") === "true" || !b.hasAttribute("href")) {
      toast(t("svp.notRunning"));
      return false;
    }
    return true;
  }
  // 0.4.18: the service panel (svc-panel.js registers it).
  var servicePanel = null;
  function setServicePanel(p) {
    servicePanel = p && typeof p.open === "function" ? p : null;
  }
  function pinHref(id) {
    var repo = id.split("/")[0];
    return "/services#repo-" + encodeURIComponent(repo);
  }
  function item(n, current, extra, attrs) {
    return (
      '<a class="den-ni" href="' +
      esc(n.href) +
      '" data-nav="' +
      esc(n.id) +
      '"' +
      (current ? ' aria-current="page"' : "") +
      (attrs || "") +
      ' title="' +
      esc(n.title) +
      '">' +
      (n.lead || icon(n.icon)) +
      '<span class="den-lbl' +
      (n.mono ? " den-mono" : "") +
      '">' +
      esc(n.title) +
      "</span>" +
      (extra || "") +
      "</a>"
    );
  }
  function group(id, label, from, body) {
    return (
      '<div class="den-rail-group" role="group" aria-labelledby="den-gh-' +
      esc(id) +
      '"' +
      (from ? ' aria-describedby="den-gd-' + esc(id) + '"' : "") +
      // The name is the label alone ("Acme", not "Acmeacme"): the tag is
      // in the description ("from acme").
      '><div class="den-gh"><span id="den-gh-' +
      esc(id) +
      '">' +
      esc(label) +
      "</span>" +
      (from
        ? '<span class="den-tagx" aria-hidden="true" title="' +
          esc(t("from", { d: from })) +
          '">' +
          esc(from) +
          "</span>"
        : "") +
      "</div>" +
      (from
        ? '<span class="den-sr" id="den-gd-' +
          esc(id) +
          '">' +
          esc(t("from", { d: from })) +
          "</span>"
        : "") +
      body +
      "</div>"
    );
  }
  /** The rail's markup from the registries and the state. */
  function railHtml() {
    var html = "";
    if (state.pins.length)
      html += group(
        "pinned",
        t("g.pinned"),
        null,
        state.pins
          .map(function (p) {
            // 0.4.18: the row (named by the id alone) opens the service's
            // panel in place (svc-panel.js); it is still the link to
            // Services, so ⌘-click and middle-click open that in a new
            // tab. Delete unpins it. Visit ↗ beside it opens the service's
            // URL, out of the tab order: the panel's first button is the
            // keyboard's Visit. Unpin is in the panel's footer.
            return (
              '<div class="den-pin-row">' +
              item(
                {
                  id: "pin-" + p,
                  href: pinHref(p),
                  title: p,
                  lead: healthDot(p),
                  mono: true,
                },
                false,
                "",
                ' data-pin="' +
                  esc(p) +
                  '" data-svpanel="' +
                  esc(p) +
                  '" aria-haspopup="dialog" aria-expanded="' +
                  (state.svpOpen === p ? "true" : "false") +
                  '" aria-keyshortcuts="Delete"',
              ) +
              pinVisit(p) +
              "</div>"
            );
          })
          .join(""),
      );
    var ordered = orderedNav();
    GROUPS.slice()
      .sort(byOrder)
      .forEach(function (g) {
        var items = ordered.filter(function (n) {
          return (
            n.group === g.id &&
            state.hidden.indexOf(n.id) < 0 &&
            (!n.when || n.when(state))
          );
        });
        if (!items.length) return;
        html += group(
          g.id,
          t(g.label),
          g.from,
          items
            .map(function (n) {
              var b = n.badge ? n.badge(state) : null;
              var name = t(n.label);
              return item(
                { id: n.id, href: n.href, title: name, icon: n.icon },
                n.id === page,
                b
                  ? '<span class="den-bdg' +
                      (b.bad ? " bad" : "") +
                      '" aria-hidden="true">' +
                      esc(b.n) +
                      "</span>"
                  : "",
                b && b.label
                  ? ' aria-label="' + esc(name + ", " + b.label) + '"'
                  : "",
              );
            })
            .join(""),
        );
      });
    html += '<div class="den-rail-grow"></div>';
    html += hubItem();
    html += item(
      {
        id: SETTINGS.id,
        href: SETTINGS.href,
        title: t(SETTINGS.label),
        icon: SETTINGS.icon,
      },
      page === SETTINGS.id,
    );
    html += identityChip();
    html +=
      '<button class="den-ni den-collapse-btn" type="button" data-act="collapse" aria-expanded="' +
      (state.collapsed ? "false" : "true") +
      '" title="' +
      esc(state.collapsed ? t("expand") : t("collapse")) +
      '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' +
      (state.collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6") +
      '"/></svg><span class="den-lbl">' +
      esc(state.collapsed ? t("expand") : t("collapse")) +
      "</span></button>";
    return html;
  }

  /**
   * The rail's Hub link, above Settings. It opens the company's page on
   * Hub in this tab (D51: a plain link, so ⌘-, Ctrl- and middle-click
   * still give a new one), with a count of what waits on the person
   * (whoami's unread). A token Hub
   * rejects, or a role it forbids, greys it, and it goes to Settings ›
   * Hub, which says what to do.
   */
  function hubTarget(u) {
    try {
      var x = new URL(u);
      return x.protocol === "https:" ||
        (x.protocol === "http:" &&
          (x.hostname === "localhost" ||
            x.hostname === "127.0.0.1" ||
            /\.localhost$/.test(x.hostname)))
        ? x.href
        : "";
    } catch (e) {
      return "";
    }
  }
  /**
   * Where Hub is, for the rail and ⌘K (D51): null when no Hub is set up;
   * else `href` (Hub, opened in this tab) or, when it can't be opened,
   * `why` (D49's reason; the item is greyed and goes to Settings › Hub).
   */
  function hubLink() {
    var h = state.hub;
    if (!h || !h.configured) return null;
    // Configured: always there. Connected, it opens Hub; otherwise it is
    // greyed, goes to Settings › Hub and says why (D49: a Hub that
    // vanished from the rail left no way across).
    var href =
      h.state === "connected"
        ? hubTarget(h.teamUrl || "") || hubTarget(h.url || "")
        : "";
    if (href) return { href: href, team: h.team || "" };
    var key =
      {
        rejected: "hub.railRejected",
        forbidden: "hub.railForbidden",
        no_token: "hub.railNoToken",
        unreachable: "hub.railUnreachable",
        bad_config: "hub.railBadConfig",
      }[h.state] ||
      (h.state === "connected" ? "hub.railBadUrl" : "hub.railUnreachable");
    return { href: "", why: t(key) };
  }
  function hubItem() {
    var h = state.hub;
    var link = hubLink();
    if (!link) return "";
    var label = t("hub.rail");
    var href = link.href;
    if (!href) {
      var why = link.why;
      return (
        '<a class="den-ni den-hub den-off" href="/settings#agents.hub" data-nav="hub" data-hub="' +
        esc(h.state || "unknown") +
        '" title="' +
        esc(why) +
        '" aria-label="' +
        esc(label + ": " + why) +
        '">' +
        icon("hub") +
        '<span class="den-lbl">' +
        esc(label) +
        "</span></a>"
      );
    }
    var tip = h.team
      ? t("hub.railTip", { team: h.team })
      : t("hub.railTipPlain");
    var n = typeof h.unread === "number" && h.unread > 0 ? h.unread : 0;
    var waiting = n ? t("hub.railUnread", { n: n }) : "";
    return (
      '<a class="den-ni den-hub" href="' +
      esc(href) +
      '" data-nav="hub" data-hub="connected" title="' +
      esc(tip) +
      '" aria-label="' +
      esc(label + ", " + tip + (waiting ? ", " + waiting : "")) +
      '">' +
      icon("hub") +
      '<span class="den-lbl">' +
      esc(label) +
      "</span>" +
      (n
        ? '<span class="den-bdg" aria-hidden="true">' +
          esc(n > 99 ? "99+" : n) +
          "</span>"
        : "") +
      "</a>"
    );
  }

  /**
   * SEC-2a: the rail footer's identity chip: "Local" (this machine, no
   * sign-in), "Signed in · this device" (a one-time link or a code) or
   * "@login" (GitHub). A rail item like Settings (the same .den-ni
   * metrics), opening Settings › Access.
   */
  function identityLabel(id) {
    if (!id) return "";
    if (id.kind === "local") return t("ident.local");
    if (id.kind === "github" && id.login) return "@" + id.login;
    if (id.kind === "github" || id.kind === "device") return t("ident.device");
    return "";
  }
  function identityChip() {
    var label = identityLabel(state.identity);
    if (!label) return "";
    return item(
      {
        id: "identity",
        href: "/settings#access",
        title: label,
        icon: "person",
      },
      false,
      "",
      ' id="den-ident" data-ident="' + esc(state.identity.kind) + '"',
    );
  }
  /** What GET /api/session said about this browser: the chip, and a toast once after a sign-in. */
  function applyIdentity(b) {
    if (!b || !b.identity) return;
    var was = state.identity;
    if (!was || was.kind !== b.identity.kind || was.login !== b.identity.login)
      setState({ identity: b.identity });
    if (b.justSignedIn)
      toast(
        t("ident.toast", {
          name: b.product || "__DEN_TITLE__",
          host: b.machine || "",
        }),
      );
  }

  // One tab stop for the rail: the current page, else the first item.
  function rove() {
    var links = Array.prototype.slice.call(nav.querySelectorAll(".den-ni"));
    var stop = null;
    for (var i = 0; i < links.length; i++)
      if (
        links[i].getAttribute
          ? links[i].getAttribute("aria-current") === "page"
          : links[i].attrs && links[i].attrs["aria-current"] === "page"
      )
        stop = links[i];
    if (!stop) stop = links[0];
    for (var j = 0; j < links.length; j++)
      links[j].tabIndex = links[j] === stop ? 0 : -1;
  }
  var lastHtml = "";
  function renderRail() {
    if (!nav) return;
    var html = railHtml();
    if (html === lastHtml) return;
    // Keep keyboard focus on the same item across a re-render.
    var active = document.activeElement;
    var keep =
      active && nav.contains && nav.contains(active) && active.dataset
        ? active.dataset.nav
        : null;
    lastHtml = html;
    nav.innerHTML = html;
    rove();
    if (keep && nav.querySelector) {
      var again = nav.querySelector('[data-nav="' + keep + '"]');
      if (again) {
        again.tabIndex = 0;
        again.focus();
      }
    }
  }

  /**
   * Unpin from the rail (Delete on a pinned row, or its ×) and keep focus
   * in the rail: the next pinned row, else the previous one, else the
   * first item. One rule for both paths.
   */
  function unpinFromRail(pinId) {
    var pins = Array.prototype.slice.call(
      nav.querySelectorAll(".den-ni[data-pin]"),
    );
    var at = -1;
    for (var k = 0; k < pins.length; k++)
      if (pins[k].dataset.pin === pinId) at = k;
    var to = at < 0 ? null : pins[at + 1] || pins[at - 1] || null;
    var toNav = to ? to.dataset.nav : null;
    unpin(pinId);
    var dest =
      (toNav && nav.querySelector('[data-nav="' + toNav + '"]')) ||
      nav.querySelector(".den-ni");
    if (!dest) return;
    Array.prototype.forEach.call(nav.querySelectorAll(".den-ni"), function (a) {
      a.tabIndex = a === dest ? 0 : -1;
    });
    dest.focus();
  }

  // ↑/↓, Home and End move along the rail; Tab still leaves it (except
  // in the narrow drawer, a modal: Tab stays inside).
  nav.addEventListener("keydown", function (e) {
    if (e.key === "Tab" && drawerOpen()) {
      e.preventDefault();
      return;
    }
    var links = Array.prototype.slice.call(nav.querySelectorAll(".den-ni"));
    var i = links.indexOf(document.activeElement);
    if (i < 0) return;
    var pinId =
      links[i].dataset && links[i].dataset.pin ? links[i].dataset.pin : null;
    if (pinId && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      unpinFromRail(pinId);
      return;
    }
    var next =
      e.key === "ArrowDown"
        ? (i + 1) % links.length
        : e.key === "ArrowUp"
          ? (i - 1 + links.length) % links.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? links.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    links[i].tabIndex = -1;
    links[next].tabIndex = 0;
    links[next].focus();
  });
  nav.addEventListener("click", function (e) {
    var tgt = e.target;
    var v = tgt && tgt.closest ? tgt.closest("[data-visit]") : null;
    if (v) {
      if (!visitPin(v)) e.preventDefault();
      return;
    }
    // 0.4.18: a plain click (or Enter) on a pinned row opens its panel;
    // ⌘/Ctrl-, Shift- and middle-click keep the link (Services).
    var sp = tgt && tgt.closest ? tgt.closest("[data-svpanel]") : null;
    if (
      sp &&
      servicePanel &&
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      servicePanel.open(sp.getAttribute("data-svpanel"), sp, {
        fromRail: true,
      });
      return;
    }
    var c = tgt && tgt.closest ? tgt.closest('[data-act="collapse"]') : null;
    if (c) {
      setState({ collapsed: !state.collapsed });
      saveShell({ collapsed: state.collapsed });
    }
  });

  function applyCollapsed() {
    if (document.body && document.body.classList)
      document.body.classList.toggle("den-rail-collapsed", !!state.collapsed);
  }

  // ☰ opens the rail as a drawer below 720px: a modal overlay. Focus
  // moves into the rail (the current item); the top bar and the page are
  // inert behind a scrim; Escape or the scrim closes it and focus goes back
  // to ☰; Tab stays inside.
  var menu = host.querySelector(".den-menu-btn");
  var scrim = null;
  function drawerOpen() {
    return document.body.classList.contains("den-rail-open");
  }
  function setInert(on) {
    var els = [
      host.querySelector(".den-top"),
      document.getElementById("den-content"),
      document.getElementById("den-dock"),
    ];
    els.forEach(function (el) {
      if (!el) return;
      if (on) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    });
  }
  function openDrawer() {
    document.body.classList.add("den-rail-open");
    if (menu) menu.setAttribute("aria-expanded", "true");
    railBox.setAttribute("role", "dialog");
    railBox.setAttribute("aria-modal", "true");
    railBox.setAttribute("aria-label", t("pages"));
    if (!scrim) {
      scrim = document.createElement("div");
      scrim.className = "den-scrim";
      scrim.addEventListener("click", function () {
        closeDrawer(true);
      });
    }
    document.body.appendChild(scrim);
    setInert(true);
    var stop =
      nav.querySelector('.den-ni[aria-current="page"]') ||
      nav.querySelector('.den-ni[tabindex="0"]') ||
      nav.querySelector(".den-ni");
    if (stop) stop.focus();
  }
  function closeDrawer(refocus) {
    if (!drawerOpen()) return;
    document.body.classList.remove("den-rail-open");
    if (menu) menu.setAttribute("aria-expanded", "false");
    railBox.removeAttribute("role");
    railBox.removeAttribute("aria-modal");
    railBox.removeAttribute("aria-label");
    if (scrim && scrim.remove) scrim.remove();
    setInert(false);
    if (refocus && menu) menu.focus();
  }
  if (menu)
    menu.addEventListener("click", function () {
      if (drawerOpen()) closeDrawer(true);
      else openDrawer();
    });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && drawerOpen() && !openPop) {
      e.preventDefault();
      closeDrawer(true);
    }
  });
  // Wider than the drawer's step: the rail is a rail again.
  window.addEventListener("resize", function () {
    if (drawerOpen() && window.innerWidth > 720) closeDrawer(false);
  });

  // ── the page header (R20, 0.3.0-dev.32) ──────────────────────────────
  // One h1 per page, the page's own (the brand is not a heading). A page
  // whose content has none gets the prototype's page header (.ph): the h1,
  // named from its rail entry or its <title> ("__DEN_TITLE__ · Services" →
  // Services), and a 13px muted sub line with the scope ("org / ws / env",
  // kept in step with the top bar's scope). A page adds its primary action
  // with denShell.pageHeader().act and its tabs below it with .tabs (both
  // empty until a page fills them). Settings and Edge draw their own.
  var ph = null;
  function scopeText() {
    var parts = [];
    var org = document.getElementById("org-crumb");
    if (org && !org.hidden) {
      var on =
        org.querySelector(".den-org-name") || org.querySelector(".den-vn");
      if (on && on.textContent) parts.push(on.textContent);
    }
    var over = (ph && ph.over) || {};
    [
      ["ws-pill", over.ws],
      ["env-btn", over.env],
    ].forEach(function (p) {
      if (p[1]) return parts.push(p[1]);
      var b = document.getElementById(p[0]);
      var v = b && !b.hidden ? b.querySelector(".den-vn") : null;
      if (v && v.textContent) parts.push(v.textContent);
    });
    return parts.join(" / ");
  }
  function paintPageSub() {
    if (!ph || ph.subFixed) return;
    var text = scopeText();
    if (ph.sub.textContent !== text) ph.sub.textContent = text;
  }
  function ensurePageHeader() {
    var main = document.getElementById("den-content");
    if (!main || main.querySelector("h1")) return;
    var label = "";
    NAV.forEach(function (n) {
      if (n.id === page) label = t(n.label);
    });
    if (!label) {
      var title = String(document.title || "");
      label = title.indexOf(" · ") >= 0 ? title.split(" · ").pop() : "";
    }
    if (!label) return;
    var el = document.createElement("div");
    el.className = "ph den-ph";
    el.innerHTML =
      '<div class="den-ph-h"><h1></h1><div class="sub"></div></div>' +
      '<div class="act" hidden></div>';
    el.querySelector("h1").textContent = label;
    main.insertBefore(el, main.firstChild);
    ph = {
      el: el,
      h1: el.querySelector("h1"),
      sub: el.querySelector(".sub"),
      act: el.querySelector(".act"),
      tabs: null,
      subFixed: false,
      over: null,
    };
    paintPageSub();
    var scope = host.querySelector(".den-scope");
    if (scope && typeof MutationObserver === "function")
      new MutationObserver(paintPageSub).observe(scope, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden"],
      });
  }
  // ── tabs: the WAI-ARIA tabs pattern, one helper (0.3.0-dev.33) ────────
  // Every page tablist (a page header's tabs) is wired here: one tab stop (the selected tab is tabindex 0, the rest
  // -1); ←/→ move and wrap, Home and End go to the ends, and each selects
  // as it moves (automatic activation); a click selects. Each tab has
  // aria-controls naming its role=tabpanel, which has aria-labelledby back
  // to the tab, and only the selected tab's panel shows.
  var tabSeq = 0;
  function tabIdOf(el, stem) {
    if (!el.id) el.id = "den-" + stem + "-" + ++tabSeq;
    return el.id;
  }
  /**
   * Wire `list` (an element with role=tablist) as tabs. opts:
   *   panelOf(tab)    its panel (default: the element its aria-controls
   *                   names)
   *   onSelect(tab)   after a tab is selected (by click or key)
   *   selected        the tab (or its index) to select first (default:
   *                   the one with aria-selected="true", else the first)
   * Returns { select(tabOrIndex, focus?), selected(), tabs() }. Wiring the
   * same list again replaces the old wiring.
   */
  function wireTabs(list, opts) {
    opts = opts || {};
    if (!list) return null;
    if (list._denTabs) list._denTabs.off();
    list.setAttribute("role", "tablist");
    function tabs() {
      return Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    }
    function panelOf(tab) {
      if (typeof opts.panelOf === "function") return opts.panelOf(tab);
      var id = tab.getAttribute("aria-controls");
      return id ? document.getElementById(id) : null;
    }
    tabs().forEach(function (tab) {
      var panel = panelOf(tab);
      tabIdOf(tab, "tab");
      if (!panel) return;
      tab.setAttribute("aria-controls", tabIdOf(panel, "tabpanel"));
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
    });
    function indexOf(t) {
      return typeof t === "number" ? t : tabs().indexOf(t);
    }
    function paint(i) {
      tabs().forEach(function (tab, j) {
        var on = j === i;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.setAttribute("tabindex", on ? "0" : "-1");
        tab.classList.toggle("active", on);
        var panel = panelOf(tab);
        if (panel) {
          panel.hidden = !on;
          panel.classList.toggle("active", on);
        }
      });
    }
    function select(t, focus) {
      var all = tabs();
      var i = indexOf(t);
      if (i < 0 || !all[i]) return;
      paint(i);
      if (focus) all[i].focus();
      if (typeof opts.onSelect === "function") opts.onSelect(all[i]);
    }
    function current() {
      var all = tabs();
      for (var i = 0; i < all.length; i++)
        if (all[i].getAttribute("aria-selected") === "true") return all[i];
      return all[0] || null;
    }
    function onClick(e) {
      var tab = e.target.closest && e.target.closest('[role="tab"]');
      if (!tab || !list.contains(tab)) return;
      e.preventDefault();
      select(tab, false);
    }
    function onKey(e) {
      var tab = e.target.closest && e.target.closest('[role="tab"]');
      if (!tab || !list.contains(tab)) return;
      var all = tabs();
      var i = all.indexOf(tab);
      var n = all.length;
      var next =
        e.key === "ArrowRight"
          ? (i + 1) % n
          : e.key === "ArrowLeft"
            ? (i - 1 + n) % n
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? n - 1
                : -1;
      if (next < 0) return;
      e.preventDefault();
      select(next, true);
    }
    list.addEventListener("click", onClick);
    list.addEventListener("keydown", onKey);
    var first =
      opts.selected != null ? indexOf(opts.selected) : indexOf(current());
    paint(first < 0 ? 0 : first);
    var api = {
      select: select,
      selected: current,
      tabs: tabs,
      off: function () {
        list.removeEventListener("click", onClick);
        list.removeEventListener("keydown", onKey);
        list._denTabs = null;
      },
    };
    list._denTabs = api;
    return api;
  }
  /**
   * The page header's tabs, made only when a page asks (no empty stub):
   * spec { label, tabs: [{ id, label, panel }], selected?, onSelect? }.
   * A .ptabs tablist below the header, wired by wireTabs; each panel is
   * the page's own element. Asked again, the old tablist is replaced.
   */
  function pageTabs(spec) {
    if (!ph || !spec || !Array.isArray(spec.tabs)) return null;
    if (ph.tabs) ph.tabs.remove();
    var list = document.createElement("div");
    list.className = "ptabs den-ptabs";
    list.setAttribute("role", "tablist");
    if (spec.label) list.setAttribute("aria-label", String(spec.label));
    var panels = [];
    var sel = 0;
    spec.tabs.forEach(function (d, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      if (d.id) b.setAttribute("data-tab", String(d.id));
      b.textContent = String(d.label || d.id || "");
      list.appendChild(b);
      panels.push(d.panel || null);
      if (spec.selected != null && d.id === spec.selected) sel = i;
    });
    ph.el.parentNode.insertBefore(list, ph.el.nextSibling);
    ph.tabs = list;
    var all = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    return wireTabs(list, {
      panelOf: function (tab) {
        return panels[all.indexOf(tab)] || null;
      },
      selected: sel,
      onSelect: function (tab) {
        if (typeof spec.onSelect === "function")
          spec.onSelect(tab.getAttribute("data-tab"), tab);
      },
    });
  }
  /**
   * The page header (R20): { el, h1, sub, act, tabs }, or null on a page
   * that draws its own. setSub(text) fixes the sub line (null: the scope
   * again); setScope({ ws?, env? }) keeps the scope line but names the
   * workspace or env the page shows (Workspaces and Graph show one
   * workspace, locally); a page shows .act by filling it and unhiding it,
   * and tabs with tabs(spec) (pageTabs: made only then).
   */
  function pageHeader() {
    if (!ph) return null;
    return {
      el: ph.el,
      h1: ph.h1,
      sub: ph.sub,
      act: ph.act,
      tabs: pageTabs,
      setSub: function (text) {
        ph.subFixed = text != null;
        if (text != null) ph.sub.textContent = String(text);
        else paintPageSub();
      },
      setScope: function (over) {
        ph.over = over || null;
        paintPageSub();
      },
    };
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", ensurePageHeader);
  else ensurePageHeader();

  // Skip to content: the page's <main id="den-content">, its one main
  // landmark (each page wraps its content in it).
  var skip = host.querySelector(".den-skip");
  if (skip)
    skip.addEventListener("click", function (e) {
      var el = document.getElementById("den-content");
      if (!el) return;
      e.preventDefault();
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus();
    });

  // The browser-tab icon is the active theme's (dev.22), set here and
  // nowhere else: no page links one. Until appearance.js knows the theme
  // (it calls setFavicon with the versioned URL for the mode it draws in,
  // again on every theme or mode change), the bare route serves the
  // active theme's, never cached.
  function setFavicon(href) {
    var links = document.querySelectorAll('link[rel~="icon"]');
    var link = document.getElementById("den-favicon");
    for (var i = 0; i < links.length; i++)
      if (links[i] !== link) links[i].remove();
    if (!link) {
      link = document.createElement("link");
      link.id = "den-favicon";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }
  setFavicon(
    "/theme-favicon?mode=" +
      (document.documentElement.dataset.mode === "light" ? "light" : "dark"),
  );

  document.body.classList.add("den-has-shell");
  applyCollapsed();
  renderRail();

  // ── the runs dock (R16, 0.3.0-dev.30) ──────────────────────────────────
  // One output dock for every page, at the foot of the content column
  // (the prototype's grid area `dock`). A bar: "Runs", the run tabs (mono
  // 12, a dot that pulses while running) and Show/Hide runs; open, a 170px
  // <pre> with the selected run's output. It replaces the pages' own output
  // panes: every run a page starts is a tab here, through denShell.runs.
  //
  //   runs.add(id, label, opts)     a tab (no change to its state if it
  //                                 exists, beyond what opts set)
  //   runs.start(id, label, opts)   add + running + selected; the dock
  //                                 stays as it is unless opts.open: true
  //                                 (R16a); opts.select: false keeps the
  //                                 selection
  //   runs.append(id, text, cls?, { key }?)  one line (cls: cmd, err, warn,
  //                                 done-ok, done-fail, ok, phase); a `key`
  //                                 replaces that line in place (progress)
  //   runs.finish(id, { ok })       stops the pulse; ok false is an error.
  //                                 A run with opts.doneLine (the default
  //                                 for new callers) gets "✓ done in {s}s"
  //   runs.set(id, { label, running, error, actions })
  //   runs.select(id, { open }) (opens only with open: true),
  //   runs.clear(id), runs.remove(id)
  //   runs.show(), hide(), toggle(), isOpen(), has(id), list(), selected(),
  //   runs.text(id), running(), onChange(fn)
  //   runs.scope({ ws } | null)     only that workspace's runs show, with
  //                                 an "All runs" toggle in the bar (R24e)
  //
  // opts: closable (default true: a × on the tab), onClose(id) (the page
  // decides; else the tab goes), onSelect(id), onClear(id), max (lines
  // kept, 0 = all), actions [{ id, label, title?, run(id) }] (buttons in
  // the bar for the selected run, e.g. Stop), doneLine, ws (the workspace
  // or workspaces it ran in, added to the ones it has).
  //
  // The bar carries Copy and Clear for the selected run (the panes had
  // them). R16a (Ward QA 2026-11-05): the dock starts collapsed to its bar.
  // Open/closed and its height are user prefs (/api/settings `shell.dock`,
  // `shell.dockHeight`, mirrored with the rest of the shell's prefs for the
  // first paint), so they survive navigation and reloads, per user. A run
  // starting never opens it: its tab appears and the Runs chip pulses. Only
  // the engineer opens it: Show runs, the Runs chip, a tab click, or a page
  // action whose whole point is output (runs.start/select with open: true).
  // Drag the dock's top edge to resize it, 60px to half the window.
  var SS_LAST_RUN = "__DEN_CLI__-last-run";
  var RUNS = [];
  var runSel = null;
  var DOCK_H = 170;
  var dockOpen = state.dock === true;
  var dockH = state.dockHeight >= 60 ? state.dockHeight : DOCK_H;
  var runSeqId = 0;
  var runListeners = [];
  /** At most half the window (R16a); at least 60px. */
  function dockCap(h) {
    var max = Math.max(60, Math.floor((window.innerHeight || 800) * 0.5));
    return Math.round(Math.max(60, Math.min(h, max)));
  }
  var dock = document.createElement("div");
  dock.className = "den-dock";
  dock.id = "den-dock";
  if (dock.setAttribute) {
    dock.setAttribute("role", "region");
    dock.setAttribute("aria-label", t("runs.title"));
  }
  function placeDock() {
    if (document.body && document.body.appendChild)
      document.body.appendChild(dock);
  }
  placeDock();
  // After the page's content (the foot of the column), once it's parsed.
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", placeDock);

  function runById(id) {
    for (var i = 0; i < RUNS.length; i++) if (RUNS[i].id === id) return RUNS[i];
    return null;
  }
  // R24e (0.3.0-dev.35): a page showing one workspace scopes the dock to
  // it (runs.scope({ ws })): only runs started in that workspace show, and
  // "All runs" (aria-pressed) shows every one. A run's workspaces are what
  // its page tagged it with (opts.ws); a run with none always shows.
  var runScope = null;
  var runAll = false;
  function inScope(r) {
    return (
      !runScope || runAll || !r.ws.length || r.ws.indexOf(runScope.ws) >= 0
    );
  }
  function visibleRuns() {
    return RUNS.filter(inScope);
  }
  function selectedRun() {
    var shown = visibleRuns();
    var r = runById(runSel);
    return (r && inScope(r) ? r : null) || shown[shown.length - 1] || null;
  }
  function runsChanged() {
    runListeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        /* a listener's problem */
      }
    });
    try {
      window.dispatchEvent(new CustomEvent("den:runs"));
    } catch (e) {
      /* no CustomEvent */
    }
  }
  /** Open/closed changed by the engineer: the pref follows. */
  function rememberDock() {
    if (state.dock === dockOpen) return Promise.resolve(true);
    state.dock = dockOpen;
    return saveShell({ dock: dockOpen });
  }
  /** The server's prefs arrived: the dock follows them. */
  function dockFromPrefs() {
    var h = state.dockHeight >= 60 ? state.dockHeight : DOCK_H;
    if (dockOpen === (state.dock === true) && h === dockH) return;
    dockOpen = state.dock === true;
    dockH = h;
    var out = outEl();
    if (out) out.style.height = dockCap(dockH) + "px";
    renderDock();
  }
  function secs(ms) {
    return num(Math.max(0, ms) / 1000, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }
  function dotClass(r) {
    if (r.running) return "run";
    if (r.error) return "bad";
    if (r.done) return "";
    return "off";
  }
  function runTitle(r) {
    if (r.running) return r.label;
    if (r.done && r.endedAt)
      return (
        r.label +
        " · " +
        t(r.error ? "dock.failed" : "dock.done", {
          s: secs(r.endedAt - r.startedAt),
        })
      );
    return r.label;
  }
  function lastRunHere() {
    try {
      var l = JSON.parse(sessionStorage.getItem(SS_LAST_RUN) || "null");
      var here = location.pathname + location.search;
      return l && l.page && l.page !== here ? l : null;
    } catch (e) {
      return null;
    }
  }

  // The bar: redrawn on any run's state change (not on every line).
  function barHtml() {
    var sel = selectedRun();
    var shown = visibleRuns();
    var tabs = shown.length
      ? shown
          .map(function (r) {
            var on = sel && sel.id === r.id;
            return (
              '<span class="den-rtab-w">' +
              '<button type="button" class="den-rtab' +
              (r.closable ? " den-x" : "") +
              '" role="tab" id="den-rtab-' +
              r.n +
              '" data-rsel="' +
              r.n +
              '" aria-selected="' +
              (on ? "true" : "false") +
              '" aria-controls="den-dock-out" tabindex="' +
              (on ? "0" : "-1") +
              '" title="' +
              esc(runTitle(r)) +
              '"' +
              (r.closable ? ' aria-keyshortcuts="Delete"' : "") +
              '><span class="den-dot ' +
              dotClass(r) +
              '" aria-hidden="true"></span>' +
              esc(r.label) +
              (r.running
                ? '<span class="den-sr">, ' +
                  esc(t("runs.n", { n: 1 })) +
                  "</span>"
                : r.error
                  ? '<span class="den-sr">, ' + esc(t("dock.err")) + "</span>"
                  : "") +
              "</button>" +
              (r.closable
                ? '<button type="button" class="den-rtab-x" tabindex="-1" data-rclose="' +
                  r.n +
                  '" aria-label="' +
                  esc(t("dock.closeRun", { s: r.label })) +
                  '" title="' +
                  esc(t("dock.closeRun", { s: r.label })) +
                  '"><span aria-hidden="true">×</span></button>'
                : "") +
              "</span>"
            );
          })
          .join("")
      : "<span>" + esc(t("runs.none")) + "</span>";
    var acts = "";
    if (dockOpen && sel) {
      (sel.actions || []).forEach(function (a, i) {
        acts +=
          '<button type="button" class="den-ib" data-ract="' +
          i +
          '"' +
          (a.title ? ' title="' + esc(a.title) + '"' : "") +
          ">" +
          esc(a.label) +
          "</button>";
      });
      acts +=
        '<button type="button" class="den-ib" data-dock="copy">' +
        esc(t("dock.copy")) +
        "</button>" +
        '<button type="button" class="den-ib" data-dock="clear">' +
        esc(t("dock.clear")) +
        "</button>";
    }
    return (
      "<b>" +
      esc(t("runs.title")) +
      "</b>" +
      // A tablist only while it holds tabs: an empty one ("No runs") is
      // a tablist with no tab, which screen readers announce as broken
      // (0.3.0-dev.34, a consumer's finding). The bar redraws on any run's
      // state change, so the first tab brings the role back.
      '<div class="den-runs-l"' +
      (shown.length
        ? ' role="tablist" aria-label="' + esc(t("runs.title")) + '"'
        : "") +
      ">" +
      tabs +
      "</div>" +
      (acts ? '<span class="den-dock-acts">' + acts + "</span>" : "") +
      // (No runs at all: nothing to filter, no toggle.)
      (runScope && RUNS.length
        ? '<button type="button" class="den-ib" data-dock="all" aria-pressed="' +
          (runAll ? "true" : "false") +
          '" title="' +
          esc(t(runAll ? "runs.allOn" : "runs.allTip", { ws: runScope.ws })) +
          '">' +
          esc(t("runs.all")) +
          "</button>"
        : "") +
      '<button type="button" class="den-ib" data-act="dock" aria-expanded="' +
      (dockOpen ? "true" : "false") +
      '" aria-controls="den-dock-out">' +
      esc(dockOpen ? t("dock.close") + " ▾" : t("dock.show") + " ▴") +
      "</button>"
    );
  }
  var shownRun = null;
  var pending = [];
  var rafId = null;
  function lineSpan(l) {
    var span = document.createElement("span");
    if (l.cls) span.className = l.cls;
    span.textContent = l.text + "\n";
    l.el = span;
    return span;
  }
  function outEl() {
    return dock.querySelector ? dock.querySelector("#den-dock-out") : null;
  }
  function fillOut() {
    var out = outEl();
    if (!out) return;
    pending = [];
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    var sel = selectedRun();
    shownRun = sel;
    out.innerHTML = "";
    if (sel) out.setAttribute("aria-labelledby", "den-rtab-" + sel.n);
    else out.removeAttribute("aria-labelledby");
    if (!sel) {
      out.textContent = t("runs.empty");
      var last = lastRunHere();
      if (last) {
        out.appendChild(document.createTextNode(" "));
        var a = document.createElement("a");
        a.href = last.page;
        a.textContent = t("dock.last", { s: last.label });
        out.appendChild(a);
      }
      return;
    }
    var frag = document.createDocumentFragment();
    sel.lines.forEach(function (l) {
      frag.appendChild(lineSpan(l));
    });
    out.appendChild(frag);
    if (sel.autoScroll) out.scrollTop = out.scrollHeight;
  }
  function flush() {
    rafId = null;
    var out = outEl();
    var batch = pending;
    pending = [];
    if (!out || !shownRun || !batch.length) return;
    var frag = document.createDocumentFragment();
    batch.forEach(function (l) {
      if (shownRun.lines.indexOf(l) >= 0) frag.appendChild(lineSpan(l));
    });
    out.appendChild(frag);
    if (shownRun.max)
      while (out.childElementCount > shownRun.max)
        out.removeChild(out.firstChild);
    if (shownRun.autoScroll) out.scrollTop = out.scrollHeight;
  }
  function renderDock() {
    if (!dock.querySelector) return;
    var bar = dock.querySelector(".den-bar");
    if (!bar) {
      dock.innerHTML =
        '<div class="den-dock-grip" aria-hidden="true" title="' +
        esc(t("dock.resize")) +
        '"></div><div class="den-bar"></div>';
      bar = dock.querySelector(".den-bar");
    }
    var focusSel =
      document.activeElement && dock.contains(document.activeElement)
        ? document.activeElement.getAttribute("data-rsel") ||
          document.activeElement.getAttribute("data-act") ||
          document.activeElement.getAttribute("data-dock")
        : null;
    bar.innerHTML = barHtml();
    dock.classList.toggle("open", dockOpen);
    var out = outEl();
    if (dockOpen && !out) {
      out = document.createElement("pre");
      out.id = "den-dock-out";
      out.setAttribute("role", "tabpanel");
      out.tabIndex = 0;
      out.style.height = dockCap(dockH) + "px";
      out.addEventListener("scroll", function () {
        if (!shownRun) return;
        shownRun.autoScroll =
          out.scrollHeight - out.scrollTop <= out.clientHeight + 20;
      });
      dock.appendChild(out);
      fillOut();
    } else if (!dockOpen && out) {
      out.remove();
      shownRun = null;
    } else if (out && selectedRun() !== shownRun) fillOut();
    // Keep focus on what had it (a redraw replaces the bar's buttons).
    if (focusSel) {
      var back =
        bar.querySelector('[data-rsel="' + focusSel + '"]') ||
        bar.querySelector('[data-act="' + focusSel + '"]') ||
        bar.querySelector('[data-dock="' + focusSel + '"]');
      if (back) back.focus();
    }
    var on = bar.querySelector('.den-rtab[aria-selected="true"]');
    if (on && on.scrollIntoView)
      on.scrollIntoView({ block: "nearest", inline: "nearest" });
    var chip = document.getElementById("den-runs");
    if (chip) {
      chip.setAttribute("aria-expanded", dockOpen ? "true" : "false");
      chip.setAttribute("aria-controls", "den-dock");
    }
  }

  function addRun(id, label, opts) {
    id = String(id);
    opts = opts || {};
    var r = runById(id);
    if (!r) {
      r = {
        id: id,
        n: ++runSeqId,
        label: String(label == null ? id : label),
        lines: [],
        running: false,
        done: false,
        error: false,
        startedAt: Date.now(),
        endedAt: null,
        autoScroll: true,
        closable: true,
        doneLine: true,
        max: 0,
        actions: [],
        keyed: {},
        ws: [],
        ranAt: null,
      };
      RUNS.push(r);
    } else if (label != null) r.label = String(label);
    // The workspaces it ran in (R24e): every one a page tagged it with.
    [].concat(opts.ws == null ? [] : opts.ws).forEach(function (w) {
      if (w && r.ws.indexOf(String(w)) < 0) r.ws.push(String(w));
    });
    [
      "closable",
      "doneLine",
      "max",
      "onClose",
      "onSelect",
      "onClear",
      "actions",
    ].forEach(function (k) {
      if (opts[k] !== undefined) r[k] = opts[k];
    });
    if (opts.running !== undefined) markRunning(r, !!opts.running);
    if (opts.error !== undefined) r.error = !!opts.error;
    return r;
  }
  /** Running on or off; when it last ran and ended (a page's last-run column). */
  function markRunning(r, on) {
    if (on && !r.running) {
      r.ranAt = Date.now();
      r.endedAt = null;
    } else if (!on && r.running) r.endedAt = Date.now();
    r.running = on;
  }
  var runsApi = {
    add: function (id, label, opts) {
      var r = addRun(id, label, opts);
      if (opts && opts.select) runSel = r.id;
      if (opts && opts.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
      runsChanged();
      return r.id;
    },
    start: function (id, label, opts) {
      opts = opts || {};
      var r = addRun(id, label, opts);
      r.running = opts.running !== false;
      r.done = false;
      r.error = false;
      r.startedAt = Date.now();
      r.ranAt = r.startedAt;
      r.endedAt = null;
      if (opts.clear) {
        r.lines = [];
        r.keyed = {};
        if (shownRun === r) shownRun = null;
      }
      if (opts.select !== false) runSel = r.id;
      // R16a: a run starting never opens the dock; open: true is for an
      // action whose whole point is output (e.g. a service's Logs).
      if (opts.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
      runsChanged();
      return r.id;
    },
    append: function (id, text, cls, o) {
      var r = runById(String(id));
      if (!r) return;
      var key = o && o.key;
      if (key != null && r.keyed[key] && r.lines.indexOf(r.keyed[key]) >= 0) {
        var l0 = r.keyed[key];
        l0.text = String(text);
        if (l0.el && shownRun === r) l0.el.textContent = l0.text + "\n";
        if (shownRun === r && r.autoScroll) {
          var o0 = outEl();
          if (o0) o0.scrollTop = o0.scrollHeight;
        }
        return;
      }
      var l = { text: String(text), cls: cls || "" };
      if (key != null) r.keyed[key] = l;
      r.lines.push(l);
      if (r.max && r.lines.length > r.max)
        r.lines.splice(0, r.lines.length - r.max);
      if (shownRun === r) {
        pending.push(l);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      }
    },
    finish: function (id, o) {
      var r = runById(String(id));
      if (!r) return;
      var ok = !(o && o.ok === false);
      r.running = false;
      r.done = true;
      r.error = !ok;
      r.endedAt = Date.now();
      if (r.doneLine)
        runsApi.append(
          r.id,
          (ok ? "✓ " : "✗ ") +
            t(ok ? "dock.done" : "dock.failed", {
              s: secs(r.endedAt - r.startedAt),
            }),
          ok ? "done-ok" : "done-fail",
        );
      renderDock();
      runsChanged();
    },
    set: function (id, o) {
      var r = runById(String(id));
      if (!r || !o) return;
      if (o.label != null) r.label = String(o.label);
      if (o.running !== undefined) markRunning(r, !!o.running);
      if (o.error !== undefined) r.error = !!o.error;
      if (o.actions !== undefined) r.actions = o.actions || [];
      renderDock();
      runsChanged();
    },
    select: function (id, o) {
      var r = runById(String(id));
      if (!r) return;
      runSel = r.id;
      if (o && o.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
    },
    clear: function (id) {
      var r = runById(String(id == null ? runSel : id));
      if (!r) return;
      r.lines = [];
      r.keyed = {};
      if (shownRun === r) fillOut();
    },
    remove: function (id) {
      var r = runById(String(id));
      if (!r) return;
      RUNS.splice(RUNS.indexOf(r), 1);
      if (runSel === r.id) {
        var last = RUNS[RUNS.length - 1];
        runSel = last ? last.id : null;
      }
      if (shownRun === r) shownRun = null;
      renderDock();
      runsChanged();
    },
    show: function () {
      dockOpen = true;
      rememberDock();
      renderDock();
    },
    hide: function () {
      dockOpen = false;
      rememberDock();
      renderDock();
    },
    toggle: function () {
      dockOpen = !dockOpen;
      rememberDock();
      renderDock();
      return dockOpen;
    },
    isOpen: function () {
      return dockOpen;
    },
    has: function (id) {
      return !!runById(String(id));
    },
    list: function () {
      return RUNS.map(function (r) {
        return {
          id: r.id,
          label: r.label,
          running: r.running,
          done: r.done,
          error: r.error,
          lines: r.lines.length,
          ws: r.ws.slice(),
          ranAt: r.ranAt,
          endedAt: r.endedAt,
          shown: inScope(r),
        };
      });
    },
    /**
     * Scope the dock to one workspace's runs (R24e), or null for every
     * run. "All runs" in the bar lifts it until the scope changes.
     */
    scope: function (o) {
      var ws = o && o.ws ? String(o.ws) : null;
      if ((runScope && runScope.ws) === ws) return;
      runScope = ws ? { ws: ws } : null;
      runAll = false;
      renderDock();
      runsChanged();
    },
    selected: function () {
      var r = selectedRun();
      return r ? r.id : null;
    },
    text: function (id) {
      var r = runById(String(id == null ? runSel : id)) || selectedRun();
      return r
        ? r.lines
            .map(function (l) {
              return l.text + "\n";
            })
            .join("")
        : "";
    },
    running: function () {
      return RUNS.filter(function (r) {
        return r.running;
      }).length;
    },
    onChange: function (fn) {
      if (typeof fn === "function") runListeners.push(fn);
    },
  };

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      ta.remove();
      if (ok) resolve();
      else reject(new Error("copy failed"));
    });
  }
  function runOfEl(el, attr) {
    var n = Number(el.getAttribute(attr));
    for (var i = 0; i < RUNS.length; i++) if (RUNS[i].n === n) return RUNS[i];
    return null;
  }
  function closeRun(r) {
    if (typeof r.onClose === "function") r.onClose(r.id);
    else runsApi.remove(r.id);
  }
  if (dock.addEventListener) {
    dock.addEventListener("click", function (e) {
      var tgt = e.target && e.target.closest ? e.target : null;
      if (!tgt) return;
      var x = tgt.closest("[data-rclose]");
      if (x) {
        var rx = runOfEl(x, "data-rclose");
        if (rx) closeRun(rx);
        return;
      }
      var tab = tgt.closest("[data-rsel]");
      if (tab) {
        var rt = runOfEl(tab, "data-rsel");
        if (!rt) return;
        runsApi.select(rt.id, { open: true });
        if (typeof rt.onSelect === "function") rt.onSelect(rt.id);
        return;
      }
      if (tgt.closest('[data-act="dock"]')) {
        runsApi.toggle();
        return;
      }
      var act = tgt.closest("[data-ract]");
      var sel = selectedRun();
      if (act && sel) {
        var a = (sel.actions || [])[Number(act.getAttribute("data-ract"))];
        if (a && typeof a.run === "function") a.run(sel.id);
        return;
      }
      var d = tgt.closest("[data-dock]");
      if (d && d.getAttribute("data-dock") === "all") {
        runAll = !runAll;
        renderDock();
        runsChanged();
        return;
      }
      if (!d || !sel) return;
      if (d.getAttribute("data-dock") === "clear") {
        runsApi.clear(sel.id);
        if (typeof sel.onClear === "function") sel.onClear(sel.id);
      } else {
        var btn = d;
        copyText(runsApi.text(sel.id))
          .then(function () {
            btn.textContent = t("dock.copied");
            setTimeout(function () {
              btn.textContent = t("dock.copy");
            }, 1500);
          })
          .catch(function () {});
      }
    });
    // The run tabs: one tab stop; ←/→, Home and End move (and select);
    // Delete closes a closable run.
    dock.addEventListener("keydown", function (e) {
      var tab = e.target && e.target.closest && e.target.closest("[data-rsel]");
      if (!tab) return;
      var r = runOfEl(tab, "data-rsel");
      var shown = visibleRuns();
      var i = shown.indexOf(r);
      var next =
        e.key === "ArrowRight"
          ? (i + 1) % shown.length
          : e.key === "ArrowLeft"
            ? (i - 1 + shown.length) % shown.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? shown.length - 1
                : -1;
      if (e.key === "Delete" && r && r.closable) {
        e.preventDefault();
        closeRun(r);
        var stop = dock.querySelector('.den-rtab[tabindex="0"]');
        if (stop) stop.focus();
        return;
      }
      if (next < 0 || !shown[next]) return;
      e.preventDefault();
      runsApi.select(shown[next].id, { open: dockOpen });
      if (typeof shown[next].onSelect === "function")
        shown[next].onSelect(shown[next].id);
      var to = dock.querySelector('[data-rsel="' + shown[next].n + '"]');
      if (to) to.focus();
    });
    // Drag the top edge to resize (Local Dev's handle): 60px to half the
    // window (R16a), remembered (shell.dockHeight).
    var drag = null;
    dock.addEventListener("mousedown", function (e) {
      if (!e.target.closest || !e.target.closest(".den-dock-grip")) return;
      var out = outEl();
      if (!out) return;
      drag = { y: e.clientY, h: out.offsetHeight };
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var out = outEl();
      if (!out) return;
      dockH = dockCap(drag.h + drag.y - e.clientY);
      out.style.height = dockH + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!drag) return;
      drag = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (state.dockHeight !== dockH) {
        state.dockHeight = dockH;
        saveShell({ dockHeight: dockH });
      }
    });
  }
  renderDock();

  // ── Errors people can see and act on (R26c, R26d, MD-2; dev.38) ───────
  // denShell.api(method, url, body?, opts?) is the one client path for a
  // call: it resolves with the data (JSON, else text) or throws a typed
  // error (name "DenApiError": status, code, requestId, method, url,
  // network, data, retry). The server's errors are { ok: false, error,
  // code, requestId } (R26b); a 200 with ok:false is an error too. One a
  // page doesn't catch becomes a toast: the message, the request id,
  // Retry and Copy details.
  //
  // Every same-origin fetch that fails at the network level (the server
  // stopped or is restarting) raises the banner "Den's server isn't
  // responding — retrying"; it probes /api/server-info with backoff and
  // clears itself when the server answers. Meanwhile `den:server` (detail
  // { up }) fires on window and the status chip reads unknown.
  //
  // Banners sit at the top of the page's content (the prototype's
  // .note-banner): the unreachable one, and the engine one (MD-2: the
  // server fills data-engine-stale on #den-shell; header.js's server-info
  // poll calls setEngine).
  function apiError(message, o) {
    var e = new Error(message);
    e.name = "DenApiError";
    e.denApi = true;
    e.status = o.status || 0;
    e.code = o.code || (o.network ? "network" : "http_" + e.status);
    e.requestId = o.requestId || null;
    e.method = o.method;
    e.url = o.url;
    e.network = !!o.network;
    e.data = o.data === undefined ? null : o.data;
    e.retry = o.retry || null;
    return e;
  }
  function pathOf(url) {
    return String(url || "").split("?")[0];
  }
  function api(method, url, body, opts) {
    opts = opts || {};
    method = String(method || "GET").toUpperCase();
    var init = { method: method, headers: {} };
    if (body !== undefined && body !== null) {
      init.headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    if (opts.signal) init.signal = opts.signal;
    if (opts.headers)
      for (var h in opts.headers) init.headers[h] = opts.headers[h];
    var what = method + " " + pathOf(url);
    var retry =
      opts.retry ||
      (method === "GET"
        ? function () {
            location.reload();
          }
        : function () {
            return api(method, url, body, opts).then(function () {
              toast(t("api.retried"));
            });
          });
    return fetch(url, init).then(
      function (r) {
        var get = function (k) {
          return r.headers && r.headers.get ? r.headers.get(k) || "" : "";
        };
        var isJson = /json/.test(get("Content-Type"));
        var parsed = isJson
          ? r.json().catch(function () {
              return null;
            })
          : typeof r.text === "function"
            ? r.text()
            : Promise.resolve(null);
        return parsed.then(function (data) {
          var failed =
            !r.ok || (data && typeof data === "object" && data.ok === false);
          if (!failed) return data;
          var msg =
            data && typeof data === "object" && typeof data.error === "string"
              ? data.error
              : typeof data === "string" && data.trim()
                ? data.trim().slice(0, 300)
                : t("api.failed", { what: what }) + " (" + r.status + ")";
          // SEC-1: a sign-in refusal in the page's language, with its command.
          if (
            data &&
            data.code === "signin_required" &&
            (data.scope === "agents" || data.scope === "terminal")
          ) {
            var cmd = /`([^`]+)`/.exec(String(data.error || ""));
            msg =
              (data.scope === "agents"
                ? t("err.signin.agents")
                : t("err.signin.terminal")) +
              (cmd ? ". " + t("err.signin.lead", { cmd: cmd[1] }) : "");
          }
          throw apiError(msg, {
            status: r.status,
            code: data && typeof data === "object" ? data.code : null,
            requestId:
              (data && typeof data === "object" && data.requestId) ||
              get("X-Request-Id") ||
              null,
            method: method,
            url: url,
            data: data,
            retry: retry,
          });
        });
      },
      function (err) {
        if (err && err.name === "AbortError") throw err;
        throw apiError(t("api.network", { what: what }), {
          network: true,
          method: method,
          url: url,
          retry: retry,
        });
      },
    );
  }
  /** The text "Copy details" puts on the clipboard (no stack, no body). */
  function errorDetails(err) {
    return [
      "Den " + (versionText() || "unknown"),
      (err.method || "GET") + " " + pathOf(err.url),
      "Status " + (err.network ? "no answer" : err.status),
      "Code " + (err.code || ""),
      "Request " + (err.requestId || "none"),
      "Message " + err.message,
      "Page " + location.pathname,
      "Time " + new Date().toISOString(),
    ].join("\n");
  }
  function versionText() {
    var v =
      document.querySelector && document.querySelector("#version-pill .v-txt");
    var s = v ? String(v.textContent || "").replace(/^v/, "") : "";
    return s && s !== "…" ? s : "";
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text).catch(function () {});
    return Promise.resolve();
  }
  var errToastTimer = null;
  /** An error toast: message, request id, Retry, Copy details, ×. */
  function errorToast(err) {
    if (!document.body || !document.createElement) return;
    var old = document.querySelector && document.querySelector(".den-toast");
    if (old && old.remove) old.remove();
    clearTimeout(toastTimer);
    clearTimeout(errToastTimer);
    var el = document.createElement("div");
    el.className = "den-toast den-toast-err";
    el.setAttribute("role", "alert");
    el.innerHTML =
      '<span class="den-te-ic" aria-hidden="true">⚠</span>' +
      '<span class="den-te-msg"><span class="den-te-t"></span>' +
      (err.requestId
        ? '<span class="den-te-id">' +
          esc(t("api.request", { id: err.requestId })) +
          "</span>"
        : "") +
      "</span>" +
      (err.retry
        ? '<button type="button" class="den-tbtn" data-te="retry">' +
          esc(t("api.retry")) +
          "</button>"
        : "") +
      '<button type="button" class="den-tbtn" data-te="copy">' +
      esc(t("api.copy")) +
      "</button>" +
      '<button type="button" class="den-tx" data-te="close" aria-label="' +
      esc(t("api.close")) +
      '">×</button>';
    el.querySelector(".den-te-t").textContent = err.message;
    var hold = false;
    var arm = function () {
      clearTimeout(errToastTimer);
      errToastTimer = setTimeout(function () {
        if (!hold && el.remove) el.remove();
      }, 12000);
    };
    el.addEventListener("mouseenter", function () {
      hold = true;
    });
    el.addEventListener("mouseleave", function () {
      hold = false;
      arm();
    });
    el.addEventListener("focusin", function () {
      hold = true;
    });
    el.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-te]");
      if (!b) return;
      var act = b.getAttribute("data-te");
      if (act === "close") el.remove();
      else if (act === "copy")
        copyText(errorDetails(err)).then(function () {
          b.textContent = t("api.copied");
        });
      else if (act === "retry") {
        el.remove();
        try {
          var p = err.retry();
          if (p && typeof p.catch === "function")
            p.catch(function (again) {
              if (again && again.denApi) errorToast(again);
            });
        } catch (again) {
          if (again && again.denApi) errorToast(again);
        }
      }
    });
    document.body.appendChild(el);
    arm();
  }
  if (typeof window.addEventListener === "function")
    window.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      if (!r || !r.denApi) return;
      if (e.preventDefault) e.preventDefault();
      errorToast(r);
    });

  // Banners (.note-banner): at the top of the page's content.
  var BANNERS = {};
  function bannerHost() {
    var main =
      document.getElementById && document.getElementById("den-content");
    if (!main) return null;
    var box = document.getElementById("den-banners");
    if (!box) {
      box = document.createElement("div");
      box.id = "den-banners";
      box.className = "den-banners";
      box.setAttribute("aria-live", "polite");
    }
    if (main.firstChild !== box) main.insertBefore(box, main.firstChild);
    // A page whose content is already inset (edge, settings) needs none.
    var pad = 0;
    try {
      pad = parseFloat(getComputedStyle(main).paddingLeft) || 0;
    } catch (e) {
      pad = 0;
    }
    box.classList.toggle("den-banners-inset", pad >= 12);
    return box;
  }
  /** Show (or replace) banner `id`: { title?, text, action?: { label, run } }. */
  function showBanner(id, b) {
    BANNERS[id] = b;
    paintBanners();
  }
  function hideBanner(id) {
    if (!BANNERS[id]) return;
    delete BANNERS[id];
    paintBanners();
  }
  function paintBanners() {
    var box = bannerHost();
    if (!box) {
      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", paintBanners, {
          once: true,
        });
      return;
    }
    var ids = Object.keys(BANNERS);
    box.hidden = ids.length === 0;
    box.innerHTML = ids
      .map(function (id) {
        var b = BANNERS[id];
        return (
          '<div class="den-banner warn" data-banner="' +
          esc(id) +
          '" role="status"><span class="den-bn-ic" aria-hidden="true">⚠</span>' +
          (b.title ? "<b>" + esc(b.title) + "</b>" : "") +
          '<span class="den-bn-t">' +
          esc(b.text) +
          "</span>" +
          (b.note ? '<span class="den-bn-n">' + esc(b.note) + "</span>" : "") +
          (b.action
            ? '<button type="button" class="den-tbtn" data-bn-act="' +
              esc(id) +
              '">' +
              esc(b.action.label) +
              "</button>"
            : "") +
          "</div>"
        );
      })
      .join("");
  }
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest && e.target.closest("[data-bn-act]");
    if (!b) return;
    var ban = BANNERS[b.getAttribute("data-bn-act")];
    if (ban && ban.action) ban.action.run();
  });

  // MD-2: the engine on disk is not the one this server runs.
  function setEngine(info) {
    if (!info || !info.stale) {
      hideBanner("engine");
      return;
    }
    // The server's message is the English one (it names builds when the
    // versions match); another language says it from its catalog.
    showBanner("engine", {
      title: t("engine.title"),
      text:
        (lang === "en" && info.message) ||
        t("engine.stale", {
          onDisk: info.onDisk || "?",
          loaded: info.loaded || "?",
          cli: "__DEN_CLI__",
        }),
    });
  }
  if (host.dataset.engineStale) {
    try {
      var eng = JSON.parse(host.dataset.engineStale);
      eng.stale = true;
      setEngine(eng);
    } catch (e) {
      /* a malformed attribute: no banner */
    }
  }

  // 0.4.3: the edge is reachable from other machines (the server fills
  // data-edge-exposed on #den-shell). One line; dismissed per browser.
  var EDGE_LS = "den.edgeExposed.dismissed";
  var edgeDismissed = false;
  try {
    edgeDismissed = localStorage.getItem(EDGE_LS) === "1";
  } catch (e) {
    edgeDismissed = false;
  }
  if (host.dataset.edgeExposed && !edgeDismissed)
    showBanner("edge-exposed", {
      text: host.dataset.edgeExposed,
      action: {
        label: t("api.close"),
        run: function () {
          try {
            localStorage.setItem(EDGE_LS, "1");
          } catch (e) {
            /* no storage: dismissed for this page only */
          }
          hideBanner("edge-exposed");
        },
      },
    });

  // The config fails validation (0.4.1): the server marks every page it
  // serves while it does (data-config-invalid on #den-shell), and the first
  // /api answer of 422 config_invalid marks it too. From then on the shell
  // and its modules start none of the polls and streams that read the
  // config (health, edge, workspaces, applications, the org config, …):
  // each would only answer 422 again. A reload once fixed starts them.
  var configBad = host.dataset.configInvalid === "1";
  // SEC-1b: a refusal page (421 "Wrong address", or signed out): the server
  // marks it (data-api-off), since every /api call from it would answer
  // the same refusal. The shell starts none of its polls and streams, the
  // same gate as an invalid config, and the status chip reads unknown.
  var apiOffPage = host.dataset.apiOff === "1";
  function apiOff() {
    return apiOffPage;
  }
  function configInvalid() {
    return configBad || apiOffPage;
  }
  function markConfigInvalid() {
    if (configBad) return;
    configBad = true;
    try {
      window.dispatchEvent(new CustomEvent("den:config-invalid"));
    } catch (e) {
      /* no CustomEvent */
    }
  }

  // R26d: the server unreachable.
  var server = { up: true, delay: 0, timer: null, tick: null, nextAt: 0 };
  var rawFetch =
    typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  function sameOrigin(input) {
    var u =
      typeof input === "string"
        ? input
        : input && (typeof input.url === "string" ? input.url : input.href);
    if (!u) return false;
    if (u.charAt(0) === "/" && u.charAt(1) !== "/") return true;
    try {
      return new URL(u, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }
  function serverState(up) {
    if (server.up === up) return;
    server.up = up;
    if (document.body && document.body.classList)
      document.body.classList.toggle("den-server-down", !up);
    try {
      window.dispatchEvent(
        new CustomEvent("den:server", { detail: { up: up } }),
      );
    } catch (e) {
      /* no CustomEvent */
    }
  }
  function paintDown() {
    var left = Math.max(0, Math.ceil((server.nextAt - Date.now()) / 1000));
    showBanner("net", {
      text: t("net.down"),
      note: left > 0 ? t("net.next", { s: left }) : "",
      action: { label: t("net.now"), run: probeNow },
    });
  }
  function serverUnreachable() {
    if (!server.up) return;
    serverState(false);
    server.delay = 1000;
    scheduleProbe();
  }
  function scheduleProbe() {
    clearTimeout(server.timer);
    clearInterval(server.tick);
    server.nextAt = Date.now() + server.delay;
    paintDown();
    server.tick = setInterval(paintDown, 1000);
    server.timer = setTimeout(probe, server.delay);
  }
  function probeNow() {
    clearTimeout(server.timer);
    probe();
  }
  function probe() {
    if (!rawFetch) return;
    rawFetch("/api/server-info", { cache: "no-store" }).then(
      function () {
        serverBack();
      },
      function () {
        if (server.up) return;
        server.delay = Math.min(server.delay * 2, 15000);
        scheduleProbe();
      },
    );
  }
  function serverBack() {
    clearTimeout(server.timer);
    clearInterval(server.tick);
    hideBanner("net");
    serverState(true);
  }
  // SEC-1a: every same-origin call that changes something (POST, PUT,
  // PATCH, DELETE), through denShell.api() or a page's own fetch(), carries
  // X-Den-CSRF with the token GET /api/session hands out. The token is per
  // server start: a 403 `csrf` (the server restarted) fetches a fresh one
  // and retries once. Never sent to another origin.
  var CSRF_METHODS = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };
  // 0.4.15: the approval key (web-session.ts). A sign-in's 303 carries it
  // in the URL fragment (#ak=…), which never reaches a server: keep it in
  // this origin's localStorage (other localhost ports can't read it),
  // strip it from the address bar, and send it with every same-origin
  // change as X-Den-Approve-Key. Only approving needs it.
  var APPROVE_KEY_STORE = "den.approveKey";
  (function takeApproveKey() {
    var m = /(?:^#|&)ak=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash || "");
    if (!m) return;
    try {
      localStorage.setItem(APPROVE_KEY_STORE, m[1]);
    } catch (e) {
      /* storage blocked: this browser signs in again to approve */
    }
    try {
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
    } catch (e) {
      location.hash = "";
    }
  })();
  function approveKey() {
    try {
      return localStorage.getItem(APPROVE_KEY_STORE);
    } catch (e) {
      return null;
    }
  }
  var csrf = { token: null, pending: null };
  function csrfToken(fresh) {
    if (fresh) csrf.token = null;
    if (csrf.token) return Promise.resolve(csrf.token);
    if (!csrf.pending)
      csrf.pending = rawFetch("/api/session", {
        cache: "no-store",
        credentials: "same-origin",
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(
          function (b) {
            csrf.pending = null;
            csrf.token = b && typeof b.csrf === "string" ? b.csrf : null;
            applyIdentity(b);
            return csrf.token;
          },
          function () {
            csrf.pending = null;
            return null;
          },
        );
    return csrf.pending;
  }
  function isRequest(input) {
    return typeof Request !== "undefined" && input instanceof Request;
  }
  function methodOf(input, init) {
    var m = (init && init.method) || (isRequest(input) && input.method);
    return String(m || "GET").toUpperCase();
  }
  function withCsrf(input, init, token) {
    var headers = new Headers(
      (init && init.headers) || (isRequest(input) ? input.headers : undefined),
    );
    headers.set("X-Den-CSRF", token);
    var ak = approveKey();
    if (ak && !headers.has("X-Den-Approve-Key"))
      headers.set("X-Den-Approve-Key", ak);
    return Object.assign({}, init || {}, { headers: headers });
  }
  function csrfFetch(input, init) {
    // A body that can be sent twice (not a stream) may be retried.
    var body = init && init.body;
    var again =
      !isRequest(input) &&
      (body == null ||
        typeof body === "string" ||
        (typeof FormData !== "undefined" && body instanceof FormData) ||
        (typeof URLSearchParams !== "undefined" &&
          body instanceof URLSearchParams) ||
        (typeof Blob !== "undefined" && body instanceof Blob));
    var send = function (token) {
      return rawFetch(input, token ? withCsrf(input, init, token) : init);
    };
    return csrfToken(false).then(function (token) {
      return send(token).then(function (r) {
        if (!again || !r || r.status !== 403) return r;
        return r
          .clone()
          .json()
          .then(
            function (b) {
              if (!b || b.code !== "csrf") return r;
              return csrfToken(true).then(function (fresh) {
                return fresh ? send(fresh) : r;
              });
            },
            function () {
              return r;
            },
          );
      });
    });
  }
  if (rawFetch && !window.fetch.__denShell) {
    var wrapped = function (input, init) {
      var p =
        CSRF_METHODS[methodOf(input, init)] && sameOrigin(input)
          ? csrfFetch(input, init)
          : rawFetch(input, init);
      if (!p || typeof p.then !== "function") return p;
      return p.then(
        function (r) {
          if (!server.up && sameOrigin(input)) serverBack();
          if (r && r.status === 422 && !configBad && sameOrigin(input))
            r.clone()
              .json()
              .then(function (b) {
                if (b && b.code === "config_invalid") markConfigInvalid();
              })
              .catch(function () {});
          return r;
        },
        function (err) {
          if (err && err.name === "TypeError" && sameOrigin(input))
            serverUnreachable();
          throw err;
        },
      );
    };
    wrapped.__denShell = true;
    window.fetch = wrapped;
    // The token is in hand before the first click needs it.
    if (!apiOffPage) csrfToken(false);
  }

  // ── ON-3: an agent's held write waits for the person ─────────────────
  // (approval-routes.ts) Every page asks GET /api/approvals every few
  // seconds while it is in view, and opens the oldest request: Den's own
  // words for it (the agent's note only quoted), Review (what it will do),
  // Later, Deny, Allow. Allow and Deny go through the wrapped fetch above,
  // so they carry the CSRF token and the approval key; the server decides
  // who may approve (a browser that isn't signed in is told to sign in).
  // The frame is the Start dialog's (persona-ui.css's .pe-dlg).
  var ap = { dlg: null, shown: null, later: {}, busy: false, css: null };
  function apCss() {
    if (ap.css) return ap.css;
    ap.css = new Promise(function (done) {
      if (document.querySelector('link[href="/persona-ui.css"]')) return done();
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "/persona-ui.css";
      l.onload = l.onerror = function () {
        done();
      };
      document.head.appendChild(l);
    });
    return ap.css;
  }
  function apWhat(a) {
    var p = a.params || {};
    var key =
      "ap.do." +
      a.action +
      (p.isNew ? ".new" : p.activates ? ".activates" : "");
    var s = t(key, p);
    if (s !== key) return s;
    s = String(a.summary || a.action);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function apDialog() {
    if (ap.dlg) return ap.dlg;
    var d = document.createElement("dialog");
    d.className = "pe-dlg den-ap-dlg";
    d.id = "den-ap-dlg";
    d.setAttribute("aria-labelledby", "den-ap-h");
    d.innerHTML =
      '<form method="dialog">' +
      '<h2 id="den-ap-h"></h2>' +
      '<p class="help den-ap-who" id="den-ap-who" hidden></p>' +
      '<p class="den-ap-what" id="den-ap-what"></p>' +
      '<p class="help" id="den-ap-note" hidden></p>' +
      '<pre class="den-ap-det" id="den-ap-det" hidden></pre>' +
      '<p class="help" id="den-ap-waits"></p>' +
      '<p class="err" id="den-ap-err" role="alert" hidden></p>' +
      '<div class="btns">' +
      '<button type="button" class="den-btn" id="den-ap-review" aria-expanded="false" aria-controls="den-ap-det"></button>' +
      '<span class="sp help" id="den-ap-more"></span>' +
      '<button type="button" class="den-btn" id="den-ap-later"></button>' +
      '<button type="button" class="den-btn" id="den-ap-deny"></button>' +
      '<button type="button" class="den-btn primary" id="den-ap-allow"></button>' +
      "</div></form>";
    document.body.appendChild(d);
    var $ = function (id) {
      return d.querySelector("#" + id);
    };
    $("den-ap-review").addEventListener("click", function () {
      var det = $("den-ap-det");
      det.hidden = !det.hidden;
      $("den-ap-review").textContent = t(det.hidden ? "ap.review" : "ap.hide");
      $("den-ap-review").setAttribute("aria-expanded", String(!det.hidden));
    });
    $("den-ap-later").addEventListener("click", function () {
      apLater();
    });
    // Esc is Later: the request keeps waiting (and the agent with it).
    d.addEventListener("cancel", function (e) {
      e.preventDefault();
      apLater();
    });
    $("den-ap-deny").addEventListener("click", function () {
      apDecide("deny");
    });
    $("den-ap-allow").addEventListener("click", function () {
      apDecide("allow");
    });
    ap.dlg = d;
    return d;
  }
  function apLater() {
    if (ap.shown) ap.later[ap.shown.id] = 1;
    apClose();
  }
  function apClose() {
    ap.shown = null;
    if (ap.dlg && ap.dlg.open) ap.dlg.close();
  }
  function apShow(a, more) {
    var d = apDialog();
    var $ = function (id) {
      return d.querySelector("#" + id);
    };
    var same = ap.shown && ap.shown.id === a.id;
    ap.shown = a;
    // No agent token: say so, and what to do if no agent was asked.
    $("den-ap-h").textContent = t("ap.title", {
      agent: a.agent ? t("ap.agent", { name: a.agent }) : t("ap.noAgent"),
    });
    $("den-ap-who").hidden = !!a.agent;
    $("den-ap-who").textContent = a.agent ? "" : t("ap.noAgentWarn");
    $("den-ap-what").textContent = apWhat(a);
    var note = $("den-ap-note");
    note.hidden = !a.note;
    note.textContent = a.note ? t("ap.says") + " “" + a.note + "”" : "";
    $("den-ap-det").textContent = (a.details || []).join("\n");
    var time = new Date(a.expiresAt);
    $("den-ap-waits").textContent = t("ap.waits", {
      time: isNaN(time)
        ? ""
        : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
    $("den-ap-more").textContent = more ? t("ap.more", { n: more }) : "";
    $("den-ap-later").textContent = t("ap.later");
    $("den-ap-deny").textContent = t("ap.deny");
    $("den-ap-allow").textContent = t("ap.allow");
    if (!same) {
      $("den-ap-det").hidden = true;
      $("den-ap-review").textContent = t("ap.review");
      $("den-ap-review").setAttribute("aria-expanded", "false");
      $("den-ap-err").hidden = true;
    }
    if (!d.open)
      apCss().then(function () {
        if (ap.shown && ap.shown.id === a.id && !d.open) d.showModal();
      });
  }
  function apError(msg) {
    var e = apDialog().querySelector("#den-ap-err");
    e.textContent = msg;
    e.hidden = false;
  }
  function apDecide(decision) {
    var a = ap.shown;
    if (!a || ap.busy) return;
    ap.busy = true;
    var btns = ap.dlg.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    fetch("/api/approvals/" + encodeURIComponent(a.id) + "/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: decision }),
    })
      .then(function (r) {
        return r.json().then(
          function (b) {
            return { ok: r.ok, b: b || {} };
          },
          function () {
            return { ok: false, b: {} };
          },
        );
      })
      .then(
        function (x) {
          if (!x.ok) {
            apError(x.b.error || t("ap.failed", { error: x.b.code || "?" }));
            return;
          }
          var res = x.b.result;
          if (decision === "allow" && res && res.ok === false)
            toast(t("ap.failed", { error: res.error || "?" }));
          else if (decision === "allow")
            toast(t("ap.done", { what: apWhat(a) }));
          apClose();
          apPoll();
        },
        function (e) {
          apError(String((e && e.message) || e));
        },
      )
      .then(function () {
        ap.busy = false;
        for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
      });
  }
  // Reading what waits needs what approving needs (approvals.ts): the
  // session's CSRF token and the approval key, on a GET too. A browser
  // without them is told only that something waits, and to sign in.
  function apList(fresh) {
    var ak = approveKey();
    // No approval key: only the count, to say "sign in to see it".
    if (!ak)
      return rawFetch("/api/approvals?count=1", {
        cache: "no-store",
        credentials: "same-origin",
      }).then(function (r) {
        return r.ok
          ? r.json().then(function (b) {
              return { code: "signin_to_approve", waiting: b && b.waiting };
            })
          : null;
      });
    return csrfToken(fresh).then(function (token) {
      var h = { "X-Den-Approve-Key": ak };
      if (token) h["X-Den-CSRF"] = token;
      return rawFetch("/api/approvals", {
        cache: "no-store",
        credentials: "same-origin",
        headers: h,
      }).then(function (r) {
        return r.json().then(
          function (b) {
            if (!fresh && r.status === 403 && b && b.code === "csrf")
              return apList(true);
            return b;
          },
          function () {
            return null;
          },
        );
      });
    });
  }
  function apSignin(b) {
    if (b && b.code === "signin_to_approve" && b.waiting > 0)
      showBanner("approvals", {
        title: t("ap.signin.title"),
        text: t("ap.signin", { cmd: "__DEN_CLI__ web login" }),
      });
    else hideBanner("approvals");
  }
  function apPoll() {
    if (document.hidden || ap.busy) return;
    apList(false).then(
      function (b) {
        apSignin(b);
        var list = (b && b.ok && b.pending) || [];
        var open = list.filter(function (a) {
          return !ap.later[a.id];
        });
        if (!open.length) return apClose();
        var cur =
          (ap.shown &&
            open.filter(function (a) {
              return a.id === ap.shown.id;
            })[0]) ||
          open[0];
        apShow(cur, open.length - 1);
      },
      function () {},
    );
  }
  if (!apiOffPage && !configBad && rawFetch) {
    setInterval(apPoll, 3000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) apPoll();
    });
    setTimeout(apPoll, 300);
  }

  // ── the UI language (R19): a user pref ───────────────────────────────
  // /api/settings `language` (user.yml), then a reload: the server serves
  // every page with that language's catalog from its first paint.
  function setLanguage(l) {
    if (l === lang) return Promise.resolve(false);
    return api("POST", "/api/settings", { language: l }).then(function () {
      location.reload();
      return true;
    });
  }
  // The tab's title names the page in the page's language.
  (function () {
    var label = page === SETTINGS.id ? SETTINGS.label : null;
    NAV.forEach(function (n) {
      if (n.id === page) label = n.label;
    });
    var title = String(document.title || "");
    var at = title.lastIndexOf(" · ");
    if (label && at >= 0)
      document.title = title.slice(0, at) + " · " + t(label);
  })();

  // D32: the rail's Agents badge on every page: helpers running now
  // (GET /api/sessions/helpers, a count). The Agents page sets it itself
  // from its own list. Quiet on any failure: the badge just isn't there.
  (function () {
    if (page === "agents" || typeof rawFetch !== "function") return;
    function poll() {
      // A refusal page or a bad config: no polls (each would be refused).
      if (configInvalid()) return;
      if (document.hidden) return void setTimeout(poll, 15000);
      rawFetch("/api/sessions/helpers", {
        cache: "no-store",
        credentials: "same-origin",
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(
          function (b) {
            var n = b && typeof b.running === "number" ? b.running : 0;
            if (n !== state.helpersRunning) setState({ helpersRunning: n });
          },
          function () {},
        )
        .then(function () {
          setTimeout(poll, 15000);
        });
    }
    setTimeout(poll, 1500);
  })();

  // The rail's Hub link (hubItem): GET /api/hub?rail=1 (which leaves
  // Connect's one-time result for Settings) at load and every minute while
  // the page shows. Quiet on any failure: the link just isn't there.
  (function () {
    if (typeof rawFetch !== "function") return;
    var last = "";
    function poll() {
      // A refusal page or a bad config: no polls (each would be refused).
      if (configInvalid()) return;
      if (document.hidden) return void setTimeout(poll, 60000);
      rawFetch("/api/hub?rail=1", {
        cache: "no-store",
        credentials: "same-origin",
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(
          function (b) {
            var h =
              b && b.configured
                ? {
                    configured: true,
                    state: b.state,
                    url: b.url,
                    team: b.team,
                    teamUrl: b.teamUrl,
                    unread: b.unread,
                  }
                : null;
            var k = JSON.stringify(h);
            if (k !== last) {
              last = k;
              setState({ hub: h });
            }
          },
          function () {},
        )
        .then(function () {
          setTimeout(poll, 60000);
        });
    }
    setTimeout(poll, 800);
  })();

  window.denShell = {
    registerGroup: registerGroup,
    registerNav: registerNav,
    addMessages: function (l, msgs) {
      MESSAGES[l] = Object.assign({}, MESSAGES[l] || {}, msgs || {});
      lastHtml = "";
      renderRail();
    },
    t: t,
    /** R19: the page's language, the ones with a catalog, and a switch. */
    lang: function () {
      return lang;
    },
    languages: function () {
      return LANGUAGES.slice();
    },
    setLanguage: setLanguage,
    /** A number in the page's language (Intl.NumberFormat options). */
    formatNumber: num,
    setState: setState,
    getState: function () {
      return state;
    },
    pin: pin,
    unpin: unpin,
    isPinned: isPinned,
    toast: toast,
    toastAction: toastAction,
    /** R26c: a call that resolves with its data or throws a DenApiError. */
    api: api,
    /** R26c: the error toast for a DenApiError (what an uncaught one gets). */
    errorToast: errorToast,
    /** A banner at the top of the content: { title?, text, note?, action? }. */
    showBanner: showBanner,
    hideBanner: hideBanner,
    /** MD-2: { stale, loaded, onDisk, message? } from /api/server-info. */
    setEngine: setEngine,
    /** R26d: whether the server answers (false while the banner shows). */
    serverUp: function () {
      return server.up;
    },
    /**
     * 0.4.1: true once the config is known to fail validation, or on a
     * refusal page (apiOff): the config polls and streams don't start.
     */
    configInvalid: configInvalid,
    /** SEC-1b: a refusal page (421, signed out): no /api call would answer. */
    apiOff: apiOff,
    /** The browser-tab icon (appearance.js: the active theme's, per mode). */
    setFavicon: setFavicon,
    /** The org part of the scope: "/ ORG <title>", static (one org). */
    setOrg: setOrg,
    setOrgs: setOrgs,
    setWorkspaces: setWorkspaces,
    workspaceNames: workspaceNames,
    // D51: Hub's link for ⌘K (null: none set up).
    hubLink: hubLink,
    /** Repaint the Env part from #env-sel (after setting its value). */
    syncEnv: syncEnv,
    syncPinToggles: syncPinToggles,
    registerCommand: registerCommand,
    unregisterCommand: unregisterCommand,
    commands: commands,
    /** A .pop menu below `anchor` (the model as the scope menus'). */
    openMenu: openMenu,
    /**
     * The top layer (0.4.17): show(el, anchor, { align: "left"|"right",
     * gap }) puts a page's own menu above everything, placed by its
     * anchor; hide(el). The page hiding it (display: none) closes it too.
     */
    topLayer: { show: topShow, hide: topHide },
    /**
     * 0.4.18: the service panel. svc-panel.js registers { open, close,
     * visit }; openServicePanel(id, opener) opens it beside opener.
     */
    setServicePanel: setServicePanel,
    openServicePanel: function (id, opener) {
      if (servicePanel) servicePanel.open(id, opener);
    },
    closeMenu: function () {
      closeMenu(false);
    },
    groups: function () {
      return GROUPS.slice().sort(byOrder);
    },
    nav: function () {
      return NAV.slice();
    },
    /** NAV in the rail's order (groups, then your order), hidden included. */
    orderedNav: orderedNav,
    setNavPrefs: setNavPrefs,
    setPins: setPins,
    setCollapsed: setCollapsed,
    setDock: setDock,
    /** The runs dock (R16): every page's output, one path. */
    runs: runsApi,
    /** The page header (R20): { el, h1, sub, act, tabs(spec), setSub }, or null. */
    pageHeader: pageHeader,
    /** Wire a role=tablist as WAI-ARIA tabs (roving tabindex, keys, panels). */
    wireTabs: wireTabs,
    registerSettingsCategory: registerSettingsCategory,
    registerSetting: registerSetting,
    settings: function () {
      return SETTING_ROWS.slice();
    },
    settingsCategories: function () {
      return SETTING_CATS.slice().sort(byOrder);
    },
  };

  // The ready path for a script that loads before shell.js:
  // window.denShellQueue is an array of functions, each called with
  // denShell once it exists (now); a later push runs at once. Then
  // `den-shell:ready` fires on window.
  var queued = Array.isArray(window.denShellQueue) ? window.denShellQueue : [];
  function runQueued(fn) {
    if (typeof fn !== "function") return;
    try {
      fn(window.denShell);
    } catch (err) {
      warn("a denShellQueue function threw: " + (err && err.message));
    }
  }
  window.denShellQueue = {
    push: function () {
      for (var i = 0; i < arguments.length; i++) runQueued(arguments[i]);
      return 0;
    },
    length: 0,
  };
  queued.forEach(runQueued);
  try {
    window.dispatchEvent(
      new CustomEvent("den-shell:ready", { detail: window.denShell }),
    );
  } catch (e) {
    /* no CustomEvent: the queue still ran */
  }
  // The queue has drained and ready has fired: a page still without its
  // group (or a setting without its category) a tick from now warns.
  settled = true;
  checkOrphansSoon();

  // The server's prefs win over the local copy.
  if (typeof fetch === "function" && !apiOff())
    fetch("/api/settings")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        if (!s || !s.shell) return;
        setState({
          pins: Array.isArray(s.shell.pins) ? s.shell.pins : [],
          collapsed: s.shell.collapsed === true,
          hidden: Array.isArray(s.shell.hidden) ? s.shell.hidden : [],
          order: Array.isArray(s.shell.order) ? s.shell.order : [],
          dock: s.shell.dock === true,
          dockHeight:
            typeof s.shell.dockHeight === "number" ? s.shell.dockHeight : 0,
        });
        remember();
        dockFromPrefs();
      })
      .catch(function () {});

  // The Edge page shows once the edge is configured (no Docker asked).
  if (typeof fetch === "function" && !configInvalid())
    fetch("/api/edge?probe=1")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (e) {
        if (!e) return;
        setState({ edge: e.configured === true });
        remember();
      })
      .catch(function () {});

  var style = document.createElement("style");
  style.id = "den-shell-styles";
  style.textContent = [
    // Layout: the prototype's 48px bar, 216px rail (56px collapsed); a
    // drawer below 720px.
    // The prototype's rail is `width: 216px` (56px collapsed) in a
    // content box: with its padding and border it takes 233px (73px).
    "body.den-has-shell { --den-top-h: 48px; --den-rail-cw: 216px;",
    "  --den-rail-w: calc(var(--den-rail-cw) + 17px); padding-left: var(--den-rail-w); }",
    "body.den-has-shell.den-rail-collapsed { --den-rail-cw: 56px; }",
    // A column on every page (most pages are one already), so the runs
    // dock sits at the foot even when the content is short.
    "body.den-has-shell { display: flex; flex-direction: column; min-height: 100vh; }",
    ".den-shell { display: contents; }",
    ".den-top, .den-rail { font: 14px/1.45 var(--sans); }",
    ".den-top :focus-visible, .den-rail :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-skip { position: fixed; left: 8px; top: -40px; z-index: 100; padding: 6px 10px;",
    "  background: var(--surface); color: var(--text); border: 1px solid var(--accent);",
    "  border-radius: var(--radius-button); font: 600 12px var(--sans); text-decoration: none; }",
    ".den-skip:focus { top: 8px; }",
    // Top bar (.top)
    ".den-top { display: flex; align-items: center; gap: 8px; height: var(--den-top-h);",
    "  box-sizing: border-box; padding: 0 12px; flex-shrink: 0; position: relative; z-index: 20;",
    "  margin-left: calc(-1 * var(--den-rail-w)); background: var(--surface);",
    "  border-bottom: 1px solid var(--border); min-width: 0; color: var(--text); }",
    ".den-top::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;",
    "  background: var(--bar, none); pointer-events: none; }",
    // Brand (.brand, .mark)
    ".den-brand { display: flex; align-items: center; gap: 8px; color: var(--text);",
    "  text-decoration: none; flex-shrink: 0; white-space: nowrap; }",
    ".den-title { font: 600 15px var(--display); margin: 0; white-space: nowrap; }",
    "#den-shell .den-mark { width: 22px; height: 22px; }",
    "#den-shell .den-mark img { width: 22px; height: 22px; }",
    "#den-shell .den-mark-text { font: 700 12px/1 var(--mono); }",
    "#den-shell .den-mark-rounded { border-radius: 6px; }",
    // Buttons in the bar (.ib)
    ".den-ib { background: none; border: 1px solid transparent; border-radius: var(--radius-button);",
    "  padding: 4px 8px; cursor: pointer; color: var(--muted); display: inline-flex;",
    "  align-items: center; gap: 6px; white-space: nowrap; font: inherit; }",
    ".den-ib:hover { background: var(--sunken); color: var(--text); }",
    ".den-menu-btn { display: none; }",
    // Scope (.scope, .sep, .k): / Org ▾ / Workspace ▾ / Env ▾ (R4)
    // The search gives way first (dev.20): the scope keeps its parts whole
    // (each name is capped below), so they never run into one another.
    ".den-scope { display: flex; align-items: center; gap: 2px; min-width: 0; flex-shrink: 0; }",
    ".den-sep { color: var(--faint); }",
    ".den-scope [hidden] { display: none; }",
    ".den-scope .den-ib { color: var(--text); font-size: 13px; }",
    ".den-k { font: 11px var(--mono); color: var(--faint); text-transform: uppercase; letter-spacing: .06em; }",
    ".den-scope .den-ib[aria-expanded='true'] { background: var(--sunken); }",
    // A long name ends in an ellipsis; the whole name is in the menu.
    ".den-scope .den-ib { min-width: 0; }",
    "#ws-pill .den-vn, #org-crumb .den-vn { display: inline-block; max-width: 200px; overflow: hidden;",
    "  text-overflow: ellipsis; vertical-align: top; }",
    // Menus (.pop, .ml, .mi, .hr: R18)
    ".den-pop { position: fixed; z-index: 45; background: var(--raised); border: 1px solid var(--border-strong);",
    "  border-radius: 10px; box-shadow: var(--shadow); padding: 6px; min-width: 220px;",
    "  max-height: calc(100vh - 72px); overflow-y: auto; box-sizing: border-box;",
    "  font: 14px/1.45 var(--sans); color: var(--text); }",
    ".den-pop:focus { outline: none; }",
    // The top layer (0.4.17): a page's menu placed by its anchor (topShow), not
    // where the UA puts a popover.
    // No inset here: top and left are topPlace's (an !important inset beat them,
    // and every menu sat at the window's corner, 0.4.17-dev.0).
    ".den-toplayer { position: fixed !important; margin: 0 !important;",
    "  right: auto !important; bottom: auto !important; z-index: 1000; overflow-y: auto;",
    "  color: var(--text); }",
    // LK-1: the admin-password prompt is a <dialog> in the top layer (a popover, or
    // a modal over another modal): placed by its top/left, no UA box.
    "dialog.den-pop { margin: 0; inset: auto; max-width: none; }",
    "dialog.den-pop::backdrop { background: transparent; }",
    ".den-pop :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-pop .den-ml { font: 11px var(--mono); color: var(--faint); text-transform: uppercase;",
    "  letter-spacing: .07em; padding: 6px 8px 2px; }",
    ".den-pop .den-mi { display: flex; width: 100%; align-items: center; gap: 8px; background: none;",
    "  border: 0; padding: 6px 8px; border-radius: 6px; cursor: pointer; text-align: left;",
    "  font: inherit; color: inherit; text-decoration: none; box-sizing: border-box; }",
    ".den-pop .den-mi:hover, .den-pop .den-mi:focus { background: var(--sunken); }",
    // The ✓ is drawn, not read (aria-checked says it): alt text "".
    ".den-pop .den-mi[aria-checked='true']::after { content: '✓' / ''; margin-left: auto; color: var(--accent-text); }",
    ".den-pop .den-mi-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-pop .den-mtag { font: 11px var(--mono); color: var(--muted); }",
    ".den-pop .den-hr { height: 1px; background: var(--border); margin: 6px 0; }",
    // The page's one main landmark (#den-content) holds all its content
    // and lays it out as the body did (a column), so pages keep their look.
    "body.den-has-shell > #den-content { display: flex; flex-direction: column; flex: 1 1 auto;",
    "  min-height: 0; min-width: 0; }",
    "body.den-has-shell > #den-content:focus { outline: none; }",
    // The page header (.ph, R20, 0.3.0-dev.32), the prototype's sizes: it
    // sits in .main's 20px/24px inset (pages keep their own content
    // full-bleed below it). .ptabs are the page tabs below it.
    "#den-content > .den-ph { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;",
    "  flex: none; margin: 0 0 16px; padding: 20px 24px 0; font: 14px/1.45 var(--sans); color: var(--text); box-sizing: border-box; }",
    ".den-ph h1 { font: 600 22px/1.2 var(--display); margin: 0; padding: 0; text-wrap: balance; color: var(--text); }",
    ".den-ph .sub { color: var(--muted); font-size: 13px; margin: 4px 0 0; padding: 0; min-height: 1.45em; }",
    ".den-ph .act { margin-left: auto; display: flex; gap: 8px; }",
    ".den-ph [hidden], .den-ptabs[hidden], [role='tabpanel'][hidden] { display: none !important; }",
    ".ptabs.den-ptabs { flex: none; margin: 0 24px 18px; }",
    ".ptabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); overflow-x: auto; }",
    ".ptabs [role='tab'] { background: none; border: 0; padding: 8px 12px; color: var(--muted); cursor: pointer;",
    "  border-bottom: 2px solid transparent; margin: 0 0 -1px; white-space: nowrap; font: inherit; font-size: 14px;",
    "  line-height: 1.45; text-decoration: none; }",
    ".ptabs [role='tab']:hover { color: var(--text); }",
    ".ptabs [role='tab'][aria-selected='true'] { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }",
    // Search (.search, kbd: R5). The prototype's sizes are content-box
    // (the pages reset everything to border-box).
    ".den-search { flex: 1 1 260px; max-width: 420px; margin: 0 auto; display: flex; align-items: center;",
    "  gap: 8px; background: var(--sunken); border: 1px solid var(--border); border-radius: var(--radius-button);",
    "  padding: 5px 10px; color: var(--faint); cursor: text; min-width: 0; font: inherit; box-sizing: content-box; }",
    ".den-search-ph { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }",
    ".den-search-ic { flex: none; }",
    ".den-top kbd, .den-pal kbd { font: 11px var(--mono); border: 1px solid var(--border); border-bottom-width: 2px;",
    "  border-radius: 4px; padding: 0 5px; color: var(--muted); background: var(--surface); }",
    // Chips (.chips, .chip, .dot: R6, R7, R8)
    ".den-chips { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }",
    ".den-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border);",
    "  border-radius: 999px; padding: 3px 10px; background: var(--surface); cursor: pointer; font: inherit;",
    "  font-size: 13px; white-space: nowrap; flex-shrink: 0; color: var(--text); }",
    ".den-chip:hover { border-color: var(--border-strong); }",
    ".den-chip.bad { border-color: color-mix(in srgb, var(--bad) 50%, var(--border)); }",
    ".den-chip .den-n { font-variant-numeric: tabular-nums; }",
    ".den-chip .den-dot, .den-drawer .den-dot, .den-pal .den-dot { margin: 0; }",
    ".den-chip[aria-expanded='true'] { border-color: var(--border-strong); }",
    ".den-chip[hidden] { display: none; }",
    "#den-lock { border-color: color-mix(in srgb, var(--warn) 55%, var(--border)); }",
    ".den-dot.run { background: var(--accent); animation: den-pulse 1.2s infinite; }",
    ".den-dot.pending { background: var(--faint); animation: den-pulse 1.2s infinite; }",
    "@keyframes den-pulse { 50% { opacity: .35; } }",
    "@media (prefers-reduced-motion: reduce) { .den-dot.run, .den-dot.pending { animation: none; } }",
    ".den-user { display: contents; }",
    // Buttons in overlays (.btn, .btn.sm, .btn.primary)
    ".den-btn { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-button);",
    "  padding: 6px 12px; cursor: pointer; font: inherit; font-weight: 500; white-space: nowrap; color: var(--text); }",
    ".den-btn:hover { border-color: var(--border-strong); }",
    ".den-btn.primary { background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); }",
    ".den-btn.sm { padding: 2px 9px; font-size: 12.5px; }",
    ".den-btn:disabled { opacity: .6; cursor: default; }",
    // D27: Visit is a link styled as a button.
    "a.den-btn, a.den-pvisit { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }",
    "a.den-pvisit { display: grid; }",
    // Status drawer (.scrim, .drawer, .prob-card, .grp, .svl: R15)
    ".den-scrim { position: fixed; inset: 0; background: rgb(0 0 0 / 0.35); z-index: 40; }",
    ".den-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100%); z-index: 41;",
    "  box-sizing: content-box; background: var(--surface); border-left: 1px solid var(--border);",
    "  box-shadow: var(--shadow); display: flex; flex-direction: column; font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    ".den-drawer :focus-visible, .den-pal :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-drawer .den-dh { display: flex; align-items: center; gap: 10px; padding: 14px 16px;",
    "  border-bottom: 1px solid var(--border); }",
    ".den-drawer .den-dh h2 { margin: 0; font: 600 16px var(--display); flex: 1; }",
    ".den-drawer .den-db { overflow-y: auto; padding: 12px 16px 24px; display: grid; gap: 16px; align-content: start; }",
    ".den-drawer .den-none { margin: 0; color: var(--muted); }",
    ".den-sec { font: 600 13px var(--mono); text-transform: uppercase; letter-spacing: .07em; color: var(--muted);",
    "  margin: 0 0 10px; }",
    ".den-cards, .den-grps { display: grid; gap: 14px; }",
    ".den-cards { gap: 8px; }",
    ".den-prob-card { border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--border));",
    "  background: color-mix(in srgb, var(--bad) 7%, var(--surface)); border-radius: var(--radius);",
    "  padding: 10px 12px; display: grid; gap: 6px; }",
    ".den-prob-card .den-t { display: flex; gap: 8px; align-items: center; font-weight: 600; }",
    ".den-prob-card .den-t .den-mono { font-weight: 400; color: var(--muted); }",
    ".den-prob-card .den-s { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }",
    ".den-prob-card .den-a { display: flex; gap: 6px; flex-wrap: wrap; }",
    ".den-grp h3 { margin: 0 0 6px; font: 600 12px var(--mono); color: var(--muted); display: flex;",
    "  justify-content: space-between; text-transform: uppercase; letter-spacing: .06em; }",
    ".den-svl { display: grid; gap: 2px; }",
    ".den-svl button { display: flex; align-items: center; gap: 8px; background: none; border: 0; padding: 4px 6px;",
    "  border-radius: 5px; cursor: pointer; text-align: left; font: inherit; color: inherit; min-width: 0; }",
    ".den-svl button:hover { background: var(--sunken); }",
    ".den-svl .den-mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-svl .den-ms { margin-left: auto; font: 12px var(--mono); color: var(--faint);",
    "  font-variant-numeric: tabular-nums; white-space: nowrap; }",
    // Command palette (.pal-wrap, .pal: R17)
    ".den-pal-wrap { position: fixed; inset: 0; z-index: 50; display: grid; justify-items: center;",
    "  align-items: start; padding: 12vh 16px 0; background: rgb(0 0 0 / 0.35); font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    ".den-pal { width: min(620px, 100%); box-sizing: content-box; background: var(--raised);",
    "  border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }",
    ".den-pal input { width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--border);",
    "  background: transparent; padding: 14px 16px; font-family: var(--sans); font-size: 16px; color: var(--text);",
    // line-height too: a page's `input { font: inherit }` (Settings) must not reach it.
    "  line-height: normal; outline: none; margin: 0; }",
    ".den-pal ul { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow-y: auto; }",
    ".den-pal li { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; cursor: pointer; }",
    ".den-pal li[aria-selected='true'] { background: color-mix(in srgb, var(--accent) 16%, transparent); }",
    ".den-pal li .den-pal-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-pal li .den-kind { margin-left: auto; font: 11px var(--mono); color: var(--faint); text-transform: uppercase;",
    "  letter-spacing: .05em; white-space: nowrap; }",
    ".den-pal li .den-sub { color: var(--faint); font: 12px var(--mono); white-space: nowrap; }",
    // D51: Hub when it can't be opened: greyed, its reason in words.
    ".den-pal li.den-off .den-pal-l { color: var(--muted); }",
    ".den-pal li.den-off .den-sub { font: 12px var(--sans); white-space: normal; min-width: 0; }",
    ".den-pal li.den-pal-empty { cursor: default; color: var(--muted); }",
    ".den-pal .den-foot { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--border);",
    "  color: var(--faint); font-size: 12px; flex-wrap: wrap; }",
    // The admin-password prompt (.pop form, .pop input, .note: R8, LK-0)
    ".den-pop form { display: grid; gap: 8px; padding: 6px 8px 8px; width: 260px; box-sizing: content-box; margin: 0; }",
    ".den-pop input:not([type='checkbox']) { border: 1px solid var(--border); background: var(--bg); color: var(--text);",
    "  border-radius: var(--radius-button); padding: 6px 8px; font: inherit; font-size: 13.3333px; line-height: normal; }",
    ".den-pop .den-note, .den-pop .den-mnote { color: var(--muted); font-size: 12.5px; margin: 0; }",
    ".den-pop .den-mnote { padding: 4px 8px; max-width: 260px; }",
    ".den-pop .den-lock-save { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 12.5px; }",
    ".den-pop .den-lock-save[hidden], .den-pop .den-lock-err[hidden], .den-mslot[hidden] { display: none; }",
    ".den-pop .den-lock-err { color: var(--bad); font-size: 12.5px; }",
    ".den-pop #den-lock-t { overflow-wrap: anywhere; }",
    // What's new (.ib.whatsnew + .badge-dot)
    "#den-shell .v-pill { font: inherit; padding: 4px 8px; border: 1px solid transparent;",
    "  border-radius: var(--radius-button); color: var(--muted); flex-shrink: 0; }",
    "#den-shell .v-pill:hover { background: var(--sunken); color: var(--text); border-color: transparent; }",
    "#den-shell .v-pip { position: static; width: 7px; height: 7px; border: 0; border-radius: 50%;",
    "  background: var(--accent); }",
    // ◐ ▾ (the prototype's user menu, an .ib: appearance.js)
    ".den-top .den-ib[aria-expanded='true'] { background: var(--sunken); color: var(--text); }",
    // Rail (.rail)
    ".den-rail-box { display: contents; }",
    ".den-rail { position: fixed; left: 0; top: var(--den-top-h); bottom: 0; width: var(--den-rail-cw);",
    "  box-sizing: content-box; display: flex; flex-direction: column; padding: 10px 8px;",
    "  background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; z-index: 15;",
    "  color: var(--text); }",
    ".den-rail-group { display: contents; }",
    // Group heading (.gh)
    ".den-gh { font: 11px var(--mono); text-transform: uppercase; letter-spacing: .07em; color: var(--faint);",
    "  padding: 12px 10px 4px; display: flex; justify-content: space-between; }",
    ".den-rail > .den-rail-group:first-child > .den-gh { padding-top: 2px; }",
    ".den-tagx { font: 10px var(--mono); color: var(--faint); border: 1px dashed var(--border-strong);",
    "  border-radius: 4px; padding: 0 4px; text-transform: none; letter-spacing: 0; }",
    // Rail item (.ni)
    ".den-ni { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box;",
    "  text-align: left; background: none; border: 0; padding: 6px 10px; border-radius: var(--radius-button);",
    "  cursor: pointer; color: var(--muted); text-decoration: none; position: relative; font: inherit; }",
    ".den-ni:hover { background: var(--sunken); color: var(--text); }",
    // The rail's Hub link: ↗ (a new tab); greyed when Hub refuses it.
    ".den-ni .den-ext { color: var(--faint); font-size: 12px; }",
    ".den-ni.den-off { opacity: .55; }",
    ".den-ni[aria-current='page'] { background: color-mix(in srgb, var(--accent) 13%, transparent);",
    "  color: var(--text); font-weight: 500; }",
    ".den-ni[aria-current='page']::before { content: ''; position: absolute; left: -8px; top: 6px;",
    "  bottom: 6px; width: 3px; border-radius: 2px; background: var(--accent); }",
    ".den-ni svg { width: 18px; height: 18px; flex: none; stroke: currentColor; fill: none;",
    "  stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }",
    ".den-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-mono { font-family: var(--mono); font-size: 12.5px; }",
    ".den-bdg { font: 11px var(--mono); padding: 0 6px; border-radius: 999px; background: var(--sunken);",
    "  color: var(--muted); font-variant-numeric: tabular-nums; }",
    ".den-bdg.bad { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }",
    ".den-rail-grow { flex: 1; }",
    ".den-sr { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden;",
    "  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }",
    // Pinned row: the dot in place of the icon (.dot, margin 0 5px)
    ".den-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none;",
    "  display: inline-block; margin: 0 5px; }",
    ".den-dot.bad { background: var(--bad); } .den-dot.warn { background: var(--warn); }",
    ".den-dot.off { background: var(--faint); }",
    // 0.4.18: a pinned row is its name (opens the service panel) and Visit ↗.
    ".den-pin-row { display: flex; align-items: center; gap: 2px; min-width: 0; }",
    ".den-pin-row .den-ni { flex: 1; min-width: 0; }",
    ".den-pin-row .den-ni[aria-expanded='true'] { background: var(--sunken); color: var(--text); }",
    ".den-pvisit { flex: none; width: 26px; height: 26px; padding: 0; display: grid; place-items: center;",
    "  background: none; border: 1px solid transparent; border-radius: var(--radius-button);",
    "  color: var(--muted); cursor: pointer; font: 13px/1 var(--sans); }",
    ".den-pvisit:hover { background: var(--sunken); color: var(--accent-text); border-color: var(--border); }",
    ".den-pvisit[aria-disabled='true'], .den-svp .den-btn[aria-disabled='true'] { opacity: .45; cursor: not-allowed; }",
    ".den-pvisit[aria-disabled='true']:hover { background: none; color: var(--muted); border-color: transparent; }",
    "body.den-rail-collapsed .den-rail .den-pvisit { display: none; }",
    "@media (max-width: 720px) { .den-pvisit { width: 32px; height: 32px; }",
    "  body.den-rail-collapsed .den-rail .den-pvisit { display: grid; } }",
    // The service panel (svc-panel.js): beside its row, a bottom sheet at phone width.
    ".den-pop.den-svp { width: 340px; max-width: calc(100vw - 16px); box-sizing: border-box; padding: 0;",
    "  max-height: calc(100dvh - 16px); overflow-y: auto; min-width: 0; }",
    ".den-svp-h { display: grid; gap: 4px; padding: 12px 12px 10px; border-bottom: 1px solid var(--border); }",
    ".den-svp-t { display: flex; align-items: center; gap: 8px; min-width: 0; }",
    ".den-svp-t .den-dot, .den-svp-ag .den-dot, .den-svp-line .den-dot { margin: 0; }",
    // Line heights pinned to the mock's (its mono font's normal), whatever the theme's font.
    ".den-svp-t b { flex: 1; min-width: 0; font: 600 14px/21px var(--mono); overflow: hidden;",
    "  text-overflow: ellipsis; white-space: nowrap; }",
    ".den-svp-x { padding: 2px 6px; margin: -4px -6px -4px 0; }",
    ".den-svp-meta { display: flex; align-items: center; gap: 4px 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }",
    ".den-wsp { font: 11px/16px var(--mono); border-radius: 999px; padding: 0 7px; white-space: nowrap;",
    "  border: 1px solid var(--border); color: var(--muted); }",
    ".den-svp-st { color: var(--ok); } .den-svp-st.bad { color: var(--bad); }",
    ".den-svp-st.off { color: var(--faint); } .den-svp-st.run { color: var(--accent-text); }",
    ".den-svp-ms { font: 11.5px var(--mono); color: var(--faint); }",
    ".den-svp-url { font: 12px/17px var(--mono); color: var(--faint); overflow-wrap: anywhere; }",
    ".den-svp-acts { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 12px; }",
    ".den-svp-sec { display: grid; gap: 6px; padding: 8px 12px 10px; border-top: 1px solid var(--border); }",
    ".den-svp-k { font: 11px/16px var(--mono); color: var(--faint); text-transform: uppercase; letter-spacing: .07em; }",
    ".den-svp-line { display: flex; align-items: center; gap: 8px; font-size: 13px; }",
    ".den-svp-line .den-svp-sp { margin-left: auto; }",
    ".den-svp-ok { color: var(--ok); } .den-svp-bad { color: var(--bad); } .den-svp-none { color: var(--faint); }",
    ".den-svp-ag { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 0 8px;",
    "  align-items: center; font-size: 13px; }",
    ".den-svp-nm { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-svp-as { font: 11px var(--mono); color: var(--faint); white-space: nowrap; }",
    ".den-wbdg { font: 10.5px var(--mono); color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);",
    "  border-radius: 999px; padding: 0 6px; }",
    ".den-svp-help { font-size: 12px; color: var(--faint); line-height: 1.4; }",
    ".den-svp-foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 8px 12px 10px;",
    "  border-top: 1px solid var(--border); }",
    ".den-svp-grow { margin-left: auto; }",
    ".den-lnk { color: var(--accent-text); cursor: pointer; font: inherit; font-size: 12.5px; text-decoration: underline;",
    "  background: none; border: 0; padding: 0; }",
    ".den-scrim.den-svp-scrim { z-index: 43; }",
    ".den-pop.den-svp.den-sheet.den-toplayer { top: auto !important; left: 0 !important; right: 0 !important;",
    "  bottom: 0 !important; width: auto; max-width: none; border-bottom: 0; border-radius: 14px 14px 0 0;",
    "  max-height: 85dvh; padding-bottom: env(safe-area-inset-bottom, 0px); }",
    ".den-pop.den-svp.den-sheet::before { content: ''; display: block; width: 36px; height: 4px; border-radius: 2px;",
    "  background: var(--border-strong); margin: 8px auto 0; }",
    ".den-pop.den-svp.den-sheet .den-svp-acts .den-btn { flex: 1 1 auto; padding: 9px 12px; }",
    // Collapsed: icons only. The prototype hides headings and labels; they
    // stay here for screen readers (visually hidden, no space taken).
    "body.den-rail-collapsed .den-rail .den-lbl, body.den-rail-collapsed .den-rail .den-gh,",
    "body.den-rail-collapsed .den-rail .den-bdg {",
    "  position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden;",
    "  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }",
    // Toast (.toast)
    ".den-toast { position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);",
    "  background: var(--raised); border: 1px solid var(--border-strong); border-radius: 8px;",
    "  padding: 8px 14px; box-shadow: var(--shadow); z-index: 60; font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    // The error toast (R26c): .toast with the message, its request id and
    // the prototype's small buttons (.btn.sm).
    ".den-toast-err { display: flex; align-items: center; gap: 10px; max-width: min(640px, calc(100vw - 32px));",
    "  border-color: color-mix(in srgb, var(--bad) 45%, var(--border-strong)); }",
    ".den-toast-act { display: flex; align-items: center; gap: 10px; max-width: min(640px, calc(100vw - 32px)); }",
    ".den-toast-err .den-te-ic { color: var(--bad); }",
    ".den-toast-err .den-te-msg { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }",
    ".den-toast-err .den-te-id { font: 11px var(--mono); color: var(--faint); }",
    ".den-tbtn { border: 1px solid var(--border); background: var(--surface); color: var(--text);",
    "  border-radius: var(--radius-button); padding: 2px 9px; font: 500 12.5px/1.45 var(--sans);",
    "  cursor: pointer; white-space: nowrap; }",
    ".den-tbtn:hover { border-color: var(--border-strong); }",
    ".den-tx { border: 0; background: none; color: var(--faint); cursor: pointer; font: 16px/1 var(--sans); padding: 0 2px; }",
    ".den-tx:hover { color: var(--text); }",
    ".den-toast :focus-visible, .den-banners :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    // Banners (.note-banner): the unreachable server (R26d) and a newer
    // engine on disk (MD-2), at the top of the content.
    ".den-banners { flex: none; margin: 16px 24px 0; display: grid; gap: 8px; font: 14px/1.45 var(--sans); }",
    ".den-banners.den-banners-inset { margin: 0 0 16px; }",
    ".den-banners[hidden] { display: none; }",
    ".den-banner { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: 12.5px;",
    "  color: var(--muted); border: 1px dashed var(--border-strong); border-radius: var(--radius);",
    "  padding: 8px 12px; }",
    ".den-banner b { color: var(--text); }",
    ".den-banner.warn { border-color: color-mix(in srgb, var(--warn) 55%, var(--border-strong)); }",
    ".den-banner .den-bn-ic { color: var(--warn); }",
    ".den-banner .den-bn-t { color: var(--text); }",
    ".den-banner .den-bn-n { font: 11px var(--mono); color: var(--faint); }",
    ".den-banner .den-tbtn { margin-left: auto; align-self: center; }",
    // The runs dock (.dock, .bar, .runs, .rtab, pre: R16), at the foot of
    // the content column; content-box as in the prototype.
    ".den-dock { flex: none; order: 99; position: sticky; bottom: 0; z-index: 14; min-width: 0;",
    "  border-top: 1px solid var(--border); background: var(--surface); font: 14px/1.45 var(--sans);",
    "  color: var(--text); box-sizing: content-box; }",
    ".den-dock :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-dock .den-bar { display: flex; align-items: center; gap: 10px; box-sizing: content-box;",
    "  padding: 6px max(16px, env(safe-area-inset-right, 0px)) calc(6px + env(safe-area-inset-bottom, 0px)) 16px;",
    "  font-size: 13px; color: var(--muted); }",
    ".den-dock .den-bar b { color: var(--text); font-weight: 500; }",
    ".den-dock .den-runs-l { display: flex; gap: 6px; overflow-x: auto; flex: 1; min-width: 0; }",
    ".den-dock .den-rtab-w { position: relative; display: inline-flex; flex: none; }",
    ".den-dock .den-rtab { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--border);",
    "  border-radius: 6px; padding: 2px 8px; background: var(--bg); cursor: pointer; white-space: nowrap;",
    "  font: 12px var(--mono); color: inherit; box-sizing: content-box; margin: 0; }",
    ".den-dock .den-rtab[aria-selected='true'] { border-color: var(--accent); }",
    ".den-dock .den-rtab .den-dot { margin: 0; }",
    // A run closes from its tab (Local Dev's tabs did): room for the ×.
    ".den-dock .den-rtab.den-x { padding-right: 22px; }",
    ".den-dock .den-rtab-x { position: absolute; top: 0; bottom: 0; right: 4px; display: flex; align-items: center;",
    "  padding: 0 3px; border: 0; background: none; cursor: pointer; font: 13px var(--sans); color: var(--faint); }",
    ".den-dock .den-rtab-x:hover { color: var(--bad); }",
    ".den-dock .den-dock-acts { display: flex; gap: 2px; flex: none; }",
    ".den-dock pre { margin: 0; height: 170px; overflow: auto; max-height: 50vh; padding: 10px 16px; font: 12px/1.5 var(--mono);",
    "  background: var(--sunken); border-top: 1px solid var(--border); color: var(--muted);",
    "  box-sizing: content-box; white-space: pre-wrap; word-break: break-all; }",
    ".den-dock pre a { color: var(--accent-text); }",
    // The panes' line classes, kept.
    ".den-dock pre .cmd { color: var(--accent-text); }",
    ".den-dock pre .err, .den-dock pre .done-fail { color: var(--bad); }",
    ".den-dock pre .warn { color: var(--warn); }",
    ".den-dock pre .ok, .den-dock pre .done-ok { color: var(--ok); }",
    ".den-dock pre .phase { color: var(--text); font-weight: 600; }",
    ".den-dock-grip { display: none; position: absolute; left: 0; right: 0; top: -3px; height: 6px;",
    "  cursor: ns-resize; z-index: 1; }",
    ".den-dock.open .den-dock-grip { display: block; }",
    // Narrow (the prototype's 860 and 720px steps): chip labels hide, the
    // dots stay; then the scope hides and the search is its icon.
    // Den's chips are wider than the prototype's (the full version, real
    // counts): the scope's keys give way from 960px, not 860, so the bar
    // fits without the scope shrinking.
    "@media (max-width: 960px) { .den-scope .den-k { display: none; } }",
    "@media (max-width: 860px) { .den-scope .den-k, .den-scope .den-sep, .den-scope .den-opt { display: none; }",
    "  .den-chip .den-lbl-l { display: none; } }",
    "@media (max-width: 720px) {",
    "  body.den-has-shell, body.den-has-shell.den-rail-collapsed { --den-rail-w: 0px; --den-rail-cw: 244px; }",
    "  .den-menu-btn { display: inline-flex; }",
    "  .den-rail { transform: translateX(-105%); transition: transform .18s;",
    "    box-shadow: var(--shadow); z-index: 42; }",
    "  body.den-rail-open .den-rail { transform: none; }",
    "  .den-scrim { position: fixed; inset: 0; z-index: 41; background: color-mix(in srgb, var(--bg) 60%, transparent); }",
    "  body.den-rail-collapsed .den-rail .den-lbl, body.den-rail-collapsed .den-rail .den-gh,",
    "  body.den-rail-collapsed .den-rail .den-bdg { position: static; width: auto; height: auto;",
    "    clip: auto; overflow: hidden; }",
    "  .den-collapse-btn { display: none; }",
    "  .den-scope { display: none; }",
    "  .den-search { flex: 0 0 auto; margin: 0 0 0 auto; }",
    "  .den-search-ph, .den-search kbd { display: none; }",
    "  .den-top .v-pill { display: none; }",
    // Never wider than the window (SA's dev.20 run: 429px at 400): a long
    // product name gives way first, the stale-server pill keeps its ⚠.
    "  .den-brand { min-width: 0; flex: 0 1 auto; }",
    "  .den-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
    "  .den-top .stale-lbl { display: none; }",
    "  .den-chips { flex-shrink: 0; }",
    "}",
    // Below 480px only the mark shows: the title stays the link's name,
    // visually hidden (SA's dev.21 run).
    "@media (max-width: 479.98px) {",
    "  .den-title { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;",
    "    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }",
    "}",
    "@media (prefers-reduced-motion: reduce) { .den-rail { transition: none; } }",
  ].join("\n");
  document.head.appendChild(style);
})();
