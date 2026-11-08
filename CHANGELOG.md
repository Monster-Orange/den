# Changelog

All notable changes to Den are documented here. Each release lists the
config and manifest changes a distribution must make to move to it under
**Migrations**.

## [0.4.17] - unreleased

### Fixed

- **An agent's workspace is a link.** The agent pane's header and the
  workspace's heading in the Agents list link to the Workspaces page
  focused on it (`?ws=`). ⌘K has "Go to workspace <ws>", found by the
  workspace's name or any of its agents'.
- **"Last test run" is the server's.** The Workspaces page's "Last run"
  column is now "Last test run", read from the server's run history
  (`<state>/run-history.jsonl`, `GET /api/runs/last`). It shows runs from
  every browser and survives a restart. The service's own state ("up 2h")
  is shown apart from it.
- **One org rule.** Environments and Releases have no org picker of their
  own. Both follow the top bar's View and say so with the same note. A
  page shows its own org picker only when it filters by org.
- **Environments never waits on a slow host.** Every row shows at once,
  pulsing "checking", and each result streams into its row. The server
  runs at most 12 checks at once, each capped at 10 s; one that runs out
  of time says "timed out after 10 s". Re-check works while checks run.
- **An agent in an inactive workspace opens its terminal.** The terminal
  route checks the person and the agent, not the workspace's active
  flag. The pane says "Sign in" only when you're signed out; any other
  refusal gives its real reason.

## [0.4.16] - 2026-11-08

### Added

- **Change an agent's persona (AG-18).** **Change persona…** in the
  agent pane's ⋯ menu (running or stopped), and `<cli> agents persona
  <id> <persona> [--model <m>] [--now | --after-turn]`. Den stops the
  session and resumes the same conversation with the new persona's role
  prompt, permission mode and allowed commands; the history, id, name,
  workspace, folder, tab and the model it runs stay. The dialog marks the
  current persona and lists what changes. Mid-turn it never stops a turn
  unasked: "It's working. Change after this turn, or stop it now?" (409
  `busy`); After this turn waits for the turn to end, Stop it now stops
  it. The wait lives in the server's memory: if Den restarts first, the
  change is dropped, the record no longer marks it pending, and the audit
  trail says "persona change cancelled: Den restarted". A person's only: an agent's token is refused (403), and there is no
  MCP tool. Only a runtime that can resume offers it. The record keeps
  `personaChanges`, and the audit trail records each change. Route `POST
  /api/workspaces/<ws>/agents/<id>/persona`.

### Changed

- **Bring in keeps the conversation's model, and says what the persona
  changes (AG-17.1c).** It used to switch the conversation to the
  persona's model, and drop MCP servers the conversation had outside Den,
  without a word. Now the model stays the one its last answer came from
  ("Keeps <model> from the conversation"; Advanced or `--model` picks
  another), and a short list under the persona says "From now on it works
  as <persona>: its role, its permissions (<mode>), Den's tools and
  guards. Its history stays.", plus "It won't have: <servers>." for MCP
  servers seen in its transcript that Den won't load. The persona of the
  latest agent that worked in its folder is preselected (`suggest`), never
  submitted. The list adds `model`, `lost` and `suggest`; the import takes
  `model` and `version`.
- **The signed-out page shows Sign in with GitHub once the owner is
  linked, with no reload.** With no owner yet it watches the session
  probe (which now says `github.state` to a signed-out browser), and step 1
  turns done and the button appears as soon as `web owner link` finishes.

- **The signed-out page explains Sign in with GitHub (SEC-2a-UX).** It
  shows the same three steps whether or not an owner is linked: on the
  machine Den runs on, run `<cli> web owner link` (or use Settings ›
  Access there); enter the code it shows at github.com/login/device and
  approve; come back and press Sign in with GitHub with the same account.
  Once an owner is linked, step 1 shows as done ("Owner: @login") and the
  button follows the steps. Below them: only the owner's GitHub account
  can sign in this way, anyone else uses Approve this computer, and Learn
  more opens docs/distributions.md, "Signing in with GitHub". English,
  Spanish and Japanese.
- Another GitHub account is refused with "@login isn't the owner of this
  Den. Only the owner's account can use Sign in with GitHub. Use Approve
  this computer instead." It no longer says to ask the owner to add you:
  a Den has one owner, and no one to add.

### Fixed

- An open agent pane stayed on the old session after Change persona, Resume
  or a rotation, showing "[the session exited (143)]" while the list showed
  the new one running. A pane now follows its agent: it moves to the new
  session in the same slot, keeps its scrollback, and says "Switched to
  <persona>". After a session ends the page looks again every second for
  15 s, so the switch shows within about 2 s.

### Migrations

- None.

## [0.4.15] - 2026-11-07

### Added

- **Onboarding reads for agents, the CLI and the browser (ON-3).** Three new
  MCP read tools, always registered, each with a CLI twin and a web API
  route (GET, a read in the route table) that a page can show as it is:
  - `onboard_status`, `<cli> onboard status [--json]`,
    `/api/onboard/status`: what's set up (a distribution, Node, git, Docker,
    the web server, workspaces, repos, a running service, Den's MCP), each
    `ok`, `warn` or `todo`, and the one next step in plain words with its
    command. It never runs an agent's CLI to check Den's MCP.
  - `repos_detect`, `<cli> repo detect <folder> [--json]`,
    `/api/onboard/repos`: the git repos in a folder, one or two levels down,
    how each one runs (the same detection as `repo add`), and suggested
    workspaces (the repos in one parent folder go in one workspace named
    after it). It never writes, runs a repo's tools or follows a symlink,
    skips dot-folders, `node_modules` and `vendor`, and stops at 50 repos.
  - `manifest_draft`, `<cli> repo add <path> --dry-run --json`,
    `/api/onboard/manifest`: the side-car manifest `repo add` would write,
    checked by the same validator, with nothing written. Several ways to
    start the repo is a question with its choices, as `repo add` asks.
- A path for `repos_detect` or `manifest_draft` must be a folder inside the
  person's home folder and outside Den's state folder; anything else is
  refused with the reason. A workspace-scoped MCP server can't scan folders,
  and drafts only inside its workspace's repos.
- **Onboarding writes, held for the person (ON-3).** Three new MCP write
  tools, `workspace_create`, `repo_add` and `service_try`, on by default
  and gated by the person's Allow (not by `mcp.actions`). They change
  nothing by themselves: each asks Den to hold the change, and every Den page opens a
  dialog in the person's browser, "The `<agent>` agent wants to: … ·
  Review · Later · Deny · Allow". Den writes the line and the Review from
  the action and its arguments (`repo_add`'s Review is its dry run); the
  agent's note is only quoted. Allow runs it once, from the stored
  arguments checked again, through the code paths the pages and the CLI
  use (the Workspaces page's create, `repo add --json`, `up` as the
  Services page starts it). Deny, 10 minutes with no answer, or the agent
  being stopped run nothing. The agent waits up to 2 minutes, then
  `approval_check` reads where its request stands; meanwhile it is
  "waiting" on the Agents page. Routes: `POST /api/approvals`,
  `GET /api/approvals`, `GET /api/approvals/<id>`,
  `POST /api/approvals/<id>/decide`. See [Onboarding writes, held for the
  person](docs/distributions.md#onboarding-writes-held-for-the-person).
- **`mcp.approvals: false`** in the distribution config turns the three
  held writes off: they aren't registered, and `POST /api/approvals`
  answers 403 `approvals_off`. `doctor` (its `mcp:approvals` check in
  `--json`), the MCP server's instructions and `mcp --list` (on stderr) say
  which is in effect. A value that isn't `true` or `false` is an error.
- **Who asked.** An agent's token shows its name ("The `<agent>` agent
  wants to:"). A request with no agent identity reads "Something on this
  machine (no agent identity) wants to:", with "If you didn't ask an agent
  to do this, Deny." under it. In English, Spanish and Japanese.
- **Only the person approves.** Allow and Deny need a browser signed in on
  this Den and holding its approval key, even on localhost. Every sign-in
  mints the key, handed over only in the sign-in's own answer (a 303's
  `#ak=` fragment, or the sign-in poll); the session keeps its hash and
  `GET /api/session` never returns it. A cookie alone (any localhost port
  receives it), the CLI's bearer, an agent's token or an anonymous request
  from this machine is refused with `signin_to_approve`.
- **Only the person sees what waits.** `GET /api/approvals` needs what
  Allow needs: the cookie, that session's CSRF token and the approval key.
  Anything else gets 403 `signin_to_approve` with a count (`waiting`), and
  a signed-out page shows a banner to sign in. An agent's token lists only
  its own requests and their outcomes. An ask with no agent token gets a
  ticket that reads that one request (`X-Den-Approval-Ticket`); Den's MCP
  server keeps it and never shows it to the agent.
- **The setup link.** `<cli> web claim-link [--json]` prints a one-time
  link (`/auth?claim=<code>`, 30 minutes) that signs this browser in, for
  an install that hands the person over to the browser. Opened twice, it
  says it was used and that someone else may have opened it.

### Changed

- Pairing a device, approving one, and linking or unlinking the GitHub
  owner (`POST /api/web/pair`, `/api/web/approve`, `/api/web/owner/link`,
  `/api/web/owner/unlink`) need the person: the CLI's bearer, or a
  signed-in browser holding its approval key. On plain localhost,
  Settings › Access asks you to sign in before pairing.
- Inside an agent's session (`DEN_AGENT` or `DEN_ACTOR_TOKEN` set), the CLI
  refuses every command that lets a browser in: `web login`, `web approve`,
  `web owner link|unlink`, `web claim-link`; `web open` opens the plain
  page.
