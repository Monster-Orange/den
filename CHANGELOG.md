# Changelog

All notable changes to Den are documented here. Each release lists the
config and manifest changes a distribution must make to move to it under
**Migrations**.

## [0.1.0] - unreleased

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
- Make targets are `den-*` in Den's own Makefile; a distribution keeps its
  own target names in its Makefile.
- `service_env` has no built-in entries: a shared-infra secrets file is
  configured as `service_env: { <KEY>: "{repo:<infra repo>}/<path>" }`.
- The smoke and browser make targets have no default repo: pass `repo=<repo>`.
