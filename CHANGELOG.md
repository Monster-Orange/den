# Changelog

All notable changes to Den are documented here. Each release lists the
config and manifest changes a distribution must make to move to it under
**Migrations**.

## [0.1.0] - unreleased

The first Den release: one engine for local development, tests and releases
across an organisation's repos, shipped as `@monster-orange/den` and used
through thin distributions that pin an exact version.

### Added

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

### Migrations

From the engine this release was generalised from:

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