- What a test run writes and Den serves (`/report/*`, the Playwright
  report, and `/reports/security/*`) is served sandboxed (an opaque
  origin, no scripts reaching Den's), with nosniff, no-store and
  no-referrer.
- A workspace name is at most 64 characters.
- **A Name is the agent's id (AG-10.10b).** A Name given at start (the
  dialog's Name, the API's `name`, the CLI's new `--name`) makes the id its
  slug: "API spike" starts `api-spike`, titled "API spike". The dialog says
  so as you type. A Name that matches a running agent in the workspace, by
  id or by title, is refused: the dialog says "api-spike is already
  running · Open it" and Start is off. A stopped one offers Resume it, or
  Start makes `api-spike-2`. No two live agents in a workspace share a
  title. With no Name the persona's id stays the default; `--id` is exact.
- The Den theme's light mode (2.0.1): `--ok`, `--warn`, `--bad`,
  `--remote` and `--accent-text` are darker, so a status pill (the token
  on a tint of itself) meets WCAG AA (4.5:1) on every surface, `--sunken`
  included. They measured 3.7 to 4.4:1 there. Dark mode is unchanged.

### Fixed

- The signed-out page's Open Terminal link was `ssh://<host>` with no
  account, so an SSH app filled in its own default (an iPad's asked for
  `user@…`'s password). The link and the ssh one-liner are now
  `<user>@<host>`, the account Den runs as, and the note says "Log in with
  your <machine> account (<user>) and its password, or an SSH key."
  `web.ssh_user` names another account; `web.ssh_user: ""` leaves it off.
- Text dimmed with opacity fell under WCAG AA on the light theme. Not
  installed editors and terminals in Settings (3.1:1, their "not found"
  2.2:1), a repo already in the workspace in Add service (1.9:1), the
  Release table's loading sub-line (3.7:1), and a primary button on hover
  (4.4:1). They are full-strength now, in `--muted`; hover darkens.
- `/reports/security/*` was always 404: the `/report` prefix shadowed it.
- Bring in on a shared repos root (the usual layout) listed every
  conversation under the root, so workspaces showed the same 50 and their
  own were crowded out. A conversation is a workspace's when it ran in one
  of its repos' folders or inside one, in its own folder, or exactly at a
  shared root; the 50 cap applies after that. Another workspace's
  conversation is refused by id: "This conversation belongs to <folder>,
  not to workspace <ws>" (CLI, API and MCP).

### Migrations

None. Sessions signed in before 0.4.15 hold no approval key: sign in again
to approve or to pair a device.

## [0.4.14] - 2026-11-07

### Added

- **Bring in a conversation (AG-17.1).** A Claude Code conversation you
  started in a terminal outside Den, in the workspace's folder or in one
  of its repos' folders (a repo added by path outside it too), can become
  a Den agent. Agents › Bring in lists them, newest first, and asks for a
  persona; Bring in runs `claude --resume <id>` in the folder it ran in,
  with Den's token, MCP, hooks and guards from then on. Den reads only the
  first and last 64 KB of each transcript. A conversation written in the
  last minute is refused: "Still open in another terminal. Close it there
  first". CLI: `agents import -w <ws>` lists, `agents import -w <ws>
  --session <id> --persona <p>` brings one in. MCP `agent_import` is
  opt-in through `mcp.actions`. Routes: `GET
  /api/workspaces/<ws>/conversations`, `POST
  /api/workspaces/<ws>/conversations/<id>/import`. Only den-claude can
  bring one in for now. The dialog asks you to close the
  conversation in any other terminal first.
- **One persona, several agents (AG-10.10).** Starting a persona that
  already has an agent in the workspace starts another: `be-dev`, then
  `be-dev-2`, `be-dev-3`. A stopped agent's id is never reused by a new
  start, only by its Resume or Start fresh. The Start dialog says the id
  it will use ("Starts as be-dev-2") and takes an optional Name. An id
  that is running is refused, and the dialog offers "Open the running
  one". `--id` stays exact. The start route takes `name`; `GET
  /api/personas?workspace=<ws>` answers `startsAs`; a 409 for a running
  agent carries `running: {id, sessionId}`.

### Changed

- Without `--id`, a start of a persona whose agent is stopped in that
  workspace no longer replaces it: it starts `<persona>-2`. To continue
  the stopped one, Resume it or Start fresh on it.

### Fixed

- Bring in: a long title no longer cuts off its "Agent …" badge, and each
  "can't bring in a conversation yet" line is its own sentence.
  Its intro names the repos' folders too.

- Start › Advanced: the Model select's default reads "Persona default
  (latest)" for a persona with no model of its own; the longer label was
  cut off.
- An `up` whose service exits at once with an error no longer leaves the
  service listed. The command could exit before Den recorded its process
  group, and then its record stayed.

## [0.4.13] - 2026-11-07

### Added

- **The Start dialog.** + Start agent opens the dialog from the Den Shell
  design. Pick a persona from a list you can search, with category and
  source chips (built-in, distribution, mine); with no filter it is grouped
  by category, and Plain session (your shell in the workspace, no agent) is
  pinned last. Each persona shows its one-line description. "What's a
  persona?" explains the idea, and Details shows the instructions, runtime,
  model and version, permission mode and allowed commands. Then Runtime,
  Workspace, an optional first instruction, and a collapsed Advanced
  section: Model and Version, Permission mode, and Extra allowed commands,
  with a preview of exactly what the runtime will be given.
- **First instruction.** Den types it into the agent's session once the
  session is ready, as a bracketed paste when the runtime asks for one,
  then Enter. It never goes on the command line and is never stored; the
  audit log records its length only.
- **Your own personas.** + New persona, Duplicate and Edit write personas
  of your own to `<state_dir>/personas/<id>.md` (0600). Settings ›
  Personas lists every persona with the same search and chips: View or
  Edit, Duplicate, Delete (your own only), + New persona. Built-in and
  distribution personas are read-only; Duplicate makes your own copy.
  Routes: `GET /api/personas/<id>`, `POST /api/personas`, `POST` and
  `DELETE /api/personas/<id>`.
- **Models and versions.** A runtime lists its models (den-claude: opus,
  sonnet and haiku, each "latest" or a pinned version, from a catalog
  shipped with Den). A pinned version runs as `--model <full id>`. A
  persona or session pinned to an older version says "newer available";
  your own persona has Use latest.
- **Permissions as intent.** Ask for everything, Auto-approve edits in the
  worktree, or Auto-approve all, plus extra allowed commands as plain
  prefixes. den-claude turns them into `--permission-mode` and
  `Bash(<prefix>)` / `Bash(<prefix> *)` allow rules beside Den's deny
  rules. Other runtimes take none from Den yet, and the dialog says "not
  supported on <runtime>" rather than dropping one.
- **Override tags.** A session started with choices that differ from its
  persona is tagged in the list: "model: haiku", "pinned <version>",
  "auto-approve edits", "custom tools", the runtime. "auto-approve all" is
  always tagged. Start fresh and Relaunch keep the choices.
- **Roles and categories.** Den's roles are planner, orchestrator, sde,
  reviewer, tester and designer. Each is a template (instructions,
  permission mode, a read-only command preset) that fills in New persona
  without overwriting what you typed, and it adds nothing hidden to a
  prompt. A distribution adds roles and categories (`agents.roles`,
  `agents.categories`) and may extend a Den role's preset, never redefine
  it.
- **Plain session from the page.** `POST /api/workspaces/<ws>/sessions`
  starts your login shell in the workspace's folder (capped by
  `sessions.max_concurrent`).
- **A tester persona** in Den's default pack.


### Changed

- `POST /api/workspaces/<ws>/agents` takes `version`, `permission`,
  `allow` and `instruction`, and refuses an unknown field. Each is checked
  against the runtime's catalog: a model or version it doesn't list, a
  mode other than `ask`, `edits` or `all`, or a command that isn't a plain
  prefix (at most 32, 120 characters each) is a 400. An agent's token gets
  403 on every persona route and on a plain session.
- The agent record keeps `version`, `permission`, `allow` and `overrides`.
- A persona's `role` is a role key; a sentence there still reads as its
  description. Personas gain `display_name`, `category`, `version` and
  `allowed_commands`. `permission_mode` takes `ask`, `edits` or `all`
  (Claude Code's own modes still read). `agents personas` shows SOURCE and
  ROLE columns.
- fe-dev, be-dev and devops are role `sde`; ux-designer is role
  `designer` in category Design.
- A persona whose runtime isn't installed starts on the first one that is,
  and the Start dialog says so.
- **`sessionTitle` is the name a session shows.** `agents list --json`,
  `GET /api/sessions` and the start and resume answers (MCP
  `agent_resume`) now carry the resolved name (Den's rename or the
  runtime's, the later) as `sessionTitle`. 0.4.12 called it `sessionName`,
  which is the agent record's session handle (`<dist>-<ws>:<id>`) and has
  been since 0.4.0. Records are unchanged.

### Fixed

- **Settings shows a saved choice at once.** Agents tab layout and Open
  file links in saved, but the pressed button stayed on the old value
  until a reload. The page now takes every setting the save returns.
- **Claude Code's `/rename "x"` shows as x.** Its title keeps the quotes;
  Den drops one pair around the whole name, for display only.
- **The terminal fit check is exact again.** The browser test compares
  what is left below and beside a terminal with the cell size xterm drew
  with (now on each pane as `data-cell-w` and `data-cell-h`), less than
  one cell, so a missed row fails on any font.

### Migrations

- None required. A persona whose `role:` is a sentence keeps working (it
  becomes the description); set `role:` to a role key to give it one.
- A persona pack may now set `display_name`, `category`, `version` and
  `allowed_commands`. Use `permission_mode: ask | edits | all` for a mode
  every runtime can translate.
- `agents.roles` and `agents.categories` are new keys of `agents:` in the
  distribution's config (see docs/distributions.md, Personas).
- Read `sessionTitle`, not `sessionName`, for the name a session shows in
  `agents list --json`, `GET /api/sessions` and the start and resume
  answers. No record needs changing.

## [0.4.12] - 2026-11-07

### Added

- **Agents tab layouts.** A switch in the page header picks Focus, Tabs or
  Tile, and so do ⌃⇧1, ⌃⇧2 and ⌃⇧3 (Ctrl+Shift+digit on every OS) and ⌘K
  "Layout: Focus/Tabs/Tile". ⌘1-9 and Ctrl+1-9 stay the browser's, for its
  tabs; inside a terminal the layout keys never reach the agent. Focus, the default, shows one pane: a
  click replaces it, and Shift-click or ⌘-click adds one alongside. Tabs
  shows one pane under a strip of tabs. Tile is a grid: one pane fills
  it, two sit side by side, three or four make a 2×2. At phone width,
  Focus and Tile show as Tabs. Your choice is saved for you
  (`agents.layout` in `config/local/user.yml`, `agents_layout` in
  `/api/settings`, and Settings › Agents), and the URL says it
  (`&layout=`).
- **Named tabs.** Each tab shows the agent's name, then its persona and
  workspace, and a dot when it is waiting. Double-click a tab to rename
  the agent. The name is stored in its record (`displayName`) and shows in
  the list, its pane, ⌘K, the Workspaces page and `agents list --json`.
  Start fresh and Relaunch keep it. The id never changes. The route is
  `POST /api/workspaces/<ws>/agents/<id>/name`.
- **Shift+Enter is a soft newline in agent terminals.** It sends the
  runtime's `softNewline` from the runtime catalog, not Enter: ESC CR for
  Claude Code and Gemini CLI (and by default), Ctrl+J for Codex CLI. A
  plain session's Shift+Enter is still Enter. Catalog entries may set
  `softNewline: esc-cr | lf | none`.
- **The session's name in the pane header.** Claude Code's `/rename` shows
  after the runtime (` · api spike`), and in the tab, the list and ⌘K. Den
  reads it from the session's transcript, following the file from where it
  last stopped (the catalog marks this source `unofficial`; a name it
  can't read is none). The most recent rename wins, Den's or the
  runtime's. `GET /api/sessions`, `agents list --json` and the start and
  resume answers carry it as `sessionName`. Catalog entries may set
  `titleFromOsc` (no runtime does yet, and the session host doesn't read
  titles yet).
- **Links and paths in agent panes are clickable.** ⌘-click (Ctrl-click on
  Windows and Linux) opens a URL or an OSC 8 link in a new tab
  (`noopener`), http and https only; a plain click still selects. A file
  path inside the agent's workspace (`src/foo.ts:42`, absolute paths) is
  a link: ⌘-click opens it in the editor set in Settings › Editor &
  terminal › "Open file links in" (`editor_open`: vscode, cursor, zed, or
  none to copy the path, the default). The server checks a path exists
  inside the workspace with `GET /api/workspaces/<ws>/agents/<id>/paths`
  (stat only). Den now ships `@xterm/addon-web-links` 0.12.0, served from
  `/vendor/`.

### Changed

- **The Agents tab fills the window.** The list and the panes reach down to
  14px above the runs dock at any window height, with the dock open or
  shut. They used to stop at a fixed guess of the window less 300px.
- **Re-picking the workspace in view on a page with `?ws=`** (Workspaces'
  detail pane) now updates `?ws=` before the reload, so the page shows the
  pick and not the old workspace.
- **Every terminal fits its pane.** A terminal used to be sized for its
  pane's padding as well, so its last row could be cut off. It now fits
  the space inside the padding, in every layout, and refits when the
  window or the dock changes size.

### Migrations

None. The record's new `displayName` and `displayNameAt` are optional:
records without them read as before. The layout pref is optional and
defaults to Focus; `editor_open` is optional and defaults to none. The
catalog's new `softNewline`, `sessionName` and `titleFromOsc` are
optional.

## [0.4.11] - 2026-11-07

### Changed

- **Picking a workspace in the top bar also makes it the CLI default.**
  There is one "current workspace": choosing one in the Workspace menu
  sets what pages show and where `<cli>` commands run (workspaces.yml, as
  Local Dev's "Make CLI default" does). "All active (n)" changes only what
  pages show; the CLI default stays. If the CLI default can't be set,
  nothing changes and the error shows.
- **The menu's separate "Make <ws> the CLI default" item is gone**, since
  picking a workspace does it. The "CLI default" tag stays on its row, and
  Local Dev keeps its "Make CLI default" button, to set it without
  changing what pages show. Each workspace row's tooltip says so.
- **Picking the workspace already in view makes it the CLI default** when
  it isn't one (after Local Dev's "Make CLI default" or `<cli> workspace
  focus` moved it). The view stays as it is.
- **Pages whose address names a workspace follow the pick.** Workspaces'
  detail pane and breadcrumb now show the workspace the top bar picked,
  not the one in the old `?ws=`.

### Migrations

None.

## [0.4.10] - 2026-11-07

### Changed

- **A confirmed merge stays confirmed.** Once `gh pr view` says an agent's
  pull request is MERGED, its record keeps that (`prMergeConfirmed`), and
  `usage` doesn't ask GitHub about it again. A later run that can't check
  no longer drops it. A merged flag from before 0.4.10, with no
  confirmation, is checked again.
- **`usage agents` counts only real asks.** "Asked GitHub for the state of
  N pull requests" counts the times gh ran. When gh is not installed, it
  says "Couldn't check N merges: gh is not installed." instead.
- **The PR column** shows the confirmed pull request, with "(merged)", when
  the agent merged one it didn't open.
- **A bare `gh pr merge`** (the branch's own pull request) is confirmed by
  the number gh gives: the check is now `gh pr view --json number,state`.
  With no number, it is not marked; an empty ref is never a key.
- **Dropping a mark drops its rotation.** When gh no longer confirms a
  merged flag, a "PR merged" rotation it made due is cleared too. A
  rotation due after compactions is left alone.

### Migrations

None.

## [0.4.9] - 2026-11-07

A session ends when its pull request merges, or after 3 compactions. The
role then relaunches from a handoff, in a fresh conversation (den#4, the
session-rotation issue). Sessions that never end re-read huge contexts on
every call. This keeps each session to one objective.

### Added

- **Den counts compactions.** A `SessionStart` hook (source `compact`),
  alongside Den's other hooks for default-pack Claude Code agents, counts
  each compaction of the agent's conversation once it happened. A
  `/compact` that does nothing is not counted. The count is in
  `<state dir>/agent-files/<id>/rotation.json`, and starts at 0 for each
  new conversation.
- **Two triggers.** A rotation is due after `agents.rotate.after_compactions`
  compactions (default 3), or once the agent's pull request merged (the
  `prMerged` outcome from `usage agents`). A merge counts only when the
  agent ran `gh pr merge` itself, it exited 0, and `gh pr view` then says
  MERGED. `echo gh pr merge 1` or `gh pr merge --help` never counts.
- **The agent is told.** The compaction summary keeps the instruction, a
  `SessionStart` hook adds it after the compaction, and the `Stop` hook
  blocks once until the handoff is written. The shared instructions say
  what to do: write `handoff.md` in the agent's files folder, then end the
  turn.
- **The handoff check.** A handoff has five parts: Objective, State, Open
  items, How to QA, Next step. Each must be there and filled in, and every
  ID explained. `<cli> agents handoff-check <id|file|->` runs the check (on an
  agent's own handoff.md, by its id) and names what is missing.
- **Relaunch from handoff.** A fresh conversation (a new conversation id),
  with the same persona, workspace, folder and grants. Its first prompt is
  the handoff. The handoff is then kept in `handoffs/`, and the record
  notes the rotation. `<cli> agents relaunch <id>`, and
  `POST /api/workspaces/<ws>/agents/<id>/relaunch`.
- **The Agents page.** A rotated agent reads "Ready to relaunch (3
  compactions)" or "Ready to relaunch (PR merged)". Its buttons are
  Relaunch from handoff (the primary one), Start fresh and Remove. With no
  handoff, or one that fails the check, the row says so and keeps Resume
  and Start fresh. A running agent shows "Handoff due" or "Ready to
  relaunch" as a tag.
- **`agents.rotate` in the org config**: `after_compactions` (1 to 100,
  default 3) and `standing` (default true). With `standing: false`,
  standing personas such as the planner never rotate.
- **Usage shows rotation.** `usage agents` adds each agent's compactions
  and rotations. `usage report` adds `long_session_context_k`,
  `never_ending_reread_pct` and `rotations`.

### Changed

- **Resume refuses a rotated conversation.** Once a rotation is due and the
  handoff passes, `agents resume <id>` exits 1 with
  `Relaunch from handoff: <cli> agents relaunch <id>`. The resume route
  answers 409 with code `rotated`. Resume all lists it as not resumed.
- **A standing persona that rotated relaunches on its own** after a
  restart, as it resumed on its own before.
- **The `Stop` hook and the new hooks take the agent's files folder** on
  their command line (`--files <dir> --after <n>`).

### Metrics (before → after)

- Peak tokens per call in a long session: 365–510k → <150k.
- Share of context re-reads from never-ending sessions: 59% → <15%.
- How it is measured: `usage report` on this machine.
  `long_session_context_k` is the highest average tokens per call of any
  session. `never_ending_reread_pct` is the share of cache re-reads from
  sessions that compacted more than `agents.rotate.after_compactions`
  times. Compare a week's report before and after.
- On the test fixture (15 sessions with 16 compactions each, and 127 that
  end within 3): 399k → 139k per call, and 59% → 0% of re-reads. The same
  calls re-read fewer tokens.

### Migrations

- None needed. Rotation is on for Den's default pack, with 3 compactions.
  To change the number, set `agents.rotate.after_compactions`. To keep
  standing personas from rotating, set `agents.rotate.standing: false`.
  `rotate` is now a reserved key under `agents:`, so no agent can have the
  id `rotate`. Agents started before 0.4.9 start counting at their next
  start or resume.

## [0.4.8] - 2026-11-07

Stopped agents stay in the list, and come back where they were (AG-14, the
stopped-agents slice). Den also counts what each agent used and what it
got done, read on this machine only (den#6, the agent-usage issue).

### Added

- **Stopped agents stay listed.** They sit below the running ones, each
  with why it stopped: stopped by you, exited (with its code), or
  interrupted by a restart. Each row has Resume, Start fresh and Remove.
- **Resume is the same conversation.** Den runs the runtime's own resume
  with the conversation id it saved (Claude Code: `--resume <id>`). The
  agent comes back in its own folder, with its workspace and grants. A
  runtime that can't resume (codex, gemini, grok), or an agent with no
  saved id, offers Start fresh only and says why.
- **Remove in one click, with Undo.** The toast offers Undo for 10 seconds.
  **Clear stopped** removes every stopped agent in view. A running agent
  is never removed.
- **After a restart, one line.** "2 agents were interrupted when Acme
  restarted · Resume all · Review". Standing personas, and personas with
  `resume_on_restart: true`, resume on their own.
- **The CLI:** `agents list --stopped`, `agents resume --all-interrupted`,
  `agents rm <id>` and `agents rm --stopped`.
- **`agent_resume`, an MCP action for orchestrators.** Off unless
  `mcp.actions` names it. It resumes agents of its own workspace or a
  granted one, never itself. The web server checks the same rule.
- **`usage agents` and `usage report`.** Each agent's tokens and outcome
  (pull request opened or merged, tests green, wall-clock time) are read
  from its transcripts and saved in its record, matched by the
  conversation id. `usage report` writes a weekly summary, compared with
  the last. Transcripts stay on the machine, and only counts are kept.
- **The `usage` plugin kind** (server tier) adds a transcript reader for
  another runtime. Den ships one for Claude Code.

### Changed

- **The audit trail survives a restart.** The last 200 actions are kept in
  `<state dir>/audit.jsonl` (0600) and read back at start.
- **An agent after a restart says Interrupted**, not Exited. An agent that
  exited says Exited (code n), even after the session host forgets it.
- **An agent record notes its grants**, its end and exit code, and its
  usage and outcome.

### Fixed

- **A resume never loses the conversation.** Stopping an agent without
  typing, then resuming it, could fail for good: Den started a new
  conversation under the same id, and Claude Code refused it as "already
  in use". Now Den decides before it launches. For Claude Code it looks
  for the conversation's transcript: if it is there, or someone typed in
  the last session, it resumes with `--resume <id>`; if not, it starts
  fresh under the same id, in the same folder and scope, and says "nothing
  to resume yet; started fresh". Every launch also marks the record
  `launched: true`, for runtimes Den can't check this way. If Claude Code
  still says there is no conversation (Den now reads past its trailing
  terminal codes), Den starts fresh once. If a
  fresh start says the id is in use, Den resumes once instead. If both
  fail, the error names the id and Start fresh (the route answers 502
  `resume_failed`).
- **No "+ Start agent" for a workspace that doesn't exist** (`?ws=` with
  an unknown name).
- **`agents stop` waits for the agent to end.** It returns once the
  agent's session has ended, so `agents stop X && agents resume X` works.
  It waits up to 5 seconds. Still running then, it prints
  `X is still stopping` and exits 1. `--no-wait` returns at once, as
  before. The stop route answers 200 with `stopped: true` once the session
  has ended, or 202 with `stillStopping: true`.
- **The Agents page never shows All in place of its `?ws=`.** A workspace
  that isn't active gets one line, "Workspace west isn't active · Switch
  to west", and the list shows that workspace alone. Clear stopped acts on
  exactly the workspaces listed. A name no workspace has gets the same
  line and an empty list.
- **Den's sudo is `/usr/bin/sudo`.** A `sudo` placed earlier on `PATH` no
  longer gets the admin password. Den looks on `PATH` only when there is no
  `/usr/bin/sudo`. `DEN_SYSTEM_SUDO` names another absolute path.
- **`mcp` refuses an argument it doesn't take.** A typo such as
  `--worksapce` exits 2 with the usage, instead of starting an unscoped
  server.

### Metrics (before → after)

- Share of agent sessions with attributed tokens and outcome: ~0 → ≥90%.
  On the test fixture (11 agents): 0% → 91%. The one left out runs on
  codex, which no usage reader covers yet.

### Migrations

- None needed. To remove stopped agents on their own, set
  `agents.remove_stopped_after` in `config/local/user.yml` to `1d` or `7d`
  (the default is `never`). Interrupted agents are never removed this way.
  To let an orchestrator resume agents, add `agent_resume` to
  `mcp.actions`.

## [0.4.7] - 2026-11-07

Agents read slices, wait in the background and hand back plainly (den#5,
the default-pack guardrails issue). Every persona in Den's default pack
gets Den's shared instructions and, on Claude Code, Den's hooks, with no
setup. `doctor` warns about polling loops it sees in the local dev metrics.

### Added

- **The Stop hook reads every last message.** With a `## Hand-back`
  heading it checks the whole hand-back, as before. Any other last message
  gets the plain-writing check: every ID explained. It still never blocks
  twice in a row.
- **`URL: none` in a hand-back.** Work with no page (a CLI change, a
  refused request) says `URL: none`, with a reason if it likes. An empty
  or missing URL still fails.

- **`down --json` and `web down --json`.** The clean-up steps answer in
  JSON like every other onboarding step: `{ ok, workspace, services }` and
  `{ ok, url, port, running, stopped }`. Both are safe to re-run.

- **Hooks for default-pack agents.** A Claude Code agent from Den's default
  pack runs with Den's own hooks, in its own `--settings` file (never your
  `~/.claude`). A `PreToolUse` hook on Bash and Read blocks reading all of
  a log or a large file into the conversation (`cat`, `less`, `tail` from
  a line such as `tail +1`, a Read with no limit; a plain `tail` passes) and says to read a slice or use a
  subagent. It blocks a foreground `sleep`, alone or in an `until`/`while`/
  `for` loop, and says to run in the background or use a wait primitive.
  It blocks nothing else.
- **Shared persona instructions.** Every default-pack persona's role prompt
  ends with Den's `guardrails/instructions.md`: write plainly, in short
  sentences; say what every issue or ID is; ask each decision as a numbered
  yes/no question; no caveat sections; and the hand-back template (URL,
  machine, branch, what changed, what to click, decisions).
- **The hand-back check.** `<cli> agents handback-check <file|->` rejects a
  hand-back with a missing part, an unexplained ID, or a decision that is
  not a numbered yes/no question, and says what to fix. A `Stop` hook runs
  the same check on a turn that ends with a `Hand-back` heading, and sends
  Claude back to fix it once.
- **doctor warns about polling loops.** It reads the end of the local
  `.dev-metrics/events.jsonl` (at most 8 MB) and warns when one command,
  run from one place, ran more than 600 times in an hour:
  `looks like a polling loop: status in services/api, 1200 calls in an hour (…)`.
  It is local and sends nothing.
- **Each dev-metrics line records `cwd`**, relative to the distribution root
  (`.` at the root, `outside` elsewhere), never an absolute or home path.
  Like every field, it is sent only when you opt in.

### Metrics (before → after)

- Polling loops a week: 18,600 → under 100 expected, since the hook blocks
  them. The "after" is counted on the candidate's first week.
- Incomplete hand-backs: not measured → 0 for default-pack agents (the Stop
  hook sends them back). The candidate's first run sets the baseline.
- Hand-backs with an unexplained ID: no baseline → 0 for default-pack
  agents. The candidate's first run sets the baseline.
- doctor on a replay of a three-day polling burst: no warning → it warns.

### Migrations

- None needed. To turn the guardrails off for Den's pack, set
  `agents.default_pack: { hooks: false, instructions: false }`. To turn
  them on for your own pack, write its `persona_packs` entry as
  `{ path: <dir>, hooks: true, instructions: true }`. A persona's
  `den_hooks` / `den_instructions` front matter wins over its pack's.

## [0.4.6] - 2026-11-07

Den in five minutes, set up by your own agent (ON-2, with ON-4's dry run).
A developer pastes one line into their agent, and every command the agent
runs answers in JSON, never prompts, and is safe to re-run.

### Added

- **Set up by your agent.** `den --help` and the README print the line to
  paste: "Set up Den for me by following
  https://raw.githubusercontent.com/Monster-Orange/den/main/skills/install-den/SKILL.md". The install-den skill it points
  at ships in the package as `skills/install-den/SKILL.md`: plain Markdown
  with Claude skill front matter, at most three questions, no secrets in
  chat, no edits to the person's repos, nothing sent off the machine.
- **`<cli> repo add <path|git-url>`** adds a repo with no prompts and never
  writes into it. A git URL is cloned where Den keeps managed clones. A repo
  with no manifest (or `--sidecar`) gets a side-car manifest in the
  distribution's `manifests/`, detected from its Makefile `up` target, its
  compose file or its `package.json` `dev`/`start` scripts (and `test`), and
  validated before it is written. When detection can't decide, nothing is
  written and the answer asks, with the choices; a re-run passes
  `--run "<cmd>"`. `--health <url>` adds a health check. The workspace is
  `-w`, else the focused one, else a new `default`. The same repo again
  answers `existed: true`.
- **`--json` for setup.** `create --yes --json` (a directory that already
  holds the distribution is `existed: true`), `up --json` (each service's
  result and health), `doctor --json` and `mcp connect --json`. Stdout is
  one JSON object, the log goes to stderr, and a failure carries a `fix`
  the agent can run or an `ask` for the person.
- **`doctor --json`'s onboarding checks:** Node 22.13 or later, git, Docker
  (only when a registered repo needs it), the web server and its URL, and
  Den's MCP through it, each `ok`, `warn` or `fail`. The human `doctor` is
  unchanged.
- **`mcp connect --runtime claude|codex|gemini|grok`** names the agent by
  its runtime. Grok CLI is a new client: Den writes its own
  `[mcp_servers.<cli>]` table in `~/.grok/config.toml` (or the project's
  `.grok/config.toml`), as xAI documents. A config file that already has the
  entry is no longer rewritten.
- **`create` picks a free web port.** When 7777 is in use on this machine,
  `create` picks the next free port above it (never 7778, 7791 or 7799),
  writes it to the new distribution's `config/local/user.yml` and says so,
  in JSON as `port` and `portPicked`. `--port <n>` sets it outright. The
  check connects and binds only; it sends nothing to the port's holder.
  `DEN_WEB_PORT_START` moves the starting port.
- **`web up --json`** answers `{ ok, url, port }` once the server answers,
  and `doctor --json`'s web check carries the `port`.

### Changed

- `create` into a directory that already holds the same distribution says
  so and exits 0, instead of refusing a non-empty directory.

### Fixed

- **An opted-in CLI sends its metrics.** The CLI records each run as it
  exits, and a send started then never ran. With `metrics.share: true`, the
  CLI now hands the event to a small detached sender that gives up after 2
  seconds. The web server sends as before. Not opted in, nothing is sent.
- **Linked devices read plainly.** A device approved with a code says
  "approved with a code", not "signed in with approved with a code".
- **An agent's refusal names the admin password.** It said "the lock",
  which 0.4.4 removed.

### Metric

- Time from the paste to "service running, MCP connected" (R11): not
  measured before; ON-4's dry run (create, repo add, up, web up, doctor,
  mcp connect, each run twice) now records it, about 16 s locally. Target:
  5 minutes or less.

### Migrations

- None.

## [0.4.5] - 2026-11-07

Sign in with GitHub as the owner, from your other devices; approve a
computer with a code; see that you're signed in (SEC-2a). Save the admin
password without editing YAML (LK-4). Dev-metrics stay on this machine
unless you opt in.

### Added

- **Sign in with GitHub.** A Den has one owner, a GitHub account:
  `<cli> web owner link` runs GitHub's device flow in the terminal (a code
  to enter at https://github.com/login/device) and stores only
  `github:<id>` and the login (`web-owner.json`, 0600), never the token.
  `web owner show` and `web owner unlink` too. The signed-out page then
  has **Sign in with GitHub**: the server runs the flow, and the owner's
  approval sets the same never-expiring session a one-time link does;
  any other account sees "@<login> isn't allowed on this Den". At most
  three sign-ins wait at once. Before an owner is linked the page says to
  run `web owner link`. See docs/distributions.md, "Signing in with GitHub".
- **Settings › Access.** The owner (link and unlink: shell-grade, so a
  signed-in browser and never an agent's token), the
  linked devices (browser, how it signed in, the client address the edge
  vouched for, first and last seen) each with **Revoke**, which ends that
  session at once, and **Pair a device**: a one-time link and its QR code
  for an edge hostname you pick.
- **`web.github_client_id`**: the GitHub App's client id (public). The
  default is Den's own App, "Monster Orange Den" (`Iv23liKL12gnN6WvRV5b`);
  a distribution sets its own App's id here, and an empty value turns Sign
  in with GitHub off (the page then offers only the code and the link).
  The App needs "Enable Device Flow" ticked and "Expire user authorization
  tokens" off (docs/distributions.md, "The GitHub App").
- **Expiring GitHub tokens are noticed.** If the App hands out expiring
  tokens (`expires_in` or `refresh_token` in the answer), sign-in still
  completes, and Den says once to switch off token expiry in the App's
  settings (never with the token). `GET /api/web/owner` reports it as
  `tokenExpiry`. Den never asks for `offline_access`.
- **Approve this computer with a code.** The signed-out page shows a
  six-character code (`XXX-XXX`, about 30 bits; the page polls with its own
  128-bit id) and the command that approves it on the machine Den runs on:
  `<cli> web approve <code>` (any case, dash optional; `--list` shows what
  waits). The page signs itself in when it's approved, onto the page it
  asked for. From a machine with SSH access the page gives the one-liner
  (`ssh <host> '<cli> web approve <code>'`) and, for a host name, an Open
  Terminal link. Codes expire after 10 minutes, are single-use, at most
  five wait at once (the oldest drops) and are kept in memory only;
  approvals are rate-limited and audited with who approved. The device is
  labelled "approved with a code".
- **Settings › Access › Waiting devices**: the computers waiting with a
  code (browser and OS, address, when), each with **Approve** and **Deny**.
- **`web.machine_name`** (Settings › Access › Machine name, in user.yml):
  the name the signed-out page gives this machine. Default: the short
  hostname. It's never taken from the browser's Host; the ssh one-liner's
  target is the Host the browser used (without the port).
- **The signed-out page says where to act.** "Sign in to <product>", which
  machine Den runs on and why it asks (once per computer), Sign in with
  GitHub (only with a client id), Approve this computer, and the one-time
  link under "Other ways". Every command it prints names the machine it
  runs on, has a copy button, and is `<cli>` when that's on PATH and this
  distribution's, else the absolute path of its bin. English, Japanese and
  Spanish.
- **See that you're signed in.** A chip at the foot of the rail says
  "Local", "Signed in · this device" or "@<login>" and opens Settings ›
  Access. The first page after a sign-in says "This device is signed in
  to <product> on <machine>", once. Linked devices lists every session
  (GitHub, a code, a one-time link) with how it signed in, when, from
  where, last seen and Revoke, and marks the one you're using as "This
  device".
- **Save the admin password without editing YAML (LK-4).** When a secrets
  backend that keeps secrets (1Password, Doppler) is available and no
  `secrets.refs.sudo` is set, the admin password prompt (shown when a
  command is about to run sudo, LK-0) still offers "Save to <backend>".
  Saving creates the item (1Password: "<Product> admin password" in your
  default vault; Doppler: `<PREFIX>_LOCAL_ADMIN_PWD`) and writes
  `secrets.refs.sudo` to your `config/local/user.yml`, so the password
  survives restarts. A ref in the distribution's config still wins. The
  vault status says so as `canSave`. A save error no longer carries the
  backend's command line.
- **`edge.proxy_protocol.trusted_ips`** (empty by default): the front
  proxies (a TCP passthrough in front of the edge) whose PROXY protocol
  every entrypoint accepts, so Den sees the real client through them.
- **`web.edge_unattested: local | signin`** (default `signin`, read only
  from `config/local/user.yml`): whether an edge client Den can't place
  signs in. `local` keeps 0.4.4's (and 0.4.3's) behaviour.

### Changed

- **Dev-metrics are local unless you opt in.** Den sent its dev-metrics
  whenever a DSN was present (in the env or a synced
  `dev-metrics.config`). Sending now needs `metrics: { share: true }` in
  `config/local/user.yml` (the boolean only); a DSN alone never sends. The
  local `events.jsonl` is unchanged, and `CI=true` and
  `DEV_METRICS_DISABLED=1` still stop sending.
- **`<cli> web login` waits.** It prints the link and an 8-character code,
  and blocks until the link is used ("Signed in: <browser> (<address>) at
  <time>") or expires ("Expired: nobody used the link", exit 1). The link
  asks for the code before it signs in; a wrong code is refused (five burn
  the link, and wrong codes are rate-limited) and the link stays
  single-use. `--no-wait` prints the link alone, as before, and asks for no
  code; with no server running it behaves like `--no-wait` and says so.
- **Edge visitors Den can't place sign in.** A client the edge reports
  with no `X-Forwarded-For`, or with a Docker/VM gateway or bridge address
  (what a TCP passthrough or Docker Desktop and OrbStack hand it), now sees
  the signed-out page with Sign in with GitHub, unless
  `web.edge_unattested: local`. Loopback and this machine's own addresses,
  as the edge reports them, stay local, and localhost straight to the
  server's port never signs in.
- **The client is the right-most `X-Forwarded-For` entry**, the one the
  edge appended (0.4.4 and earlier read the left-most, which a client could
  write).
- **The edge believes forwarded headers only from its own networks.** Den
  renders `forwardedHeaders.trustedIPs` (loopback and the Docker ranges)
  on every entrypoint, never `forwardedHeaders.insecure`. An `edge.args`
  entry that sets `forwardedHeaders` or `proxyProtocol` is dropped with a
  notice from `edge up`.
- **"Your edge is reachable from other machines"** now reads "A browser it
  can't place as this one signs in first (Sign in with GitHub, or a
  pairing link)." (with `web.edge_unattested: local`, that anyone it can't
  place can use terminals).
