# Changelog

All notable changes to Den are documented here. Each release lists the
config and manifest changes a distribution must make to move to it under
**Migrations**.

## [0.2.0] - unreleased

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
- **One secret redactor** (`src/shared/redact.ts`), shared by the journeys and
  security pillars and the MCP server.

### Changed

- **`/api/health` rows: `url` is only ever a URL.** A shell health check's
  command (a compose stack's `<cli> stack health …`, or any declared shell
  check) is now in a new `check` field and `url` is null; the UI shows the
  same tooltips as before. Clients that read the command from `url` should
  read `check`.
- `/api/server-info` returns Den's `version`.

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
