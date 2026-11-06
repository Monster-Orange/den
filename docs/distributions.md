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

Run with no argument in the distribution root, `<cli> validate` checks every
manifest the distribution uses, and never clones:

- each repo of every workspace, once per checkout path, with the
  workspaces that use it and where its base comes from (`own`, `held`,
  `+ override`);
- a repo with no checkout on disk falls back to its held manifest, marked
  `held only, no checkout`. With no held manifest either it is a warning, not
  a failure;
- each held manifest in `manifests/` that no workspace uses.

It prints one line per repo, details only for a layer with errors or
warnings, and exits 1 if any fails. `<cli> validate --held` checks only
`manifests/`, as if nothing were checked out, so the result does not depend on
the machine (use it in a CI or upgrade gate). An override whose base is the
repo's own manifest is noted there, not checked.

The web UI's Services cards show the layers each manifest was built from
(`manifest: repo + override`), and `/api/services` returns them per service as
`manifestLayers`, e.g. `["held", "override"]`. `DEN_MANIFESTS_DIR` points the
held and override lookup at another directory (tests use it).

Once a repo carries its own manifest, a held `manifests/<repo>.acme.yml` is
never read. `validate` says so, as a warning (not an error), naming the held
file: delete it, or keep only what this distribution changes as
`manifests/<repo>.override.yml`.

## Naming a service

`up`, `down`, `restart` and `logs` take a repo name (`shop`) or a
`repo/service` address (`shop/api`). A service's manifest key (`api`) or a
compose stack's name (`compose.name`, else the manifest's `name`) works too,
when it names exactly one service in the workspace: a stack stands for its
repo, so `<cli> restart search` restarts the repo whose stack is `search`.
Repo names and listed addresses always win over an alias, so a catalog repo
is never mistaken for another repo's service. An alias that names more than
one service is an error that lists them (`"worker" is ambiguous in workspace
"default": one/worker, two/worker`); name one of them.

## Health checks

A service declares its health per environment under `health`, in one of
three types:

```yaml
services:
  api:
    health:
      local: { url: http://shop-api/healthz } # http (the default type)
  db:
    health:
      local: { type: shell, cmd: pg_isready -h localhost } # exit 0 is up
  cache:
    health:
      local: { type: container, project: shop-main, service: cache }
```

`label` (optional, any type) is shown in the UI instead of the URL or the
command. A compose repo with no declared check gets Den's own stack check
(`<cli> stack health`), answered in-process.

**`type: container`** asks whether a container is up, from the one
`docker ps` listing a health cycle already makes for the compose checks: it
adds no docker call however many container checks there are, in the web
health row and in `<cli> status`. It matches a compose container by its
`com.docker.compose.project` and `com.docker.compose.service` labels
(`project` + `service`), or any container by name (`container_name`, for one
compose does not run). One or the other, never both:

| What the listing shows                    | Verdict                                                 |
| ----------------------------------------- | ------------------------------------------------------- |
| running, healthcheck `healthy`            | up                                                      |
| running, healthcheck `unhealthy`          | down                                                    |
| running, healthcheck `starting`           | pending                                                 |
| running, no healthcheck                   | up                                                      |
| not running (exited, created, restarting) | down                                                    |
| no matching container                     | down (`<project>/<service>: no container`)              |
| `docker ps` fails (daemon down)           | unknown (`ok: null`, the reason in `error`), never down |
| `docker ps` past its 5s budget            | pending (`ok: null`, `pending: true`)                   |
| more than one match                       | the best one: healthy, then running                     |

When docker gives no listing, a container check says what a compose check
says, through the same code: docker state unknown is not "not running", so
a failed `docker ps` is `ok: null` however many cycles it lasts, in the
health row and in `<cli> status`. Only a listing that runs past its budget
is `pending`, and like any check with no answer it is down when that
repeats on the next cycle. A container whose healthcheck is still starting
stays pending. In
`/api/health` the row's `check` reads `container <project>/<service>` (or
`container <name>`).

Before, a container check was a shell check that ran docker itself, one
process and one docker call per check per cycle:

```yaml
health:
  local:
    type: shell
    cmd: test -n "$(docker ps -q --filter label=com.docker.compose.project=shop-main --filter label=com.docker.compose.service=cache)"
```

After:

```yaml
health:
  local: { type: container, project: shop-main, service: cache }
```

which also reads the container's own healthcheck (the shell form only saw
that a container existed, running or not).

**Validation.** `<cli> validate` rejects a container check with neither
`project` + `service` nor `container_name`, with only one of `project` and
`service`, with both forms at once, or with a key of another type (`cmd`,
`url`), and says which.

## Placement

Each service says where it runs, per environment: `local` (on this machine,
started by Den) or `remote` (deployed elsewhere). A remote service still
shows in the graph, the health row and the applications, marked ☁, but Den
never starts, stops, scans or execs it. The common case is a hybrid
application: its frontend runs here and calls the team's dev deployment of
its backend.

```yaml
# .acme.yml of shop-core
services:
  core:
    runs: { local: remote, dev: remote } # per env: local | remote
    target:
      env: dev # one of the org's environments
      account: AWS # a label for where it is deployed
      url: https://api.dev.acme.example/admin/manifest
      expect: 401 # the API answers 401 when it is up (behind a JWT authorizer)
```

When `runs` says nothing for the env being viewed:

- `local` if the service has commands there. Locally that also covers every
  service of a repo that runs here: a compose stack, or a repo where any
  service has `commands.local` (one repo-level `up` starts the others). A
  remote service inside such a repo says `runs: { local: remote }`;
- `remote` if it has an HTTP health URL there and nothing in its repo runs
  there;
- otherwise `none`: Den knows no runtime for it, and shows no placement.

