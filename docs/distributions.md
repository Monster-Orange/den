# Distributions

Den is one engine, `@monster-orange/den`. You run it through a small repo of
your own, a **distribution**, that installs Den as a package and holds
everything that makes it yours: its name, brand, config, manifests and tests.
Den's own checkout is itself a distribution, named `den`.

- [Create one](#create-one)
- [Layout](#layout)
- [den.yml: the product profile](#denyml-the-product-profile)
- [Brand](#brand)
- [The bin shim](#the-bin-shim)
- [make: den.mk](#make-denmk)
- [Two roots](#two-roots)
- [Pinning and upgrading](#pinning-and-upgrading)
- [Developing Den against a distribution](#developing-den-against-a-distribution)

## Create one

```sh
npx @monster-orange/den create acme          # writes ./acme
npx @monster-orange/den create acme ~/src/acme-dev --title "Acme Dev"
```

From a Den checkout, `./bin/den create acme ../acme` does the same.

| Option                  | Default             | What                                  |
| ----------------------- | ------------------- | ------------------------------------- |
| `<name>`                | (required)          | Product name: `[a-z][a-z0-9-]*`       |
| `[dir]`                 | `./<name>`          | A new or empty directory              |
| `--title <title>`       | `<Name>` Title Case | Brand name shown to people            |
| `--cli <cli>`           | `<name>`            | The command people type               |
| `--env-prefix <PREFIX>` | `<NAME>`            | Env-var prefix (`ACME` → `ACME_HOME`) |

`create` refuses a directory that is not empty and never overwrites a file.
[`examples/distribution/`](../examples/distribution) is exactly the output of
`den create acme`; a unit test regenerates it, so the two never drift
(`npm run example:regen` after changing the scaffolder).

Then:

```sh
cd acme
npm install
./bin/acme --help
./bin/acme web          # the web UI, branded "Acme"
make help
```

## Layout

| Path                      | What                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `den.yml`                 | The product profile ([below](#denyml-the-product-profile))                                       |
| `package.json`            | Pins an exact `@monster-orange/den` version                                                      |
| `bin/<cli>`               | The shim people run ([below](#the-bin-shim))                                                     |
| `Makefile`                | Includes Den's targets ([below](#make-denmk))                                                    |
| `config/<name>.yml`       | Org config: brand, `github_org`, `secrets`, `edge`, …                                            |
| `config/environments/`    | One `<env>.json` per environment (base URLs, auth, timeouts)                                     |
| `config/local/`           | Per-engineer overrides (`user.yml`); gitignored                                                  |
| `manifests/`              | Manifests for repos that do not carry their own, and overrides ([below](#overriding-a-manifest)) |
| `tests/pillars/<pillar>/` | Your own suites, e.g. `tests/pillars/perf/<module>/test.js`                                      |
| `reports/`, `results/`    | Test output; gitignored                                                                          |

## Overriding a manifest

A repo's manifest comes from one base: the repo's own file (`.acme.yml`, or
its `.json` twin) or, when the repo has none, the one the distribution holds
at `manifests/<repo>.acme.yml`. On top of that base, an optional
`manifests/<repo>.override.yml` changes what this distribution needs to
differ, without a commit to the repo. The override file is named with
`.override` plus the manifest's extension, and `<repo>` is matched exactly as
for a held manifest: the checkout's `origin` repo name, then the managed-clone
name, then the folder name.

```yaml
# manifests/shop.override.yml, merged onto shop's own .acme.yml
services:
  web:
    commands:
      local:
        up: make up-fast # replaces up; the base's other commands stay
    depends_on: [] # lists replace whole: web no longer waits on api
    urls: null # null deletes the key
```

Merge rules:

- Maps merge by key, recursively.
- Lists and scalars replace the base value whole.
- An explicit `null` deletes the key from the result.

An override only changes or deletes what the base has. A service or key the
base lacks is an error, even inside a map whose keys are free-form (a new
command, a new environment): put new entries in the base. An override with no
base is an error, never a manifest on its own.

`<cli> validate <repo-dir>` checks each layer against the schema on its own,
naming the file each error is in, then checks the merged result:

```
  ✓  /src/shop/.acme.yml  (repo, v1, no issues)
  ✗  /dist/manifests/shop.override.yml  (override, v1, 1 error)
  ERROR   services.api.commands.local.down  unknown key "down": not in the base manifest
```

The web UI's Services cards show the layers each manifest was built from
(`manifest: repo + override`), and `/api/services` returns them per service as
`manifestLayers`, e.g. `["held", "override"]`. `DEN_MANIFESTS_DIR` points the
held and override lookup at another directory (tests use it).

## den.yml: the product profile

Every runtime name derives from `product.name`. Set only what you want to
differ.

```yaml
product:
  name: acme
  # cli: acme
  # env_prefix: ACME
  # config: config/acme.yml
  # manifest: .acme.yml
  # state_dir: ~/.acme
  # services_dir: .acme-services
  # workspaces_dir: acme-workspaces
```

| Field            | Default              | What it names                                                     |
| ---------------- | -------------------- | ----------------------------------------------------------------- |
| `name`           | `den`                | The product; `[a-z][a-z0-9-]*`. Everything below derives from it  |
| `cli`            | `<name>`             | The command shown in help, hints and the web UI                   |
| `env_prefix`     | `<NAME>` (`-` → `_`) | Env vars: `<PREFIX>_ROOT`, `<PREFIX>_HOME`, `<PREFIX>_INVOKE_CWD` |
| `config`         | `config/<name>.yml`  | The org config, relative to the distribution root                 |
| `manifest`       | `.<name>.yml`        | The manifest file a repo carries; the `.json` twin is also read   |
| `state_dir`      | `~/.<name>`          | Per-user state: web server, daemons, logs, history                |
| `services_dir`   | `.<name>-services`   | Managed clones, relative to the distribution root                 |
| `workspaces_dir` | `<name>-workspaces`  | Workspace checkouts, relative to the distribution root            |

Env vars, with `ACME` as the prefix:

| Variable          | What                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `ACME_ROOT`       | The distribution root, if Den cannot find it from the entry script |
| `ACME_HOME`       | Overrides `state_dir` (two instances on one machine stay apart)    |
| `DEN_ROOT`        | The same as `<PREFIX>_ROOT`; the shim sets it                      |
| `DEN_ENGINE_ROOT` | Den's package directory; `bin/den` sets it                         |
| `DEN_PROFILE`     | Read another profile file instead of `<root>/den.yml` (tests)      |

## Brand

What people see: the CLI banner and help header, web page titles and the
edge's web route. Read from `brand:` in the org config; every field is
optional.

```yaml
brand:
  name: Acme # default: the product name, first letter upper-cased
  tagline: Acme local dev and E2E harness # default: "Local dev and E2E harness"
  banner: # optional ASCII-art lines; default: the name spelled out
    - "  ┌───────────┐"
    - "  │  A C M E  │"
    - "  └───────────┘"
```

| Field     | Used for                                                                     |
| --------- | ---------------------------------------------------------------------------- |
| `name`    | Web page `<title>`s, the banner fallback, the web route on the edge (`acme`) |
| `tagline` | The line under the banner                                                    |
| `banner`  | The CLI and web server startup banner                                        |

Runtime names (env vars, files, directories) always come from `den.yml`,
never from the brand.

## The bin shim

`bin/<cli>` is three lines of sh: it names the distribution root and runs
Den from `node_modules`.

```sh
#!/bin/sh
DEN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEN_ROOT; exec "$DEN_ROOT/node_modules/@monster-orange/den/bin/den" "$@"
```

`package.json` also lists it under `bin`, so `npm link` (or a global
install of the distribution) puts `acme` on your PATH.

Den's own `bin/den` sets `DEN_ENGINE_ROOT` to its own package directory and
sets `DEN_ROOT` only when it is unset and the engine directory holds a
`den.yml` (Den's own checkout). An installed Den ships no `den.yml`, so the
engine directory is never taken for a distribution. `DEN_USE_DIST=1` still
runs a compiled `dist/` build when one exists.

## make: den.mk

A distribution's `Makefile` includes Den's targets from the package:

```make
DEN_TARGET_PREFIX := acme
include node_modules/@monster-orange/den/make/den.mk
```

`DEN_TARGET_PREFIX` names the service and setup targets: `make acme-up`,
`acme-down`, `acme-status`, `acme-logs`, `acme-graph`, `acme-workspace`,
`acme-setup` and the rest (default `den`). `den create` sets it to the CLI
name.

`den.mk` defines:

| Variable         | What                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `DEN_ENGINE`     | Den's package directory (the directory above `den.mk`)                |
| `DEN_TSX`        | The tsx binary: Den's own, or the one npm hoisted into `node_modules` |
| `DEN_PLAYWRIGHT` | The playwright binary, found the same way                             |
| `DEN_BIN`        | `$(DEN_ENGINE)/bin/den`                                               |
| `DEN_ROOT`       | Exported: the directory make runs in (`$(CURDIR)`)                    |

and includes `make/test.mk`, `local_dev.mk`, `journeys.mk`, `security.mk` and
`demo.mk`: `make test`, `make web`, `make <prefix>-up`, `make test-syn-all
repo=<repo>`, `make test-smk-all repo=<repo>`, `make test-perf
module=<module>`, `make test-jrn-all`, `make test-sec-all` and the rest.
Recipes run from the distribution root (reports and staged tests land there)
and reach Den's files through `$(DEN_ENGINE)`. `make help` lists the main
targets; define your own `help` by setting `DEN_OWN_HELP := 1` before the
include. Add your own targets below it.

## Two roots

Den resolves two directories (`src/shared/paths.ts`, `src/shared/engine.ts`):

- the **engine root** (`getEngineRoot()`, `enginePath()`): Den's own files,
  `src/`, `make/`, `scripts/`; `node_modules/@monster-orange/den` in a
  distribution;
- the **distribution root** (`getDistRoot()`, `distPath()`): `den.yml`,
  config, manifests, `tests/pillars/`, reports, results, staged tests.

Den's scripts run with the engine's tsx (`tsxCommand()`), never through `npx`
or a path relative to the current directory. In Den's own checkout both roots
are the same directory.

## Running the web UI as a service (macOS)

Den ships a launchd installer that runs the web UI at login and restarts it if
it exits. From the distribution root:

```bash
DEN_ROOT="$PWD" DEN_SERVICE_LABEL=local.acme.web \
  node_modules/@monster-orange/den/service/install.sh            # install or refresh
node_modules/@monster-orange/den/service/install.sh status      # with the same env
node_modules/@monster-orange/den/service/install.sh uninstall
node_modules/@monster-orange/den/service/install.sh print       # the plist only
```

| Variable            | Default                                  |
| ------------------- | ---------------------------------------- |
| `DEN_ROOT`          | required in a distribution               |
| `DEN_SERVICE_LABEL` | `local.<distribution dir name>.web`      |
| `DEN_SERVICE_LOGS`  | `~/Library/Logs/<distribution dir name>` |

The service runs the engine's server with the `node` on your `PATH` at install
time, from the distribution root; re-run `install` after changing node versions
or upgrading Den. Keep the label stable: it is how launchd knows the service.

## MCP server

`./bin/acme mcp` runs an [MCP](https://modelcontextprotocol.io) server over
stdio, so an agent (an MCP client such as an editor or a coding agent) can
read and, where the org allows it, act on the same local environment the web
UI shows. It is a thin client of the running web server
(`http://localhost:<web.port>`): agents and the UI share one state and one
set of guards. It never starts the web server; if it is not running, every
tool answers with the command that starts it (`./bin/acme web up`). stdout
carries only the protocol; diagnostics go to stderr.

The web server keeps running the Den it started with until it is restarted,
so after an upgrade it can be older than the MCP server. When a tool's route
answers 404, the MCP server reads the web server's version from
`/api/server-info` and, if it predates the route, says so:
`web server is Den 0.1.0; stacks needs >= 0.2.0: run acme web restart`. Any
other 404 is reported as it is.

Register it with a client as a stdio server, for example:

```json
{
  "mcpServers": {
    "acme": { "command": "/path/to/acme/bin/acme", "args": ["mcp"] }
  }
}
```

`--port <n>` points it at a web server on another port.

### Config

Without an `mcp:` block in the org config (`config/<name>.yml`) only the read
tools are registered. Actions are opt-in, by name:

```yaml
mcp:
  actions:
    [service_up, service_down, service_restart, workspace_sync, run_tests]
  run_tests:
    envs: [local] # the default; production is refused even if listed
  logs:
    remote: false # the default; true lets the log tools read non-local sources
```

An unknown action or environment name is an error, so a typo never turns a
guard off.

### Tools

Read tools (always registered):

| Tool                | Web API                                    | What                                                       |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| `status`            | `/api/health`                              | Service health; `url` (HTTP check) or `check` (shell)      |
| `services`          | `/api/services`                            | Services, their mode (managed or dev-managed) and commands |
| `applications`      | `/api/applications`                        | Org > Application > Repo > Services                        |
| `graph`             | `/api/graph`                               | The derived dependency graph and startup order             |
| `workspaces`        | `/api/workspaces`                          | Workspaces, active and focused                             |
| `environments`      | `/api/environments`                        | The enabled environment names (never their values)         |
| `logs_search`       | `/api/logs/search`                         | Search services' full log history                          |
| `logs_tail`         | `/api/service/taillog`                     | The last lines of a service's log (bounded, no follow)     |
| `tests_available`   | `/api/modules`, `/api/test-sources`        | A pillar's modules and the repos they come from            |
| `security_latest`   | `/api/security/latest`                     | The newest security scan per mode                          |
| `release_status`    | `/api/release/runs`, `/api/release/status` | Recent CD runs, and an env's deployed-version table        |
| `manifest_validate` | `/api/manifest/validate`                   | Validate a manifest by path or content                     |
| `stacks`            | `/api/stacks`                              | What `stack ls/ps/health` show: project, routes, health    |
| `edge_status`       | `/api/edge`                                | The edge: up or down, its routes and cert names            |

Action tools (only those named in `mcp.actions`): `service_up`,
`service_down`, `service_restart` (through `/api/service/exec`),
`workspace_sync` (`/api/workspace/sync`) and `run_tests` (`/api/run`). There
is no deploy tool.

### Guards

- **Lifecycle only, local only.** The service tools run a manifest's `up`,
  `down` or `restart` and nothing else, with `env=local`, and only for a
  service run locally (today: its manifest has a local `up` command).
- **Sync touches managed clones only.** It never pulls, resets or switches
  branches in a dev-managed checkout (your own). The web server enforces
  this for the UI's Sync too: a managed entry whose path is, holds or sits
  inside a dev-managed checkout is refused, out loud.
- **Tests:** `run_tests` targets only `mcp.run_tests.envs` (default
  `[local]`) and never production. A security run must first pass the
  security CLI's own plan (`/api/security/plan`, a dry run): every target
  host in `security.owned_hosts` and the mode within the env's ceiling.
  `full` (active attacks) is local only.
- **Logs** read local sources only, unless `mcp.logs.remote: true`. All text
  the tools return is scrubbed of secret-shaped values: bearer tokens, JWTs,
  AWS keys, credentials in URLs and DSNs, `key=value` secrets, private-key
  blocks.
- **Never exposed:** sudo passwords, AWS login, opening a terminal or editor,
  workspace-wide exec, any other service command, settings writes, workspace
  create, rename or mode changes, the server log, and anything that returns
  environment values. The MCP server's HTTP client cannot reach any other
  route.

### Audit

Every action is recorded with actor `agent`, the MCP client's name and
version (as the client reports them at initialize: a label, never used to
authorise anything), and the MCP server's pid and session id. They travel as
`x-den-*` headers on each web API call. The web server writes each action
(and each UI one) as a lifecycle line in its log; on the Logs page, the
`acme/server` stream shows an agent's actions as `[agent]`, ending
`· by agent <client> <version> (mcp pid <pid>, session <id>)`.

## Pinning and upgrading

`package.json` pins an exact Den version (`create` writes the version that
ran it). Den is pre-1.0: read the **Migrations** section of
[CHANGELOG.md](../CHANGELOG.md) for every version between yours and the
target, make the config and manifest changes it lists, then:

```sh
npm install @monster-orange/den@<version> --save-exact
./bin/acme --version
```

Installing from a tarball (`npm pack` of a Den checkout, before a version is
on npm): every tarball Den hands out has its own prerelease number
(`0.1.0-dev.1`, `-dev.2`, …). npm caches a tarball by version and
integrity, so a repacked tarball with an unchanged version reinstalls the
old copy; if you ever repack one yourself without bumping, remove
`node_modules/@monster-orange/den` and its `package-lock.json` entry first.

## Developing Den against a distribution

To try a Den change in a distribution, install your checkout instead of the
published package:

```sh
cd acme
npm install ../den        # node_modules/@monster-orange/den → your checkout
./bin/acme status
```

npm links the directory, so edits to Den's `src/` take effect on the next
run (Den runs its TypeScript with tsx; there is no build step). Den's
checkout has its own `den.yml`, but the shim's `DEN_ROOT` wins, so the CLI
still runs as the distribution. Put the pinned version back with `npm
install @monster-orange/den@<version> --save-exact` before committing.

To check a change the way CI does, run `scripts/dist-smoke.sh` in Den's
checkout: it packs Den, scaffolds `acme` from the tarball, installs the
tarball into it, and checks the CLI, make targets and web server.
