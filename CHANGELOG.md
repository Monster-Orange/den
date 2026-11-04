# Changelog

All notable changes to Den are documented here. Each release lists the
config and manifest changes a distribution must make to move to it under
**Migrations**.

## [0.2.1] - unreleased

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

- **Refused attempts are in the activity trail.** `/api/activity` entries may
  carry `outcome: "refused"` and a `reason`: a refused or unresolvable
  `/api/service/exec`, and any MCP action a guard refused before it reached
  the web server. Agents report the latter to `POST /api/activity` (agent
  audit header required; it appends one sanitised entry and nothing else).
  The panel's Activity tab shows them as refused.
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