- **`edge up` says when the running edge's command differs** from the one
  it renders, and why, before recreating it.

### Fixed

- **The workspace commands run in is named: "CLI default".** Local Dev's
  workspace list marked it with a bare accent dot and no label, and
  picking a workspace in the top bar never moved the dot (by design: that
  picks the view), so it looked broken. It now says "CLI default", with
  a tooltip: CLI commands run there when you don't name a workspace, and
  the top bar only changes what pages show. The top bar's Workspace menu
  tags it "CLI default" (was "focus") and offers "Make <ws> the CLI
  default"; the Workspaces pane's badge reads "active · CLI default" and
  its button "Make CLI default". Nothing behaves differently.

- **A browser signs in on a plain-http LAN bind** (`DEN_BIND_HOST` with
  `web.allow_plain_http_remote`). A `web login --origin http://<LAN IP>:<port>`
  link got 403 `origin_rejected`: the browser sends a plain-http origin that
  isn't localhost no `Sec-Fetch-*` headers, and a navigation sends no
  Origin. The sign-in GETs (`/auth` and the GitHub sign-in poll), which
  carry their own one-time credential, now pass with neither header. Either
  header, when present, is still checked, and every other GET that runs
  something still needs this server's page or a bearer.
- **`web up` with `DEN_BIND_HOST` on one address is ready when it serves.**
  Its readiness probe (and `web sessions`/`web logout`'s calls) asked
  127.0.0.1, so a server bound to a LAN IP or `::1` printed "did not become
  ready" and exited non-zero. They ask the bound address now (loopback for
  0.0.0.0 and `::`), with a Host the allowlist accepts and the CLI's
  bearer: a LAN address answers an unsigned probe 401 `signin_required`.
  `web up` names the bound address (`http://<LAN IP>:<port>`), not
  localhost, which a LAN-only bind doesn't answer.

### Migrations

- **One edge recreate.** The edge's command changes (forwarded-header
  trust), so the first `<cli> edge up` (or `stack up`) after upgrading
  recreates it once, and says so: "<org>-edge's settings changed
  (forwarded-header trust): recreating it once." Routes drop only while it
  restarts.
- **Edge visitors now see Sign in with GitHub** where 0.4.4 let a client
  it couldn't place in. Link an owner (`<cli> web owner link`), approve
  the computer with its code (`<cli> web approve <code>`) or pair with
  `<cli> web login --host <name>`;
  or set `web.edge_unattested: local` in `config/local/user.yml` to keep
  0.4.4's behaviour on that machine.
- **Scripts that run `<cli> web login` and read its output** should pass
  `--no-wait`: it now waits for the link to be used.
- **Remove `forwardedHeaders.*` and `proxyProtocol.*` from `edge.args`.**
  They are ignored now; use `edge.proxy_protocol.trusted_ips` for a front
  proxy.

## [0.4.4] - 2026-11-07

The admin password is for sudo, and nothing else (LK-0). An agent's
terminal uses its pane's width, and Den knows Codex, Gemini and Grok as
well as Claude Code (AG-0.5). A scoped agent gets a whole, honest picture
through Den's MCP (MCP-2).

### Changed

- **Nothing asks for the admin password up front.** It was a lock: agent
  start, stop and resume answered `423 locked` without it, and the pages
  asked for it before agent actions, service actions and syncs. It is no
  access check (that is sign-in, the Host/Origin/CSRF checks and agent
  tokens), and Den now asks for it only when a command it runs is about to
  run sudo. Agents, sessions, terminals and services whose commands run no
  sudo never ask. The agent routes' `423 locked` is gone, and so is the
  Start agent dialog's password field.
- **A run that needs sudo says so, and the page asks then.** Every service
  command (up, down, restart, setup, sync) gets a `sudo` shim first on its
  PATH. With the password held, it gives it to sudo, as before. Without
  it, sudo that needs no password (NOPASSWD, a warm cache) runs as it
  would; anything else never prompts: the run's events carry
  `{ "type": "needs-sudo", "command": "sudo <command>", "step": "<service>" }`
  (sudo's own "a password is required" counts too, without the command).
  The page then says "`sudo <command>` needs your admin password", in the
  top layer, and runs the action again after it. Before asking, it asks
  the server (another tab or device may have set it) and, when one is
  stored, the vault. Local Dev no longer loads it from the vault on page
  load.
- **No Locked/Unlocked chip.** The top bar shows "🔑 Admin password
  needed" only while a run waits for it. Settings › Command line › Admin
  password says "Saved in 1Password", "Saved for this session" or "Not
  saved", with Forget (`POST /api/sudo-password/forget`, which also clears
  the vault's copy when this server saved or loaded it there).
  `GET /api/sudo-password/status` adds `saved` and `vault`.
- **Scoped answers say so (MCP-2.2).** `status`, `services`,
  `applications`, `graph`, `stacks` and `workspaces` on a scoped server
  carry a `scope` block: the workspace shown and what is left out
  (`hidden: { repos: 6 }`), pointing at `org_summary`. Their descriptions
  say "This workspace only", and a pinned server registers them without
  the `workspace` parameter (with grants it stays, as the scope's own or a
  granted one). A scoped `graph` is the workspace's own repos and the edges
  out of them; unscoped it is labelled `map: "org-wide"`. Before, `graph`
  listed every repo while every other tool showed one workspace's.
- **Refusals say how to get more (MCP-2.3).** A call naming another
  workspace says a person adds it to `agents.<id>.grants` in the org config
  and restarts the agent; a refused log read says logs stay inside each
  workspace and a grant does not widen them.
- **`status` (MCP tool) is an object:** `{ env, counts, services }`, each
  service with a `state` and, when it has no plain verdict, `why`. It was
  the bare `/api/health` array.

### Added

- **The runtime catalog (AG-0.5).** Den ships, as data, the vendor CLIs it
  can find: Claude Code (`den-claude`), OpenAI's Codex CLI (`codex`),
  Google's Gemini CLI (`gemini`) and xAI's Grok Build (`grok`), each with
  its binary names, version command, install directories and launch
  command, checked against the vendor's docs. Installed runtimes are
  listed first, with their versions, in the Start agent dialog, Settings
  and `agents doctor`. A runtime other than Claude Code runs its own
  interactive CLI in the workspace's directory, tagged "Den tools:
  coming"; nothing is offered as startable unless it can start here.
  When a catalog runtime is still not found, Den asks your interactive
  shell (`$SHELL -ilc`) once, and says so (`interactive-shell`).
- **Runtime paths per workspace.** `<ws>.agents.runtimes.<id>.bin` in
  `config/local/workspaces.yml` wins over `agents.runtimes.<id>.bin` in
  `config/local/user.yml`, which wins over what Den finds. **Settings ›
  Agents › Runtimes** shows each runtime's status, version, path and its
  source; **Set path…** runs the version command and refuses a path that
  isn't that runtime, and a selector edits one workspace's paths.
  `agents doctor -w <ws>` shows that workspace's.
- **The Start agent dialog is the approved width** (the mock's 600px of
  content: 638px wide, never wider than the window less 16px a side).
- **`org_summary`, the org at a glance for every agent (MCP-2.1).** A new
  read tool: every workspace and repo with status counts (running, partial,
  stopped, inactive; up, down, redirect, not checked), the dependency graph
  (names and edge kinds), the edge (up, TLS, whether HTTPS serves) and the
  environments. Scoped, `yours` adds the agent's own workspace's services
  in full, so "what are our servers?" is answered without `docker ps`. For
  other workspaces it carries names and counts only: never logs, env
  values, commands, URLs, paths or check output.
- **`edge_status.https` (MCP-2.5)**: the TLS strategy, who supplies the
  cert (`den` or `distribution`) and whether HTTPS is serving, from a TLS
  handshake on the edge's https port. `edge status` prints it too.

### Fixed

- **A service's first lines reach the page.** A started service writes to
  its log, and Den tails that log back to the page. The tail started at the
  log's end, so a command that wrote and exited before the tail opened the
  file (on Linux, a refused sudo) showed nothing, and the page never asked
  for the admin password. The tail now reads from the start of this run.

- **An agent's terminal uses the pane's width.** A session has one PTY
  size, and the last viewer to resize it won: a second, narrower browser
  (or a hidden tab) left the TUI wrapping at its width in every other
  viewer. The viewer in use now wins: focusing a pane, typing in it after
  another viewer changed the size, and the page being shown again each
  send that pane's size; a hidden pane never resizes the PTY, and no
  resize under 2×2 is sent (the server refuses one too). The server tells
  every viewer the PTY's size on attach and on each change (a `size`
  frame), so a viewer knows when it is out of step. A session host
  that outlived an upgrade sends no such frame, so then every keystroke
  says the typing viewer's size (the same size again redraws nothing). The cells are also
  measured again once fonts finish loading and after a theme is applied,
  so a theme's web font no longer leaves the terminal fitted to the
  fallback font's width.
- **A Settings row with its own control is drawn.** A custom row without a
  write was drawn as an empty read-only value, so Browser sign-in showed
  nothing; it now shows its state and Sign out.
