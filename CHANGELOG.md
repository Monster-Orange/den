# Changelog

All notable changes to Den are documented here. Each release lists the
config and manifest changes a distribution must make to move to it under
**Migrations**.

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
