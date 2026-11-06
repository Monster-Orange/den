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

Each entry takes `repos`, `branch`, `autostart_off` and `org`, the same
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
`-w <workspace>` (repeatable) plans those workspaces instead, active or not,
and `--all-active` every active one; on a fresh machine `-w` narrows the
blueprint's plan. Repos that only workspaces outside the plan hold are named
in a closing hint. A dev-managed repo shows the branch its checkout has out
(read from its `.git/HEAD`), not a configured one. `acme up --plan` lists
the same lines for the repos it would start, and exits 1 when nothing
resolves (a name no workspace has, an empty workspace). Both are read-only:
nothing is cloned, seeded or written.

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

### Sources and repos (0.2.8)

An org is Den's own: its id is any key of `orgs:`, and it needs no git
host. Two optional keys bind it to where its repos live:

```yaml
github_org: acme
orgs:
  acme-group: # one org, two GitHub owners
    label: Acme Group
    sources:
      - { host: github, owner: acme }
      - { host: github, owner: acme-labs }
  globex-billing: # one owner split across two orgs
    repos: [globex-invoices]
  globex:
    sources: [{ host: github, owner: globex }]
  initech: # no git host at all
    sources: []
    repos: [widget]
```

- `orgs.<id>.sources` is a list of `{host, owner}` (or `{host, group}`). A
  source claims that owner's repos for the org. `host: github` is built
  in; any other host id (`gitlab`, …) claims repos whose `remote:` is on
  `<host>.com` or a `<host>.` hostname, and clones them from that remote.
- `orgs.<id>.repos` lists repos that belong to the org whatever their
  owner.
- An entry with neither key is what it was before 0.2.8: the GitHub owner
  of its own name.

The catalog (`config/local/service-catalog.yml`) takes a `remote:` for any
host, beside `gh: owner/repo`, which stays as the GitHub shorthand:

```yaml
widget: { remote: git@git.initech.example:tools/widget.git }
```

A repo's org is the org whose `repos` lists it, else the org with a source
that claims its owner, else its GitHub owner as before. That org is what
`/api/orgs?repos=1` maps the repo to and what infers a workspace's org (step
3 above). A claimed owner is not listed as an org of its own, and a
`github_org` that names one makes the claiming org the default. Service rows
(`/api/services`, `/api/health`) keep `org` as the repo's GitHub owner.

A repo clones from its source: a GitHub source gives
`https://github.com/<owner>/<repo>.git` with your `gh` as credential helper.
A repo with no source that claims it clones and pulls from its `remote:`
through plain git, with your own git credential helper; Den never hands it
`gh` or any credential of its own. A remote must be `https://`, `ssh://`,
`git://`, `file://`, `user@host:path` or an absolute path. `setup --plan`
shows it as the clone URL, with any user info masked.

An org with no GitHub source has no repo discovery (`register` lists
nothing for it) and its repos are left off the Release page.

These keys are checked when den.yml is read, and a bad value is an error
that names its key (`orgs.initech.sources[0].owner must be …`). A repo
listed by two orgs, or an owner claimed by two orgs' sources (or by a
source and an org with no `sources` of that name), is an error naming both
keys. Without the new keys nothing changes: `/api/orgs` is byte for byte
what 0.2.7 answered. They need Den 0.2.8 or later.

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

### Scoped to one workspace

```sh
./bin/acme mcp --workspace smb --actor agent:planner
```

`--workspace <ws>` and `--actor agent:<id>` (both or neither) scope the server
to one workspace for one agent:

- **Pinned.** A tool that takes a `workspace` gets `<ws>` when none is given.
  A call naming another workspace is refused (`Refused: <tool>: this MCP
server is scoped to workspace "<ws>" (agent:<id>); "<other>" is another
workspace`) before anything reaches the web server. A refused call is
  recorded in the activity trail, read tools included.
- **Filtered.** `workspaces` lists `<ws>` only. `logs_search` and `logs_tail`
  take only `<ws>`'s services, `manifest_validate` takes only an absolute path
  inside one of its repos (or the content), and `workspace_sync` syncs `<ws>`.
  Tests run against the focused workspace, so `tests_available` and
  `run_tests` are refused unless `<ws>` is the focused one.
- **Not workspace data**, served as unscoped: `environments`,
  `security_latest`, `release_status` and `edge_status` (the org's and the
  distribution's, not a workspace's).
- **Stamped.** Every web API call carries `x-den-mcp-agent: agent:<id>` and
  `x-den-mcp-workspace: <ws>` beside the usual audit headers. The activity
  entry gains `agent` and `workspace`, and the log line reads `· by
agent:<id> <client> <version> (workspace <ws>, mcp pid <pid>, session
<id>)` for every exec, run and sync.
- `<ws>` must exist in this distribution; until it does, every tool says so.
  The id is letters, digits, dots, dashes and underscores (at most 64). A bad
  or half-given scope is a usage error, exit 2. `--list` and `--call` take
  the scope too.

**It binds cooperating agents only.** The scope lives in the MCP server's
process. The web server's HTTP API does not check it yet, so an agent that
calls the API itself (curl, a browser) is not held to its workspace. Enforcing
the scope in the HTTP server is WS-3a, planned for 0.4. `mcp connect` still
registers the unscoped server; to hand one agent a scoped server, add it to
that agent's config yourself, for example in a project's `.mcp.json`:
`"args": ["mcp", "--workspace", "smb", "--actor", "agent:planner"]`.

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