`target` names where a remote service runs: `env`, an optional `account`
label, an optional `url`, and `expect`, a status code or a list of codes that
count as up when Den probes `url` (default: any 2xx). Codes are integers
100–599. A service with `runs.local: remote` must have a `target`.

**Health.** A remote service is checked by the health declared for its
`target.env` (`health.dev` above), the same check Den runs when you view that
env. Only when there is none does Den GET `target.url` and compare the status
with `expect`. The health row's label names the target, `dev · AWS`, followed
by the status or response time.

**Validation.** `<cli> validate` rejects an env name in `runs`, or a
`target.env`, that is not one of the org's `environments`, an unknown key in
`target`, and `expect` codes outside 100–599. Placement is the one thing an
[override](#overriding-a-manifest) may add to a service its base has, so a
distribution can place a repo's service remote without a commit to the repo:

```yaml
# manifests/shop-core.override.yml
services:
  core:
    runs: { local: remote }
    target: { env: dev, account: AWS, url: https://api.dev.acme.example/health }
```

**Where it shows.** `/api/services` and `/api/health` rows carry `runs`
(`local`, `remote` or `none`, for the env asked about) and `target`
(`{ env, account?, url? }`, or null unless remote). `/api/applications`
carries each service's placement in `placements` (keyed by address), and per
application `placement` (`local`, `remote`, `hybrid` or `none`) with a
`summary` such as `shop-frontend local · shop-core remote (dev)`.
`<cli> status` and `<cli> services` suffix remote services with
`☁ remote (dev)`; `<cli> apps` marks hybrid and remote applications and
repos; `<cli> graph` marks remote nodes (dashed in `--format dot`) and hybrid
ones (`⇄ hybrid`).

**Guards.**

- Service exec (`/api/service/exec`, `<cli> up|down|restart`, workspace-wide
  up and down, `<cli> up`'s plan) refuses every command on a remote service:
  `shop/core runs in dev (AWS); nothing to start here`. A `down` stops
  nothing and succeeds, so a workspace down is not failed by it.
- MCP: `runsLocally()` reads the served `runs`, so agents cannot start, stop
  or restart a remote service.
- Security: `auto_targets` never adds a remote service, even one with local
  commands. A declared target of a remote service is not scanned in `local`,
  only in other envs.
- **Production.** A remote service whose `target.env` counts as production is
  never scanned, in any env, and never acted on. Production is an attribute of
  an env in the org config, never a name check:

  ```yaml
  # config/acme.yml
  production_envs: [prod] # default: [prod, production]
  ```

## Secrets

A distribution needs no secrets store. Den has no store, vault, item,
field, key or account of its own that a distribution is assumed to share.
Where a distribution keeps its secrets, if anywhere, is its own config.

### Choosing a backend

The backend is a strategy, chosen with `secrets.provider` in the org config
(per engineer in `config/local/user.yml`, per shell with
`<PREFIX>_SECRETS_PROVIDER`):

| `secrets.provider` | What it is                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `none`             | No store. Nothing is resolved, no CLI is run; `den create` scaffolds this                |
| `env`              | Plain environment variables of the process running Den                                   |
| `doppler`          | The `doppler` CLI (`secrets.doppler: { project, config }` for a default scope)           |
| `1password`        | The `op` CLI (`secrets.onepassword.account` for the account, else your own `OP_ACCOUNT`) |

```yaml
# config/acme.yml
secrets:
  provider: none # or env | doppler | 1password
```

When `secrets.provider` is not set at all, Den falls back to `doppler`,
but only at the moment something actually resolves a secret: a
distribution with no refs, no `secret_env` and no `required` never runs
`doppler` and never sees a warning. The first time an unset provider does
resolve a secret, Den prints, once, that the implicit default is deprecated.
Set the provider explicitly to silence it.

Each backend is registered as a strategy (`src/shared/secrets/strategies.ts`,
through the generic registry in `src/shared/strategies/registry.ts`) with a
`detect()`: a file check that never prompts. A backend whose CLI is not on
PATH reports "not available: The Doppler CLI (doppler) is not on PATH"
instead of failing a spawn.

### Refs: where Den's own features find their secrets

Two Den features can use a secret, and only when the distribution says
where it is, under `secrets.refs`:

| Ref                  | Feature                                                      |
| -------------------- | ------------------------------------------------------------ |
| `sudo`               | The saved local-dev sudo password (auto-unlock, "Save to …") |
| `journeys_agent_key` | The journeys agent's API key, when `CURSOR_API_KEY` is unset |

```yaml
secrets:
  provider: 1password
  onepassword: { account: example.1password.com }
  refs:
    sudo: { vault: Private, item: Dev Keys, field: ACME_LOCAL_ADMIN_PWD }
    journeys_agent_key:
      { vault: Private, item: Dev Keys, field: CURSOR_API_KEY }
```

```yaml
secrets:
  provider: doppler # or env
  refs:
    sudo: { key: ACME_LOCAL_ADMIN_PWD }
    journeys_agent_key: { key: CURSOR_API_KEY }
```

`1password` needs an `item` and a `field` (`vault` is optional); `doppler`
and `env` need a `key` (or an env-shaped `field`). There are no defaults:
a ref that is not set is **not configured**, and its feature says so
("not configured: set secrets.provider and secrets.refs.sudo in
config/acme.yml") instead of running a CLI. The interactive unlock always
works; only the saved password needs `refs.sudo`.
`/api/sudo-password/vault-status` reports `backend`, `label`,
`configured`, `backendAvailable`, `reason` and `hasStored` (`opAvailable`
is a deprecated alias of `backendAvailable`, kept for one minor).

A `1password` distribution with no refs gets one warning, in the web
server's startup log and in `<cli> validate`, with the YAML to add.

### Setup targets

`make <cli>-setup-secrets` runs the selected backend's setup: `doppler
login` and `doppler setup`, the 1Password developer-keys setup, or a note
for `env`. With `none`, or no provider set, it says there is nothing to set
up and exits 0.

Backend-only make targets come from `make/secrets-<provider>.mk` and exist
only when that backend is selected: with `secrets.provider: 1password`,
`make <cli>-setup-1password` (the developer-keys item at
`secrets.developer_keys: { vault, item }`, else the vault and item of
`refs.sudo`) and `make auth-configure env=<env>` (your own admin account
for staging and production). Any other distribution has neither.

`make up` and `make web` check the backend only when `secrets.required:
true`; otherwise the check passes silently, whatever the provider.

## Secrets in a target's env

`secret_env` puts secrets from the configured secrets provider
(`secrets.provider`: `doppler`, `1password` or `env`) into the env of what
Den starts, instead of wrapping `<provider> run -- <cli> restart <repo>` by
hand:

```yaml
# .acme.yml
compose:
  secret_env: # the docker compose process's env, at stack up / restart
    OPENAI_API_KEY: shop/dev_personal/OPENAI_API_KEY
services:
  worker:
    secret_env: # the env of this service's own up / restart command
      STRIPE_KEY: Engineering/Stripe Test/secret key
```

Each value is a fully qualified ref, `<vault>/<item>/<field>`:

| Provider    | `a/b/c` means                                                              |
| ----------- | -------------------------------------------------------------------------- |
| `doppler`   | `--project a --config b`, key `c` (`secrets.doppler` is not consulted)     |
| `1password` | vault `a`, item `b`, field `c`                                             |
| `env`       | the env var `c` of the process running Den (`secrets.keys` is not applied) |

A `compose.secret_env` key reaches a container only through the compose
file: `${OPENAI_API_KEY}` in it, or a pass-through `environment:
[OPENAI_API_KEY]`.

- **When.** `up` and `restart`, including `restart <repo>/<service>` of one
  compose service (`stack up`, `stack restart`, `stack restart --service`),
  from the CLI, the web UI and MCP. Every key is resolved before anything
  stops or starts.
- **Missing.** A key the provider cannot resolve (unset, empty, no access)
  fails that target, exit 1, naming the key, the ref and the provider. The
  rest of the set is not used: nothing starts with a partial set, and a
  restart leaves the old instance running.
- **Where values go.** Only into the spawned process's env (the docker
  compose process, or the service's command). Never into the generated
  compose override, logs, activity records, MCP output, dry runs or
  messages. A CLI-tabs (`cli_tabs`) start of a service with `secret_env`
  runs as a daemon, since a tab would put them in its shell history.
- **Dry run.** `-n`/`--dry-run` never asks the provider. It lists the key
  names it would inject: `shop: would inject secret_env compose:
OPENAI_API_KEY (names only; not resolved in a dry run)`.
- **Validation.** `<cli> validate` rejects a ref that is not exactly three
  non-empty parts and a key that is not an env var name
  (`[A-Za-z_][A-Za-z0-9_]*`). A `stacks:` entry in the org config takes
  `secret_env` too.

## The edge and TLS

The edge is one Traefik per org that routes `<name>.<edge.domain>` (and
every `edge.aliases` domain) to local services. It exists only when the
org config has an `edge:` block, which needs `org` and `domain`; Den has
no default domain. How it gets certificates is a strategy, `edge.tls`:

```yaml
# config/acme.yml
edge:
  org: acme
  domain: acme.localhost
  tls: none # http only: no https entrypoint, no cert work, no mkcert
  # tls: { strategy: mkcert }                  # a local CA, minted per machine
  # tls: { strategy: mkcert, ca: ~/path/to/ca } # an existing mkcert CA
  # tls:                                       # your own certs
  #   strategy: files
  #   include: edge/dynamic                    # Traefik dynamic config holding them
  #   mounts: { edge/certs: /etc/traefik/dynamic/certs }
  #   ca: ~/path/to/ca                         # optional: the CA that signed them
```

| Strategy | What the edge does                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `none`   | Serves http on `edge.http_port` (80) only. Route URLs are `http://`. No cert, no CA, mkcert is never run.                                                                                              |
| `mkcert` | Issues its own wildcard cert for every domain, workspace and stack zone. Its CA is its own under the state dir (`~/.local/share/<org>/edge/ca`), or `ca`, an existing CA it never mints or uninstalls. |
| `files`  | Issues nothing: the `include` directory (copied beside the generated config) and `mounts` hold the certs. `ca` only tells health checks which CA to trust.                                             |

`tls: <id>` is short for `tls: { strategy: <id> }`. `config/local/user.yml`'s
`edge.tls` replaces the team's whole. An unknown strategy, or a key the
strategy does not take, is an error naming the built-ins (`none`, `mkcert`,
`files`). `secret` (cert and key from the secrets strategy) and `acme` are
later plugins.

- **mkcert is checked before it is used.** It is run from PATH, never
  bundled. With it missing, `validate`, `doctor`, `edge up` and `edge trust`
  say "mkcert is not installed" instead of failing a spawn.
- **`<cli> edge trust` and `untrust` exist under mkcert.** `edge trust` also
  works under `files` with a `ca` (it installs that existing CA). Elsewhere
  they exit 1: "edge trust needs edge.tls.strategy: mkcert (or files with a
  ca)". `untrust` is
  refused for a shared CA (`ca:`), whose trust other devices rely on.
- **`<cli> create`** scaffolds `tls: none`, with the other forms in a
  comment: one line opts into https.
- **Legacy keys** still work, mapped to a strategy, with no change to what
  the edge renders: `issue_cert: false` is `files`, `caroot: <ca>` is
  `mkcert` with `ca`, and an `edge:` block with neither is `mkcert` with
  its own CA, warned once per run ("edge.tls is not set; defaulting to
  mkcert with a local CA. Set edge.tls explicitly.") by `validate`,
  `doctor`, `edge up` and `stack up`. `edge.tls` beside a legacy key is an
  error. See the 0.3.0 Migrations in the changelog.

## doctor

`<cli> doctor` lists every strategy kind in the registry (secrets, tls):
the one this distribution selects, whether nothing chose it (implicit),
and whether it can work on this machine, with the reason. It only checks
PATH: it never runs a backend CLI, prompts, or prints a secret. It exits
1 when a strategy that will be used cannot work (an implicit secrets
default is used only when a secret is asked for, so it never fails
doctor).

```
Acme doctor: strategies

  secrets  none                 ✓ available: no secrets backend configured
  tls      mkcert (implicit)    ✗ unavailable: mkcert is not installed
    ⚠ edge.tls is not set; defaulting to mkcert with a local CA. Set edge.tls explicitly.
```

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

## Plugins

A plugin adds to Den without changing it: a theme, a page in the web UI, and
later other kinds. Its manifest is a `den-plugin.json` that follows the
[`den.plugin/v1` schema](../schemas/den.plugin.v1.json); a theme can also be a
bare `den-theme.json`, which Den reads as a plugin that provides one theme
and asks for nothing.

```jsonc
{
  "schema": "den.plugin/v1",
  "id": "runbook",
  "name": "Team runbook",
  "version": "1.0.0",
  "license": "MIT", // an SPDX expression, the same rule as a theme's
  "den": ">=0.3.0-0 <0.4.0", // required: the Den versions it runs on
  "maintainer": "platform team",
  "provides": [
    {
      "kind": "page",
      "entry": "page/index.js",
      "nav": { "group": "verify", "label": "nav.runbook" },
    },
  ],
  "capabilities": ["ui.nav", "api.read"],
}
```

Every plugin lives in `plugins/<id>/` in the distribution, and gets there in
one of two ways:

|              | Local                                                 | Added                                                     |
| ------------ | ----------------------------------------------------- | --------------------------------------------------------- |
| What it is   | the distribution's own (its theme, a team page)       | someone else's published plugin                           |
| How          | put it in `plugins/<id>/` and commit it               | `<cli> plugin add <repo>[/<subpath>]@<tag\|commit>`       |
| Lock entry   | none                                                  | `plugins.lock.json`: source, ref, commit, hash, approvals |
| Integrity    | the distribution's own git history and review         | `plugin list` fails when its bytes differ from the lock   |
| Capabilities | present is approved: what it declares is what it gets | approved at `add` (`--yes`), kept in the lock             |
| Removing it  | delete it in git                                      | `<cli> plugin remove <id>`                                |

```sh
<cli> plugin list                 # every plugin: version, kinds, local or source@ref, lock check
<cli> plugin validate             # every local and added plugin
<cli> plugin validate runbook     # plugins/runbook/ (an id is never a cwd path)
<cli> plugin validate path/to/dir # one plugin, a distribution, or a repo of them
<cli> plugin add github.com/acme/den-plugins/runbook@runbook/v1.0.0 --yes
<cli> plugin update runbook @runbook/v1.1.0
<cli> plugin remove runbook
```

- **Every `plugins/<id>/` needs a manifest.** A directory with neither
  `den-plugin.json` nor `den-theme.json` is an error in `list` and
  `validate` ("no den-plugin.json or den-theme.json, so it isn't a
  plugin"), so an id can never collide unseen. So is a directory named
  `den` (the built-in theme's id), a name that is not an id (2–40
  characters: lowercase letters, digits or dashes, starting with a letter),
  and a symlink. `plugin list` prints exactly one row for every directory
  in `plugins/`, even when `plugins.lock.json` can't be read. `theme list`
  shows themes only and doesn't fail on other plugins, but counts the
  plugin dirs with errors and points at `plugin list`.
- **`den` is the range of Den versions the plugin runs on**, as a semver
  range. Prereleases count, so a range meant to include Den's dev builds
  starts at `-0`: `>=0.3.0-0 <0.4.0` admits 0.3.0-dev.8, while `>=0.3.0`
  does not. `validate` fails a plugin whose range excludes the running Den
  and names both, and on a prerelease Den says when only the `-0` is
  missing.
- **Load agrees with `validate`.** A theme that fails `validate` for any
  reason (its range, a missing `author` or `maintainer`, a README, a
  capability, contrast) is never offered in the Theme menu and never loads.
  The web UI skips it with one server-log notice and draws with the next
  choice (yours, then `brand.theme`, then `den`); it never fails to start.
- **What `validate` checks:** the schema; each kind with its own validator
  (a theme as `theme validate` does, a page's entry module on disk); and the
  admission rules: a `maintainer` (for a bare `den-theme.json`, its
  `author`; `theme new` sets it to the brand's name); for a page or server plugin, a README
  (`readme`, default `README.md`) that names its tier and says what it may
  touch and what it must never do (themes are exempt); an SPDX `license`,
  with every bundled font licensed.
- **Capabilities** come from a closed list: `ui.nav`, `api.read`,
  `api.actions:<id,...>`, `secrets:<ref,...>`, `net:<host,...>`,
  `exec:<binary,...>` and `send:<channel>`. Anything else fails validation.
- **Commit a local plugin before you trust it.** Den loads what is on disk,
  so it can't tell committed from uncommitted. When a local plugin declares
  `api.actions`, `secrets`, `exec`, `net` or `send` and has files git has not
  committed, `validate` warns, so the change goes through the same review as
  the rest of the distribution. Themes and read-only plugins never warn.
- **`add`** takes an exact ref: a tag or a full commit SHA (a branch only
  with `--track`, recorded as tracking). It validates the plugin, vendors it
  into `plugins/<id>/` and writes its lock entry, with `kinds` and
  `approved_capabilities` from the manifest. A plugin that asks for
  capabilities needs `--yes`. `add` never replaces a local plugin, and a
  plugin already added from another source must be removed first.
- **`update <id> @<ref>`** fetches an added plugin again from its locked
  source, and asks again (`--yes`) only when it wants more capabilities than
  were approved. A tracking plugin can be updated without a ref.
- **A `file://` source is refused.** A path on one machine must never reach
  a committed lock: for your own plugin, put it in `plugins/<id>/` as a local
  plugin; to try a published one before tagging, push a branch and use
  `--track`.

### Where plugins may come from

`add` fetches from any git host unless `den.yml` (the product profile at the
distribution root) lists the ones it allows:

```yaml
# den.yml
product:
  name: acme
plugins:
  allow:
    - github.com/acme # <host>/<owner>
    - git.acme.example # a bare host: every owner there
```

A source outside the list is refused before anything is fetched, and a value
that is not a list of strings is an error rather than "allow everything".

## Themes

A theme is the web UI's look and feel: color tokens for dark and light, type,
shape and a mark, in a `den-theme.json` that follows the
[`den.theme/v1` schema](../schemas/den.theme.v1.json). Den ships its own theme
(`den`). Others live in git repos; Monster-Orange/den-themes is the public set
and the guide to making your own
(<https://github.com/Monster-Orange/den-themes>).

```sh
<cli> theme add github.com/Monster-Orange/den-themes/themes/paper@paper/v1.0.0
<cli> theme list
<cli> theme validate path/to/my-theme
<cli> theme remove paper
```

- `add` takes an exact ref: a tag or a full commit SHA. A branch is refused
  unless `--track` (for theme authors), which the lock records as tracking.
- It validates the theme (schema, contrast in both modes, files) and copies it
  into the distribution's `plugins/<id>/`, with an entry in `plugins.lock.json`
  (kinds `["theme"]`, source, ref, commit, content hash). A theme is a
  plugin, so `theme add | list | validate | remove` are `plugin` filtered to
  kind theme (see [Plugins](#plugins)): the same lock and directory, the
  `file://` refusal and `plugins.allow`. Commit both: a fresh clone has the
  theme offline, and theme changes show up as reviewable diffs.
- `list` checks every theme against its lock and fails if one has changed.
- A distribution can also keep its own theme in the repo: `<cli> theme new
<id>` copies the built-in theme into `plugins/<id>/` to edit (or put one
  there by hand), and committing it gives everyone on the repo the theme.
  It is a local plugin: publishing it to a themes repo is only for sharing
  it with other teams. `list` shows it as `local` and `validate` with no
  argument checks it along with the added ones; `add` never replaces it.
- Contrast: every text token (`text`, `muted`, `faint`, `accent-text`, and
  the status colors) at 4.5:1 on every ground (`bg`, `surface`, `raised`,
  `sunken`); `accent` and `border-strong` at 3:1; `on-accent` on
  `accent-fill` at 4.5:1. `accent` is never text: Den draws links and accent
  text in `accent-text`.
- The mark is one image or text: `svg` (with `svg_dark`), `png` (with
  `png_dark`) or `webp` (with `webp_dark`), or `text` (up to 3 characters).
  A mark that gives two image kinds fails validate, naming both. Use a
  raster only for a mark that exists only as one (one that must not be
  vectorised): `validate` checks that the file is what its extension says
  (the PNG signature, or `RIFF….WEBP`), is at most 64 KB, and is at least
  44×44 px (twice the 22px mark in the top bar). An SVG mark may reference
  nothing outside itself (every `href` and `url()` starts with `#`).
- `favicon` (optional): the browser-tab icon, a `.png`, `.svg` or `.ico`
  file in the theme, at most 64 KB, its format checked by its first bytes.

```json
"mark": { "png": "mark.png", "png_dark": "mark-dark.png", "shape": "circle" },
"favicon": "favicon.png"
```

### The active theme

The web UI draws every color, font and radius from the active theme. Which
one is active:

1. the engineer's own choice (`appearance.theme` in `config/local/user.yml`,
   set from the header's theme menu);
2. else the distribution's default, `brand.theme` in the org config;
3. else `den`.

```yaml
# config/<name>.yml
brand:
  theme: paper # an id in plugins/<id>/ (locked or local), or den
```

An id that is not installed, or no longer validates under this Den, is
skipped for the next choice, ending at `den`, with one warning in the server
log; the UI never fails over a theme.

Appearance is a per-engineer preference, stored with the other settings
(`/api/settings`, `appearance`):

```yaml
# config/local/user.yml (gitignored)
appearance:
  theme: paper # omit to follow the distribution
  mode: light # system (default) | dark | light
```

The Theme menu's first entry is "Org default (<name>)": it stores no theme
(`appearance.theme` null, the same as omitting it), so you follow
`brand.theme`, and a later `brand.theme` change reaches you. Picking a theme
by name stores its id, even the theme that is the org default today: that
pins it, and the menu shows it as "<name> (pinned)" rather than "Org
default".

`system` follows the OS (`prefers-color-scheme`), and the theme's
`default_mode` when the OS gives none. The header's Mode and Theme menus save
here and apply at once, without a reload. Changing either writes only that
block: no edge route, edge config, service or the web service process is
touched.

What the server serves:

- `/theme.css`: the active theme as CSS custom properties
  (`:root[data-mode="dark"] { --bg: …; }` and the light block, plus `--sans`,
  `--mono`, `--display`, `--ja`, `--radius`, `--radius-button` and
  `@font-face` for the theme's fonts). Only a validated manifest is rendered.
- `/theme/<id>/<file>`: only the files the manifest names (the mark's
  `.svg`, `.png` or `.webp`, the favicon, the `.woff2` fonts), from that
  theme's directory, each with its own type (`image/svg+xml`, `image/png`,
  `image/webp`, `image/x-icon`, `font/woff2`).
- `/theme-favicon/<id>?mode=light|dark&v=<version>-<hash>`: the theme's
  browser-tab icon in that mode: its `favicon` in both modes, else its
  mark's file (the dark variant in dark mode, if it has one, else the base
  file), else (a text mark) Den's own icon. `/theme-favicon` with no id is
  the active theme's, never cached.
- `/api/themes`: every installed theme (id, name, version, `built-in` |
  `locked` | `local`, ok), the active one (with its `mark` and its
  `favicon` URL for each mode) and `org_default` (the theme no choice
  draws: `brand.theme`, else den).

Each page sets `data-mode` on `<html>` before first paint, and its styles use
only the tokens: a page or plugin that draws in the UI uses `var(--token)`,
never a color literal (`accent` is never text: `accent-text` is), and only
`var(--sans)`, `var(--mono)` or `var(--display)` for a font (the fallbacks
are in `/theme.css`: a stack with no generic family gets Den's after it).
The header shows the active theme's mark: its SVG, PNG or WebP (the dark
variant in dark mode, if it has one) as an image at 22px, a raster clipped
to the mark's `shape`, or its `text` drawn by Den in `shape` on
`accent-fill`. The browser tab shows the theme's icon for the mode the page
draws in: the shell sets it (no page links one) and changes it with the
theme or the mode, System following the OS included. Each URL carries the
theme's id, version, mode and a hash of the file, so a switch is never
answered from cache.
A color from the org config (`orgs.<id>.color`) is only ever a swatch,
border or dot, never text or a ground: labels are `--text` or `--muted`.
Links in body content are underlined, so a link never reads by color alone.

## Workspace blueprint

The workspaces a new machine starts with. Read from `defaults:` in the org
config. Every repo is seeded as a managed clone (`mode: managed`) on the
blueprint's branch; nothing is cloned until a command needs it. Switch a repo
to a local checkout afterwards with `acme use-local <repo>`.

One workspace, `default`:

```yaml
defaults:
  workspace:
    branch: main # default: main
    repos: [shop-web, shop, infra-stack]
    autostart_off: [shop] # seeded with autostart: false
    entry: shop-web # where the setup script's dependency walk starts
```

Several named workspaces:

```yaml
defaults:
  workspaces:
    storefront:
      repos: [shop-web, shop]
    data:
      repos: [warehouse, infra-stack]
      branch: develop
      focus: true
```

Each entry takes `repos`, `branch`, `autostart_off`, `org` and
`stack_namespace` (see [Stack namespaces](#stack-namespaces)), the same
fields as `defaults.workspace`, plus `focus`. Seeding creates every named workspace
with its repos, activates them all, and focuses the one with `focus: true`
(else the first). Set `defaults.workspace` or `defaults.workspaces`, not both:
both at once is an error, as is more than one `focus: true`.

The blueprint applies only to a genuine fresh setup: no workspace except an
empty `default` that was never seeded. On a TTY the first command that needs
workspaces offers to seed. Without a TTY it prints a one-line hint and changes
nothing. `acme workspace seed` (or `acme init` in the distribution root) seeds
explicitly, and resets the blueprint's workspaces if they already hold repos.

Once seeded, a repo that later joins `defaults.workspace.repos` is added to
`default`, but only while `default` is your only workspace, and never a repo
you removed from it or that another workspace holds. With
`defaults.workspaces` nothing is topped up.

To see what a setup would clone before it clones anything, run
`acme setup --plan`: each repo with its org and clone URL, and whether it
is cloned yet. On a fresh machine it plans the blueprint (every workspace
`acme workspace seed` would create); once seeded, the focused workspace.
`acme up --plan` lists the same lines for the repos it would start. Both
are read-only: nothing is cloned, seeded or written.

## Orgs

A distribution can hold work for more than one org: each workspace belongs
to one. An org's id is a key of `orgs:` or a GitHub owner, and today an org
is the GitHub owner of the same name. `github_org` is the default org. A
distribution that never mentions orgs has one org, the default, and every
workspace is in it.

```yaml
github_org: acme
orgs:
  acme: { label: Acme }
  globex: { label: Globex, color: "#0af" }
defaults:
  workspaces:
    storefront:
      repos: [shop-web, shop]
    client:
      org: globex # optional: the workspace's org
      repos: [globex-web, globex-api]
```

A workspace's org is the first of:

1. `org:` on the workspace in `config/local/workspaces.yml` (this machine)
2. `org:` on the blueprint workspace of the same name (committed)
3. the one owner of its repos in the catalog (`gh: <owner>/<repo>`; owners
   compare case-insensitively, and a `gh: ""` counts as unknown)
4. `github_org`

It is worked out each time it is read and never written back. A repo with
no clone URL is cloned from `<org>/<repo>` with its workspace's org: seeding
the blueprint above gives `globex-web` `gh: globex/globex-web`, not
`acme/...`. `acme register` picks a managed clone from the focused
workspace's org, or from `--org <id>`.

`acme org list` shows each org's label, its workspaces and which is the
default. `acme workspace list` has an Org column, and `--org <id>` lists one
org's workspaces. A workspace whose repos belong to several owners, an
`org:` naming an owner Den does not know, or a repo in another owner than
its workspace's org is a warning in both lists, never an error.
`GET /api/orgs` adds `default` and `workspaces` to each entry, and
`/api/<cli>/config` adds `default_org`.

`org:` in the blueprint needs Den 0.2.7 or later: an older Den rejects the
unknown key. Pin 0.2.7 before you commit it.

## Stack namespaces

A repo's compose stack runs as the Compose project `<stack>-<workspace>`,
and its containers, volumes and networks are named from it. The `default`
workspace uses `main` (`shop-main`), so its data predates workspaces. That
is the default and needs no config.

A workspace can opt out with `stack_namespace`, which replaces the suffix:

```yaml
# config/local/workspaces.yml (this machine)
workspaces:
  storefront:
    stack_namespace: main # shop runs as shop-main, with default's data
    services: { shop: { mode: dev-managed, path: ~/src/shop } }
```

```yaml
# org config: on a blueprint workspace, next to org
defaults:
  workspaces:
    storefront:
      repos: [shop-web, shop]
      stack_namespace: main
```

A workspace's namespace is the first of `stack_namespace` in
workspaces.yml, `stack_namespace` on the blueprint workspace of the same
name, and its own name (`default`: `main`). `acme workspace seed` writes
the blueprint's value into the workspace it seeds. workspaces.yml
overriding a different blueprint value is a warning naming both. The value
is lowercase letters, digits and dashes; anything else is a config error
that names the key.

Workspaces with the same namespace share their stacks' projects, and so
their data; a stack keeps its data when its repo moves between them. A
shared project is one instance, keyed by checkout:

- Two workspaces bringing up the same stack from the same checkout (repo
  path and branch) share it. `acme down <repo>` or `acme stack down
<stack>` from one, while another active workspace in the namespace still
  holds it, detaches and leaves it running; the last one stops it.
  `stack down --force` stops it regardless. A workspace that skips the
  stack as already healthy counts as holding it too.
- Bringing it up from a different checkout or branch is refused
  (`identity_mismatch`), naming both checkouts and the namespace. Stop it
  where it runs first, or give the workspace its own `stack_namespace`.

`acme workspace list` adds a Stacks column when a workspace's namespace is
not its default, the Workspaces page shows a "stacks: <ns>" chip in the
workspace's header, and `GET /api/workspaces` gives `stackNamespaces`:
each workspace's `stack_namespace`, its `source` (`workspace`, `blueprint`
or `default`), its `default` and whether it `differs`.

`DEN_STACK_WORKSPACE=<suffix>` overrides the suffix for one command
(`DEN_STACK_WORKSPACE=pr-12 acme stack up shop` runs `shop-pr-12`). It wins
over `stack_namespace` and bypasses the shared-project bookkeeping. It is a
per-command override, not a migration tool: to keep a workspace on another
namespace, set `stack_namespace`.

`stack_namespace` in the blueprint needs Den 0.3.0-dev.36 or later: an
older Den rejects the unknown key.

## Releases

The Release page dispatches each repo's CD workflow on GitHub. A repo's
owner there is its own `gh: owner/repo` in `release.repos`, else
`release.org` when it is set, else the repo's owner in the catalog, else
`github_org`. Leave `release.org` unset when the repos belong to different
orgs: each then releases from its own.

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
it exits:

```bash
./bin/acme service install     # install (or refresh) and start it
./bin/acme service install --plan  # what install would do; writes and loads nothing
./bin/acme service status      # launchd's view: state, pid, last exit code
./bin/acme service print       # the LaunchAgent plist it would install; installs nothing
./bin/acme service uninstall   # stop it and remove the LaunchAgent
```

The label and log directory come from the org config:

```yaml
web:
  port: 7777
  service:
    label: local.acme.web # default: local.<distribution dir name>.web
    logs: ~/Library/Logs/acme # default: ~/Library/Logs/<distribution dir name>
```

The defaults are the installer's own, so an install made by the script keeps
its label. `logs` may start with `~/`; a relative path is under the
distribution root. A label other than letters, digits, `.`, `-` and `_`, a
`logs` that is not a path, or any other key under `web.service` is an error.
`print` works on any OS; the rest are macOS only.

`install` also restarts a service that is already installed. It says the
service is running only once the web server answers
`http://localhost:<web.port>/api/server-info` with JSON (a fresh server
answers empty for a few seconds while it starts). If it has not answered
within 30s, it says `installed but not answering yet: check <logs dir>` and
exits 1.

`install --plan` is read-only: it prints the label, the plist path
(`~/Library/LaunchAgents/<label>.plist`), the log file, the distribution and
engine roots, whose server answers on `web.port` (this distribution's, free,
or `port <N> is in use by <product> at <root>; not this distribution's
server`), and the plist install would write. It writes nothing, never calls
launchctl, and exits 1 when the port is another distribution's. Any other
argument to a `service` subcommand is an error, so a mistyped `--plan` never
installs. `status` also names another distribution's server on the port.

`<cli> service` runs the installer script below, which you can also run
yourself, from the distribution root:

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
| `DEN_SERVICE_NODE`  | see below                                |

The service runs the engine's server, from the distribution root, with the
`node` on your `PATH` at install time. A version manager's node (nvm, fnm,
volta, asdf, mise) lives under a versioned path that disappears when that
version is removed, so install prefers `/opt/homebrew/bin/node` or
`/usr/local/bin/node` when one has the same major version, and otherwise
keeps the version manager's and warns. `DEN_SERVICE_NODE` names the node
outright. `service status` exits 1 when the installed node no longer exists.
Re-run `install` after changing node versions or upgrading Den. Keep the
label stable: it is how launchd knows the service.

## MCP server

`./bin/acme mcp` runs an [MCP](https://modelcontextprotocol.io) server over
stdio, so an agent (an MCP client such as an editor or a coding agent) can
read and, where the org allows it, act on the same local environment the web
UI shows. It is a thin client of the running web server
(`http://localhost:<web.port>`): agents and the UI share one state and one
set of guards. It never starts the web server; if it is not running, every
tool answers with the command that starts it (`./bin/acme web up`). stdout
carries only the protocol; diagnostics go to stderr.

It reads only from this distribution's server. Before serving a tool it
checks `/api/server-info` (root and product, or for a server from before
0.2.6 its working directory), trusts a positive answer for 30s, and checks
again after a connection error. When another distribution's server answers
on the port, every tool says `port <N> is in use by <product> at <root>; not
this distribution's server` and returns none of its data.

The web server keeps running the Den it started with until it is restarted,
so after an upgrade it can be older than the MCP server. When a tool's route
answers 404, the MCP server reads the web server's version from
`/api/server-info` and, if it predates the route, says so:
`web server is Den 0.1.0; stacks needs >= 0.2.0: run acme web restart`. Any
other 404 is reported as it is.

### Connecting your agents

`<cli> mcp connect` registers the server with the agents you use, so nobody
edits an MCP config by hand:

```sh
./bin/acme mcp clients                 # which agents are installed, which are connected
./bin/acme mcp connect --all           # every installed agent, user scope
./bin/acme mcp connect claude-code     # one (or several) by id
./bin/acme mcp connect cursor --project ../shop   # a project's config instead
./bin/acme mcp connect --all --dry-run # show what it would write or run
./bin/acme mcp disconnect cursor
./bin/acme mcp config                  # JSON for any other MCP client
```

| Client           | User scope                            | Project scope (`--project [dir]`) |
| ---------------- | ------------------------------------- | --------------------------------- |
| `claude-code`    | `claude mcp add --scope user`         | `<dir>/.mcp.json`                 |
| `codex`          | `codex mcp add`                       | –                                 |
| `cursor`         | `~/.cursor/mcp.json`                  | `<dir>/.cursor/mcp.json`          |
| `vscode`         | `code --add-mcp`                      | `<dir>/.vscode/mcp.json`          |
| `claude-desktop` | its `claude_desktop_config.json`      | –                                 |
| `windsurf`       | `~/.codeium/windsurf/mcp_config.json` | –                                 |
| `gemini`         | `~/.gemini/settings.json`             | `<dir>/.gemini/settings.json`     |

The server is registered under the CLI's name (`acme`) as the distribution's
`bin/<cli>` by absolute path, with `PATH` set to the directory of the `node`
that ran `connect` plus the system dirs. GUI agents start without your login
shell's PATH (so without nvm's node) and would otherwise fail to launch it.
After upgrading or switching node, run `connect` again. For a JSON config,
`connect` changes only its own entry, keeps the previous file as `.bak`, and
refuses to rewrite a file it cannot parse. Connecting again replaces the entry.
Restart the agent, or start a new session, to load it.

Project-scope files hold absolute paths on your machine: commit them only if
everyone's checkout is in the same place.

`--port <n>` (on `mcp` or `mcp connect`) points it at a web server on another
port.

### One call from a shell

```sh
./bin/acme mcp --list                                  # the tool names this org registers
./bin/acme mcp --call status                           # one tool; prints its text result
./bin/acme mcp --call logs_tail '{"service":"shop/api","lines":50}'
```

`--call <tool> ['<json args>']` runs one tool through the same tool layer as
the server: only registered tools (so actions only as named in
`mcp.actions`), every guard, the same redaction and audit headers. It prints
the tool's text to stdout and exits 1 when the tool reports an error (a
refusal, a failed action, the web server down).

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

| Tool                | Web API                                    | What                                                                                                                                                                                |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`            | `/api/health`                              | Service health; `url` (HTTP check) or `check` (shell, or `container <project>/<service>`); `ok` true up, false down, null not known (`pending: true` when a check has not answered) |
| `services`          | `/api/services`                            | Services, their mode (managed or dev-managed) and commands                                                                                                                          |
| `applications`      | `/api/applications`                        | Org > Application > Repo > Services                                                                                                                                                 |
| `graph`             | `/api/graph`                               | The derived dependency graph and startup order                                                                                                                                      |
| `workspaces`        | `/api/workspaces`                          | Workspaces, active and focused                                                                                                                                                      |
| `environments`      | `/api/environments`                        | The enabled environment names (never their values)                                                                                                                                  |
| `logs_search`       | `/api/logs/search`                         | Search services' full log history                                                                                                                                                   |
| `logs_tail`         | `/api/service/taillog`                     | The last lines of a service's log (bounded, no follow)                                                                                                                              |
| `tests_available`   | `/api/modules`, `/api/test-sources`        | A pillar's modules and the repos they come from                                                                                                                                     |
| `security_latest`   | `/api/security/latest`                     | The newest security scan per mode                                                                                                                                                   |
| `release_status`    | `/api/release/runs`, `/api/release/status` | Recent CD runs, and an env's deployed-version table                                                                                                                                 |
| `manifest_validate` | `/api/manifest/validate`                   | Validate a manifest by path or content                                                                                                                                              |
| `stacks`            | `/api/stacks`                              | What `stack ls/ps/health` show: project, routes, health                                                                                                                             |
| `edge_status`       | `/api/edge`                                | The edge: up or down, its routes and cert names                                                                                                                                     |

Action tools (only those named in `mcp.actions`): `service_up`,
`service_down`, `service_restart` (through `/api/service/exec`),
`workspace_sync` (`/api/workspace/sync`) and `run_tests` (`/api/run`). There
is no deploy tool.

### Guards

- **Lifecycle only, local only.** The service tools run a manifest's `up`,
  `down` or `restart` and nothing else, with `env=local`, and only for a
  service run locally: its placement is `local` and it has a local `up`
  command (see [Placement](#placement)).
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