- **A redirect is not down (MCP-2.4).** A health check answered `302 →
  /login` (a production app's login page) was reported down. The bug was
  in the shared HTTP check, so the web health row and `<cli> status` had
  it too. A 3xx is now `redirect`: ok null, with its status and target (the
  query dropped), never green, so an ALB's 301 for a stopped service is
  still not taken for up. `target.expect` listing the code counts it as up.
  `<cli> status` shows `redirect 302 → /login`, and `up` and `restart` no
  longer wait out a service that answers with a redirect.
- **An unchecked service says why (MCP-2.4).** `ok: null` with no reason
  (`runs: none` in beta and prod) now carries `why` on the web health row
  and in `status`: no health check for the env, remote with no check, not
  deployed in the env, or no manifest.
- **An empty `stacks` explains itself (MCP-2.4):** `/api/stacks` says the
  org config declares no `stacks:` and no repo of the workspace has a
  `compose:` block (or the workspace doesn't exist); scoped, that the
  stacks listed belong to repos outside it.
- **`certIssued: false` while HTTPS works (MCP-2.5).** It meant "Den minted
  the cert", which is false under `tls: files`. Renamed `certIssuedByDen`.
- **Security: a scoped `mcp --call` goes through the scoped path, and
  says so.** A review reported that `mcp --workspace A --actor agent:<id>
  --call services '{"workspace":"B"}'` could read workspace B's services
  (paths and commands included). A one-shot now lists and validates
  against the pinned tools exactly as the stdio server registers them, a
  `workspace` naming another workspace always reaches Den's refusal, and
  `--call` prints its scope on stderr (`<cli> mcp --call: scoped to A as
  agent:<id>`), so an unscoped run can't pass for a scoped one. Tests now
  drive the real `bin/den mcp --call` entry.
- **An ungranted workspace gets Den's refusal (MCP-2.3).** On a scoped
  server with grants, naming a workspace that is not granted answered
  `MCP error -32602 … expected one of "A"|"C"` (the schema). The
  `workspace` parameter is now a name whose description lists the allowed
  ones, and any other gets the refusal naming `agents.<id>.grants` and how
  a person grants it.
- **The org-wide map is org-wide.** `org_summary.graph` and an unscoped
  `graph` held only the focused workspace's repos, so a repo only in
  another active workspace was missing. They now merge every active
  workspace's graph (`workspaces` names them; `order`, a startup order
  within one workspace, only when one is active); `org_summary` keeps
  names and edge kinds only. `graph` with a `workspace` is labelled
  `map: "workspace"`.
- **A service's command runs in its own workspace.** The Services page's
  and the tests page's setup, up, down and restart sent no workspace, so a
  service only in a non-focused active workspace failed: `Command "setup"
  not found for <repo>/<svc> … Active workspace: <focus>`. They now send
  the workspace the row was built from. (0.4.3 had the same bug.)
- **`agents doctor -w <ws>` works.** It answered `workspaces not loaded`;
  it now loads the workspaces config first, as `agents start` does.
- **A redirect is a redirect in `status`.** A repo row's reason counted a
  service that answered with a redirect as "1 not checked"; it now says
  "1 redirect" (the web header and graph cards too).

### Migrations

- A page script that imported `requireUnlock`, `checkUnlock`,
  `isUnlocked` or `onLockChange` from `header.js` or `topbar.js`: they are
  gone. Run the action; when its run's events carry `needs-sudo`, the
  shell asks (`sudoRun()` from `header.js`: `see(msg)` on each event,
  `done(retry)` when the run ends).
- A client that handled `423 locked` from the agent routes: it no longer
  happens.
- A distribution may add runtimes with `agents.runtime_catalog` (see
  Runtimes in docs/distributions.md).
- A script reading `<cli> mcp --call status` gets `{ env, counts, services
  }` in place of the array: read `.services`.
- `edge_status.certIssued` (and `/api/edge`'s) is deprecated: read
  `certIssuedByDen`, or `https.serving` for whether HTTPS works. It goes in
  the release after 0.4.4.

## [0.4.3] - 2026-11-06

Agents start, and the edge counts as local.

### Fixed

- **The Start agent dialog can be submitted (AG-10.0).** A persona's whole
  role sentence was in its option, so the select grew past the dialog and
  pushed Cancel and Start out of sight. A persona option now shows its id,
  with its role on a help line under the select that follows the pick. The
  runtime's first option names what it resolves to ("Claude Code (persona
  default)"), a runtime that can't run here says why, and Enter starts
  from any field. The Workspaces page's agents form gets the same choices.

- **Agents start on a Den run as a service (AG-0.1).** Starting any agent
  failed with "den-claude is unavailable: claude is not on PATH" when the
  web server ran under launchd: its PATH leaves out `~/.local/bin`, where
  Claude Code's native installer puts `claude`, and Den searched only that
  PATH. Den now finds a runtime's CLI as your terminal would:
  `agents.runtimes.<id>.bin` in `config/local/user.yml` wins (an absolute
  path, checked; a bad one is refused with its reason), then the login
  shell's PATH (`$SHELL -lc`, asked once at server start in the
  background, 3-second timeout, falling back to the current PATH), the
  server's PATH, and the runtime's install directories (`~/.local/bin`,
  `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, npm's global
  bin). Agents and plain sessions get the same directories on their PATH.
- **The lock is always reachable (LK-1 to LK-3).** Start agent opened its
  dialog and only then asked for the lock, whose popover sat under the
  dialog where nothing could reach it. The lock is now checked before the
  dialog opens, and the dialog asks for the admin password at its top:
  Start unlocks, then starts. The lock popover is in the top layer, so no
  dialog covers it. A page that thinks it's locked asks the server before
  asking you (another tab or device may have unlocked it), and, when a
  password is stored in the vault, the first action that needs the lock
  loads it from there on every page, not only Local Dev. A page view still
  never wakes the vault.

### Changed

- **The edge from this machine needs no sign-in.** A request for the edge
  hostname from an edge peer is treated as loopback: no sign-in on any
  route, agents and the terminal included (0.4.2 asked for one on every
  route). Host, Origin, CSRF and the agent-token rules stay. The client is
  the left-most `X-Forwarded-For` entry: loopback or one of this machine's
  own interface addresses (a Tailscale `100.x` included) is local; missing,
  or a Docker/VM network's address (what Docker Desktop and OrbStack hand
  the edge; the subnets of the edge's own Docker networks, `<org>-edge`
  and those it joins, read once at start with `docker network inspect`;
  OrbStack's host address `0.250.250.254`), is "can't tell", also local, so
  a TCP-passthrough proxy container on the edge's network is no other
  machine; any other address is another
  machine and needs a sign-in. A non-loopback `DEN_BIND_HOST` bind (other
  than the Linux edge's Docker bridge) and `web.allow_plain_http_remote`'s
  LAN names still need one. See docs/distributions.md, "Signing in".

### Added

- **The Start dialog says before Start whether the agent can run
  (AG-0.2).** Under the runtime a line names what Start will run, with its
  version and path ("Starts Claude Code 2.1.0 from …"); the runtime's
  option shows its version. When the runtime can't run here, Start is
  disabled and the line says why and how to fix it: where Den looked, then
  install it, or set `agents.runtimes.<id>.bin` in the user.yml it names,
  or run `<cli> agents doctor`. The Workspaces page's agents form does the
  same. `GET /api/personas` gives each runtime `version` (its version
  command, run once under a timeout and kept), `path`, `source`
  (`setting`, `login-shell`, `well-known` or `PATH`), `searched` and
  `setting`, and the response a `userConfig` path.
- **`<cli> agents doctor [--json]` (AG-0.3)**: each runtime's status, the
  CLI it runs and where it came from, its version, the directories
  searched (names only, never an environment value), and the fix when it
  is missing. It exits 1 when the default runtime is unavailable.

- **"Your edge is reachable from other machines".** When an edge hostname
  resolves to an address that isn't loopback, or the edge container
  publishes a port on every interface (`docker inspect`), Den says so once
  in `web.log` at start and in a banner on every page (dismissed per
  browser): "Your edge is reachable from other machines; anyone who can
  reach it can use terminals. Auth is coming."
- **`<cli> web login --host <name>`** mints the one-time link for an edge
  hostname (an edge domain or alias, a VPN name among them) at its edge
  URL, instead of localhost. A name the edge doesn't route to this server
  is refused, naming the hostnames it does and what to add. `--origin`
  stays.

### Migrations

- **A Den run as a service whose agents' CLI is somewhere unusual**: set
  `agents.runtimes.<id>.bin` (an absolute path) in `config/local/user.yml`.
  Nothing else changes: a runtime on the server's PATH is found as before.
- **A page script that called `requireUnlock()`** (header.js): it now
  returns a promise of the answer; `await` it.

## [0.4.2] - 2026-11-06

The 0.4.1 carry-overs.

### Added

- **`sessions.max_concurrent`** (default 8): the cap on plain sessions
  (`sessions start`) running at once. Past it, `sessions start` is refused
  as the agents' cap is: "2 sessions are running and
  sessions.max_concurrent is 2", then "Stop one first (`<cli> sessions
  kill <name>`), or raise sessions.max_concurrent." `<cli> validate` names
  a wrong value of it or of `agents.max_concurrent`.

### Changed

- **`agents.max_concurrent` counts agents only.** Plain sessions count
  against `sessions.max_concurrent` instead, so a few plain shells never
  stop an agent from starting (from the CLI, the Workspaces page, the
  Agents tab or MCP). Its refusal says "1 agent is running and
  agents.max_concurrent is 1".
- **The Agents tab's pane title and Close** name the agent by its id
  (its display name once AG-10 adds one), never its persona; the list row
  still shows the persona, with the id beside it.
- **den-claude's deny list, in the docs**: it is a convenience, not the
  boundary. It binds cooperating agents only and does not catch every
  spelling (a path relative to the agent's cwd, another program); the
  server's token rules are the boundary.

### Fixed

- **A distribution config's `web.allow_plain_http_remote`** (ignored: it is
  read only from `config/local/user.yml`) was warned about only in the
  in-app server log. It is now in `web.log` too (before a bind refusal it
  often explains), in the `web up` and `web restart` output, and in
  `<cli> validate`.
- **`up --help`**: `-w, --workspace <ws>` ran into its text ("<ws>act in
  that…"); there are two spaces now. `down`, `restart` and `setup --help`
  were already spaced.


### Migrations

- **More than 4 plain sessions at once**, or a script that relied on
  `agents.max_concurrent` to cap plain sessions: set
  `sessions.max_concurrent` (default 8). `agents.max_concurrent` no longer
  counts them. A session host already running from 0.4.1 keeps counting
  every session until it restarts (`sessions host --stop`, which ends its
  sessions, or a reboot).

## [0.4.1] - 2026-11-06

### Added

- **The Agents tab** (0.4.1-dev.5, AG-4a-term, AG spec §5d): "Agents" in
  the rail under Develop, after Graph, at `/agents`. The list holds every
  session and agent of the workspaces in view (the scope bar, or `?ws=`),
  grouped by workspace: state, persona and runtime, and a waiting badge
  (shown once the host can tell, AG-6a);
  a plain session (`sessions start`) is labelled "session", an agent whose
  token `web logout --all` revoked says "token revoked". Click a row to
  open its terminal (xterm.js, served from Den's own node_modules: no CDN):
  the scrollback, then the live output, and your keys go to the session.
  Up to four panes tile (a fifth closes the oldest), and the URL holds them
  (`/agents?open=<id>,<id>`), so a reload or Back reattaches each with its
  scrollback. A pane's bar has its name, workspace and runtime, Stop (an
  agent, behind the lock) and Close, which detaches: the session keeps
  running, as it does when you leave the page. "+ Start agent" (or
  `/agents?start=1`) asks for the workspace under All, starts it and opens
  its pane. ⌘K offers "Agents › <ws> / <name>" for each and "Start agent…".
  The Workspaces page's Agents section links to it ("Open in Agents →",
  and Open on a row with a session). In English, Japanese and Spanish;
  light and dark; one column on a phone. Without the optional PTY module
  the list says terminals need it, and nothing else changes.
- **`GET /api/sessions` and the `/api/sessions/<id>/io` WebSocket**
  (0.4.1-dev.5). The list: the sessions and agents of the active
  workspaces, this distribution's only (asking never starts a session
  host). The io socket is the session host's attach: binary frames carry
  output and input, a text frame `{"type":"resize","cols":c,"rows":r}`
  resizes, and the server says `{"type":"session",…}` first and
  `{"type":"exit","exitCode":n}` at the end. Closing it detaches and never
  signals the session; several browsers and the CLI can attach at once
  (the size is the last one's). It is shell-grade: this server's Host, the
  page's Origin, the CSRF token as the `den.csrf.<token>` subprotocol (a
  browser's WebSocket can't send a header), a sign-in beyond loopback, and
  an agent token reaches its own session's io only. Every attach and
  detach is in the audit trail, with the actor from the credential. A
  plain GET of it is 426.

- **`web logout --all` revokes every agent's token** (0.4.1-dev.4, SEC-1
  §6c.2): it is the "something leaked" button, so it ends everything. A
  running agent's next call gets 401 `token_revoked`: "This agent's token
  was revoked (`web logout --all`): restart or resume the agent to get a
  new one." (its stdio MCP server refuses to start with one). The output
  says how many it revoked. Plain `web logout` (one browser, or every
  browser) leaves agent tokens alone.
- **den-claude denies Den's state dir to the agent** (0.4.1-dev.4, SEC-1
  §6c.1): `--settings <file>` (0600) with `permissions.deny` for `Read` and
  `Bash` of `<state>/web.secret` and `<state>/sessions/**`. It binds
  cooperating agents only: an agent runs as the same OS user, and the
  server's token rules are the boundary.
- **`setup`, `up`, `down` and `restart` across active workspaces**
  (0.4.1-dev.4). `-w <workspace>` names the workspace (`setup` takes one
  now; several still go with `--plan`). With no `-w`, a named service
  resolves in the focus first, then across the other active workspaces, as
  the web API's `&workspace=` does: in exactly one, it runs there (the CLI
  says which); in several, an error lists them with the `-w` command for
  each; in none, or names in different workspaces, an error. Each exits 1
  and runs nothing. Before, a service in an active workspace that wasn't
  the focus made `setup` print nothing and exit 0, `restart` say "not
  found" and `up` say "no derived dependencies".

- **Agent actor tokens** (0.4.1-dev.3, SEC-1c, SEC-1 spec §1, §5, §7).
  - **`agents start`** (the CLI and `POST /api/workspaces/<ws>/agents`)
    mints a random `den_at_…` token for the agent and hands it to the
    session as `DEN_ACTOR_TOKEN`, through the §5a-env allowlist's Den
    markers (a caller's, a runtime's or a `--keep-env` value of it is
    dropped). Only its sha256 is stored, in `actor-tokens.json` (0600) in
    the state dir, with the agent, its workspace, its grants and its
    session. One live token per agent: **resume** mints a fresh one and the
    old one stops working; **stop** revokes it, and so does the session's
    end (an exit or a crash), checked when the token is presented.
  - **The scrub always strips a person's credential** from every session's
    env, whatever put it there: `DEN_PERSON_TOKEN`, any value carrying a
    person token, a path to `web.secret`. **`sessions start --keep-env`**
    of one (or of `DEN_ACTOR_TOKEN`) is refused, exit 1, and the session
    host's log records the refusal and who asked (the name, never a value).
  - **The server accepts the agent's bearer.** The CLI inside an agent
    sends its `DEN_ACTOR_TOKEN`, never the person token (an agent without
    one sends none). The audit actor comes from the credential: an entry
    reads `actor: "agent"` only for a verified agent token. Agent headers
    (`X-Den-Agent`, …) next to another credential, or alone, are recorded
    as `claimed` with `unverified: true`, and the Activity panel shows
    them as "(unverified)".
  - **What an agent token can't do**: open another session's routes
    (`/api/sessions/<id>/…`: only its own session; the routes themselves
    come with the terminal), any other shell-grade route (start, resume,
    the session admin routes, so it mints no tokens), `/api/web/*`,
    `/auth`, `/signin`, sign out or rotate; and it never passes the lock
    (R8): no unlock, no sudo password, no prewarmed sudo, and the lock reads
    closed to it. Each answers 403 `agent_forbidden`. A workspace check
    (WS-3a) has its seam in the request guard, allowing everything for now.
  - **The stdio MCP server Den starts for an agent** carries that agent's
    token: its calls are audited as the agent, and `--actor` /
    `--workspace` that don't match the token's record refuse to start.
- **Signing in the browser** (0.4.1-dev.2, SEC-1b, SEC-1 spec §2, §4). No
  password: reading `web.secret` proves you are this computer's user, and
  the CLI does it.
  - **`<cli> web open`** starts the server if needed and opens a fresh tab
    on a sign-in link; **`<cli> web up`** opens one too when it doesn't find
    an existing tab. **`<cli> web login [--next <path>] [--origin <url>]`**
    prints a fresh link, for another browser.
    The link is `http://localhost:<port>/auth?c=<code>&next=<path>`: the
    code works once, within 60 seconds, and is an HMAC of a random nonce
    and its expiry under `web.secret` (the server records the nonce as
    used). It is printed only on that one line and never logged. `next`
    must be a same-origin path (`//evil`, `http://evil`, `/\evil` go to
    `/`).
  - **`GET /auth?c=…`** swaps the code for a session and answers 303 to
    `next`. A bad, expired or used code gets the signed-out page: "That
    sign-in link expired or was used. Run `<cli> web login` for a new one."
  - **The cookie** `den_session_<port>` (an opaque random id; per port, so
    two distributions on one machine keep their own): HttpOnly,
    SameSite=Strict, Path=/, and Secure when the request came over HTTPS
    (the edge's `X-Forwarded-Proto` counts only on the edge hostname from
    a loopback or Docker peer). The record is server-side, in
    `web-sessions.json` (0600) in the state dir, keyed by an HMAC of the id
    under the secret: created, last seen, the user agent (truncated), the
    host it was issued on and its own CSRF token. It never expires
    (0.4.1-dev.4, above).
  - **`GET /api/session`** answers `{ csrf, actor: "person-browser",
    signedIn: true }` for a signed-in browser, with the session's own CSRF
    token (a signed-in browser's mutations must carry that one). Signed out
    on loopback it answers as before.
  - **The route classes (§4).** On loopback no route needs a sign-in
    (0.4.1-dev.4): read-only is open; mutating and **shell-grade** (an
    agent's start and resume, the session admin routes, later the terminal)
    need Origin and CSRF (as in SEC-1a), or the person's bearer (the CLI and
    MCP need no setup). Beyond loopback (the edge hostname, a LAN name, or
    a peer that isn't loopback): every route needs a session or a bearer,
    so a LAN or edge Host is usable again once signed in. Only `/auth`,
    `/signin`, `/api/session` and the UI's static files need none.
  - **The signed-out page** (beyond loopback), in the shell frame: "Sign in
    to use <name>", "Run `<cli> web login` and open the link." with a copy
    button (through the edge the command names its origin), and on
    `127.0.0.1` or `[::1]` a link to the same page on `localhost`, where the
    cookie is. It never offers a form for a secret or a token. `/api`
    answers 401 `signin_required` (R26's shape). In en, ja and es.
  - **localhost is canonical**: the links Den prints use it, and following
    the signed-out page's link from 127.0.0.1 lands signed in.
  - **`<cli> web sessions [--json]`** lists the signed-in browsers (id
    prefix, created, last seen, host, user agent); **`<cli> web logout
    [<id prefix>]`** signs out one, or every browser; **`--all`** also
    rotates `web.secret`, which ends every session and every person token
    (the CLI re-reads it and keeps working), and (0.4.1-dev.4) revokes every
    agent's token. They ask the running server
    with the person token, or edit the state files when it isn't running.
  - **Settings → Command line → Browser sign-in** says whether this
    browser is signed in, with **Sign out** (`POST /api/session/logout`).
  - **A non-loopback bind refuses to start** (`DEN_BIND_HOST=0.0.0.0` or a
    LAN address) without HTTPS in front (the edge, with `edge.tls`), unless
    `web.allow_plain_http_remote: true` is in `config/local/user.yml`: the
    error says a session cookie would cross the network in clear text.
    With it, the machine's own addresses and host name are accepted with
    the port.
- **Request checks on every request** (0.4.1-dev.1, SEC-1a, SEC-1 spec §3).
  Hardening for everyone; no sign-in yet (that is SEC-1b).
  - **Host allowlist** (DNS rebinding): `localhost`, `127.0.0.1` and
    `[::1]` with the server's port, plus the edge hostnames that route to
    Den. Anything else answers 421 `misdirected` (R26's JSON for `/api`, the
    shell-frame error page for a page, which links to the same path on
    `localhost`). The product's own name is accepted when `/etc/hosts` maps
    it to 127.0.0.1 (the URL `web up` opens then), and so is a specific
    address `DEN_BIND_HOST` binds.
  - **Origin** on POST, PUT, PATCH, DELETE and every WebSocket upgrade: an
    allowed host, http or https. A missing Origin needs a valid
    `Authorization`. Otherwise 403 `origin_rejected`.
  - **CSRF**: the shell sends `X-Den-CSRF` on every same-origin mutation,
    through `denShell.api()` or a page's own `fetch()`, with the token the
    new `GET /api/session` hands out (`{ csrf, actor }`, same-origin callers
    only). The token is per server start; after a restart the shell fetches
    a fresh one and retries once. A browser mutation without it answers 403
    `csrf`.
  - **GETs that run something** (they stream over GET, for EventSource):
    `/api/service/exec`, `/api/run`, `/api/workspace/exec`,
    `/api/workspace/sync` and `/api/aws/login`. They answer this server's
    own pages only (`Sec-Fetch-Site: same-origin`, or `none` for a typed
    URL), or a caller with neither header and a valid bearer (the CLI,
    MCP, curl). Another site's `<img src>` or no-cors fetch answers 403
    `cross_site` (or `origin_rejected`), and nothing runs.
  - **One route table** (`route-classes.ts`): every route the server
    dispatches is `readonly`, `mutating` or `shell-grade` (§4), by method
    and path; the checks read it, and SEC-1b will too. A test scans the
    dispatchers and fails on a route the table doesn't classify.
  - Other GETs, pages and SSE streams are unchanged on loopback (§6).
- **`web.secret` and the CLI's person token** (SEC-1a, §5). The server
  creates `web.secret` (32 random bytes, mode 0600) in the state dir at
  start. The CLI and the stdio MCP server send `Authorization: Bearer
  den_pt_…`, derived from it, on every call: nothing to set up. The server
  verifies it in constant time; an invalid bearer answers 401
  `unauthorized`. The audit entry of a call made with it gains `principal:
  "person:<os user>"`, from the credential, never from a header.
  `<cli> web token --print` prints it for curl (stdout only, with a
  one-line note on stderr that it grants your access).
- **Agents on the Workspaces page** (0.4.1-dev.0, AG-4a, AG spec §5c).
  Under the selected workspace's repo table, one row per agent: id and
  persona, runtime, state (`running`, `stopping`, `stopped`, `ended`,
  `exited (<code>)`), directory and when its session started. **Stop**, and
  **Resume** where the record allows it (the runtime declares resume and the
  agent isn't running). **+ Start agent** picks a persona and a runtime. The
  workspace header counts them ("n agents"). In en, ja and es.
  - Routes: `GET /api/workspaces/<ws>/agents`, `POST
    /api/workspaces/<ws>/agents` (start), `POST
    /api/workspaces/<ws>/agents/<id>/stop` and `…/resume`, `GET
    /api/personas`. They call the CLI's own operations (the new
    `agent-ops.ts`, which `<cli> agents` is now a front for): neither keeps
    state of its own, and a workspace lists its own agents only.
  - Guards: the lock (R8) gates Start, Stop and Resume (423 `locked`;
    the page opens the lock first, as for a service action),
    `agents.max_concurrent` caps starts (429 `cap`), and an agent actor is
    refused (403). Errors are R26's shape and reach the page as error
    toasts. The agent's env is the CLI's allowlist (§5a-env), and every
    action is audited with the person as its actor.
  - Listing never starts a session host: with none running, every agent
    reads `ended`.
  - No terminal and no Open in dev.0 to dev.4: dev.5 adds them (the Agents
    tab, above).

### Changed

- **No browser sign-in on loopback, for any route** (0.4.1-dev.4; Ward,
  2026-11-06; SEC-1 Q-SEC-1). On localhost the agents (start, resume), the
  browser-session routes, `/signin` and, later, the terminal need only what
  any change needs: this server's Host, the page's Origin and its CSRF
  token. The lock (R8) stays the only prompt. A sign-in is still required
  for every route when the server is reached beyond loopback: the edge
  hostname, a LAN name or address, or a peer that isn't loopback (a
  `DEN_BIND_HOST` bind). The Host allowlist, the Origin check,
  `X-Den-CSRF`, `web.secret`, the person token and agent tokens (and what
  an agent token can't do) are unchanged.
- **A browser session never expires** (0.4.1-dev.4; SEC-1 Q-SEC-2): it ends
  at sign-out, `web logout` or `web logout --all`. The cookie asks to be
  kept 400 days, a browser's most. `web.session.idle` and
  `web.session.max` are gone: if either is still in a config file the
  server logs that it is ignored, naming the key and the file, and starts.
- **Health covers every active workspace, whatever is in view**
  (0.4.1-dev.4, WS-6.4). `/api/health` and its stream check every active
  workspace's services; each row carries `inView` (one of its workspaces is
  in the view scope). The top bar's chip and drawer count only the rows in
  view; the pages get every row, so the Workspaces page shows a workspace's
  real health when it is outside the view (it read "unknown (not
  checked)").
- **The stdio MCP server's startup line says `unverified`** (0.4.1-dev.4,
  SEC-1 §6c.3) when no `DEN_ACTOR_TOKEN` verified its `--actor`: "scoped
  to north as agent:planner (unverified: no DEN_ACTOR_TOKEN)".
- **`/signin` is read-only** (0.4.1-dev.3). Signed in, or on loopback, it
  answers 303 to its (same-origin) `next`; signed out beyond loopback, the
  signed-out page. It was shell-grade, so the route's own check never ran
  beyond loopback.
- **`web up` and `web restart` print the server's refusal** (0.4.1-dev.3):
  when the server exits at start (a non-loopback bind without HTTPS, a
  wrong `web.allow_plain_http_remote` value) the CLI prints "<name> web refused to start:
  <the reason line>" and then where the log is, instead of waiting out
  "did not become ready". Secrets in the line are redacted.
- **`web sessions --help`** says that LAST SEEN is written at most once a
  minute, so it equals CREATED right after a sign-in, and that a session
  never expires.
- **`agents list` shows `stopping`** for an agent that was stopped while its
  session is still on its way out (it was `running`), and its `--json` rows
  gain `startedAt` and `resumable`.

### Fixed

- **A non-loopback bind needs `web.allow_plain_http_remote`, edge or no
  edge** (0.4.1-dev.5, a dev.4 dogfood finding). With the edge configured,
  `DEN_BIND_HOST=0.0.0.0` started, but the server's own port still answered
  plain HTTP on every interface. It is refused now unless
  `web.allow_plain_http_remote: true` is in `config/local/user.yml`; the
  one exception is the Docker bridge address (`172.16.0.0/12`, as
  `DEN_BIND_HOST=172.17.0.1`) with the edge configured, for an edge that
  reaches the host there (Linux). The edge on macOS reaches Den on
  loopback and needs neither.
- **The edge hostname is believed only from the edge** (0.4.1-dev.5): a
  request whose `Host` is the edge hostname from a peer the edge can't be
  (not loopback, the Docker bridge or Docker Desktop's network) is 421
  `misdirected`. A LAN client could send the edge's name straight to a
  non-loopback bind and be treated as coming through the edge.
- **`web.allow_plain_http_remote` in the distribution config is said to be
  ignored** (0.4.1-dev.5): it is read only from `config/local/user.yml` (a
  choice for one machine); the server logs a warning naming the file it
  found it in, and the refusal names the file to set it in.
- **den-claude's Bash denies match** (0.4.1-dev.5): Claude Code 2.1.x asked
  for approval of `cat <state>/web.secret` instead of denying it; the
  legacy `Bash(cat <path>:*)` shape didn't match. The rules are Claude
  Code's wildcard form now (`Bash(*<path>*)`, and `cat`, `head`, `tail`,
  `less`, `more`, `xxd`, `od`, `strings`, `base64` and `cp` of it), with
  the path under `~` and `$HOME` too, and a path with spaces escaped. The
  `Read` rules are unchanged.
- **`restart <repo>/<svc>` of a single-service repo restarts it** after
  `up <repo>` (0.4.1-dev.5, a dev.4 dogfood finding). The record was kept
  under `<repo>`, so the restart found none, adopted the running process
  and printed ✔ without restarting anything, leaving two records on one
  process group. For a repo with one service, `<repo>` and `<repo>/<svc>`
  are one daemon now; a duplicate left by dev.4 is merged at the next
  command; and a restart that adopts a process restarts it.
- **`up`, `down`, `restart` and `setup --help` mention `-w <workspace>`**
  (0.4.1-dev.5).
- **A subcommand's `--help` is its own** (0.4.1-dev.4): `web sessions`,
  `web login`, `web logout` and `web token --help` (or `-h`) printed the
  general web help, and `mcp connect|disconnect|clients|config --help`
  printed `mcp`'s, because the dispatcher answered `<command> --help`
  first. `web login`, `web logout` and `web token` have a help of their own
  now (`web token --help` exited 2).
- **A relative `product.state_dir` is relative to den.yml's directory**
  (0.4.1-dev.4), the distribution root. It was resolved against the cwd, so
  an agent's CLI or MCP server started in its workspace's directory read
  and wrote another state dir (another `web.secret`, other tokens).
- **Den's test servers are all tracked** (0.4.1-dev.4): every suite and
  helper that starts a web or MCP server starts it in a process group of
  its own and stops the group (tests/child-servers.ts), so none outlives a
  run.
- **A command name that isn't declared never runs** (0.4.1-dev.3, SEC-1
  §6b.2). `/api/service/exec?cmd=constructor` (or `toString`, any name an
  object inherits) ran `undefined` as a shell command; the service and
  workspace command lookups now read the declared commands only. `/api/run`
  refuses a `module` that isn't a module name (a `..` segment, a slash at
  the start), 400.
- **A web server whose output's reader is gone no longer spins**
  (0.4.1-dev.3). When the terminal, script or test runner that started the
  server was killed, the next log line failed with EPIPE and the "continue"
  guard for uncaught errors logged that to the equally closed stderr, which
  failed again: a loop at a full core that stopped the server answering,
  for as long as the orphan lived. The server now writes nothing once its
  output is gone, and shuts down (as for SIGTERM: services it started stay
  up). A server `<cli> web up` starts logs to a file and is not affected.
- **The server's exit is bounded** (0.4.1-dev.3). A SIGTERM or SIGINT with
  no prompt waiting on the person forces the exit after 10 s
  (`DEN_SHUTDOWN_DEADLINE_MS`) if the shutdown hasn't finished, and a
  second signal exits at once (it was ignored, so a stuck shutdown left the
  server deaf to every later SIGTERM).
- **Den's own test servers never outlive a test run** (0.4.1-dev.3): they
  start in a process group of their own, a test stops the whole group, and
  the run's global teardown (or the next run's setup) stops any group a
  killed or timed-out test left behind.
- **The Release page with no deploy environment** (`environments: [local]`
  only) no longer asks `/api/release/status?env=undefined` (a 400 on every
  load); it says no deploy environment is configured.
- **An agent's persona shows on every row** (0.4.1-dev.1), an id that is
  its persona too ("planner persona planner").
- **The unlock popover names agents** (0.4.1-dev.1): "Unlock to start, stop
  and restart services and agents", in en, ja and es.
- **Another workspace's agent is a 404 before the lock** (0.4.1-dev.1):
  Stop or Resume of an agent id that belongs to another workspace answers
  "no agent here" even while the lock is closed (it answered 423), and
  still never names the other workspace.
- **The 421 page and the signed-out page start no polls** (0.4.1-dev.2, a
  consumer's SEC-1a dogfood). Every `/api` call from them would answer the
  same refusal, so the server marks them and the shell, as for an invalid
  config, starts none of its polls and streams (health, the lock, the env
  list, themes, the changelog, the stale-server check); the status chip
  reads "Status unknown" instead of "Checking…" forever.
- **No config polls under an invalid config.** The server marks every page
  it serves while the config fails validation, and the shell also learns it
  from the first `422 config_invalid` answer. From then on it starts none of
  the polls and streams that read the config (health and its stream, edge,
  workspaces, applications, the org config, the sudo vault status, Logs'
  services, Settings' workspace settings), so the browser console no longer
  logs a "Failed to load resource … 422" line for each of them. A reload
  once the config is fixed starts them again.

### Migrations

- **Scripts that POST to `/api` with curl** need `Authorization: Bearer
  $(<cli> web token --print)` or an `Origin` (SEC-1a), and so do curl GETs
  of the routes that run something (`/api/service/exec`, `/api/run`,
  `/api/workspace/exec`, `/api/workspace/sync`, `/api/aws/login`). Other
  GETs work unchanged.
- **A Host other than `localhost`, `127.0.0.1`, `[::1]` or Den's edge
  hostname** answers 421 (SEC-1a). A server exposed with
  `DEN_BIND_HOST=0.0.0.0` goes through the edge, or sets
  `web.allow_plain_http_remote: true` in `config/local/user.yml`: then the
  machine's own addresses and host name work again, signed in (SEC-1b).
  Without either, a non-loopback bind now refuses to start, saying why.
- **SEC-1: nothing asks for a sign-in on localhost.** Pages, read-only
  calls, the shell's changes, agents and (later) the terminal work as
  before; the lock (R8) is the only prompt. A sign-in is needed only when
  the server is reached beyond loopback (below).
- **`web.session.idle` and `web.session.max` are ignored** (a session never
  expires). Remove them; until then the server logs a warning naming each,
  and starts.
- **Supported browsers for signing in**: Chromium, Firefox and Safari 16.4
  or later. A browser that sends neither `Sec-Fetch-Site` nor `Origin`
  (Safari before 16.4) can't sign in (it can still use localhost, where no
  sign-in is asked).
- **Edge-fronted or remote users** see the signed-out page once; `<cli> web
  login --origin <the edge's URL>` (the page shows the exact command) signs
  that browser in.
- **Scripts that call `/api` with curl from loopback**: GETs work
  unchanged; mutations need `Authorization: Bearer $(<cli> web token
  --print)` or an `Origin`. Through the edge every call needs the bearer.
- **The GETs that run a service's, a workspace's or a test's command**
  (`/api/service/exec`, `/api/run`, `/api/workspace/exec`,
  `/api/workspace/sync`, `/api/aws/login`) are classed `mutating`, as §4
  lists up, down and restart, not `shell-grade`: they need no sign-in on
  loopback, and keep SEC-1a's same-origin-or-bearer check.
- **Audit entries (SEC-1c).** `actor: "agent"` now means a verified agent
  token. Agent headers without one (an MCP server started with `--actor`
  but no token, a script that sets `X-Den-Agent`) record the person (or
  `user`) as the actor, with the headers under `claimed` and `unverified:
  true`. A reader that filtered on `actor: "agent"` and the headers should
  read `claimed` for those.
- **An agent's MCP server** is audited as the agent only when it inherits
  the agent's `DEN_ACTOR_TOKEN` from the session (Den starts it so); a
  hand-written MCP entry with `--actor agent:<id>` and no token is now a
  claim.
- **`sessions start --keep-env DEN_PERSON_TOKEN`** (or of a variable that
  holds a person token or a path to `web.secret`) is refused; it was
  passed with a warning.

## [0.4.0] - 2026-11-06

0.4.0-dev.2 and later are built on 0.3.0 and include all of it (below).

### Added

- **`<cli> doctor --probe`** (0.4.0-dev.3, AG spec §5a-env; a consumer's
  dogfood finding). Opt-in: it starts a short probe session through the
  real session host for a plain session and for each available runtime's
  agent env (built as `agents start` builds it, running a tiny node script
  instead of the runtime's CLI). The probe prints key names and whether
  each is credential-shaped, never values. It exits 1, one row per finding,
  when a runtime's `scrubEnv` name or a credential-shaped variable reaches
  either; without the PTY module it says unavailable, not failed. Plain
  `doctor` still never spawns anything, and adds a note to run `<cli>
  doctor --probe` when agents are configured (an `agents:` block or an
  agent record).
- **`sessions start --keep-env NAME`** (0.4.0-dev.3): one exact name per
  flag, repeatable, no globs. The session host's log names each kept
  variable and who asked, never its value, and marks a credential-shaped one
  (it is still passed). Refused for an agent (`DEN_AGENT` set); `agents
  start` has no `--keep-env`.
- **Runtime contract: `envPassthrough` and `scrubEnv`** (0.4.0-dev.3). A
  runtime names extra caller variables it needs (den-claude:
  `CLAUDE_CONFIG_DIR`) and names it owns that must never reach a session
  (exact, or a prefix ending in `*`; den-claude: `CLAUDECODE`,
  `CLAUDE_CODE_*`). Every runtime's `scrubEnv` is removed from every
  session's env last, whatever put it back. `LaunchOutput.warnings` are
  printed at start.
- **den-claude passes `--permission-mode`** (0.4.0-dev.3; a consumer's
  dogfood finding): `default` unless the persona's `permission_mode` sets
  `default`, `acceptEdits`, `plan` or `bypassPermissions` (anything else is
  an error naming the key), so `approvals: "terminal"` means prompts reach
  the terminal. `bypassPermissions` prints a one-line warning at start.
- **`GET /api/activity?address=workspace:<ws>`** (0.4.0-dev.3; a consumer's
  dogfood finding): an agent's cross-workspace call under a grant, which has
  no repo or service, is listed under the workspace it reached and the
  agent's own. Before, it showed only in the server log.
- **Agents: personas, runtimes and the agent record** (0.4.0-dev.1, AG-2a).
  `<cli> agents start -w <ws> --persona <p> [--runtime <r>] [--model <m>]
  [--id <id>]` resolves the persona and the runtime, asks the runtime for
  argv, env and files, and starts the agent as session `<dist>-<ws>:<id>`
  in the workspace's checkout dir (what `/api/workspaces` reports as its
  `resolvedDirs`), capped by `agents.max_concurrent`. `agents stop <id>`
  ends its session (TERM) and marks it stopped; `agents resume <id>`, only
  when its runtime declares resume and its session is not running, starts a
  new session in the same cwd continuing the last run. `agents personas
  [--json]` lists the personas. `agents list -w <ws>` now shows each
  agent's persona, runtime, model, state and cwd. Attach with `sessions
  attach`.
  - **The agent record**: `<stateDir>/agents/<id>.json` (0600, directory
    0700): id, persona, runtime, model, workspace, cwd, session, start and
    stop times, and the runtime's resume handle. Never the env or the argv.
    An id is unique in a distribution: the default is the persona's id, or
    `<persona>-<ws>` when another workspace has that one.
  - **Personas** are markdown files with YAML front matter; the body is the
    role prompt. The format is a Claude Code agent file read as it is
    (`name`, `description`, `model`, `tools`; `model: inherit` means none),
    with Den's own keys beside it: `id`, `role`, `runtime`, `standing`,
    `context` and `argv`. A pack is a directory of them; a pack with an
    `agents/` directory (a Claude Code plugin) is read from there. Den ships
    a default pack: planner and orchestrator (standing), fe-dev, be-dev,
    devops, reviewer and ux-designer, with short runtime-neutral prompts.
  - **Runtimes** are strategy kind `runtime` (`<cli> doctor` lists it).
    `den-claude` (default) finds `claude` on PATH and reads its version from
    the install without running it; it launches `claude --session-id <id>
    --mcp-config <file> --strict-mcp-config [--model <m>]
    --append-system-prompt <role prompt>` and resumes with `--resume <id>`.
    `generic` runs the persona's `argv` template, substituting `{model}`
    and `{mcp_config}`; it declares no resume.
  - **An agent's MCP is pinned to its workspace**: its MCP config
    (`<stateDir>/agent-files/<id>/mcp.json`, 0600) runs `<cli> mcp
    --workspace <ws> --actor agent:<id>`, plus `--grant <ws>` for each
    workspace in `agents.<id>.grants`.
- **`<cli> mcp --grant <ws>`** (0.4.0-dev.1, AG spec §5b; repeatable): a
  scoped server also serves that workspace, only when the org config's
  `agents.<id>.grants` lists it (a flag alone is refused, exit 2). A call
  naming a granted workspace is reported before it runs, and the web
  server's audit entry names both workspaces (`workspace` and
  `targetWorkspace`). `workspaces` lists the scoped workspace and its
  grants; tests run when the focused workspace is either. Logs and manifest
  checks stay on the scoped workspace's own services.

- **Sessions: terminals that outlive the web server** (0.4.0-dev.0,
  AG-3a). `<cli> sessions start --workspace <ws> --name <n> [--cwd <dir>]
  -- <argv…>` runs argv in a PTY named `<dist>-<ws>:<n>`; `sessions list
  [-w <ws>] [--json]` lists them (`-w` shows that workspace's only);
  `sessions attach <name|id>` is a raw terminal on one (output fans out to
  every attachment, scrollback replays first, SIGWINCH resizes, ctrl-]
  detaches and leaves it running); `sessions kill <name|id> [--signal
  INT|TERM|KILL]` signals its process group (TERM by default) or, once it
  has exited, removes it and its scrollback. A name is the full name,
  `<ws>:<n>`, a bare `<n>` only one session has, or the id. Usage errors
  exit 2.
  - A **session host** owns every PTY: `<cli> sessions host`, one detached
    process per distribution (its own session and process group), started
    on demand by the first client and serving `<stateDir>/sessions.sock`
    (mode 0600). Restarting the web server, or the CLI that started a
    session, leaves it running. A second host finds the first and stands
    down; a socket nobody answers on is stale and is replaced. `sessions
    host --stop` stops it (its running sessions end). The host logs to
    `<stateDir>/logs/<cli>/sessions-host.log`. Its protocol is versioned
    (newline JSON, v1).
  - **Scrollback** is a 2 MB ring per session, flushed to
    `<stateDir>/sessions/<id>.log` (0600), so after a host restart a session
    is listed as exited and attaching replays its history. A record holds
    the name, cwd, pid, times and exit code, never argv or env.
  - **`agents.max_concurrent`** (default 4) caps the sessions running at
    once; a start past it is refused, naming the key. A value that is not a
    whole number of at least 1 is an error naming the key.
- **`<cli> agents list -w <ws> [--json]`** (0.4.0-dev.0): that workspace's
  sessions as agents. Persona and runtime come from the agent record
  (0.4.0-dev.1); a session started with `sessions start` has them blank.
- **`<cli> doctor` lists the session backend** (0.4.0-dev.0): `den-pty`,
  available when the PTY module loads, else why not. It is never a doctor
  failure.

### Changed

- **A session's environment is an allowlist** (0.4.0-dev.3, AG spec
  §5a-env; a consumer's dogfood finding). Every session started an agent
  with the caller's whole environment, so an agent started from inside
  Claude Code inherited `CLAUDECODE` and `CLAUDE_CODE_*` (Claude Code then
  turned transcripts off, so resume could not work, and the agent could
  message peers as its parent), and every secret in the caller's env reached
  every agent. Now every session's env starts empty: `PATH`, `HOME`, `USER`,
  `LOGNAME`, `SHELL`, `TERM` (default `xterm-256color`), `COLORTERM`,
  `LANG`, `LC_*`, `TZ` and `TMPDIR`; then, for a plain session, the names
  given with `--keep-env`; for an agent, its runtime's `envPassthrough`, its
  launch env and `DEN_AGENT=agent:<id>`; then every runtime's `scrubEnv` is
  removed. `sessions start` names the variables it left out, never values.
  An agent's MCP server gets the distribution's location (`DEN_ROOT`,
  `<PREFIX>_ROOT`, `<PREFIX>_HOME`, when set) in its own config. The
  credential patterns test workers are scrubbed with now live in Den
  (`src/shared/secret-env.ts`), and the tests import them.
- **`agents resume` of a session that was never prompted starts fresh**
  (0.4.0-dev.3; a consumer's dogfood finding): there is no conversation to
  continue, so it starts under the same conversation id (`--session-id`, not
  `--resume`) and says "starting fresh: it was never prompted, so there is
  no conversation to resume". The session host records whether a session
  ever got input with a line end (`prompted`), never the input.
- **`agents start` and `resume` report an early exit** (0.4.0-dev.3; a
  consumer's dogfood finding): Den watches the new session for up to 3 s;
  a non-zero exit prints the code and the last lines it printed (at most
  10, escapes stripped, secret-shaped values redacted) and exits 1. Before,
  it printed "resumed agent …" and exited 0 while the agent's CLI had
  exited 1.
- **`agents list` shows agents only** (0.4.0-dev.3; a consumer's dogfood
  finding): a session without an agent record (from `sessions start`) is
  left out; `sessions list` shows it.
- **`sessions attach` prints its banner first** (0.4.0-dev.3; a consumer's
  dogfood finding): `[attached to …]`, then the scrollback replay.
- **An MCP scope refusal names the agent's grants** (0.4.0-dev.3; a
  consumer's dogfood finding): `(agent:<id>; grants: <a>, <b>)` or
  `(agent:<id>; no grants)`.
- **A PTY module is an optional dependency** (0.4.0-dev.0, Q-AG-1):
  `@lydell/node-pty` 1.1.0, exact. Its binaries are prebuilt per platform
  (macOS and Linux, x64 and arm64; Windows) in packages npm installs with
  it, with no install script and nothing downloaded. Installed with
  `--omit=optional`, or on another platform, Den runs as before and
  `sessions start` says den-pty is unavailable and why.
- **`agents list --json`** (0.4.0-dev.1): each row has `state` (running,
  exited, stopped or ended) and, for an agent with a record, `persona`,
  `runtime`, `model`, `workspace` and `cwd`; `session` is absent for a
  record whose session is gone.

### Migrations

- **Plugins with a `den` range that ends below 0.4.0** (for example
  `>=0.3.0-0 <0.4.0`) are skipped on 0.4.0, and `validate` fails them:
  widen the range (for example `<1.0.0`). A plugin with no `den` range,
  as Den's own themes, needs nothing.
- `agents:` is a new, optional block of the org config. Any key other
  than `max_concurrent` and `persona_packs` is an agent id; an invalid value
  is an error naming the key:

  ```yaml
  agents:
    max_concurrent: 4
    persona_packs: [personas] # relative to the distribution root
    planner:
      grants: [other-workspace] # widens agent planner's MCP scope
  ```

## [0.3.0] - 2026-11-06

0.3.0-dev.31 and later include all of 0.2.7 (below).

### Added

- **R26a's 422 page: "Config is invalid"** (0.3.0-dev.40). A page
  navigation with a config that fails validation gets the shell frame
  with a table of each problem (file, key path, message), the command
  that shows them in a terminal (`<cli> validate`), "Reload once fixed",
  and links to Logs and Settings, in en, ja and es. The rail stays
  usable: `/settings` and `/logs` load whatever the config holds, and so
  do the routes the shell and those pages need (`/api/settings`,
  `/api/themes`, `/api/scope`, `/api/workspaces/settings`,
  `/api/sudo-password/status`, `/api/environments` (dev.41), besides `/api/server-info`,
  `/api/server-log`, `/api/changelog` and `/api/web/restart`). Any other
  page answers 422 with this page.
  - Org config validation lists every problem, not the first: a
    ConfigError carries `issues` (`{ file, key, message }`), its message is
    one line per issue as each always read, and the 422 JSON body gains
    `issues`.
- **`up --dry-run` says what up will do about a pre-dev.37 record or a
  held port** (0.3.0-dev.40, a consumer's dev.39 nit; it said only "Would
  up"): "would adopt pid N (port P), nothing started", "would drop the
  record (nothing running), then start it", or "port P held outside the
  repo: would not start" (exit 1, as the real up). It signals nothing and
  writes no record.
- Everything in 0.2.8 (scoped MCP for agents, orgs that own their sources,
  config validation that stops every command) is in 0.3.0.
- **The UI in Japanese and Spanish** (0.3.0-dev.39, R19; R10's and R21's
  Language).
  - Catalogs for en, ja and es. en is shell.js's `MESSAGES.en`, the
    fallback; ja and es are `public/i18n/<lang>.js`, which the server
    loads before shell.js for a page in that language (with
    `<html lang>`), so the first paint is already in it. Every lookup is
    `t(key, vars)`; a `key.one` (any CLDR category) is the plural form
    `Intl.PluralRules` picks for `n`, and numbers go through
    `Intl.NumberFormat`.
  - The language is a user pref, `language:` in `config/local/user.yml`
    (absent: English), read and written by `/api/settings` (`ui_languages`
    lists the choices; anything else is a 400). The user menu has a
    Language section, each language named in itself, Settings → Appearance
    a Language row, and ⌘K a "Language: …" command; a pick reloads the
    page in it.
  - The whole shell is converted: rail, top bar and scope menus, status
    chip and drawer, ⌘K palette (its Settings rows too), Runs chip and
    dock, lock popover, user menu, What's new, the stale-server pill and
    restart overlay, the engine and network banners, the error toasts and
    the 404 and 500 pages. The pages' own content (Workspaces, Graph,
    Services, Logs, Tests, Environments, Releases, Edge and the Settings
    page's rows) is still English: they move to `t()` page by page.
  - Never translated: names (services, workspaces, repos, themes,
    languages), logs, command output, run labels, and "Copy details"
    (it is for a report, so it stays English).
  - Guards: `i18n.test.ts` fails when any catalog lacks a key en has, has
    one en doesn't, drops a placeholder, or uses a plural form its
    language doesn't; when the code looks up a key en lacks; and when a
    node-side `EN_FALLBACK` drifts from en. `i18n-shell.browser.test.ts`
    draws the shell in a pseudo-locale with every overlay open and fails
    on any word that skipped `t()`.
  - English shows exactly what it did, apart from the new Language
    controls.

- **Errors people can see and act on** (0.3.0-dev.38, R26, Ward QA
  2026-11-05: "we don't handle 500 or 404s from the den server with
  anything remotely obvious ... just text").
  - A page request that fails gets the shell frame (rail, top bar, status
    chip) around an error page (`error.html`, `error-page.js`). 404 "Page
    not found" shows the path, "Did you mean …" from the command palette's
    own matcher (`rankCommands`), links to Workspaces and Search (⌘K) and
    the list of pages; a path under `/plugins/<id>/` says which plugin it
    belongs to and that it isn't installed. 500 "Something went wrong"
    shows the method and route template (never query values), the time,
    a request id, Retry and Copy details, and no stack: the server log
    has it under the same request id (`✗ GET /route failed (req
    <id>): …`). Assets and non-browser requests keep a plain 404.
  - Every `/api/*` error is JSON, one shape:
    `{ ok: false, error, code, requestId }` (`code`: `not_found`,
    `bad_request`, `internal`, `method_not_allowed`, `engine_stale`, …). It
    holds at the response for every route, whatever the route sends, and a
    route's own fields (`runCmd`, …) are kept. Every response carries
    `X-Request-Id`; a failed request's log line carries the id.
  - `denShell.api(method, url, body?)`: the one client path for a call. It
    resolves with the data or throws a typed error (`DenApiError`: status,
    code, requestId, network); one no page catches becomes a toast with
    the message, the request id, Retry and Copy details
    (`denShell.errorToast`). The shell's own calls, the scope and focus
    menus, Services' workspace panel, the Workspaces page's add, create,
    delete, rename, auto-start, mode and open-in-editor/terminal actions,
    Releases' config save and deploy start, and the log search use it.
  - When fetches fail at the network level (the server stopped or is
    restarting), a banner says "Den's server isn't responding — retrying",
    retries with backoff (1 s doubling to 15 s, or Retry now), and clears
    itself when the server answers; meanwhile the status chip reads
    "Status unknown", never a stale green.
- **A server older than the engine on disk says so** (0.3.0-dev.38, MD-2).
  After a pin upgrades Den under a running web server, the server keeps the
  old engine in memory while serving the new pages, so their new routes
  404. The server records the engine's version and build id (a hash of its
  package.json) at startup and compares them with the engine on disk on
  page requests (cached for 3 s). On a mismatch every page leads with a
  banner, "Den was updated to <new>. This server is still running <old>.
  Restart it: `<cli> web restart` (or your service restart).", an unknown
  route answers that message (`/api`: code `engine_stale` with `loaded`
  and `onDisk`) instead of a 404, and a failed MCP tool call names both
  versions and the restart. `/api/server-info` gains `loaded` and `onDisk`
  (`{ version, buildId }`) and `engineStale`; its `version` is now the
  engine the server runs.
- **DOC-1: the README's screenshots, generated** (0.3.0-dev.40; `npm run docs:shots`,
  `scripts/doc-shots.mjs`). Runs Den on a scratch copy of
  `examples/distribution` with the `examples/demo` repos as its workspace (a
  docker shim, a random localhost port, a throwaway HOME, and a server env
  built from HOME, PATH and the DEN_* it needs, never the caller's), and
  writes to `docs/images/<version>/` (package.json's version without the
  prerelease suffix): `hero-dark.png` and `hero-light.png` (the Graph page,
  2x), `social-preview.png`, `workspaces.png`, `graph.png`,
  `status-drawer.png`, `edge.png`, `runs-dock.png`, the `make up`
  animation (`up.gif` with ffmpeg, else `up.webp` with img2webp, else
  skipped with a message) and `alt.json`, the alt text. Size budgets: hero
  400 KB a theme, the rest 200 KB, the animation 5 MB; over budget, the run
  fails. Nothing reaches the tree unless every shot passes.
  - The capture guard (`scripts/doc-shots-guard.js`): before each shot, the
    page's innerText, every title, alt, aria-label and placeholder, and SVG
    text go through the org-name gate's own matcher, now shared
    (`scripts/org-names.js`, used by `org-name-gate.mjs` too). A hit aborts
    the run naming the shot and the term, never the text around it, and
    writes no image; so does a path under the real HOME. Without
    DEN_ORG_NAMES or DEN_ORG_NAMES_FILE the script refuses (exit 2);
    `--unguarded` is for local layout work only.
  - The images stay out of the npm package: `files` has `!docs/images/`,
    and dist-smoke fails on any image in the tarball.
- **`npm run docs:links`** (`scripts/docs-links.js`) checks that every
  relative link in README.md and docs/ reaches a file and, with a
  `#fragment`, a heading.

- **`stack_namespace`: a workspace can choose its stacks' Compose
  namespace** (0.3.0-dev.36, Ward 2026-11-05). By default nothing changes:
  a stack runs as Compose project `<stack>-<workspace>` (`default`:
  `<stack>-main`), and so do its containers, volumes and networks. A
  workspace can opt out with `stack_namespace: <slug>`, which replaces that
  suffix: several workspaces can then share one namespace, and a stack
  keeps its data when its repo moves to another workspace.
  - Where: `workspaces.<ws>.stack_namespace` in
    `config/local/workspaces.yml`, or `stack_namespace` on a blueprint
    workspace (`defaults.workspaces.<n>`, next to `org`). First match wins:
    workspaces.yml, the blueprint, then the workspace's own name.
    `workspace seed` carries the blueprint's value into the workspace it
    seeds. workspaces.yml overriding a different blueprint value is a
    warning naming both, as for `org`. The value is lowercase letters,
    digits and dashes; anything else is a config error naming the key.
  - One resolver: every stack path (`stack` commands, `/api/stacks`,
    Den's in-process compose health checks, a stack service's container
    lookup, `workspace deactivate`'s running-stacks note) turns a workspace
    into its suffix through `resolveStackWorkspaces`.
  - A shared namespace means a shared instance, keyed by checkout. Two
    workspaces bringing up the same stack from the same checkout (repo
    path and branch) share one project: `stack down` (and `down <repo>`)
    from one while another active workspace in the namespace still holds
    it detaches instead of stopping it; the last one stops it
    (`stack down --force` stops it regardless). A workspace skipping the
    stack as already healthy is recorded as an owner too. The owners are
    kept in `owners.json` in the project's edge state directory, and
    re-derived on every decision (active, same namespace, still holds the
    stack), like Den's own service refcount. Bringing it up from a
    different checkout or branch is refused (`ServiceConflictError`,
    `identity_mismatch`), naming both checkouts and the namespace: Den
    never swaps the containers under another workspace.
  - Visible: `workspace list` gains a Stacks column when a workspace's
    namespace is not its default; the Workspaces page header shows a
    "stacks: <ns>" chip; `GET /api/workspaces` adds `stackNamespaces`, each
    workspace's resolved `stack_namespace`, its `source` (`workspace`,
    `blueprint` or `default`), its `default` and whether it `differs`.
  - `DEN_STACK_WORKSPACE` still wins over all of it, for that one process:
    a per-command override (it also bypasses the owner refcount), not a
    migration tool. To move a workspace's stacks onto another namespace
    for good, set `stack_namespace`.
- **The graph's edges flow when a card is selected, and stay on top**
  (0.3.0-dev.35, R22b, Ward's QA of dev.34). Selecting a card only
  thickened its edges, and the edge layer painted under the group frames,
  repo frames and cards, so an opaque frame hid an edge or an arrowhead
  that crossed it (dev.34's routed cross-group edges too). The edge layer
  now paints above the frames and cards, still taking no pointer events
  (cards under an edge stay clickable). A highlighted edge carries a
  marching-dash overlay, in its kind's colour, moving from the dependent
  to its dependency (data-f to data-t) at about one cycle a second: a
  selected card's dependencies flow out of it and its dependents flow in.
  Under reduced motion nothing moves: a highlighted edge is drawn thicker
  in the accent colour.
- **Workspaces: Local Dev is an ops page** (0.3.0-dev.35, R24a–e, Ward
  2026-11-05: "the UX is a bit of a kitchen sink"). One job: run your
  workspaces.
  - R24a: the rail item, the page title and its header read
    **Workspaces** (same icon and place). `/` and `/local-dev` still serve
    it; the palette finds it as "Local Dev" too. The nav label key is
    `n.workspaces`.
  - R24b: the "⚙ Settings" footer under the workspace list is gone; "+ new
    workspace" stays.
  - R24c: the selected workspace's header adds **Open in Graph →**
    (`/graph?ws=<name>`) and a ⋯ menu: Workspace settings
    (`/settings?ws=<name>#workspace`, the old "Settings ↗" tab), Rename,
    Delete.
  - R24d: **one repo table** replaces the Graph, Applications and Config
    tabs. Per repo: the health dot and rollup ("2/2 healthy", or the
    failing check), the branch, the mode with "use local / use managed",
    the last run's result and time (from the runs dock), Start, Stop,
    Restart, Logs (in the dock) and ⋯ (terminal, editor, auto-start,
    clone, validate, remove). A repo with several services expands to a
    sub-row each (keyboard: the ▸ button, `aria-expanded`). Problems sort
    first, then the startup order, with the fix inline: the status
    drawer's text and Start/Logs buttons, from one source
    (`topbar.js problemFix`). **Group by** None, Application (as `den
    apps`, each application's Up/Restart/Down in its row) or Org, a user
    pref (`graph.groupBy`). **Find** uses the Graph page's matcher. "+ Add
    repo" sits under the table; "Validate a manifest" folds under it. The
    empty state is unchanged. A real `<table>` with `th scope`; every
    action button is named with its repo or service.
  - R24e: on Workspaces the runs dock shows the selected workspace's runs
    (a run belongs to every workspace that has its repo; one with no repo,
    such as Sync, always shows), with an **All runs** toggle in the bar.
    `denShell.runs.scope({ ws })`, and `runs.add(…, { ws })` tags a run.
  - Not changed: the Graph page, Services, Settings and every API; no
    consumer config needs a change.

- **The Graph page** (0.3.0-dev.32, R22, Ward 2026-11-05). Develop ›
  Graph, after Local Dev, at `/graph`: the workspace graph alone, full
  width under its page header, with the same toolbar, zoom, Maximize
  (which now hides the page header too) and details panel as Local Dev's
  Graph tab. It shows the workspace Local Dev would (`?ws=`, else the
  view scope when it is one workspace, else the focus). Local Dev keeps
  the workspace list, the workspace's actions and its tabs, Graph tab
  included. Overview and Security stay out for now.
- **A page header on every page** (0.3.0-dev.32, R20). The shell draws the
  prototype's `.ph` on each page that has no header of its own: the page's
  title (`600 22px/1.2`, its one h1, which used to be visually hidden) and
  a 13px muted line with the scope, `org / workspace / env`, kept in step
  with the top bar (Local Dev and Graph name the workspace they show). Pages
  keep their content below it. `denShell.pageHeader()` gives a page the
  header's `act` (the primary action, at the end) and `tabs` (`.ptabs`,
  below it), and `setScope` / `setSub` for the line. Local Dev's workspace
  tabs are page tabs now: real tabs (`role="tab"`, `aria-selected`) at the
  prototype's sizes (8px 12px, 14px, a 2px accent rule under the selected
  one).
- **The stacks' routes on the Edge page and in `edge routes`**
  (0.3.0-dev.32, from a consumer). The routers Den writes into
  `edge/dynamic/stack-*.yml` when a stack comes up are neither Den's host
  routes nor `edge include` files, so nothing listed them. They are listed
  last, source "stack" with the file; `/api/edge` adds `stacks` and
  `stackErrors` (a file that doesn't parse is named, never fatal).

- **The runs dock** (0.3.0-dev.30, R16). One output dock for every page, at
  the foot of the content column, ported from the shell prototype: a bar
  with "Runs", the run tabs (12px mono, a dot that pulses while running,
  red when the run failed) and Show/Hide runs; open, a 170px output. The
  Runs chip (R7) shows and hides it and counts the running tabs; an empty
  dock links to the page that ran the last run. The bar carries Copy and
  Clear for the selected run, a tab closes with its × (or Delete), ←/→ move
  between tabs, and the dock's top edge drags to resize it. Pages and
  plugins use one path, `denShell.runs` (`start`, `append`, `finish`, `set`,
  `select`, `clear`, `remove`, `show`/`hide`/`toggle`, `list`, `onChange`);
  a run started there gets "✓ done in {s}s" when it finishes. Since R16a
  (below) the dock starts collapsed and open/closed is a user pref.
- **The Edge page** (0.3.0-dev.30, PL-SPEC §10). A built-in page in the
  rail's Ship group, shown once `/api/edge` reports the edge configured
  (`/api/edge?probe=1`, which asks no Docker). Read-only: the container and
  its ports, the TLS strategy (`edge.tls`: none, mkcert or files) with
  where it came from (set, mapped from the legacy keys, or implicit), CA
  trust and the CA's directory, the cert and its names, the domains, and
  every route: Den's own, then the routers in the included dynamic files
  (`edge include`), each marked by its source file.
- **Room for Local Dev's graph** (0.3.0-dev.30, R23, Ward QA 2026-11-05).
  The workspace list, the output and two toolbar rows left the graph at 40%
  Fit. The workspace list now collapses to a 40px strip (« in its header;
  » brings it back), remembered per user (`graph.workspaces`: `open` or
  `collapsed`, on the Settings page under Graph). A Maximize button in the
  graph's zoom group, or `F` with focus outside a field, hides the list,
  the workspace header, the action row and the tabs; Esc restores. Fit
  measures the whole area, so its zoom rises once maximized.
- **Included routers in `edge routes` and `/api/edge`** (0.3.0-dev.30,
  PL-SPEC §10, from a consumer review). Routers defined in the distribution's
  included dynamic files are served by Traefik but were never listed. Den
  now reads their `http.routers` (read-only) and lists them after its own
  routes with their source file; `/api/edge` adds `included`,
  `includedErrors` (a file that doesn't parse is named, never fatal) and
  `tls.from` / `tls.ca`. The rendered edge config is unchanged.

- **`<cli> relocate <repo> <path>`** (0.3.0-dev.26, from a consumer). A
  checkout moved on disk: every workspace's dev-managed entries for the repo
  (bare and `<repo>/<svc>`) now point at the new path, keeping each entry's
  other settings. Managed entries (Den's own clones) are left alone, and focus
  and the active set never change. It refuses a missing path, one whose
  manifest name or GitHub remote names a different repo, and a repo no
  workspace has. Since 0.3.0-dev.27 (from a consumer's dev.26 run) it also
  refuses a folder where nothing names the repo (an empty or unrelated
  folder): the manifest name, or the GitHub remote against the catalog's
  `gh` (or the repo name when the catalog has none), must match.
  `--force` accepts such a folder. The refusal's `--force` hint keeps
  `--dry-run` and `-w` when given (0.3.0-dev.28). `--dry-run` shows the changes without writing; `-w` limits it
  to one workspace.
- **`<cli> register <path> -w <workspace>`** (0.3.0-dev.26). `-w` writes that
  workspace, active or not, and leaves focus alone. It used to fail with
  "-w/--workspace is not valid with register". The no-TTY usage line names `-w` too
  (0.3.0-dev.27).

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
- **Secrets backends are registered strategies, and `none` is one**
  (0.3.0-dev.23). Each built-in (`none`, `env`, `doppler`, `1password`)
  registers through one registry (`src/shared/strategies/registry.ts`, kind
  `secrets`) as `{ id, kind, detect(), capabilities }`: a factory, a label,
  its CLI, which ref parts it needs, and optional `setup` and env
  injection. `detect()` is a PATH check that never prompts or prints; a
  backend whose CLI is missing reports "not available: The Doppler CLI
  (doppler) is not on PATH" instead of failing a spawn. `secrets.provider:
  none` resolves nothing and never runs a CLI. `den create` now scaffolds
  `secrets: { provider: none }`, with the choices in a comment, so a new
  distribution depends on no store. See "Secrets" in
  `docs/distributions.md`.
- **The edge's TLS is a registered strategy: `edge.tls`** (0.3.0-dev.25,
  TLS-1a). `none`, `mkcert` and `files` register through the strategy
  registry as kind `tls`, as the secrets backends do. `tls: none` serves
  http only (no https entrypoint, no cert work, mkcert never run);
  `{ strategy: mkcert }` issues the edge's wildcard cert from a local CA,
  its own or `ca:` (an existing CA, never minted or uninstalled);
  `{ strategy: files, include, mounts }` serves the certs your included
  config holds (`ca:` optional, for health checks). An unknown strategy,
  or a key a strategy does not take, is a validation error naming the
  built-ins. mkcert's `detect()` is a PATH check: with it missing,
  `validate`, `doctor`, `edge up` and `edge trust` say "mkcert is not
  installed" instead of a spawn error. `edge trust` / `untrust` exist under
  mkcert, and `edge trust` also under `files` with a `ca` (it installs that
  existing CA, as `caroot` did); elsewhere they exit 1 ("edge trust needs
  edge.tls.strategy: mkcert (or files with a ca)").
  `den create` scaffolds `edge.tls: none`, with the mkcert and files forms
  in a comment. `/api/edge` adds `tls: { strategy, implicit }`. See "The
  edge and TLS" in `docs/distributions.md`.
- **`<cli> doctor`** (0.3.0-dev.25): each strategy kind (secrets, tls),
  the strategy selected, whether it was implicit, and its `detect()` with
  the reason. Read-only: a PATH check, never a backend CLI, a prompt or a
  secret value. Exit 1 when a strategy that will be used cannot work.

### Changed

- **`down` works under an invalid config** (0.3.0-dev.40): it is
  config-free, so stopping is never stranded. With a config that fails
  validation it says so ("Stopping anyway, without the config's org
  data") and stops from the daemon records and compose projects; `down -a`
  too. Every other command still stops first.
- **Only up and restart detach by default** (0.3.0-dev.40, DOC-1). Every
  string command but down and setup ran detached, so `preflight` run from
  the Services page never finished. A command other than up and restart
  now runs to completion unless it says `detachable: true`.
- **English plurals** (0.3.0-dev.40): en has the `.one` forms (`org.n.one`
  "{n} workspace", and the status, badge, drawer and changelog counts), so
  the org menu no longer says "1 workspaces". The catalog test fails when a
  count another catalog makes singular has no en `.one`.
- **The graph's top-level groups wrap to the stage** (0.3.0-dev.34, a
  consumer's dogfood finding: 31 services in 10 org groups). Top-down,
  every org (or application) group sat in one row, so the whole graph
  fitted only at 15–24%, where cards are hard to read. Each top-level
  group is now laid out on its own by the same layered layout (a group's
  inside is unchanged), and the groups wrap into rows (top-down) or
  columns (left-right), choosing the wrap that fits the stage at the
  highest zoom; the edges between groups are routed through the gaps
  between rows. A 31-card, 10-org graph fits at 45% at 1440×900 (was
  22%) and 33% at 1024×768 (was 14%).
- **The automatic fit shows the whole graph** (0.3.0-dev.34). A graph
  that needed less than 25% used to open on its top at 60%; the first
  paint now fits it as Fit does (down to 10%).

- **The Graph page follows the top bar's workspace scope** (0.3.0-dev.33,
  a consumer's dogfood finding). With the top bar's Workspace on "All
  active", `/graph` used to show (and name) the focused workspace only. It
  now shows every active workspace in one graph, as the Services page
  lists them: one card per service, a service several workspaces define
  listed once with its owners (`demo-api · main, notes`). One workspace
  picked shows that one, and `?ws=` still wins. The page header's line
  names what is shown (`acme / All active / local`). A card's actions run
  in the workspace that owns its repo (the first in view, focus first).
  Local Dev keeps one workspace, the list's selection: its actions, its
  Applications and Config tabs and its Graph tab are per workspace.
- **Stack routes on the Edge page and in `edge routes`: scheme and
  upstream** (0.3.0-dev.33, a consumer's dogfood finding). A stack
  router's URL is shown with its scheme like Den's own rows: `https://`
  when the router has TLS or is on the `websecure` entrypoint, else
  `http://`. UPSTREAM shows the service's `loadBalancer` server URL when
  the router's file defines it, else the Traefik service's name. The
  routers in `/api/edge` (`included`, `stacks`) carry `secure` and
  `upstream`; included routers get the same.
- **Page tabs are WAI-ARIA tabs** (0.3.0-dev.33, a consumer's dogfood
  finding: ArrowRight, Home and End left focus on Graph). Local Dev's
  workspace tabs and any tabs `denShell.pageHeader().tabs(spec)` makes
  share one helper, `denShell.wireTabs(tablist, opts)`: one tab stop (the
  selected tab is `tabindex=0`, the rest `-1`), ←/→ move and wrap, Home and
  End go to the ends, and a tab is selected as focus moves to it
  (automatic activation). Each tab's `aria-controls` names its
  `role="tabpanel"`, whose `aria-labelledby` names the tab, and the other
  panels are hidden. Local Dev's "Settings ↗" link now sits beside the
  tablist rather than in it. `pageHeader().tabs` is a function now: the
  shell no longer adds a hidden, unlabelled, empty `.ptabs` tablist to
  every page, only the one a page asks for.

- **POST /api/settings: null clears a pref** (0.3.0-dev.32, from a
  consumer). A key set to `null` (`{"graph":{"workspaces":null}}`, or in
  `shell` or `appearance`) is removed from config/local/user.yml instead of
  failing with 400, and a block left empty goes too; a whole block set to
  `null` (`{"graph":null}`) removes it. `graph:` now keeps only the keys
  someone set (it used to write every default), so setting a pref and
  clearing it again leaves user.yml byte-identical.
- **Edge page: the cert-names card under tls `files`** (0.3.0-dev.32, from a
  consumer) reads "Names the included certs should cover": Den issues
  nothing there. mkcert keeps "Certificate names (planned)".

- **The pages' output panes are gone; their runs are tabs in the runs
  dock** (0.3.0-dev.30, R16). Local Dev's output panel (one tab per
  system, log tails, the dismissed tabs per workspace), Services' output
  pane, Tests' output pane and its service command strip (Stop / Detach is
  now a button in the dock's bar while the command runs), and Releases'
  deploy log (each deploy session is a tab: selecting one attaches its
  log, its × closes the session; the session chips are gone) all write to
  the dock. The output lines are the same text with the same line classes;
  k6's progress lines still update in place, Local Dev still keeps its
  last 1000 lines per tab. Auto-scroll now pauses on every page when you
  scroll up (Local Dev's rule).
- **The runs dock starts collapsed, and stays as you leave it** (0.3.0-dev.30,
  R16a, Ward QA 2026-11-05). A run starting never opens it: its tab
  appears and the Runs chip pulses, and you open it (Show runs, the chip or
  a tab). Only an action whose whole point is output opens it: Logs on a
  service (Services) and a card's output in Local Dev's graph. Open or
  closed and its height are user prefs (`shell.dock`, `shell.dockHeight`
  in `/api/settings`, the Settings page's Navigation row "Open the runs
  dock"), so they hold across pages, reloads and browsers; nothing is kept
  per browser tab any more. Dragging its top edge stops at half the window.
- **Settings: the search and the category list stay put** (0.3.0-dev.30,
  R21a, Ward QA 2026-11-05). The page header with its search box and the
  category list on the left are sticky while the rows scroll; a category
  click scrolls its section to just below the header.

- **Existing edge configs render exactly as before** (0.3.0-dev.25). The
  legacy keys map to `edge.tls` (EXT-1 rule 6): `issue_cert: false` is
  `files`, `caroot` is `mkcert` with `ca`, and an `edge:` block with
  neither is `mkcert` with the edge's own CA. A test renders each shape
  (and its explicit `edge.tls` form) and compares the Traefik dynamic and
  compose files, cert names and paths, route URLs and the mkcert call
  byte for byte with 0.3.0-dev.24's own output. Under `files` with no `ca`,
  `edge trust` now refuses (it minted a CA that signs nothing the edge
  serves); with a `ca` it installs that CA, as before.
- **No built-in secret locations** (0.3.0-dev.23). Den no longer assumes a
  vault, item, field, key or account of its own: the default 1Password
  vault, developer-keys item and sudo field, the default account domain, and
  the flat `<PREFIX>_LOCAL_ADMIN_PWD` key that doppler and env used for the
  saved sudo password are gone. The saved sudo password and the journeys
  agent key come only from `secrets.refs.sudo` and
  `secrets.refs.journeys_agent_key`; without them each says "not configured:
  set secrets.provider and secrets.refs.<name> in config/<cli>.yml" and
  runs no CLI (the interactive unlock still works). A `1password`
  distribution with no refs gets one warning in the web server's startup
  log and in `validate`. The 1Password developer-keys setup writes to
  `secrets.developer_keys: { vault, item }` (else the vault and item of
  `refs.sudo`). See Migrations.
- **`make up` / `make web` check secrets only when `secrets.required` is
  set** (0.3.0-dev.23). Otherwise the gate passes silently, whatever the
  provider, and never asks the backend. `make <cli>-setup-secrets` runs the
  selected strategy's setup; with `none`, or no provider set, it says there
  is nothing to set up and exits 0.
- **`/api/sudo-password/vault-status` is backend-neutral** (0.3.0-dev.23):
  `{ backend, label, configured, backendAvailable, reason?, hasStored }`,
  and the unlock form says "Save to <backend>". `load-from-vault` answers
  `{ ok: false, reason: "not-configured", message }` with no `refs.sudo`.
- **A local-jwt signing key that is not found names its provider**
  (0.3.0-dev.23): "... not found in env or the doppler secrets backend
  (secrets.provider)". Its resolution is unchanged.

### Deprecated

- **The implicit mkcert default (set `edge.tls`)** (0.3.0-dev.25). An
  `edge:` block with no `tls`, `caroot` or `issue_cert` still means mkcert
  with a local CA, and warns once per run (`validate`, `doctor`, `edge up`,
  `stack up`): "edge.tls is not set; defaulting to mkcert with a local CA.
  Set edge.tls explicitly." `edge.caroot` and `edge.issue_cert` still work,
  and `validate` and `doctor` name the `edge.tls` line that says the same.
- **The implicit doppler default (set `secrets.provider`)** (0.3.0-dev.23).
  An unset `secrets.provider` still means `doppler`, but only when something
  actually resolves a secret; the first time it does, Den warns once:
  "secrets.provider is not set; the implicit doppler default is deprecated
  and will be removed in a later minor. Set it explicitly: doppler,
  1password, env or none." A distribution that resolves no secret never
  runs `doppler` and never sees the warning.
- **`opAvailable` in `/api/sudo-password/vault-status`** (0.3.0-dev.23):
  an alias of `backendAvailable`, removed in a later minor. Read
  `backendAvailable` (and `backend`, `reason`).

### Fixed

- **`web up` under an invalid config reports the server ready**
  (0.3.0-dev.42, a consumer's dev.41 finding). It waited for
  `/api/health`, which answers 422 by design then, and exited 1 with
  "web did not become ready" while the server ran. Readiness now asks
  `/api/server-info` (answered under any config; `/api/health` for a
  server too old for it), and the 422 "Config is invalid" page counts as
  the shell serving.
- **No page throws under an invalid config** (0.3.0-dev.41, a consumer's
  dev.40 finding: "envs.map is not a function" on every page).
  `/api/environments` is config-free (it already fell back to `local`),
  the env picker and the Logs toolbar treat an error answer as an empty
  list, and a test loads every page with an invalid config and expects
  no uncaught error.
- **A refused `edge down` says "not stopping it"**, not "not replacing
  it"; `edge` rejects an unknown flag (a mistyped `--take-over` is never
  ignored) (0.3.0-dev.41).
- **A pre-dev.37 record whose port is held by another process** no
  longer warns "nothing running is it" before saying what holds the port
  (0.3.0-dev.41).
- **Safety: an edge another state dir owns is never replaced**
  (0.3.0-dev.40, P1). The edge's container and Compose project are named
  by `edge.org`, so a scratch root with its own `DEN_EDGE_DIR` but the real
  `edge.org` recreated the real edge with its scratch certs and routes
  (`stack up` brings the edge up first). The edge container now carries
  `den.edge.root=<realpath of its state dir>` and `den.edge.org=<org>`, and
  `edge up`, `stack up`/`restart` (their implicit edge up) and `edge down`
  touch an existing `<org>-edge` only when its `den.edge.root` is their own
  state dir. Otherwise they refuse before writing or starting anything,
  exit 1: "edge <org>-edge belongs to <its dir>; not replacing it". An
  unlabelled (pre-dev.40) edge is adopted only from the default state dir,
  never under a `DEN_EDGE_DIR` that overrides it (the refusal names its
  mounts' dir when known). Under such an override a refusal also warns:
  "Give this root a distinct edge.org." `edge up --take-over` is the only
  override, and nothing implies it. The routes (the dynamic files) are
  byte-identical. See "The edge and TLS" in docs/distributions.md.
- **A recreated edge keeps running stacks routed** (0.3.0-dev.40, P1). A
  new or restarted edge container starts on its own network only, so every
  running stack's routes answered 502 until that stack's next `stack up`.
  After `edge up` (and `stack up`/`restart`'s implicit edge up) the edge
  now rejoins the routed networks of each stack that has its routes file
  (`dynamic/stack-<project>.yml`) in this edge's state dir and whose
  Compose project is running, with one line per network ("rejoined
  <network> (<project>)"). Stacks that are down are skipped; a network the
  edge is on already is left alone; a project with no routes file in this
  state dir is never touched. `stack up` connects through the same helper.
- **`validate` reports an org config error** (0.3.0-dev.40, a consumer's
  0.2.8 nit): each problem with its file and key path, exit 1; the
  manifests are still checked.
- **The scoped `manifest_validate` refusal names the whole path**
  (0.3.0-dev.40, a consumer's 0.2.8 nit): it was cut at 80 characters,
  mid-filename. Up to 160 it is whole; a longer one keeps its start and its
  filename and elides the middle with "…".
- **A named `up <repo>/<svc>` whose port is held refuses before spawning**
  (0.3.0-dev.40, a consumer's dev.39 finding): it started the server once,
  which died on EADDRINUSE, before refusing. It now refuses as the
  repo-level up does ("<repo>/<svc> not started"), with or without a
  pre-dev.37 record. And a listener in the repo but in Den's own process
  group is said as that ("in Den's own process group; not adopted"), not
  as "outside <repoPath>".
- **Graph cards** (0.3.0-dev.40, DOC-1): a service card's red "down"
  border goes when it recovers (only repo cards toggled it); before the
  first health round cards say "checking…", as the Workspaces table does,
  not "no health check"; the details panel's Opens link follows the edge's
  TLS (`http://` and the http port for `tls: none`; it always said
  `https://`).
- **Records from before 0.3.0-dev.37 reach adoption from the CLI**
  (0.3.0-dev.39, a consumer's dev.38 finding). dev.38 decided right when
  asked, but the CLI's paths never asked. Every up, down and healthy-skip
  now reads a service's record through one accessor
  (`settledDaemonRecord`) that settles a pre-dev.37 record first: adopted
  (its group recorded) or dropped (said, nothing signalled).
  - `up <repo>` on a healthy service attached to the old record and left
    it without a group, so a later `down` could not stop it. It now adopts
    the running process ("adopted pre-dev.37 process (pid …, port …)"),
    starts nothing, and `down <repo>` stops it.
  - `down <repo>/<svc>` of a service with an up of its own pointed at the
    repo's down ("it is stopped by repox's down") and stopped nothing. Its
    down is its own: the group its up recorded.
  - A healthy service with no record whose port is held by a process in
    its repo is adopted the same way; one held from outside the repo is
    said ("port N is in use by pid … (cwd …), outside …: left alone"),
    never claimed or signalled, and nothing is started on it (a named
    target fails; a dependency warns).
  - An up whose process exits non-zero during startup (a second server
    that died on EADDRINUSE) keeps no record and no process group, so a
    later `down` never signals a dead group while the real listener runs.
  - The CLI prints what was adopted, dropped or found busy; before, those
    lines only flashed in the spinner.
  - `down -a` warns about records no active workspace reaches ("… is in no
    active workspace: down -a left it alone") and leaves them alone, where
    it skipped them silently.
- **`restart` of a service with only an `up` works** (0.3.0-dev.39, a
  consumer's dev.38 finding). `restart repox/web` failed with `command
  "restart" not found` and left the old group running. With no restart or
  down command, a restart stops the recorded group, then runs the up
  detached, as `down` then `up` would.
- **`down <repo>` and `down -a` stop a repo's per-service daemons**
  (0.3.0-dev.38, a consumer's dev.37 finding). A repo with services of
  their own (`up repox` started `repox/web` and `repox/api`, each with
  its own process group) and no down of its own printed "down repox
  (nothing to stop)" and left both running. A repo-level down with no
  down command now stops every service record of the repo through the
  per-record path (its refcount, its down command or its recorded group);
  `down -a` does it for each repo of the workspace. The mirror of
  dev.35's `up` multi-service fix.
- **Records from before 0.3.0-dev.37 are adopted or dropped, never
  trusted blindly** (0.3.0-dev.38, a consumer's dev.37 finding). A record
  with no process group made `up` print "✔ up repox/api" while nothing ran,
  and `down` give up on it. One rule now serves `up` and `down`: the
  listener on the service's known port (its `port`, the port in its
  health URL, or `--port`/`-p` in its up command) whose cwd is inside the
  repo is adopted (its process group is recorded: "adopted pre-dev.37
  process (pid N, port P)"); else a recorded pid whose group shows every
  token of the up command (leading `VAR=value` and an `npx`/`npm exec`
  prefix stripped) is adopted; else the record is stale: warned, dropped,
  nothing signalled. `up` then reports an adopted service already running
  and starts a stale one; `down` stops an adopted one through the
  TERM→KILL group path. A port held by a process outside the repo is
  named and left alone.
- **A restart records only the up** (0.3.0-dev.38). A service with a down
  and an up but no restart ran one detached `sh -c "<down> && <up>"`, so
  its recorded process group held the down too. It is now the down step,
  then a detached up step, and the group is the up's.

- **Graph: a selected card's flowing edges are visible** (0.3.0-dev.37,
  Ward QA of dev.35). The marching dashes were drawn in the same colour on
  a full-strength line, so they barely showed. A lit edge's line is now a
  faint track in its kind's colour and the dashes run wider on top of it;
  under reduced motion the lit edge stays solid and thicker, as before.
- **Test workers inherit no credentials** (0.3.0-dev.37). `tests/setup.ts`
  strips credential-shaped variables (by name, family or token shape) from
  the environment before any suite runs, so a failing assertion on a
  spawn env can no longer print a developer's tokens.
- **`down` stops what a detached `up` started** (0.3.0-dev.37, a
  consumer's dogfood finding). `<cli> down <repo>` for a service with no
  down command and no container printed ✔ and stopped nothing: daemon
  records kept no process. A detached `up` now records its process group
  (`pgid`, and the leader's start time as `pgidStartedAt`) in the daemon
  record, and `down` sends the group SIGTERM, waits up to 3s
  (`DEN_DOWN_GRACE_MS`), then SIGKILL. Before each signal it checks the
  pid still belongs to the recorded process (same start time), so a
  reused pid is never signalled: that service had already exited, and
  `down` says so and leaves the process alone. After a declared down
  succeeds, a recorded group still running is stopped too. When `down`
  cannot stop what it knows is running (a record written before dev.37,
  with no group; a group that survives SIGKILL), it warns, and an explicit
  `down <repo>` exits non-zero (a workspace-wide `down` warns and goes
  on). With nothing recorded, the CLI says "nothing to stop" instead of ✔.
  `down --dry-run` lists a service with a recorded group as one it stops.
- **A compose-stack repo's Start and Restart work on the Workspaces page**
  (0.3.0-dev.37, a consumer's dev.35 finding). The repo row's buttons
  were disabled, "has no up command", for a repo whose up is its compose
  stack's. `/api/services` now gives each local service its effective
  commands (a stack's synthesized up/down/restart included) and
  `upTargets`: what `<cli> up <repo>` starts (`resolveUpTargets`), as the
  table's addresses. The repo row's Start and Restart are enabled when it
  is non-empty and run exactly those addresses.
- **The Workspaces table says "checking…" until the first health round
  lands** (0.3.0-dev.37). Before it, repo and service health cells read
  "unknown (not checked)" or "no health check".
- **Find shows only the sub-rows it matches** (0.3.0-dev.37). A Find that
  matched one service of a repo opened every one of the repo's sub-rows;
  now only the matching ones show under their repo (a match on the repo
  itself still shows them all).

- **`<cli> up <repo>` no longer fails fast on a multi-service dependency**
  (0.3.0-dev.35; backported to 0.2.8). A dependency with no `up` of its
  own but with per-service ups (two services, each with its `up`) was run
  as the repo, `command "up" not found for service "<repo>"`, and the run
  aborted before the repo you asked for. `up <repo>` and `up -a` now make
  one decision (`resolveUpTargets`): a repo with its own `up` starts as
  before; one with none but per-service ups starts its services (all of
  them, or the ones its dependents name in `depends_on`); only one with
  no `up` at all is skipped, said as `-a` says it ("Skipping (no local up
  command): …"), and nothing waits on it. A dependency whose `up` fails
  still fails fast.

- **The graph fits on first paint** (0.3.0-dev.34, a consumer's dogfood
  finding). With "All active", `/graph` opened at 60% with 17 of 31 cards
  outside the stage at 1440×900 (23 at 1024×768) until Fit was clicked:
  the org frames land after the first draw, the graph was drawn again,
  and only the first draw was fitted (a render a newer one overtook could
  also fit the stale layout). The view now fits once the final layout is
  drawn, and again whenever the set of cards changes, unless you zoomed
  or panned since. Local Dev's per-workspace graph likewise.
- **The Workspace picker on `/graph` replaces `?ws=`** (0.3.0-dev.34, a
  consumer's dogfood finding). On `/graph?ws=w2`, "All active" changed the
  pill but the URL kept `?ws=w2`, which wins, so the header and the graph
  stayed on w2, after a reload too. A choice there now drops `?ws=` (All
  active) or sets it (a workspace), replacing the history entry, and the
  pill shows the workspace a fresh `?ws=` names: the pill, URL, the
  header's line and the graph agree.
- **The runs dock is a tablist only while it holds tabs** (0.3.0-dev.34).
  With no runs, `.den-runs-l` was a `role=tablist` holding a "No runs"
  span and no tab; the role and its label come back with the first run.
- **`theme-switch-isolation` is deterministic under load** (0.3.0-dev.34;
  it failed 5/6 then 1/6 on a busy machine). Its file snapshot covered the
  throwaway HOME, where a container runner's CLI that the health check
  calls writes its own update hint on its own schedule; it now covers
  Den's files (the distribution and `DEN_HOME`). The server gets a port
  from the OS on localhost (not a random pick that could land on another
  session's server), and readiness waits for the server whose
  `/api/server-info` names this distribution's root.

- **Stale daemon records are dropped** (0.3.0-dev.33, a consumer's
  dogfood finding). A record whose repo had been relocated (no pid,
  `containers: []`) was kept forever because its address still resolved,
  and the Runs dock showed a permanent tab. The startup sweep and the
  health reaper now drop a record of this root's, or an unstamped one,
  whose `repoPath` is not on disk, or whose `repoPath` is no longer where
  the service resolves and none of its candidate containers (captured,
  or the dev-op's at its old path) is running; the relocated checkout's
  own container, which carries the repo's name, does not count.
  Another root's records are never touched, and a record that resolves
  to its own checkout with nothing to verify is still kept (it may be a
  live non-opctl process). Removals are logged with the sweep's and the
  reaper's lines.
- **Graph group boxes fit their content** (0.3.0-dev.33, a consumer's
  dogfood finding). On `/graph` a repo box with one row of cards drew
  about twice the height it needs: top-down, ELK reads a compound node's
  minimum size in its own layout axes, so the repo box's minimum width
  (386px) became its height. The minimum is passed in that order now; the
  boxes are their padding plus their cards, and keep the header's width.
- **Fit keeps the graph above the legend and the zoom group**
  (0.3.0-dev.33, a consumer's dogfood finding). After Fit, a legend on
  two lines covered the last group's bottom ~10px. Fit's height now leaves
  out the overlays' measured height (and a gap), so no card or group
  border sits under them.

- **CA trust on a fronted edge reads "not needed: fronted"** (0.3.0-dev.32,
  from a consumer). With `edge.publish: false` a proxy in front owns
  browser trust (BOOT-1), so the Edge page's CA trust tile is neutral
  instead of a red "not trusted", and `edge status` says the same.
- **Fit follows the graph's size on maximize and restore** (0.3.0-dev.32,
  R23, from a consumer). Fit stopped at 35%, so a big graph at 1440×900 read
  35% maximized or not, and didn't fit either way. Fit now fits the whole
  graph, by width and height, down to 10% (zooming out goes as far as
  that), and a fitted view refits when the graph is maximized or restored.

- **A seed without a terminal no longer resets a workspace that has
  entries** (SEED-0, 0.3.0-dev.29; also 0.2.7). `<cli> init` and
  `<cli> workspace seed` from a script or `make` replaced every entry of the
  default (or blueprint) workspaces with managed clones, dev-managed
  checkouts included, without asking. Without a TTY they now refuse (exit 1,
  nothing written) and name `--reset`; on a TTY they still ask, default No.
  `init --reset` and `workspace seed --reset` reset as before. A script that
  relied on the silent reset must pass `--reset`.
- **`<cli> init` in the distribution root seeds through a symlinked path**
  (0.3.0-dev.29): it compared paths without resolving links and ran the
  manifest scaffolder instead.

- **`create`'s "Next:" hint names an absolute path** (0.3.0-dev.26) when the
  new directory is not under the cwd, instead of `cd ../../../..`.

- **A fresh distribution runs no gh for a placeholder org** (0.3.0-dev.25,
  from a consumer's dev.24 run): `den create` wrote `github_org:
  your-github-org`, and Local Dev then ran `gh repo list your-github-org`
  on every load. The scaffold now leaves `github_org` commented out, with
  an example. With `github_org` unset or still a placeholder
  (`your-github-org`, `your-org`, `<your-org>`, `example-org`) GitHub is
  "not configured": `/api/github/repos` is empty and runs no gh (no
  fallback to catalog owners or a git remote), and `register`'s GitHub
  list ignores a placeholder.
- **The lock's not-configured note names your config file** (0.3.0-dev.25):
  with no `secrets.refs.sudo`, the admin-password popover says "Saving the
  password is off: set secrets.provider and secrets.refs.sudo in
  config/acme.yml.", the distribution's real file, from the new
  `configFile` field of `/api/sudo-password/vault-status`.
- **`register` with no terminal exits cleanly** (0.3.0-dev.25): with stdin
  closed or piped, the interactive `register` crashed with
  ERR_USE_AFTER_CLOSE. It now exits 2 (a usage error, since 0.2.8's
  check; it exited 1 before): "register needs a terminal (stdin is not a
  TTY)", naming the non-interactive form, `register <path> [--name
  <repo>] [--gh <owner/repo>]`.
- **`bin/den` sets no backend account** (0.3.0-dev.24, from a consumer's
  dev.23 run): the launcher exported `OP_ACCOUNT` with a placeholder
  domain for every command, whatever the secrets backend, so it reached
  the web server even under doppler. It now adds nothing; the 1password
  strategy sets it from `secrets.onepassword.account`, or the caller's own
  is kept.
- **`backendAvailable` is true for a usable backend even with no sudo ref**
  (0.3.0-dev.24): dev.23 reported false whenever `secrets.refs.sudo` was
  unset, so the deprecated `opAvailable` alias changed meaning. With no
  ref it now reflects detect() (a PATH check, nothing spawned) for an
  explicitly chosen backend; `configured: false` says the ref is missing.
  An unset provider and `none` still report false and are never probed.
- **Raster marks are scaled to fit, never cropped** (0.3.0-dev.23).
- **Den adds no 1Password account to anything it starts** (0.3.0-dev.23).
  The web server daemon (`web up`, `web restart`) was always given
  `OP_ACCOUNT`, with a built-in domain when unset, and `den.mk` exported
  one to every recipe. Now only the `1password` strategy gives one, from
  `secrets.onepassword.account` or your own `OP_ACCOUNT`; no other backend
  gives any, and `den.mk` sets none.
- **1Password make targets exist only when 1Password is selected**
  (0.3.0-dev.23). `make <cli>-setup-1password` and `make auth-configure`
  moved to `make/secrets-1password.mk`, which `den.mk` includes only when
  `secrets.provider` (or `<PREFIX>_SECRETS_PROVIDER`) is `1password`; every
  other distribution no longer has them.
- **"Register a managed repo" never lists the engine's owner's repos**
  (0.3.0-dev.23). With no `github_org`, the org fell back to the git remote
  of the engine's own checkout, so a linked or git-installed engine listed
  its owner's repos for an unrelated project. The fallback is now the
  distribution's own checkout (only when it is the top of its own repo),
  else the "set github_org" error. The 1Password setup scripts likewise
  read `developer_keys.env_file` and write `admin-auth-<env>.json` under the
  distribution root, not the engine's.
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

- 0.3.0-dev.40, the edge's owner labels: plan one `edge up`. The edge's
  compose.yml gains `den.edge.root` and `den.edge.org` labels, so the first
  `edge up` (or `stack up`) after upgrading recreates the edge once, from
  its own state dir. Routes drop only while the container restarts, then
  stay up: the edge rejoins running stacks' networks. Run it once, from
  the edge's own dir, when a brief blip is acceptable. A scratch or test root that sets `DEN_EDGE_DIR` needs an
  `edge.org` of its own; with the real one it is refused.
- 0.3.0-dev.40, commands that detach: a command other than up and restart
  that should keep running detached says `detachable: true`.
- 0.3.0-dev.39, the UI language: nothing required. With no `language:`
  in `user.yml` the UI is English, as before. A distribution or plugin
  that adds its own words with `denShell.addMessages(lang, table)` can
  add `ja` and `es` tables the same way.
- 0.3.0-dev.39, pre-dev.37 records: nothing required. Their next `up`,
  `down` or `restart` from the CLI or the web adopts or drops them (said).
- 0.3.0-dev.38, the restart banner: **restart the web server once after
  installing.** The first upgrade from a server older than dev.38 can't
  show the "Den was updated" banner: the old server has no MD-2 code, so
  it keeps serving the new pages from the old engine until it restarts
  (`<cli> web restart`, or your service restart). From dev.38 on, the
  banner says when a restart is needed.
- 0.3.0-dev.38, `/api` error bodies: **they changed from text to JSON.**
  Every `/api/*` error now answers `Content-Type: application/json` with
  `{ ok: false, error, code, requestId }`, where some routes sent
  `text/plain` (a message, or an empty body). A script that read the text
  should read `.error`; a status check needs nothing. Den's own pages and
  the MCP server read the new shape.
- 0.3.0-dev.38, records from before dev.37: nothing required. A service
  still running from such a record is adopted on its next `up` or `down`
  (by its port, else its pid); one that can't be matched is dropped with a
  warning and never signalled.
- 0.3.0-dev.37, `down` and process groups: nothing required. A service
  started by an older Den has no recorded group, so its first `down
  <repo>` after the upgrade (for a service with no down command and no
  container) warns, drops that record and exits non-zero: stop it
  yourself once; its next `up` records the group.
- 0.3.0-dev.36, `stack_namespace`: optional, no change required. Without it
  every Compose project, container, volume and network keeps its name.
  `stack_namespace` in a blueprint needs Den 0.3.0-dev.36 or later: an
  older Den rejects the unknown key.
- 0.3.0-dev.25, edge TLS. Nothing is required: every existing edge config
  renders as before (only `edge trust` under `issue_cert: false` with no
  `caroot` now refuses). To silence the warnings, say what your config already means,
  in the org config (`config/<cli>.yml`):
  - **No `tls`, `caroot` or `issue_cert`** (the implicit default):

    ```yaml
    edge:
      tls: { strategy: mkcert }
    ```

    Or, if the edge needs no https, `tls: none`.
  - **`caroot: <ca>`**: replace it with

    ```yaml
    edge:
      tls: { strategy: mkcert, ca: <ca> }
    ```

  - **`issue_cert: false`** (with `include` and `mounts`): replace it with

    ```yaml
    edge:
      tls:
        strategy: files
        include: edge/dynamic # was edge.include
        mounts: { <host path>: <container path> } # was edge.mounts
    ```

    `include` and `mounts` may also stay where they were. With `caroot`
    too, move it to `ca: <ca>` under `tls`.
  - `edge.tls` beside `caroot` or `issue_cert` is an error: move them.
  - `github_org: your-github-org` from an earlier `den create`: set your
    real org, or delete the line.
- 0.3.0-dev.23, secrets. Nothing is required of a distribution that uses
  no secrets; the YAML below goes in the org config (`config/<cli>.yml`).
  - **Relied on the old 1Password defaults** (the saved sudo password or
    the journeys key in the developer-keys item): add the old layout as
    your own refs. These are the exact former defaults; `<PREFIX>` is your
    env prefix (`ACME` for `acme`, `DEN` for Den's own checkout).

    ```yaml
    secrets:
      provider: 1password
      onepassword:
        account: example.1password.com # your account; Den injects none now
      refs:
        sudo:
          { vault: Employee, item: Developer API Keys, field: <PREFIX>_LOCAL_ADMIN_PWD }
        journeys_agent_key:
          { vault: Employee, item: Developer API Keys, field: CURSOR_API_KEY }
      developer_keys: { vault: Employee, item: Developer API Keys }
    ```
  - **Relied on doppler or env for the saved sudo password** (the flat
    `<PREFIX>_LOCAL_ADMIN_PWD` key):

    ```yaml
    secrets:
      provider: doppler # or env
      refs:
        sudo: { key: <PREFIX>_LOCAL_ADMIN_PWD }
    ```

  - **Relied on the implicit doppler default**: it still works. To silence
    the deprecation warning, say so: `secrets: { provider: doppler }`. A
    distribution that uses no secrets store can set `secrets: { provider:
    none }`.
  - A page or script that read `opAvailable` from
    `/api/sudo-password/vault-status` reads `backendAvailable`.
  - A `make auth-configure` or `make <cli>-setup-1password` in your own
    scripts needs `secrets.provider: 1password`.
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
## [0.2.8] - 2026-11-05

### Added

- **A scoped MCP server for cooperating agents** (0.2.8-dev.0, AG-2a-core).
  `<cli> mcp --workspace <ws> --actor agent:<id>` pins one workspace: a tool
  that takes a workspace gets `<ws>`, and a call naming another is refused
  before it reaches the web server and recorded in the activity trail.
  Lists are filtered to `<ws>`: `workspaces` shows it alone, the log tools
  and `manifest_validate` take only its services and repos, `workspace_sync`
  syncs it, and the test tools need it to be the focused workspace. Every
  web API call is stamped with the actor (`x-den-mcp-agent`,
  `x-den-mcp-workspace`), so each exec, run and sync in the activity trail
  and the server log names `agent:<id>` and its workspace. Both flags or
  neither; a bad value is a usage error (exit 2). `--list` and `--call` take
  them too. Without them the server is unchanged. **Limit:** it binds
  cooperating agents only. The scope lives in the MCP process, and the web
  server's HTTP API does not check it yet (WS-3a, 0.4); `mcp connect` still
  registers the unscoped server.
- **`<cli> setup --plan -w <ws>` and `--all-active`** (0.2.8-dev.0). `-w` is
  repeatable and plans those workspaces, active or not; `--all-active` plans
  every active one; on a fresh machine `-w` narrows the blueprint's plan. A
  closing hint names the repos only workspaces outside the plan hold. `-w`
  and `--all-active` go with `--plan` only.
- **Orgs are Den's own; sources are bindings** (0.2.8-dev.1, ORG-1d). An
  org is any key of `orgs:`. `orgs.<id>.sources: [{host, owner|group}]`
  claims git-host owners for it (an org can span two GitHub owners), and
  `orgs.<id>.repos: [...]` lists repos outright (one owner can be split
  across orgs). Catalog entries take `remote: <git url>` for any host;
  `gh: owner/repo` stays the GitHub shorthand. A repo's org is the org
  listing it, else the one whose source claims its owner, else its GitHub
  owner; inference, `/api/orgs` and `org list` use it, and a claimed owner
  is not listed as its own org. A repo clones from its source (GitHub with
  `gh` as credential helper), or with no source from its `remote:` through
  plain git and the user's own credential helper (SEC-0); `setup --plan`
  shows that URL. Discovery (`register`) and the Release page skip an org
  with no GitHub source. A bad value names its key; a repo or owner claimed
  by two orgs is an error naming both. See docs/distributions.md, Orgs.
- **`<cli> register <path> -w <ws>`** (0.2.8-dev.0) writes that workspace,
  active or not, and leaves focus alone. It used to fail with "-w/--workspace
  is not valid with register".

### Changed

- **`setup --plan` and `up --plan` show a dev-managed repo's real branch**
  (0.2.8-dev.0): the one its checkout has out (read from `.git/HEAD`, no git
  process), or `(branch unknown)`, where they printed `main` for every
  checkout.
- **`up --plan` exits 1 when nothing resolves** (0.2.8-dev.0): a name no
  workspace has, or a workspace with nothing to start. It exited 0.
- **`register` with no terminal exits 2** (0.2.8-dev.0) with one usage line
  that names `-w`: `register needs a terminal (stdin is not a TTY); without
  one: <cli> register <path> [--name <repo>] [--gh <owner/repo>] [-w
  <workspace>]`. It went on to prompt with nothing to answer.

### Fixed

- **A config that fails validation stops every command** (0.2.8-dev.2).
  A repo or owner claimed by two orgs (or any other bad ORG-1d value) is
  checked before any command that touches orgs, the catalog, clones or
  releases runs, and it exits 1 naming both keys. `sync` over existing
  clones exited 0 and pulled, because it reads only workspaces.yml and the
  catalog; `register <path> -w <ws>` wrote workspaces.yml and the catalog,
  `workspace create` wrote workspaces.yml, and `workspace use` /
  `add-service` exited 0. Now each stops before any git call or write. `web`, `mcp`, `validate`, `create`,
  `config`, `local-dev` and `view-results` still run.
- **The web API answers a config that fails validation as JSON**
  (0.2.8-dev.2). Every API route that reads the config answers 422
  `{ ok: false, error: "<the message naming the keys>", code:
  "config_invalid" }`, where `/api/orgs`, `/api/services` and others
  answered a text/plain 500 "internal server error" and some routes turned
  it into a 400 or an empty list. The error names config keys, never
  values. `/api/server-info`, `/api/server-log`, `/api/changelog` and
  `/api/web/restart` still answer, and pages still load.
- **A scoped MCP `manifest_validate` refused on another workspace's path
  shows in that repo's activity** (0.2.8-dev.2). The refusal is recorded
  under the catalog repo whose checkout holds the path (in any workspace),
  as `logs_tail` refusals are since 0.2.8-dev.1. The entry is addressed by
  the repo, not the path; its detail is the refusal message, which quotes
  the path.
- **A scoped MCP refusal of a non-lifecycle tool shows on its service**
  (0.2.8-dev.1). A refused `logs_tail`, `logs_search` or other non-lifecycle tool
  was stored with an empty detail and no service, so the service panel's
  activity (`GET /api/activity?address=<repo>/<svc>`) never showed it. The
  entry's detail is now the refusal, and it carries `addresses`: the repo
  or `repo/service` the call named, or every target of a `logs_search`
  (one entry, listed under each).
- **`up --plan -w <ws>` with nothing to start is a usage error**
  (0.2.8-dev.1): one line, exit 2, naming `up -a -w <ws>` (the whole
  workspace) and `up <repo> -w <ws>`. It printed "No services specified and
  no invocation target resolvable".
- **Test workers inherit no credentials** (0.2.8-dev.0). `tests/setup.ts`
  strips credential-shaped variables (by name, family or token shape) from
  the environment before any suite runs, so a failing assertion on a
  spawn env can no longer print a developer's tokens.

### Migrations

- None. A script that ran `up --plan` and ignored its exit code may now see
  1 when the plan is empty (2 for `up --plan -w <ws>` with no repo or
  `-a`).
- ORG-1d (`orgs.<id>.sources`, `orgs.<id>.repos`, catalog `remote:`) is
  optional: no change is needed, and a config without those keys behaves
  exactly as on 0.2.7. A den.yml that uses them needs Den 0.2.8 or later.
- A client of the web API that reads a config error should check for
  status 422 and `code: "config_invalid"` (0.2.8-dev.2); it was a
  text/plain 500.

## [0.2.7] - 2026-11-05

### Added

- **A workspace belongs to an org** (0.2.7-dev.2, ORG-1a). Its org is
  `org:` on the workspace in workspaces.yml, else `org:` on the blueprint
  workspace (`defaults.workspaces.<n>.org`, the one new blueprint key), else
  the one catalog owner of its repos (case-insensitive; `gh: ""` ignored),
  else `github_org`, the default org. It is computed on read, never written
  to workspaces.yml. A config with no `org:` resolves to `github_org` as
  before, unless all of a workspace's repos have one other owner in the
  catalog.
- **`<cli> org list`** (0.2.7-dev.2, ORG-1a): each org's label, its
  workspaces on this machine, which is the default, and the org warnings.
  `<cli> workspace list` gains an Org column; `--org <id>` filters it.
- **Org warnings, never errors** (0.2.7-dev.2, ORG-1a, C1): a workspace
  whose repos span several owners, an `org:` naming an owner Den does not
  know, a repo in another owner than its workspace's org, a workspaces.yml
  `org:` that overrides the blueprint's. Shown by `org list` and
  `workspace list`.
- **`<cli> setup --plan`** (0.2.7-dev.2, ORG-1a): each repo's org and clone
  URL, and whether it is cloned, then stop. On a fresh machine it plans the
  blueprint's workspaces; once seeded, the focused workspace. `<cli> up
  --plan` prints the same lines for its repos. Nothing is cloned, seeded or
  written.
- **`GET /api/orgs` entries gain `default` and `workspaces`**, and
  `/api/<cli>/config` gains `default_org` (0.2.7-dev.2, ORG-1a). Every
  existing field, entry and order is unchanged; `?repos=1` still maps each
  repo to its owner string.
- **`<cli> register --org <id>`** (0.2.7-dev.2, ORG-1a) lists another org's
  repos for a managed clone.

- **Bare `<cli> validate` checks every manifest** (0.2.7-dev.1, from a
  consumer). In the distribution root, with no argument: each workspace repo
  once per checkout (own or held, plus any override, then the merge), the
  held manifest when there is no checkout, and held manifests no workspace
  uses. One line per repo, details on failure, exit 1 if any fails, nothing
  cloned. `--held` checks `manifests/` alone, independent of the machine. A
  path argument works as before.

### Changed

- **A repo is released from its own org** (0.2.7-dev.2, REL-1). With no
  `release.org`, a repo with no `gh:` in `release.repos` released from
  `github_org`, so a client org's repo targeted the wrong owner. Its owner
  is now an explicit `release.org` (unchanged: it still wins for every
  repo), else the repo's non-empty catalog owner, else `github_org`.
- **`register` lists the focused workspace's org** (0.2.7-dev.2, ORG-1a),
  not `github_org` alone, and no longer falls back to the owner of Den's own
  git remote (SEC-0): with no org it says how to set one.

### Fixed

- **A second root's server leaves the first root's services alone**
  (0.2.7-dev.3, dev.4). Every root of a product shares one daemons file.
  A server's two startup sweeps (the stale-daemon prune and the health
  reaper) dropped any record whose address did not resolve in its own
  workspaces, so starting a scratch root's server silently forgot another
  root's running dev server; an interactive Ctrl-C stopped every service in
  the file, and deactivating a workspace released any record with the same
  workspace name. Records are now stamped with the root that started them
  and a server lists, stops, releases and sweeps only its own (other roots'
  records stay in the file untouched). An older unstamped record is never
  dropped just for not resolving; it still goes when its containers are
  verifiably gone or two health checks fail. The reaper now logs what it
  removes.
- **A service the edge has no route for is no longer healthy** (0.2.7-dev.2).
  A health URL served through the edge answered the edge's own
  `404 page not found` when the service had no route, and Den counted any
  404 as up. That exact 404 is now down with "no route (edge 404)", over
  HTTP and HTTPS; a 404 from the service itself is still up.
- **A client workspace no longer clones from the default org** (0.2.7-dev.2,
  ORG-1a). Seeding, `up` and the web sync gave a repo with no clone URL
  `<github_org>/<repo>`; it is now `<org>/<repo>` with its workspace's org.
- **`<cli> setup` clones a catalog entry with `gh: ""`** from its
  workspace's org (0.2.7-dev.2), as `up` does, instead of failing on an
  empty slug.
- **A seed without a terminal no longer resets a workspace that has
  entries** (SEED-0). `<cli> init` and `<cli> workspace seed` from a script
  or `make` replaced every entry of the default (or blueprint) workspaces with
  managed clones, your own dev-managed checkouts included, without asking.
  Without a TTY they now refuse (exit 1, nothing written) and name
  `--reset`; on a TTY they still ask, default No. `init --reset` and
  `workspace seed --reset` reset as before.
- **A failed seed leaves the workspaces as they were** (0.2.7-dev.1, from a
  consumer). Seeding wrote workspaces.yml, then filled the catalog, which
  fails with no `github_org`: the workspace was reset and nothing could be
  cloned. The catalog comes first now, and the org is needed only for a repo
  with no clone URL in the catalog.
- **A seed refusal names the command that was run** (`init --reset` or
  `workspace seed --reset`).
- **A `DEN_ROOT` with no den.yml is a one-line error** (exit 2), not a stack
  trace from deep in module loading.
- **Piped output carries no ANSI from tables** (`status`, `services`, test
  results). cli-table3 coloured borders and head cells itself, ignoring
  NO_COLOR and a pipe.
- **`<cli> mcp --call` validates its arguments** against the tool's schema,
  strictly: an unknown or misspelt key, or a bad value, exits 2 with the
  problem and the keys the tool takes, and calls nothing.
- **The web UI service survives a removed nvm version.** Install prefers a
  stable node of the same major version over a version manager's (or uses
  `DEN_SERVICE_NODE`), and warns when it must keep one. `service status`
  exits 1, naming it, when the installed node no longer exists.

- **`<cli> init` in the distribution root seeds even through a symlinked
  path** (`/var` → `/private/var`, a symlinked home). It compared paths
  without resolving links and ran the manifest scaffolder instead.

### Migrations

- A script that relied on a non-interactive seed resetting a changed
  workspace must pass `--reset`.
- Optional (ORG-1a): to put a blueprint workspace in an org other than the
  one its catalog owners give, add `org: <id>` to it under
  `defaults.workspaces`. Pin Den 0.2.7 or later first: an older Den rejects
  the key. Nothing else needs changing.

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
