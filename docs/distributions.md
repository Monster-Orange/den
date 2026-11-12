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
- [Dev metrics: local unless you opt in](#dev-metrics-local-unless-you-opt-in)
- [Pinning and upgrading](#pinning-and-upgrading)
- [Developing Den against a distribution](#developing-den-against-a-distribution)

## Create one

```sh
npx @monster-orange/den@latest create acme          # writes ./acme
npx @monster-orange/den@latest create acme ~/src/acme-dev --title "Acme Dev"
```

From a Den checkout, `./bin/den create acme ../acme` does the same.

| Option                  | Default             | What                                  |
| ----------------------- | ------------------- | ------------------------------------- |
| `<name>`                | (required)          | Product name: `[a-z][a-z0-9-]*`       |
| `[dir]`                 | `./<name>`          | A new or empty directory              |
| `--title <title>`       | `<Name>` Title Case | Brand name shown to people            |
| `--cli <cli>`           | `<name>`            | The command people type               |
| `--env-prefix <PREFIX>` | `<NAME>`            | Env-var prefix (`ACME` → `ACME_HOME`) |
| `--yes`, `-y`           |                     | Never prompt (create never does)      |
| `--json`                |                     | One JSON object on stdout             |
| `--port <n>`            | `7777`, else free   | The web UI's port                     |

`create` refuses a directory that is not empty and never overwrites a file.
A directory that already holds this distribution (its `den.yml` names the
same product and command) is not an error: `create` says so and writes
nothing, so it is safe to re-run.

The web UI's port is 7777 unless that port is in use on this machine (another
Den already running, say). Then `create` picks the next free port above it,
never a port Den itself reserves (7778, 7791, 7799), writes it to the new
distribution's `config/local/user.yml` as `web: { port: N }`, and says so.
`--port <n>` sets it outright. The check only connects and binds; it sends
nothing to whatever holds the port. `DEN_WEB_PORT_START` moves the starting
port (tests use it so none touches 7777).
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

## Set up by your agent

A developer pastes one line into their agent:

```text
Set up Den for me by following https://raw.githubusercontent.com/Monster-Orange/den/main/skills/install-den/SKILL.md
```

That file is the install-den skill, also in the package at
`skills/install-den/SKILL.md`: plain Markdown any agent can follow, with
Claude skill front matter. `den --help` prints the line. The skill does three
things only: it installs Den (after checking Node and git), helps the person
pick its name and folder (default `~/<name>`), then runs `web up` and hands
over the one-time link from `web claim-link`: "Den's own agent takes it from
there." It adds no repo and creates no workspace: that is
[the server agent](#the-server-agent)'s job. Every command below also stays a
person's own: `npm i -g @monster-orange/den` → `den create <name>` →
`<cli> repo add` → `<cli> up` skips both agents. The skill runs the first
of the commands below, and the server agent the rest through MCP. Each one takes `--json`, never prompts, and is safe to
re-run. With `--json`, stdout carries exactly one JSON object and the
command's log goes to stderr. When `ok` is false the object says why
(`error`) and carries either a command the agent can run (`fix`) or a
question for the person (`ask`, sometimes with `choices`).

| Step                                                              | Answers                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npx @monster-orange/den@latest create <name> [dir] --yes --json` | `{ ok, dir, cli, existed, files, port, portPicked?, next }`                  |
| `<cli> repo add <path\|git-url> --json`                           | `{ ok, existed, repo, workspace, mode, path, manifest, services, next }`     |
| `<cli> repo detect <folder> --json`                               | `{ ok, path, repos, workspaces, truncated, skipped, rule, next }`            |
| `<cli> repo add <path> --dry-run --json`                          | `{ ok, dryRun, repo, workspace, path, manifest, draft, validation, next }`   |
| `<cli> onboard status --json`                                     | `{ ok, checks: [{ id, status, detail, fix?, ask? }], next }`                 |
| `<cli> up <repo> --json`                                          | `{ ok, workspace, services: [{ address, result, health, detail? }], next }`  |
| `<cli> web up --no-open --json`                                   | `{ ok, url, port, version? }`                                                |
| `<cli> doctor --json`                                             | `{ ok, checks: [{ id, status, detail, url?, port?, fix?, ask? }] }`          |
| `<cli> mcp connect --runtime <runtime> --json`                    | `{ ok, server, clients: [{ id, ok, said, file?, changed? }], restart, web }` |
| `<cli> down <repo> --json`                                        | `{ ok, workspace, services, all? }`                                          |
| `<cli> web down --json`                                           | `{ ok, url, port, running, stopped }`                                        |

### repo add

`<cli> repo add <path|git-url> [--sidecar] [-w <workspace>] [--name <repo>]
[--run "<cmd>"] [--down "<cmd>"] [--health <url>] [--branch <branch>]
[--json]` adds a repo to a workspace without writing into the repo.

- A path is the person's own checkout, added dev-managed at that path. A git
  URL is cloned where Den keeps its managed clones
  (`.<name>-services/<repo>/<branch>`, the remote's default branch unless
  `--branch` says otherwise) and added managed. A clone that is already
  there is used as it is.
- A repo with its own manifest is used as it is. One without, or with
  `--sidecar`, gets a side-car: a held manifest at
  `manifests/<repo>.<name>.yml` ([below](#overriding-a-manifest)), keyed by
  the repo's `origin` name or folder name. It is checked by the manifest
  validator before it is written, and an existing one is never overwritten.
  `--sidecar` on a repo with its own manifest is an error: Den always uses
  the repo's own file (change it with an override instead).
- The side-car's commands are detected from the repo's files, in this order:
  a Makefile with an `up` target (`make up`, plus `down`, `setup` and
  `restart` when present); otherwise a compose file
  (`docker compose -f <file> up -d` and `down`) or `package.json`'s `dev`,
  else `start`, script. One candidate decides. Two, or none, is a question:
  the answer has `ask` and `choices`, nothing is written, and a re-run names
  the command with `--run "<cmd>"`. A Makefile `test` target or a
  `package.json` `test` script becomes the repo's `tests.unit`.
  `--health <url>` adds an HTTP health check. Without it, when the start
  script names a port (`--port`, `-p`, `PORT=`) or runs a dev server with a
  fixed default port (Vite 5173, Next 3000, Angular 4200,
  Gatsby 8000, webpack-dev-server 8080), the side-car gets
  `http://localhost:<port>/` as its health URL, so the service has Visit ↗.
  No port: no health URL is guessed.
- The workspace is `-w <workspace>` (made and activated if it doesn't exist),
  else the focused one, else a new `default` workspace.
- The same repo again answers `ok` with `existed: true`. A different repo
  under the same name is an error that offers `relocate` or `--name`.
- `--dry-run` (a local path only) runs the same detection and validator and
  writes nothing: no side-car, no workspace entry, no catalog entry. The
  answer carries the side-car as YAML (`draft`), the validator's answer
  (`validation`), where it would go (`manifest.file`, `written: false`) and,
  in `next`, the same command without `--dry-run`. A git URL is refused: it
  would have to be cloned first.

### Onboarding reads

Three reads help a person, or an agent, finish setting Den up. Each one is
a CLI command, an MCP read tool and a web API route, with the same answer
(the browser can show the route's JSON as it is):

| CLI                                      | MCP tool         | Web API (GET)           |
| ---------------------------------------- | ---------------- | ----------------------- |
| `<cli> onboard status [--json]`          | `onboard_status` | `/api/onboard/status`   |
| `<cli> repo detect <folder> [--json]`    | `repos_detect`   | `/api/onboard/repos`    |
| `<cli> repo add <path> --dry-run --json` | `manifest_draft` | `/api/onboard/manifest` |

- **`onboard status`** says what's set up and the one next step. `checks`
  are, in order: `distribution` (this folder has its own `bin/<cli>`),
  `node`, `git`, `docker` and `web` (the same probes as `doctor --json`),
  `workspaces` (how many, and the active ones), `repos` (how many are
  added), `service` (how many services Den started are running) and `mcp`.
  Each is `ok`, `warn` or `todo`, with a `fix` command or an `ask` for the
  person when there is one. `next` is `{ id, step, command }`: the step in
  plain words and the command for it, or `id: "done"` when everything is
  set up. `mcp` never runs an agent's CLI: it is `ok` when the question
  came through Den's MCP, or when a client's config file names this
  distribution's server; with only Claude Code or Codex installed (they
  keep their list behind their own CLI) it is a `warn` pointing at
  `<cli> mcp clients`. It exits 0 whenever it answers.
- **`repo detect <folder>`** finds the git repos in one folder: the folder
  itself when it is a repo, else its subfolders one and two levels down (a
  repo's own subfolders are not scanned). For each repo: `manifest` (`repo`,
  `sidecar` or `none`), `runs` (what [`repo add`](#repo-add) would detect)
  or `ask` and `choices`, the suggested `workspace`, and `registered` when
  it is already in one. `workspaces` groups them by one simple rule: the
  repos in one parent folder go in one workspace named after that folder,
  and a repo directly in the scanned folder gets the scanned folder's name.
  It skips dot-folders, `node_modules` and `vendor`, never follows a
  symlink, stops at 50 repos or 5,000 folder entries (`truncated: true`),
  and never writes or runs a repo's tools.
- **`repo add --dry-run`** is the draft: see [`repo add`](#repo-add).
- **The path rule** (`repos_detect`, `manifest_draft` and both routes): a
  path is required, absolute or starting with `~/`. It is resolved with its
  symlinks, and must be a folder inside the person's home folder and outside
  Den's own state folder; anything else is refused with the reason (a 400
  from the route, `Refused:` from the tool, exit 1 from the CLI).

### Onboarding writes, held for the person

An agent finishes setup with three MCP write tools. None of them changes
anything by itself: each asks Den to hold the change, and the person's
browser opens a dialog on whatever Den page is open: "The `<agent>` agent
wants to: … · Review · Later · Deny · Allow". A request with no agent
token (an MCP server outside an agent's session, or anything else on this
machine) reads "Something on this machine (no agent identity) wants to:",
with "If you didn't ask an agent to do this, Deny." under it.

| MCP tool           | What Allow runs                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_create` | The Workspaces page's create: an empty workspace, made active                                                                                      |
| `repo_add`         | `repo add <path> --json`, a local folder inside home                                                                                               |
| `service_try`      | `up` for one service, as the Services page's Start does; an inactive workspace is activated first ("Start <service> (this activates <workspace>)") |

- **Den writes the dialog.** Its line and its Review come from the action
  and its arguments, never from the agent. `repo_add`'s Review is its dry
  run: the folder, the workspace (new or not) and the side-car Den would
  write. The agent's `note` is shown only quoted, as "Agent says".
- **Bad arguments are refused before anything waits**: the same checks as
  the page, `repo add` and the path rule of
  [Onboarding reads](#onboarding-reads).
- **Only the person approves.** Allow and Deny need a browser signed in on
  this Den holding its approval key: a session cookie alone, the CLI's
  bearer, an agent's token, or an anonymous request from this machine (an
  agent with a shell) is refused with `signin_to_approve`. On a fresh Den,
  `<cli> web claim-link` prints a one-time setup link that signs the
  browser in.
- **Allow runs it once**, from the arguments stored when it was asked,
  checked again first. Deny, 10 minutes with no answer, or the agent being
  stopped run nothing. An agent may have 5 requests waiting; a restart drops
  what waits (the agent asks again).
- **The agent waits** up to 2 minutes for the answer, then gets the request
  id: `approval_check` says `pending`, `done` (with what the run said),
  `denied` or `expired`. While a request waits, its agent is "waiting" on
  the Agents page.
- **Only the person sees what waits.** `GET /api/approvals` needs what
  Allow needs: the session cookie, that session's CSRF token
  (`X-Den-CSRF`) and the approval key. Anything else gets 403
  `signin_to_approve` with only `waiting`, a count, so a signed-out page
  can show "Something is waiting for your approval. Sign in to see it."
  An agent's token lists its own requests and their outcomes (`mine`),
  never another agent's. An ask with no agent token gets a `ticket` in the
  reply; `X-Den-Approval-Ticket: <ticket>` reads that one request and no
  other. Den's MCP server keeps it and never shows it to the agent.
- **Routes:** `POST /api/approvals` (`{ action, args, note? }`, 202 with the
  request), `GET /api/approvals` (the person's: what waits; an agent's
  token: its own), `GET /api/approvals/<id>` (the asking agent's own, the
  ticket holder's, or the person's) and
  `POST /api/approvals/<id>/decide` (`{ decision: "allow" | "deny" }`).
  Every ask and decision is in the activity trail.
- **On by default; `mcp.approvals: false` turns them off.** The person's
  Allow is the gate, not `mcp.actions`. Off, the three tools aren't
  registered and `POST /api/approvals` answers 403 `approvals_off`.
  `doctor` (and its `mcp:approvals` check in `--json`), the MCP server's
  instructions and `mcp --list` (on stderr) say which is in effect. A
  workspace-scoped MCP server refuses `workspace_create` and `repo_add`:
  they change Den beyond its workspace.

### up, doctor and mcp connect

- `down --json` and `web down --json` are the clean-up steps. Each is safe
  to re-run: `web down` answers `stopped: false` when the server wasn't
  running, and `ok` is true once nothing answers on its port. On a busy
  machine, where `lsof` or `ps` can't say which process holds the port
  (each lookup gets 5 s, then 20 s; `DEN_LOOKUP_TIMEOUTS_MS` sets them),
  `web down` and `web restart` exit 1 saying they couldn't tell, and
  their `--json` answers `ok: false` with `stopped: false` (and `running:
null` when the server doesn't answer either). Run them again.

- `up --json` runs `up` as usual, then reports each service it touched:
  `result` is `started`, `already-running`, `failed` or `skipped`, and
  `health` is the service's health after it started (a service with a
  health check is waited on, up to 30 seconds). A healthy service is
  `already-running` on a re-run.
- `doctor --json` lists the onboarding checks first: `node` (22.13 or
  later), `git`, `docker` (only when a registered repo has a compose file or
  block, or a docker command), `web` (the web server answers at `url`) and
  `mcp` (`<cli> mcp --call workspaces` gets an answer through it). Then one
  `strategy:<kind>` check per row of the [human doctor](#doctor). `ok` is
  false, and the exit code 1, when any check is `fail`.
- `mcp connect --runtime <runtime>` names the agent by its runtime: `claude`
  (the `claude-code` client), `codex`, `gemini` or `grok`. Grok CLI keeps its
  MCP servers in `~/.grok/config.toml` (or `.grok/config.toml` with
  `--project`), one `[mcp_servers.<name>]` table each
  ([xAI's docs](https://docs.x.ai/build/features/mcp-servers)); Den writes
  only its own table. A config file that already has the entry is left as
  it is (`changed: false`).

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

## Opening a service

A service with a URL gets **Visit ↗**, which opens it in a new tab. It
shows on Workspaces (beside Start, Stop, Restart and Logs, and as a link
on the service's name), on Services and on Graph cards. Den picks the
URL in this order: the service's `urls.<env>`; for `local`, its edge
route when the edge serves one; else the origin of its HTTP health
check. A service with none of these has no Visit.

The ☆ star on Workspaces rows, Services and Graph cards marks a
favourite. It is one list, saved in `shell.pins`, so a star set on one
page shows on all of them.

### The service panel

A pinned service in the rail has **↗** at the end of its row, always
shown: it opens the service's URL in a new tab ("Visit <service> (opens a
new tab)", the URL as its tooltip). It is greyed out, saying "Not
running", while the service is down, and absent when the service has no
URL.

A click on the service's name (or Enter on its row, or its dot when the
rail is collapsed) opens its **panel** beside the row, without leaving
the page. ⌘-click, Ctrl-click or a middle click still opens Services in a
new tab. Esc or a click outside closes it, and focus goes back to the
row. Under 640 px wide it is a sheet at the bottom of the screen. The
Services card's name and the Graph card's **⋯** open the same panel.

Top to bottom, it has:

- the name, workspace, health dot, state ("up 2h", "down: HTTP 502",
  "starting…") and URL;
- **Visit ↗**, then **Start** or **Stop**, **Restart** and **Logs**. These
  call what the Services page calls (`/api/service/exec` with `up`,
  `down` or `restart`, and `/api/service/logs`), each in a tab of the runs
  dock. Logs opens the dock on that service;
- **Last test run** (the server's run history, `GET /api/runs/last`) and
  **Run tests**, which runs the repo's suites (`/api/run?pillar=suites`);
- **Agents**: the agents working in the repo, each with **Open**, and
  **+ Start agent here**, which opens the Start dialog with the workspace
  and the repo's folder filled in;
- **Open in Services**, **Open in Graph** and **Unpin** (or **Pin**).

It stays current while it is open, from the same feeds the pages use. Delete
on a pinned row still unpins it.

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

### The Environments page

The Environments page lists every service's row at once, each cell pulsing
"checking" until its result arrives. The results stream in one at a time
(`GET /api/health/stream`, one event per check), so a slow host holds up
its own cell only. The server runs at most 12 checks at once, and no check
takes longer than 10 s. A check that runs out of time says "timed out after
10 s" in its row. Re-check and the page's other controls work while the
checks run.

The page has no org picker of its own. It follows the top bar's View (all
active workspaces, or one), asks for that workspace only, and says so:
"Shows workspace south, as the top bar's View. Change it there." The
Release page follows the same rule with the same note. A page shows its own
org picker only when it filters by org.

### Last test run

The Workspaces page's "Last test run" column shows each repo's latest test
run: its result (✓ or ✗), how long ago, and the pillar and environment on
hover. It reads the server's run history, so it shows runs started from any
browser or tab, and it survives a restart. The service's own state ("up 2h")
is shown apart from it, in the Health cell.

The history is `<state>/run-history.jsonl` (mode 0600): one line when a run
starts and one when it ends. Past 2000 lines it keeps the newest 1000.
`GET /api/runs/last` (read only) gives `{ repos: { <repo>: { id, pillar,
env, repos, startedAt, endedAt, exitCode, running } } }`. A run a restart
cut off has no end and is not shown.

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

| `secrets.provider` | What it is                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`             | No store. Nothing is resolved, no CLI is run; `den create` scaffolds this                                                                                                    |
| `env`              | Plain environment variables of the process running Den                                                                                                                       |
| `doppler`          | The `doppler` CLI (`secrets.doppler: { project, config }` for a default scope)                                                                                               |
| `1password`        | The `op` CLI (`secrets.onepassword.account` for the account, else your own `OP_ACCOUNT`; [a service-account token for a service](#1password-for-a-den-running-as-a-service)) |

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
| `sudo`               | The saved admin password, for sudo (auto-load, "Save to …")  |
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
config/acme.yml") instead of running a CLI. Typing the password always
works; only the saved password needs `refs.sudo`.

**Saving writes `refs.sudo` for you** (LK-4, 0.4.5). When `secrets.provider`
is `1password` or `doppler`, its CLI is available, and no `refs.sudo` is
set, the admin password prompt (shown when a command is about to run sudo)
still offers "Save to 1Password". Saving creates the item
(1Password: a Password item "<Product> admin password", field `password`,
in your default vault; Doppler: the key `<PREFIX>_LOCAL_ADMIN_PWD`) and
then writes that ref to `config/local/user.yml`, because the password is
the person's, not the distribution's. From then on it survives restarts.
A failed save writes nothing, and its error never carries the password.
`env` keeps nothing past the process, so it offers no save. A `refs.sudo`
in the distribution's config always wins over the one in user.yml.

`/api/sudo-password/vault-status` reports `backend`, `label`,
`configured`, `canSave` (saving works with no YAML to edit),
`backendAvailable`, `reason` and `hasStored` (`opAvailable` is a
deprecated alias of `backendAvailable`, kept for one minor).

**Den's sudo is `/usr/bin/sudo`.** Den checks and caches the admin
password with `/usr/bin/sudo` only, never a `sudo` found earlier on `PATH`.
Only on a machine with no `/usr/bin/sudo` does it look on `PATH`.
`DEN_SYSTEM_SUDO=<absolute path>` names another system sudo.

The admin password is for sudo, and nothing else (LK-0). It is no sign-in
and no access check: starting, stopping and resuming agents, sessions and
terminals, and a service whose commands run no sudo, never ask for it.
Den asks only when a command it runs is about to run sudo without it:
every service command (up, down, restart, setup, sync) gets a `sudo` shim
first on its `PATH`. With a password held, the shim gives it to sudo. With
none, sudo that needs no password (NOPASSWD, a warm cache) runs as it
would, and anything else never prompts: the shim prints
`<cli>: needs-sudo: sudo <command>` and fails, and the run's event stream
carries `{ "type": "needs-sudo", "command": "sudo <command>", "step":
"<service>" }` (sudo's own "a password is required" counts too, without
the command). Only then does the page ask, saying "`sudo <command>` needs
your admin password", with the 🔑 chip in the top bar while it waits. It
asks the server first (another tab or device may have set it), then, when
a password is stored, loads it from the vault (a page view alone never
wakes the vault), and only then shows the password field, always on top,
even over a dialog. After the password, the action runs again.

Settings › Command line › Admin password says whether it is saved ("Saved
in 1Password", "Saved for this session" or "Not saved"), with **Forget**:
`POST /api/sudo-password/forget` drops the password the server holds and,
when this server saved it to the vault or loaded it from there, clears the
vault's copy. `GET /api/sudo-password/status` answers `set`,
`passwordless`, `saved` (`vault`, `session` or null) and `vault` (`{
configured, label }`, read from the config alone).

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

## 1Password for a Den running as a service

A Den started by launchd or systemd does not read your login shell, so
`op` has no `OP_SERVICE_ACCOUNT_TOKEN` and every 1Password ref fails.
`secrets.onepassword.token` says where this machine keeps the
service-account token. It is per machine: Den reads it from
`config/local/user.yml` only, and a value in the distribution's config is
ignored.

```yaml
# config/local/user.yml
secrets:
  onepassword:
    token: keychain:op-service-account # or file:~/.config/op/token | env:OP_SERVICE_ACCOUNT_TOKEN
```

| Value                | Where the token comes from                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `keychain:<service>` | macOS: `security find-generic-password -s <service> -w`, run with no shell. Refused on other systems                     |
| `file:<path>`        | A file whose mode is exactly 600 (a group or other bit refuses it). `~` expands; a trailing newline is dropped           |
| `env:<VAR>`          | The env var `<VAR>` of the process running Den. With no key set the default is `env:OP_SERVICE_ACCOUNT_TOKEN`, as before |

- **Checked at config load.** A value that is none of these shapes is
  refused, naming `secrets.onepassword.token`. The message never repeats
  the value.
- **Read each time.** The token is read when a ref is resolved, never
  cached or written anywhere, and passed only in the `op` child's env as
  `OP_SERVICE_ACCOUNT_TOKEN`. It is never in a log, an error, the activity
  records or an API response.
- **Why a ref failed.** A `secret_env` key that does not resolve says why,
  in plain words: no service-account token or session; no access to the
  vault; item or field not found; rate limited; or a short summary of
  what `op` said. When the token source itself fails (the keychain item is
  missing, the file's mode is wrong, the env var is unset) the message
  names the source, never the token.
- **doctor.** With `secrets.provider: 1password` and a source that yields
  no token, `doctor` adds a `1password` row: "this process has no
  service-account token. Set secrets.onepassword.token." It is a warning,
  not a failure (a signed-in `op` app needs no token). `doctor` only looks
  a keychain item up; it never reads the token.
- **Settings.** Settings › Secrets shows the source (`keychain: <service>`,
  `file: <path>`, `env: <VAR>` or "not set"), never the token.

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
- **One edge per `edge.org` per machine.** The edge's container and Compose
  project are named after `edge.org` (`<org>-edge`), whatever its state dir
  (`DEN_EDGE_DIR`). Give a scratch or test root that points `DEN_EDGE_DIR`
  (and `DEN_HOME`) elsewhere an `edge.org` of its own: the name comes from
  the org, so nothing else keeps it apart. The edge container is labelled
  with the state dir that owns it (`den.edge.root`). Edge up, edge down and
  stack up (which brings the edge up first) refuse to touch an `<org>-edge`
  another state dir owns. They start nothing and exit non-zero: "edge
  acme-edge belongs to <its dir>; not replacing it". An unlabelled edge
  (from before 0.3.0-dev.40) is adopted only from the default state dir,
  never under an overriding `DEN_EDGE_DIR`. The only override is
  `edge up --take-over`. (0.3.0-dev.40.)
- **A recreated edge keeps its routes.** After edge up creates, recreates
  or starts the edge, it rejoins the routed networks of every running stack
  whose routes file (`dynamic/stack-<project>.yml`) is in its state dir,
  one line per network. Stacks that are down, and projects with no routes
  file there, are left alone. (0.3.0-dev.40.)

## Hub

Connect an install to your company's Hub and every agent Den launches
gets Hub's tools: it can search Hub and publish docs and mocks there.
Without it, nothing about agents changes.

### Connect to Hub (HUB-1.7)

Settings › Agents › Hub: type Hub's address (or keep the one the
distribution set in `hub.url`) and press **Connect**. Hub opens; sign
in, pick the company and approve this install. Hub sends you back to
Settings, connected. Nobody copies a token or edits config.

- Den makes a PKCE verifier (S256) and a single-use state and keeps both
  in memory for 10 minutes. Hub's answer comes back to
  `<this Den>/hub/callback`, which trades the one-time code for the
  install's token server to server (`POST <hub>/connect/token`). A
  replayed or old state changes nothing.
- `/hub/callback` needs no sign-in: the session cookie is SameSite
  Strict, so Hub's redirect doesn't carry it. The state this server
  issued to a signed-in Connect, and the verifier only it holds, are
  what protect it. It then moves on to Settings by script, which carries
  the cookie again.
- Hub can only send the person back to https or to this machine, so
  open Den over https (its edge address), on localhost, or on a
  `<name>.localhost` address (an edge on this machine over http; RFC 6761
  keeps it on this machine) to Connect.
- When this Den has an edge address, Connect sends it as `den_url`:
  its https one, else an `http://<name>.localhost` one. Hub links back to Den with it when the browser came over
  loopback. A Reconnect sends it again.
- This install's label on Hub is `<cli> on <machine>`.
- The token is the install's (SEC-0), kept in the install's own secrets
  store when it keeps secrets: a 1Password item `<Product> Hub token`
  (field `token`), or a Doppler key `<PREFIX>_HUB_TOKEN`. Otherwise Den
  keeps it in `<state dir>/hub/token` (mode 0600, folder 0700). It goes
  to the store on stdin or into the file, never in a command line, and
  never to a page, a log or an API answer. If it can't be kept, Den
  revokes it on Hub at once.
- Connect writes `hub.url` (Hub's own address), `hub.token` (the store
  ref, or `file:<path>`) and `hub.mcp_url` (Hub's MCP address, as given)
  to `config/local/user.yml`.
- **Disconnect** asks first: "This revokes this Den's Hub key on Hub.
  Agents lose Hub until you Connect again." Then it revokes the token on Hub (`POST <hub>/connect/revoke`),
  then removes it here and clears `hub.token` and `hub.mcp_url`;
  `hub.url` stays, so Connect is one click. If Hub can't be reached,
  nothing is removed; **Remove it here anyway** removes it, and says the
  token still works on Hub until an admin revokes the install.
- A token Hub no longer accepts (revoked, or replaced by a newer
  connect) shows **Reconnect**. A role that may no longer connect Den
  installs says to ask a Hub admin; Den never retries it.
- Once connected, the rail has a **Hub ↗** link above Settings. It opens
  the company's page on Hub in a new tab, with the company in its tooltip
  and a count of the threads waiting on you (Hub's `unread`). A token Hub
  rejects, or a role it forbids, greys it, and it goes to Settings › Hub
  instead. Den looks at Hub for it once a minute while a page shows.

### Config

A distribution can preset Hub's address, or set everything by hand:

```yaml
# config/local/user.yml (or the org config; user.yml wins)
hub:
  url: https://hub.example.com
  token: { vault: Private, item: Acme Hub, field: token }
  # or the name of a secrets.refs entry: token: hub_install
  # or a source: token: "file:/path/to/token" (also keychain:, env:)
  mcp_url: https://hub.example.com/mcp # default: <url>/mcp
  allow_tools: true # the default: agents use Hub's tools without asking
  inbox_on_stop: nudge # the default; off: agents are never asked
```

- `hub.url` must be https. Plain http works only to this machine
  (`localhost`, `127.0.0.1`, `*.localhost`).
- `hub.token` is this install's Hub token (one per install), as a ref in
  this install's own secrets store (`secrets.provider`) or a source. Den
  never assumes a vault, item or field for it.

### What agents get

- Agents reach Hub through Den, never straight. Each agent's MCP config
  gets a server named `hub`: Streamable HTTP at Den's own
  `http://localhost:<port>/hub/mcp`, with
  `Authorization: Bearer ${DEN_ACTOR_TOKEN}`. That is the agent's own Den
  token, which Claude Code fills in from the session's env. Den's proxy
  then calls `hub.mcp_url` (default `<hub.url>/mcp`) with the install's
  token and plain headers naming the caller, taken from Den's records:
  `X-Den-Agent` (its name), `X-Den-Agent-Id` (its stable id, which Hub
  keys attribution on), `X-Den-Session` (its session), `X-Den-Workspace`
  and `X-Den-Repos` (the workspace's repos, `owner/repo`,
  comma-separated). Hub sets the company from the token and the project
  from the repos.
- The proxy (`/hub/<path>`) takes only an agent's own Den token. A
  person's token or a browser gets 403: people use Hub itself. It passes
  only Hub's paths for agents: `/mcp`, `/api/inbox`,
  `/api/notifications…`, `/api/import/packs…`, `/api/import/ds/…`
  (a design system), `/api/reports/…`, `/api/admin/fixtures/…` and
  `/api/admin/fold/…` (asking to fold one company into another). Anything else gets 404. The agent's own
  `Authorization` and any `X-Den-*` it sends are dropped. Redirects are
  passed back, never followed, and Hub's status and errors come back as
  they are. Bodies stream both ways, and Hub enforces its own size
  limits.
- Its prompt gets one line: "You can search Hub and publish docs and
  mocks there with the hub\_\* tools; your team and project are set from
  this Den install."
- The install's token stays in Den's server. It is never in an agent's
  files (its MCP config included), its env, a command line, a record, a
  log, a page or an API answer.
- `<cli> hub push <dir> [--request "<why>"]`, run by an agent, sends an
  import pack to Hub through the proxy. `<dir>` holds `pack.json` and
  `blobs/<sha256>`. It stages the pack, uploads the files Hub lacks (four
  at a time), and prints Hub's dry run. With `--request`, it asks a
  person to apply it and prints the link where they approve it in Hub.
  Outside an agent's session it is refused.
- `hub.allow_tools` (default `true`): agents use Hub's tools without
  asking (Den allows `mcp__hub` for every agent it launches). The token
  limits writes to this install's company, and Hub keeps every version.
  Set it to `false` and Hub's tools ask before they run, like any tool.
  An explicit deny in the install's own Claude Code permissions still
  wins. Settings › Agents › Hub has the checkbox (it saves to
  `config/local/user.yml`).
- `hub.inbox_on_stop` (default `nudge`): when a den-claude agent is
  about to stop, its Stop hook asks Hub through Den
  (`GET <den>/hub/api/inbox`, two seconds at most) how many comments wait
  on it. When that number went
  up since it was last told, the agent is asked once to carry on: "2 Hub
  comments wait on you: call hub_inbox, answer them (hub_comment) or say
  why not, then finish." Answered threads drop out of the count, so a
  new reply asks again. The hook sends the agent's own Den token from its
  env; no token is in the hook's command line. The count it last told
  is kept in the agent's files (`hub-inbox.json`). A Hub that is down or
  slow lets the agent stop. Set it to `off` and agents are never asked.
  A persona without Den's hooks still gets this check. codex and gemini
  agents don't have it.
- A Hub that is down, or a token that can't be read, never stops an
  agent: it starts without Hub.
- A running agent keeps the MCP servers it started with. When Hub is
  connected after it started (or disconnected), its row and pane say
  "Hub tools arrive on restart" (or "Hub tools go on restart"), with
  Restart on the pane. Restart waits for its turn to end, then stops it
  and resumes the same conversation, now with Hub's tools (`agents
restart <id>`; `--now` stops it at once). After Connect or Disconnect,
  Settings › Agents › Hub offers "Restart N agents at their next idle".
  `agents doctor` lists those agents. A restart is a person's: an
  agent's token is refused.
- An agent can ask Den about itself with the MCP tool `whoami`: its id,
  workspace, and whether Hub is connected and its tools are loaded. When
  Hub is connected but its tools are missing, it tells the person to
  restart it from Den. There is no token step for the agent or the
  person.

### Status

Settings › Agents › Hub shows Hub's address, connected or not, the
company (a link to it on Hub), your role, who signed in and this
install's label (from `GET <hub>/connect/whoami`), or why it can't
connect. `GET /api/hub` answers the same (never the token). `<cli>
doctor` has a Hub row: ✓ when connected, ⚠ with the reason when not,
and where to Connect or Reconnect. A Hub that is down never fails
doctor.

## doctor

`<cli> doctor` lists every strategy kind in the registry (secrets, tls,
session-backend): the one this distribution selects, whether nothing chose
it (implicit), and whether it can work on this machine, with the reason.
It only checks PATH (and, for session-backend, whether the PTY module
loads): it never runs a backend CLI, prompts, or prints a secret. It exits
1 when a strategy that will be used cannot work (an implicit secrets
default is used only when a secret is asked for, so it never fails
doctor).

```
Acme doctor: strategies

  secrets          none                 ✓ available: no secrets backend configured
  tls              mkcert (implicit)    ✗ unavailable: mkcert is not installed
    ⚠ edge.tls is not set; defaulting to mkcert with a local CA. Set edge.tls explicitly.
  session-backend  den-pty (implicit)   ✓ available: PTY module loaded
```

`session-backend` is never a doctor failure: nothing needs a session until
one is started (see Sessions).

`<cli> doctor --json` adds the onboarding checks (Node, git, Docker, the web
server, Den's MCP) and answers with one JSON object: see
[Set up by your agent](#up-doctor-and-mcp-connect).

doctor also reads the end of the local `.dev-metrics/events.jsonl` (at
most 8 MB of it, however big the file) and warns when one command, run
from one place, ran more than 600 times in an hour. That is almost always
an agent polling. It is a warning, never a failure, and nothing is sent
(see [Dev metrics](#dev-metrics-local-unless-you-opt-in)):

```
Acme doctor: dev-metrics (local, never sent)

  ⚠ looks like a polling loop: status in services/api, 1200 calls in an hour (2026-11-04T09:00:00Z–2026-11-04T09:59:57Z)
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

| Field            | Default              | What it names                                                                                                        |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `name`           | `den`                | The product; `[a-z][a-z0-9-]*`. Everything below derives from it                                                     |
| `cli`            | `<name>`             | The command shown in help, hints and the web UI                                                                      |
| `env_prefix`     | `<NAME>` (`-` → `_`) | Env vars: `<PREFIX>_ROOT`, `<PREFIX>_HOME`, `<PREFIX>_INVOKE_CWD`                                                    |
| `config`         | `config/<name>.yml`  | The org config, relative to the distribution root                                                                    |
| `manifest`       | `.<name>.yml`        | The manifest file a repo carries; the `.json` twin is also read                                                      |
| `state_dir`      | `~/.<name>`          | Per-user state: web server, daemons, logs, history (a relative path is relative to den.yml's directory, not the cwd) |
| `services_dir`   | `.<name>-services`   | Managed clones, relative to the distribution root                                                                    |
| `workspaces_dir` | `<name>-workspaces`  | Workspace checkouts, relative to the distribution root                                                               |

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

| Field     | Used for                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`    | The name people see: page titles and copy ("Sign in to Acme Den"), `--version`, doctor, the server agent's name, the banner fallback, the web route on the edge (`acme`) |
| `tagline` | The line under the banner                                                                                                                                                |
| `banner`  | The CLI and web server startup banner                                                                                                                                    |

Runtime names (env vars, files, directories) always come from `den.yml`,
never from the brand.

`brand.name` is used in pages and messages only when it is letters, digits,
spaces, `.`, `_` and `-` (up to 40, starting with a letter or digit), so
it can't break a page. Anything else (a quote, `&`, `<`) falls back to the
product name with its first letter upper-cased ("Acme-den"); the page
`<title>` still shows it.

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
keys. Such an error stops every command that touches orgs, the catalog,
clones or releases (exit 1, before any git call or write), and every web
API route that reads the config answers it as 422 `{ "ok": false, "error":
"<message>", "code": "config_invalid", "requestId": "<id>" }` (0.3: with
the `X-Request-Id` header; a page request gets the error page). A bad key
or value under `agents:` or `sessions:` (0.4.29) is the same 422 error,
naming its key (`agents.helpers.collapse_done: unknown key …`), but only
for the agent and session commands and routes, and the Agents page shows
the error page. Everything else carries on, and `<cli> doctor` names the
key. Without the new keys nothing
changes: `/api/orgs` is byte for byte what 0.2.7 answered. They need Den
0.2.8 or later.

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

A shared stack's identity is its checkout path, plus the branch only when
the workspace entry pins one. Den does not read the checkout's HEAD, so a
`git switch` in that checkout does not refuse its co-owners.

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

## Signing in

On localhost nothing asks you to sign in: every page, the agents and the
terminal work as they are, and the admin password (R8) is the only prompt,
asked only when a command Den runs needs sudo. Through the edge, a browser
the edge shows is on this machine asks for nothing either. Signing in is
for everything else: the edge for a client it can't place here (0.4.5), a
LAN address, or a bind that isn't loopback (`DEN_BIND_HOST`). From another
device, sign in with GitHub as the Den's owner, approve the computer with
the code its page shows, or open a one-time link (below, and
[Signing in with GitHub](#signing-in-with-github)).

There is no password. Reading `web.secret` (32 random bytes, mode 0600 in
the state dir, made at the first `web up`) proves you are this computer's
user, and the CLI does that for you:

```bash
./bin/acme web open        # start if needed, and sign this browser in (a new tab)
./bin/acme web login       # a one-time sign-in link and its code; waits until it's used
./bin/acme web login --no-wait  # the link alone (asks for no code), and return
./bin/acme web approve ABC-123  # approve the computer showing this code
./bin/acme web approve --list   # the computers waiting with a code
./bin/acme web sessions    # the signed-in browsers: id, created, last seen, host, user agent
./bin/acme web logout <id> # sign out one browser (an id prefix from `web sessions`)
./bin/acme web logout      # sign out every browser
./bin/acme web logout --all  # and rotate web.secret and revoke every agent's token
```

- **The link** is `http://localhost:<port>/auth?c=<code>`, with `&next=<path>`
  for where to land (`web login --next /settings`). The code works once,
  within `web.login_link_ttl` (5 minutes unless set; 30s to 60m, as `90s`,
  `5m` or `1h`, in `config/local/user.yml` or the team config), and only
  this server's secret makes one. `web login` shows the time left while it
  waits, on a terminal. It is printed
  only on the one line you asked for (`web login`, or `web up` when it
  couldn't open the browser), never logged. Through the edge or a LAN name,
  the cookie belongs to that name: `web login --host acme.acme.localhost`
  mints the link for an edge hostname (any edge domain or alias, a VPN name
  among them; its URL comes from the edge config, and a name the edge
  doesn't route here is refused, saying what to add), and
  `web login --origin http://<lan name>:<port>` for any other allowed name
  (the signed-out page there shows the exact command, under "Other ways").
- **`web login` waits** (0.4.5). Besides the link it prints an
  8-character code ("It asks for this code: ABCD-EFGH") and blocks until
  the link is used, then says who: "Signed in: Safari on macOS
  (100.64.0.7) at 10:42". Nobody within the minute: "Expired: nobody used
  the link", exit 1. The link's page asks for the code before it signs in,
  so the link alone is useless; once opened it waits 5 minutes for the
  code. A wrong code is refused; five burn the link ("Refused: too many
  wrong codes", exit 1), more than 20 wrong a minute (any link) are slowed,
  and the link still works once. The CLI asks the running server through
  its bearer and never logs the code. `--no-wait` prints the link alone and
  returns, as before (no code); with no server running `web login` does
  that too, and says so.
- **The cookie** (`den_session_<port>`) is HttpOnly, SameSite=Strict and
  Path=/, and Secure when the request came over HTTPS through the edge. The
  session lives server-side (`web-sessions.json`, 0600, in the state dir)
  and never expires: it ends at sign-out, `web logout`, or `web logout
--all`. The cookie asks the browser to keep it for 400 days, the most a
  browser allows. The 0.4.1-dev `web.session.idle` and `web.session.max`
  keys are ignored; the server logs a warning naming each one it finds.

  `web sessions`' LAST SEEN is written at most once a minute (60 s), so it
  equals CREATED right after a sign-in.

- **What needs it.** On loopback, nothing: pages and read-only calls are
  open, and changes (an agent's start or resume and the terminal included)
  need only the page's own Origin and CSRF token, which the shell sends.
  The Host allowlist, the Origin check and the CSRF token are what stop
  another site or a rebinding DNS name. From another machine, every page
  and call needs a signed-in browser (or a bearer). A page there shows
  "Sign in to <name>" and the ways to sign in (below); it never asks for a
  secret. `/api` answers 401 `signin_required`.
- **The signed-out page says where to act.** It names the machine Den runs
  on ("You're opening Den from another computer. Den runs on
  **studio**, so it needs to know this is you."), then:
  - **Sign in with GitHub**, only when a client id is set (below);
  - **Approve this computer**: a code (`XXX-XXX`) and the command that
    approves it, to run on that machine (`<cli> web approve <code>`), or
    Settings › Access › Waiting devices there. The page signs itself in
    when it's approved and goes to the page you asked for; it counts down
    the 10 minutes, and an expired code is a click away from a new one.
    From a computer with SSH access to it, the page gives the one-liner
    (`ssh <host> '<cli> web approve <code>'`) and, when the host is a name,
    an Open Terminal (`ssh://`) link. On Windows, which has no `ssh://`
    app by default, there is no link: the one-liner is the step, with
    "Open Windows Terminal or PowerShell, paste this, and press Enter."
    Elsewhere, if the page still has focus 2 seconds after a click on Open
    Terminal (no app took the link), it says "Nothing opened? Copy the
    command below and paste it into your terminal app.";
  - **Other ways**, collapsed: the one-time link with
    `web login --origin`.

  Every command the page prints names the machine it runs on and has a
  copy button. It is `<cli>` when the first `<cli>` on that machine's PATH
  is this distribution's, else the absolute path of its bin.

- **The machine's name** on the page is `web.machine_name` from
  `config/local/user.yml` (Settings › Access › Machine name), else the short
  host name (up to the first dot). It is never taken from the browser's
  Host. The ssh one-liner's target is the Host the browser used, without
  the port (the machine's host name if it had none).
- **The ssh account.** The ssh one-liner and the Open Terminal link log in
  as `<user>@<host>`, where user is the account the Den server runs as, so
  an SSH app doesn't fill in its own default. The note under the button
  says "Log in with your <machine> account (<user>) and its password, or
  an SSH key." `web.ssh_user` names another account (`config/local/user.yml`,
  else the distribution's `config/den.yml`; read at once). `web.ssh_user:
""` leaves the account off, for a distribution that doesn't want it on a
  page anyone on the network can see. It takes letters, digits, `.`, `_`
  and `-`; anything else is refused at start, naming the key.
- **Codes.** About 30 bits (Crockford base32: no I, L, O or U; typed in any
  case, the dash optional); the page polls with a separate 128-bit id. A
  code expires after 10 minutes and works once; at most five wait at once
  (a sixth drops the oldest). They live in the server's memory only.
  Approving is rate-limited (10 a minute) and recorded in the activity log
  with who approved, never the code. The new session is "approved with a
  code". **Deny** (Settings › Access, or `web deny` through the API) tells
  the page it was refused.
- **Seeing that you're signed in.** The chip at the foot of the rail says
  "Local" (this machine), "Signed in · this device" (a code or a one-time
  link) or "@<login>" (GitHub), and opens Settings › Access. The first page
  after a sign-in says "This device is signed in to Den on <machine>",
  once. Linked devices lists every session (GitHub, a code, a one-time
  link): how it signed in, when, from where (the address and the browser
  and OS), last seen, and **Revoke**; the one you're using says "This
  device".
- **The edge counts as local only when it shows the client is.** A
  request for the edge hostname from the edge (an edge peer, below) is
  treated as loopback (no sign-in on any route, the agents and the
  terminal included) when the client the edge reports is this machine.
  Host, Origin, CSRF and the agent-token rules still apply. Who the client
  is comes from the right-most `X-Forwarded-For` entry, the one the edge
  itself appended (anything left of it came from the client, and is never
  believed):
  - loopback, or one of this machine's own interface addresses (a LAN
    address, or a VPN's such as a Tailscale `100.x`): local, no sign-in;
  - missing, or a container/VM network's address (the Docker ranges, or a
    subnet of one of this machine's Docker/OrbStack/VM bridges): Den can't
    tell (Docker Desktop and OrbStack on macOS hand the edge their
    gateway's address, and a TCP passthrough in front of the edge hides the
    client), so it signs in: `web.edge_unattested`, below;
  - any other address: another machine, which signs in.

  `web.edge_unattested: local` in `config/local/user.yml` counts a client
  Den can't place as local again (0.4.4's behaviour). It is read only from
  that file (a choice for that machine); the distribution config's key is
  ignored with a warning. The default is `signin`. A request straight to
  the server's port on localhost (loopback Host and peer) never signs in.
  With `DEN_BIND_HOST` beyond loopback (a deliberate exposure, other than
  the Linux edge's Docker bridge address) the edge always signs in.

- **The edge believes forwarded headers only from its own networks.** Den
  renders each entrypoint with `forwardedHeaders.trustedIPs` set to
  loopback and the Docker ranges (`127.0.0.1/32`, `::1/128`,
  `172.16.0.0/12`, `192.168.65.0/24`), never `forwardedHeaders.insecure`,
  so a client can't hand the edge an `X-Forwarded-For` of its own. An
  `edge.args` entry that sets `forwardedHeaders` or `proxyProtocol` is
  dropped, and `edge up` says so.
- **A TCP passthrough in front of the edge** (a gateway that publishes
  `:443` and passes TLS through) hides the client: the edge sees the
  gateway's address. Have the gateway send the PROXY protocol, and list it
  in `edge.proxy_protocol.trusted_ips` (empty by default; IP addresses or
  CIDRs; `config/local/user.yml`'s list replaces the team's):

  ```yaml
  edge:
    proxy_protocol:
      trusted_ips: [172.18.0.5]
  ```

  Every entrypoint then takes the PROXY protocol from those addresses, and
  the client it carries is what Den sees. Configuring the gateway is the
  gateway's job.

- **`edge up` recreates the edge when its command changed.** It compares
  the running edge's command with the one it renders and says why ("acme-edge's
  settings changed (forwarded-header trust): recreating it once. Routes
  drop only while it restarts."). Upgrading to 0.4.5 does this once.

- **"Your edge is reachable from other machines".** When Den can tell, at
  start, that the edge is reachable beyond this machine (an edge hostname
  that resolves to an address that isn't loopback, such as a LAN or
  Tailscale address, or the edge container publishing a port on every
  interface, from `docker inspect`), it writes "Your edge is reachable from
  other machines. A browser it can't place as this one signs in first
  (Sign in with GitHub, or a pairing link)." once to `web.log`, and every
  page shows it as a banner (dismissed per browser). With
  `web.edge_unattested: local` it says instead that anyone it can't place
  can use terminals, and to remove the key to have them sign in.
- **localhost is the canonical name.** A cookie set on `localhost` isn't
  sent to `127.0.0.1`, so the links Den prints use `localhost`.
- **Browsers.** Chromium, Firefox and Safari 16.4 or later: a sign-in link
  needs the browser to send `Sec-Fetch-Site` or `Origin`.
- **Scripts and the CLI** are unaffected: the CLI and the MCP server send
  the person token (`web token --print` prints it for curl). After `web
logout --all` the old token is refused; the CLI reads the new one.
- **`web logout --all` is the "something leaked" button.** It signs out
  every browser, rotates `web.secret` (every person token is void) and
  revokes every agent's token: a running agent's next call gets 401
  `token_revoked` ("restart or resume the agent to get a new one"). Plain
  `web logout` (one browser, or every browser) leaves agent tokens alone.
- **Another machine.** `DEN_BIND_HOST=0.0.0.0` (or any non-loopback
  address) starts only with `web.allow_plain_http_remote: true` in
  `config/local/user.yml`, since a session cookie would otherwise cross the
  network in clear text. Having the edge in front is not enough: the
  server's own port would still answer plain HTTP on every interface. Only
  `config/local/user.yml` is read (a choice for that machine); the key in
  the distribution config is ignored, and the server logs a warning naming
  the file. With it, the machine's own addresses and host name are accepted
  with the port, and every route there needs a session.
- **The edge** reaches Den on loopback (macOS, through
  `host.docker.internal`), so it needs no other bind. On Linux, where the
  edge container reaches the host on the Docker bridge, the one other bind
  allowed without the key is the bridge address (`172.16.0.0/12`, for
  example `DEN_BIND_HOST=172.17.0.1`), and only with the edge configured.
- **The edge hostname is believed only from the edge.** A request whose
  `Host` is the edge hostname is accepted only from a peer the edge could
  be (loopback, the Docker bridge range or Docker Desktop's VM network);
  from any other address it is
  421 `misdirected`, so a LAN client can't send the edge's name straight to
  the server's port.

## Signing in with GitHub

A Den has one owner: a GitHub account. Once it is linked, that account
signs in from any device (a phone, another laptop, a browser through the
edge) with **Sign in with GitHub** on the signed-out page. Den stores only
the account's id and login, never a token, and no other account gets in.

```bash
./bin/acme web owner link    # link the owner: GitHub's device flow, in the terminal
./bin/acme web owner         # show who it is (also: web owner show, --json)
./bin/acme web owner unlink  # forget the owner (signed-in browsers stay signed in)
```

- **`web owner link`** prints `https://github.com/login/device` and a code.
  Enter the code there and approve; Den asks GitHub who approved, stores
  `owner: github:<id>` and the login in `web-owner.json` (0600, in the
  state dir) and throws the token away. A second link is refused until
  `web owner unlink`. Settings › Access does the same in the browser
  (Link your GitHub account, Unlink): shell-grade actions, for a signed-in
  browser and never an agent's token.
- **Sign in with GitHub** on the signed-out page shows the same three
  steps whether or not an owner is linked:
  1. On the machine Den runs on, run `web owner link`, or use
     Settings › Access there.
  2. It shows a code. Enter it at `github.com/login/device` and approve.
  3. Come back to the signed-out page and press **Sign in with GitHub**,
     with the same GitHub account.

  Once an owner is linked, step 1 shows as done ("Owner: @<login>") and
  the button follows the steps; before that there is no button. Below the
  steps the page says only the owner's GitHub account can sign in this
  way, and that anyone else uses **Approve this computer**; **Learn more**
  opens this section. With no owner yet, the page watches (the session
  probe, `GET /api/session`, says `github.state` to a signed-out
  browser): once the owner is linked on the machine, step 1 shows done
  and the button appears, with no reload.

- Pressing the button shows a code and `github.com/login/device`. The
  server runs the flow, and when the owner approves it sets the same
  never-expiring session cookie a one-time link sets, and the page reloads
  signed in. Another account sees "@<login> isn't the owner of this Den.
  Only the owner's account can use Sign in with GitHub. Use Approve this
  computer instead." Den has one owner, so there is no one to add. The
  token is thrown away either way. At most three sign-ins wait for GitHub
  at once; a code expires as GitHub says (15 minutes).
- **Settings › Access** lists the linked devices (the browser, how it
  signed in, the client address when the edge vouched for one, created and
  last seen; "This device" on yours), each with **Revoke**, which ends its session at once (its
  open terminals included). **Pair a device** makes a one-time link and a
  QR code for an edge hostname you pick (`web login --host <name>` in the
  browser): scan it on the other device before it expires
  (`web.login_link_ttl`; the page counts down).
- **`web.github_client_id`** is the GitHub App's client id (public; no
  secret). The default is Den's own App, **Monster Orange Den**
  (`Iv23liKL12gnN6WvRV5b`), so Sign in with GitHub works out of the box. A
  distribution that ships its own App sets its client id here (below);
  `config/local/user.yml`'s wins over the team's. An empty value
  (`github_client_id: ""`) turns Sign in with GitHub off: the page then
  offers the code and the one-time link only.
- **Expiring tokens.** If the App hands out expiring tokens (GitHub's
  answer carries `expires_in` or a `refresh_token`), sign-in still
  completes, and Den says once, in the log and on stderr, to switch off
  token expiry in the App's settings ("Expire user authorization tokens");
  it never prints the token. `GET /api/web/owner` reports it as
  `tokenExpiry: true`.

### A company's Den: every developer connects GitHub from the browser

The common shape: a company makes its own Den repo (`create`), pushes it to
its GitHub org, and every developer clones it and runs their own instance
on their own machine. Everyone opens the same URL (an edge name such as
`https://den.local.<your zone>`, whose DNS says 127.0.0.1) and connects
their GitHub account there, with no terminal and nothing to explain.

```yaml
# config/<name>.yml (the team's, committed): who may claim an instance
web:
  allowed_github_org: acme
```

- **`create` writes it**: `--github-org <org>`, else the GitHub owner of the
  repo the new folder is in. Neither: a commented line and a next step.
- **`web.owner_github`** (`config/local/user.yml`, per machine) is the
  GitHub login of whoever runs this instance. `web up`, `web restart` and
  `service install` record it from `gh` (`gh api user`) when `gh` is signed
  in, no owner is linked and it isn't set, and print it. Only the login is
  kept. This is the path most people take: org memberships are private
  by default. When `gh` isn't signed in, `web up` and `doctor` say so,
  with the fix (`gh auth login`, then `web restart`; or set
  `web.owner_github` yourself).
- **The signed-out page leads with Connect your GitHub account** while the
  instance has no owner and one of the two is set. Who may claim it:
  - **A member of `allowed_github_org`, on this computer.** **This is my
    computer** navigates to `http://localhost:<port>/attest` and straight
    back: only a browser on the machine Den runs on reaches it there. It
    returns with a short-lived (2 minutes), single-use code, signed with
    `web.secret`, bound to the edge hostname, in the URL fragment (never
    sent to a server or logged), and only to one of this Den's own edge
    hostnames. The page then starts Sign in with GitHub with it; when
    GitHub says the account is a member of the org, it becomes the owner
    and the browser is signed in. This exists because Docker Desktop,
    OrbStack and a TCP passthrough show the edge a gateway's address, so
    Den can't tell a browser on its own machine from another one.
  - **`owner_github`'s login, from any browser** (a devbox you reach from a
    laptop).
  - **Anyone else is refused, with the reason**: not a member of the org;
    a member, but not on this computer; not the login `owner_github` names.
    The proof alone never signs a browser in: any program on the machine
    can reach localhost, so the GitHub approval is always the person's.
- **Membership.** Den asks GitHub with the sign-in's own token: the
  account's own membership (`GET /user/memberships/orgs/<org>`, which needs
  the App to have the org's Members (read) permission), then the public
  member list. A private membership the App can't read is refused, saying
  so: make the membership public, give the App that permission, or set
  `web.owner_github`.
- **Neither set**: the page names both settings and offers no claim.
  `doctor` shows who may claim the instance, and fails (✗) when neither is
  set and the edge is reachable from other machines.
- Once claimed, it is an ordinary owner: Sign in with GitHub from any
  browser, as above.

### The GitHub App (once, by whoever ships the Den)

Den's default App is Monster Orange Den. A distribution that wants its own
(its name on GitHub's approval page) needs a GitHub App with the device
flow on. Create it once (organization or account › Settings › Developer settings › GitHub
Apps › New GitHub App):

1. No callback URL; untick "Request user authorization during
   installation". Webhook off.
2. **Enable Device Flow**: ticked. The device flow needs only the client
   id.
3. **Expire user authorization tokens**: off. Den never asks for
   `offline_access`, and keeps no token either way.
4. Account permissions: none. Den reads only `GET /user` (the id and the
   login), which needs none. Repository permissions are only for features
   that act on a repository (Den's default App has Issues for feedback).
5. **Where can this GitHub App be installed**: Any account. GitHub lets only
   members of the owning organization authorize a private App, so anyone
   else couldn't sign in.
6. Put the **Client ID** in `web.github_client_id`. Never generate or
   share a client secret or a private key for Den: it never uses one.

## Running the web UI as a service (macOS)

Den ships a launchd installer that runs the web UI and the session host (every
terminal and agent) as launchd jobs, restarted if they exit:

```bash
./bin/acme service install                # install (or refresh) and start them
./bin/acme service install --mode always  # meant to keep them running across logout (opt-in, not yet proven)
./bin/acme service install --plan  # what install would do; writes and loads nothing
./bin/acme service status      # launchd's view: state, pid, last exit code
./bin/acme service print       # the web plist it would install; installs nothing
./bin/acme service uninstall   # stop them and remove their plists
```

With the service installed, `web` works through launchd. `web restart`
restarts the job (`launchctl kickstart -k`) and names its new pid and the
service's log. `web up` starts the job when it isn't answering. `web down`
refuses, because launchd would only start it again: use `service
uninstall` to stop it. Under `always`, restarting needs sudo, so `web
restart` prints the `sudo launchctl kickstart -k system/<label>` line for
you to run.

### Login or always

| `--mode`          | Jobs                                                  | At logout                            |
| ----------------- | ----------------------------------------------------- | ------------------------------------ |
| `login` (default) | LaunchAgents in the desktop session (`gui/<uid>`)     | stop, with every agent               |
| `always`          | LaunchDaemons that run as you (`UserName`), from boot | meant to keep running, and so agents |

`always` is opt-in and not yet proven across a logout: no logout has
shown it keeping an agent on the same conversation yet. Use `login` unless
you are testing it.

`always` takes your admin password once (sudo writes and loads the
LaunchDaemons in `/Library/LaunchDaemons`); it is never asked for again.
Without `--mode`, install keeps the mode already installed, so re-running it
after an upgrade never changes it. Switching mode removes the other mode's
jobs: never both. Use `always` on a machine you reach from elsewhere (ssh, a
browser on another machine); `login` on a laptop.

A process outside the desktop session has no login keychain and no GUI. So
under `always`, agents use:

- **1Password**: the service-account token (`secrets.onepassword.token`),
  not the desktop app. `doctor` warns when this process has none.
- **Browsers**: headless Chromium and Firefox. WebKit on macOS needs a
  desktop session; run it from Playwright's Linux image instead
  (CONTRIBUTING.md, `DEN_PW_WS`).
- **Protected folders** (other volumes, Desktop, Documents): Full Disk
  Access, granted once (below).

Each session records the launchd session its host ran in, and the Agents page
tags it: **Stops at logout** (the desktop session; tap it for the fix) or
**No GUI** (kept across logout). `web up` from an ssh shell (a Background
session) says the same before it starts a server there.

### The session host job and Full Disk Access

Both modes install the session host as its own job, `<label>` with `.web`
replaced by `.sessions` (`local.acme.sessions`), so it runs in the mode's
session whoever starts the first terminal; `<cli> sessions` and agents then
wait for it rather than starting a host in the caller's session. It runs a
copy of node Den owns, `<stateDir>/bin/<cli>-sessions-host` (0700), and
macOS grants Full Disk Access to that path: never to the shared node, which
would give it to every node program. To grant it: System Settings → Privacy &
Security → Full Disk Access → + → that path (⌘⇧G to type it), then
`<cli> sessions host --stop` (it restarts with the grant). Agents inherit it.

Install refreshes the copy when node changes. An official node build
(nodejs.org, nvm) is signed by the Node.js project, so the grant holds across
upgrades; install says when the signer changed and it must be granted again.
An ad-hoc signed node needs a new grant after every change, and Homebrew's
node loads libraries beside it and can't be copied: install then runs it
directly and says so. `doctor` shows whether the host has Full Disk Access,
and the path to grant.

### What doctor shows

`doctor` ends with **where it runs**: the web server's and the session host's
launchd session (a warning with the fix when it stops at logout), Full Disk
Access, and the service: its mode, or `plist present, job not loaded:
launchctl bootstrap <domain> <plist>` (`sudo` for a LaunchDaemon) when launchd
has dropped a job whose plist is still there.

### Running means the job's own process

A plain `web up` server of the same install on the port would answer for the
job, which then fails to start on the taken port and restarts forever. So
install stops a plain server of this install first (and says so), and says
`running` only when the server answering is the job's own process (its pid is
launchd's). Otherwise it says `port <N> is served by pid <P>, not the job`
and exits 1; `status` says the same.

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

| Variable               | Default                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `DEN_ROOT`             | required in a distribution                                              |
| `DEN_SERVICE_LABEL`    | `local.<distribution dir name>.web`                                     |
| `DEN_SERVICE_LOGS`     | `~/Library/Logs/<distribution dir name>`                                |
| `DEN_SERVICE_NODE`     | see below                                                               |
| `DEN_SERVICE_MODE`     | `login` (or `always`)                                                   |
| `DEN_SERVICE_HOST_EXE` | none: the host runs that node (`<cli> service install` sets Den's copy) |

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
./bin/acme mcp --workspace north --actor agent:planner
```

`--workspace <ws>` and `--actor agent:<id>` (both or neither) scope the server
to one workspace for one agent:

- **Pinned.** A tool that takes a `workspace` gets `<ws>`. The server
  registers each workspace tool with "This workspace only" in its
  description and without the `workspace` parameter (with grants it stays,
  a name whose description lists `<ws>` and the granted ones; any other
  name gets the refusal below, not a schema error). A call naming another
  workspace is refused
  (`Refused: <tool>: this MCP server is scoped to workspace "<ws>"
(agent:<id>; no grants); "<other>" is another workspace`; with grants,
  `grants: <a>, <b>`) before anything reaches the web server. The refusal
  says how to get more: a person adds `<other>` to `agents.<id>.grants` in
  the org config and restarts the agent; an agent can't grant itself one. A
  refused call is recorded in the activity trail, read tools included.
- **Says so.** Every scoped answer (`status`, `services`, `applications`,
  `graph`, `stacks`, `workspaces`) carries a `scope` block: the workspace
  shown, how many other workspaces there are and how much it leaves out,
  for example `hidden: { repos: 6 }`, and a note pointing at `org_summary`.
  A scoped `graph` is the workspace's own repos and the edges out of them
  (`map: "workspace"`, with `outside` naming the repos they depend on
  elsewhere). Unscoped with no `workspace` it is the org-wide map
  (`map: "org-wide"`: every active workspace's graph merged, `workspaces`
  naming them); with one, that workspace's (`map: "workspace"`).
- **Filtered.** `workspaces` lists `<ws>` only. `logs_search` and `logs_tail`
  take only `<ws>`'s services, `manifest_validate` and `manifest_draft` take
  only an absolute path inside one of its repos (or, for `manifest_validate`,
  the content), and `workspace_sync` syncs `<ws>`. `repos_detect` is refused:
  scanning folders reaches outside any workspace, so onboarding is for the
  unscoped server.
  Tests run against the focused workspace, so `tests_available` and
  `run_tests` are refused unless `<ws>` is the focused one.
- **Not workspace data**, served as unscoped: `environments`,
  `security_latest`, `release_status`, `edge_status`, `onboard_status` (counts
  and checks only) and `org_summary` (the org's and the distribution's, not
  a workspace's).
- **The org at a glance.** `org_summary` gives every agent every workspace
  and repo with status counts, the graph, the edge and the environments
  (see [Tools](#tools)). Detail and actions stay scoped: for workspaces
  other than `<ws>` it carries names and counts only, never logs, env
  values, commands, URLs, paths or check output.
- **Stamped.** Every web API call carries `x-den-mcp-agent: agent:<id>` and
  `x-den-mcp-workspace: <ws>` beside the usual audit headers. The activity
  entry gains `agent` and `workspace`, and the log line reads `· by
agent:<id> <client> <version> (workspace <ws>, mcp pid <pid>, session
<id>)` for every exec, run and sync.
- **Granted.** `--grant <other>` (repeatable) also serves `<other>`, but only
  when the org config's `agents.<id>.grants` lists it; otherwise the server
  exits 2 (an agent can't grant itself one). A call naming a granted
  workspace is reported to the web server before it runs, and its activity
  entry names both (`workspace` and `targetWorkspace`; the log line reads
  `▶ <tool> in workspace <other>, under a grant to agent:<id> of workspace
<ws>`). `GET /api/activity?address=workspace:<ws>` lists these entries
  under either workspace. `workspaces` lists `<ws>` and its grants, and tests run when either
  is focused. Logs and `manifest_validate` stay on `<ws>`'s own services.
  `agents start` passes an agent's grants for you (see [Agents](#agents)).
- `<ws>` must exist in this distribution; until it does, every tool says so.
  The id is letters, digits, dots, dashes and underscores (at most 64). A bad
  or half-given scope is a usage error, exit 2. `--list` and `--call` take
  the scope too: they list and validate against the pinned tools, as the
  server registers them, and `--call` names its scope on stderr
  (`acme mcp --call: scoped to <ws> as agent:<id>`).

**It binds cooperating agents only.** The scope lives in the MCP server's
process. The web server's HTTP API does not check it yet, so an agent that
calls the API itself (curl, a browser) is not held to its workspace. Enforcing
the scope in the HTTP server is WS-3a, planned for 0.4. `mcp connect` still
registers the unscoped server; to hand one agent a scoped server, add it to
that agent's config yourself, for example in a project's `.mcp.json`:
`"args": ["mcp", "--workspace", "north", "--actor", "agent:planner"]`.

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

`mcp` takes only the arguments its usage lists. Any other (a typo such as
`--worksapce`) exits 2 with the usage, before anything starts.

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
  approvals: true # the default: the held writes, each run on the person's Allow
```

An unknown action or environment name is an error, so a typo never turns a
guard off; so is an `approvals` that isn't `true` or `false`. See
[Onboarding writes, held for the person](#onboarding-writes-held-for-the-person).

### Tools

Read tools (always registered):

| Tool                | Web API                                    | What                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`            | `/api/health`                              | Service health: `counts`, then each service's `state` (`up`, `down`, `redirect`, `pending`, `unknown`, `not-checked`) and, without a plain verdict, `why`; `url` (HTTP check) or `check` (shell, or `container <project>/<service>`); `ok` true up, false down, null not known |
| `services`          | `/api/services`                            | Services, their mode (managed or dev-managed) and commands                                                                                                                                                                                                                     |
| `applications`      | `/api/applications`                        | Org > Application > Repo > Services                                                                                                                                                                                                                                            |
| `graph`             | `/api/graph`                               | The derived dependency graph (`map: "org-wide"`, every active workspace's; with `workspace`, that one's and its startup order; scoped, the workspace's own)                                                                                                                    |
| `workspaces`        | `/api/workspaces`                          | Workspaces, active and focused                                                                                                                                                                                                                                                 |
| `environments`      | `/api/environments`                        | The enabled environment names (never their values)                                                                                                                                                                                                                             |
| `logs_search`       | `/api/logs/search`                         | Search services' full log history                                                                                                                                                                                                                                              |
| `logs_tail`         | `/api/service/taillog`                     | The last lines of a service's log (bounded, no follow)                                                                                                                                                                                                                         |
| `tests_available`   | `/api/modules`, `/api/test-sources`        | A pillar's modules and the repos they come from                                                                                                                                                                                                                                |
| `security_latest`   | `/api/security/latest`                     | The newest security scan per mode                                                                                                                                                                                                                                              |
| `release_status`    | `/api/release/runs`, `/api/release/status` | Recent CD runs, and an env's deployed-version table                                                                                                                                                                                                                            |
| `manifest_validate` | `/api/manifest/validate`                   | Validate a manifest by path or content                                                                                                                                                                                                                                         |
| `stacks`            | `/api/stacks`                              | What `stack ls/ps/health` show: project, routes, health; an empty list says `why`                                                                                                                                                                                              |
| `edge_status`       | `/api/edge`                                | The edge: up or down, its routes and cert names; `https` (TLS strategy, who supplies the cert, whether HTTPS is serving)                                                                                                                                                       |
| `org_summary`       | several (read only)                        | Every workspace and repo with status counts, the graph, the edge and the environments; scoped, `yours` adds your workspace's services                                                                                                                                          |
| `onboard_status`    | `/api/onboard/status`                      | What's set up and the one next step: `checks` (`ok`, `warn`, `todo`) and `next` (`step`, `command`); see [Onboarding reads](#onboarding-reads)                                                                                                                                 |
| `repos_detect`      | `/api/onboard/repos`                       | The git repos in `path` (one or two levels down), how each runs, and suggested `workspaces`; never writes or follows a symlink; refused on a scoped server                                                                                                                     |
| `manifest_draft`    | `/api/onboard/manifest`                    | The side-car `repo add` would write for `path`, validated (`draft`, `validation`), nothing written; `ask` and `choices` when it can start in several ways (call again with `run`)                                                                                              |

**Health states.** A service with no verdict says why in `why`: no health
check in the manifest for the env, remote with no check or `target.url`
for its env, not deployed in the env (no commands and no check there), no
manifest, or checked but no answer yet. A redirect (`302 → /login`) is
`redirect` with its status and target (the query is dropped), not down:
something answered. It is never green either, so an unexpected redirect
(an ALB answering for a stopped service) is not taken for up; list the code
in `target.expect` to count it as up. The web health row and `<cli> status`
use the same rule: the web row shows a redirect muted (with `status` and `redirect`
in `/api/health`), and `<cli> status` as `redirect 302 → /login`.

**`org_summary`** reads `/api/workspaces`, `/api/health` (local, every
active workspace), `/api/graph`, `/api/edge` and `/api/environments`:

- `workspaces`: each workspace's name, whether it is active, focused or
  yours, its state (`running`: every checked service answers; `partial`:
  some are down; `stopped`: all checked ones are down; `unknown`: nothing
  checked; `inactive`: not polled), its counts (up, down, redirect,
  pending, not checked) and its repos, each with its rolled-up state.
- `graph`: the org-wide map, every active workspace's repos merged (each
  workspace's graph from the web server; `workspaces` names them, and
  `unavailable` any whose graph failed), repo names and edge kinds only (no
  evidence, paths or URLs).
- `edge`: up, state, domains, the route count and `https`.
- `environments`: the enabled names, never their values.
- scoped, `yours`: your workspace's services as `status` gives them.

**`edge_status.https`** says which TLS strategy is in use (`mkcert`,
`files`, `none`), who supplies the cert (`den`, or `distribution` under
`tls: files` and the legacy `issue_cert: false`) and whether HTTPS is
serving: a TLS handshake on the edge's published https port (`serving`
true or false, null when a proxy in front owns the port), with `detail`.
`certIssuedByDen` replaces `certIssued`, which is kept for 0.4.4 with a
note in `deprecated`: it said whether Den minted the cert, so it was
`false` under `tls: files` while HTTPS worked. `edge status` prints the
same `https` line.

Action tools (only those named in `mcp.actions`): `service_up`,
`service_down`, `service_restart` (through `/api/service/exec`),
`workspace_sync` (`/api/workspace/sync`) and `run_tests` (`/api/run`). There
is no deploy tool.

`agent_resume` (AG-14.4) resumes a stopped or interrupted agent, for an
orchestrator. It is off unless `mcp.actions` names it. A scoped server
(`--workspace`) resumes agents of its own workspace or a granted one, never
itself. The web server checks the same rule, and the resume route is the
only agent route an agent's token reaches.

`agent_import` (AG-17.1) brings in a conversation started outside Den as an
agent: with no `session` it lists them, with `session` and `persona` it
brings one in (see [Bring in a conversation](#bring-in-a-conversation)). It
is off unless `mcp.actions` names it, and a scoped server reaches its own
workspace or a granted one. Without it, an agent's token gets 403 on both
the list and the import.

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

## Sessions

A session is a terminal that keeps running when the web server restarts:
an argv in a PTY, owned by the distribution's **session host**. The host
is one small detached process (`<cli> sessions host`) that the first
client starts on demand; it serves `<stateDir>/sessions.sock` (mode 0600)
and logs to `<stateDir>/logs/<cli>/sessions-host.log`. The state dir is
the profile's `state_dir` (`~/.<name>`), or `<PREFIX>_HOME`.

```
<cli> sessions start --workspace <ws> --name <n> [--cwd <dir>] [--keep-env NAME…] -- <argv…>
<cli> sessions list [-w <ws>] [--json]
<cli> sessions attach <name|id>          # ctrl-] detaches; the session keeps running
<cli> sessions kill <name|id> [--signal INT|TERM|KILL]
<cli> sessions host [--stop]
<cli> agents list -w <ws> [--json]
```

- A session is named `<dist>-<ws>:<n>`. `list -w <ws>` and `agents list
-w <ws>` show that workspace's sessions only. Elsewhere a session can be
  named in full, as `<ws>:<n>`, as a bare `<n>` only one session has, or by
  its id.
- It runs in `--cwd` (default: where you ran the command). Its environment
  starts empty and gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
  `TERM` (default `xterm-256color`), `COLORTERM`, `LANG`, `LC_*`, `TZ` and
  `TMPDIR` from yours; `start` names the variables it left out (names, never
  values). `--keep-env NAME` adds one more: one exact name per flag,
  repeatable, no globs. It is audited: the session host's log
  (`<stateDir>/logs/<cli>/sessions-host.log`) gets a line naming each kept
  variable and who asked, never its value, and says `credential-shaped` when
  the value or name looks like a credential (it is still passed: you named
  it). An agent can't use it: `agents start` has no `--keep-env`, and
  `sessions start` refuses it when run by an agent (`DEN_AGENT` is set).
  Every runtime's `scrubEnv` (den-claude: `CLAUDECODE`, `CLAUDE_CODE_*`) is
  removed last, even a name you kept.
- Every attachment gets all of its output; attaching prints `[attached to
<name>]`, then replays the scrollback (2 MB per session, kept in
  `<stateDir>/sessions/<id>.log`).
- Stopping the host (`sessions host --stop`, or a reboot) ends its
  sessions. They stay listed as exited, with their scrollback, until
  `sessions kill` removes them.
- `sessions.max_concurrent` caps the plain sessions (`sessions start`)
  running at once (default 8), and `agents.max_concurrent` the agents
  (default 4). Each counts only its own, so a few plain shells never stop
  an agent from starting, nor agents a shell. Past either, the start is
  refused, naming the key ("2 sessions are running and
  sessions.max_concurrent is 2"); `<cli> validate` names a wrong value.

  ```yaml
  sessions:
    max_concurrent: 8
  agents:
    max_concurrent: 4
  ```

- A PTY needs a native module, `@lydell/node-pty`, which Den lists as an
  optional dependency (prebuilt binaries for macOS, Linux and Windows,
  nothing downloaded at install). Without it (`npm install
--omit=optional`, another platform) everything else works, and `sessions
start` and `<cli> doctor` say why den-pty is unavailable.
- A state dir whose socket path would pass 103 bytes (the unix socket
  limit) is refused with that reason; point `<PREFIX>_HOME` somewhere
  shorter.

## The server agent

Every Den has its own agent, named after the distribution ("Acme agent"),
for anything about the server itself: set it up, add a repo, fix a failing
service, change a setting, explain what's running. It belongs to no
workspace. It is a normal Den agent underneath (its record, its session,
Resume after a restart, rotation and Den's hooks), with Den's persona
`server` and the plain-writing rule, in a reserved scope, `den-server`: no
workspace may take that name.

- **It acts only through Den's MCP.** Its MCP server
  (`<cli> mcp --workspace den-server --actor agent:server`) serves the whole
  Den, not one workspace, so it may use the onboarding tools a workspace's
  agent is refused. Every write (`workspace_create`, `repo_add`,
  `service_try`) is [held for the person](#onboarding-writes-held-for-the-person):
  until they allow one in the browser, it only reads. It starts in an empty
  folder of its own (`<state_dir>/server-agent`), with no checkout to edit,
  and its runtime asks before every command (`permission_mode: ask`).
  Den's own MCP tools are the exception, for this agent only: its settings
  file allows `mcp__<server>` (the `--mcp-config` server), so reads just
  run and each write asks once, in the browser. The org's immediate actions
  (`mcp.actions`) stay in `permissions.ask`. On a fresh Den the page says
  above its terminal: "Claude asks whether to trust this folder. Choose
  Yes." Den doesn't answer that prompt for the person.
- **Where it lives.** On a fresh Den (no repo in any workspace yet), the
  first page, `/`, is that agent in a terminal framed as the page, with
  Open in Agents as the way out. After setup it is one click away in the
  rail ("Acme agent", `/server-agent`), and ⌘K has "Ask Acme". Agents lists
  it first, under "Server", not under a workspace.
- **Its onboarding:** `onboard_status`, then "Let's set up Acme. Where are
  your repos? I'll look in <the folder above the Den's> unless you name
  another folder." in its first turn, `repos_detect` and suggested workspaces, `workspace_create`,
  `manifest_draft` and `repo_add` for each repo, `service_try` (and
  `doctor` when it fails), then "Here's what's running, and three things to
  try next."
- **What runs it.** A catalog runtime that is installed and carries Den's
  tools: the person's choice (`agents.server_runtime` in
  `config/local/user.yml`, set from the page's Runs on picker), else the
  first one found. Den can tell a runtime is installed, not that it is
  logged in: one that isn't asks in its own terminal, on the page. On a
  fresh Den with such a runtime it starts by itself, once per page load;
  after setup it starts only from its Start button. With no runtime, the
  page shows how to install one and the manual path for this Den, from its
  folder: `cd <dir>`, `./bin/<cli> repo add <path>`, `./bin/<cli> up`.
- **Its model.** The page's Model picker, beside Runs on, offers the
  runtime's own models (`agents.server_model`). With none saved, Sonnet
  when the runtime has it, else the runtime's default. A new model starts
  a fresh conversation at the next start.
- **Only a person starts it or picks its runtime or model.** An agent's token, or a
  request claiming to be an agent, is refused (403).

| Route                            | What it does                                                                |
| -------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/server-agent`          | Its name, runtime (or none), state, session, fresh, manual                  |
| `POST /api/server-agent/start`   | `{ runtime? }`: start it, or resume or relaunch it                          |
| `POST /api/server-agent/runtime` | `{ runtime: id \| null }`: the person's choice of runtime                   |
| `POST /api/server-agent/model`   | `{ model: id \| null }`: the person's choice of model, one of the runtime's |

## Agents

An agent is a **persona** (who) in a **workspace** (where), run by a
**runtime** (which CLI) in a [session](#sessions), acting through Den's MCP
server scoped to its workspace.

```
<cli> agents start -w <ws> --persona <p> [--runtime <r>] [--model <m>] [--name <name>] [--id <id>]
<cli> agents list -w <ws> [--json]
<cli> agents stop <id> [-w <ws>]
<cli> agents resume <id> [-w <ws>]
<cli> agents import -w <ws> [--runtime <r>] [--json]          # conversations to bring in
<cli> agents import -w <ws> --session <id> --persona <p> [--model <m>]  # bring one in
<cli> agents persona <id> <persona> [-w <ws>] [--model <m>] [--now | --after-turn]  # change its persona
<cli> agents restart <id> [-w <ws>] [--now]  # the same conversation, with the tools it gets now
<cli> agents personas [--json]
<cli> agents doctor [-w <ws>] [--json]  # can each runtime run here, and why not
<cli> agents handback-check <file|->    # is a hand-back complete and plain (see Guardrails)
<cli> sessions attach <ws>:<id>         # its terminal; ctrl-] detaches
```

- `start` runs the agent as session `<dist>-<ws>:<id>` in the workspace's
  checkout dir (its `directory`, else `den-workspaces/<ws>`), capped by
  `agents.max_concurrent` (agents only: plain sessions never count). The id defaults to the persona's id; an id is
  unique in the distribution, so a second workspace's planner gets
  `planner-<ws>` unless you give `--id`. A persona that already has an
  agent there, running or stopped, starts another: `planner-2`,
  `planner-3`. A stopped agent is continued by Resume or Start fresh,
  never by a new start. `--id` is exact: a running id is refused.
  `--name "API spike"` makes the id its slug, `api-spike`, titled as
  typed; a running agent there with that id or title is refused, and a
  stopped one makes it `api-spike-2`.
- The **agent record**, `<stateDir>/agents/<id>.json` (0600), holds its id,
  persona, runtime, model, workspace, cwd, session and times, and what it was
  started with from the Start dialog: `version` (the model's, "latest" or
  pinned), `permission` (`ask`, `edits` or `all`), `allow` (extra allowed
  commands) and `overrides` (which of these differ from its persona). Start
  fresh and Relaunch keep them. It never holds the environment, the command
  line or a first instruction. `list` reads it for persona, runtime
  and model; a record whose session has gone is listed as `stopped` (after
  `stop`) or `ended`.
- **Two name fields.** In the record, `sessionName` is the session's
  handle, `<dist>-<ws>:<id>` (what `sessions attach` takes); it has meant
  that since 0.4.0, and `displayName` is the name a person gave the agent.
  In `agents list --json`, `GET /api/sessions` and the start and resume
  answers (MCP `agent_resume`), `sessionTitle` is the name its session
  shows: the latest of Den's rename and the runtime's own (Claude Code's
  `/rename`, one pair of surrounding quotes dropped), absent when there is
  none. The handle there is `name` (`/api/sessions`) or `session` (the
  start and resume answers). 0.4.12 sent the name shown as `sessionName`;
  read `sessionTitle` instead. Records are unchanged, so none written
  before needs migrating.
- **Renaming.** `agents rename <id> <name>` (or `--clear`, back to its
  id) names a running or stopped agent; on the Agents tab, **Rename…** in a
  running agent's pane ⋯ menu, by touch or keyboard, or a double-click on
  its tab. A stopped agent's row and pane don't offer it (0.4.29); the CLI
  still does. The id never changes.
- **The name other sessions see.** Den names a Claude Code agent's session
  `<cli>-<ws>:<name, else id>` (`--name`) at every start and resume, so
  another session listing its peers tells Den's agents apart. A rename
  shows at its next start or resume. The record's `peerName` is the name
  last given, so reading it back is never taken for a `/rename`.
- `list` shows agents only: sessions with an agent record. A session from
  `sessions start` is not an agent; `sessions list` shows it.
- `stop` sends its session TERM and marks it stopped. `resume` works only
  when the runtime declares resume and the session is not running: it starts
  a new session in the same cwd that continues the last conversation. A
  session that never got a prompt (no input with a line end) has no
  conversation, so `resume` starts it fresh under the same conversation id
  and says so.
- After `start` or `resume`, Den watches the session for up to 3 s. If it
  exits non-zero, Den prints the exit code and its last lines (at most 10,
  secret-shaped values redacted) and exits 1.

#### Bring in a conversation

A conversation you started in a terminal outside Den (Claude Code, in the
workspace's own folder or one inside it, or a folder of one of its repos,
a repo added by path outside it too) can become a Den agent. When
workspaces share one repos root, only each one's repos' folders count,
and the root itself only exactly; another workspace's conversation is
refused by id. Agents ›
**Bring in** lists them, newest first, with the persona list; `agents
import -w <ws>` lists them too.

- Den reads the runtime's own history: Claude Code's
  `~/.claude/projects/<folder>/<id>.jsonl` (or under `CLAUDE_CONFIG_DIR`).
  It reads only the first and last 64 KB of each file, for the folder it
  ran in, its latest `/rename` and its first prompt. It never reads a whole
  transcript, and it lists at most 50.
- Bringing one in runs the runtime's resume (`claude --resume <id>`) in the
  folder it ran in, as a new agent with the persona you pick. From then on
  Den's token, MCP config, hooks, guards and audit trail apply. It is an
  agent like any other: stop, resume, rename. The record notes
  `broughtInAt`.
- **What the persona changes.** The persona is the role it takes on from
  now on: its role prompt, its permission mode and allowed commands, and
  Den's tools and guards. The history stays. The dialog says so under the
  persona list: "From now on it works as <persona>: its role, its
  permissions (<mode>), Den's tools and guards. Its history stays."
- **The model stays the conversation's own.** Den reads the model of its
  last answer (`message.model` on the last assistant record, in the ends
  it reads) and runs it on that: "Keeps <model> from the conversation".
  Advanced (or `--model`) picks another. With no model in the
  transcript, the persona's applies.
- **The MCP servers it won't have.** An agent runs with Den's MCP only
  (`--strict-mcp-config`). When the transcript shows tool calls from other
  servers (`mcp__<server>__…`), the dialog names them: "It won't have:
  <servers>." The list's `lost` field has them.
- **A suggested persona.** The list's `suggest` is the persona of the
  latest agent of the workspace that worked in the conversation's folder
  (or a folder inside it, or one containing it), else the workspace's
  latest agent's. The dialog preselects it; you confirm with Bring in.
- **One writer only.** A conversation written in the last minute is taken
  to be still open in another terminal: "Still open in another terminal.
  Close it there first" (HTTP 409 `open_elsewhere`). A conversation an
  agent already continues is refused too (409 `already_agent`).
- The agent's id is the persona's, or `<persona>-2`, `-3`… when that is
  taken; `--id` sets one. An existing agent is never overwritten.
- Only den-claude can bring one in for now. Other runtimes say "<runtime>
  can't bring in a conversation yet".
- Routes: `GET /api/workspaces/<ws>/conversations[?runtime=<r>]` and `POST
/api/workspaces/<ws>/conversations/<id>/import` `{ persona, runtime?, id?,
model?, version? }`. A person's only, unless MCP `agent_import` is opted
  in.

#### Change an agent's persona

**Change persona…** (the agent pane's ⋯ menu, running or stopped) and
`agents persona <id> <persona>` switch an agent to another persona on the
same conversation. Den stops its session and resumes the conversation with
the new persona's role prompt, permission mode and allowed commands (the
old persona's mode and commands go). The history stays, and so do the
agent's id, name, workspace, folder, grants, tab and slot, and the model it
runs unless Advanced (`--model`) picks another. The dialog lists the
personas with the current one marked, and the same "From now on it works
as…" line as Bring in.

- **Never mid-turn without asking.** While it works (den-claude: its
  transcript's last record is a tool call, or a prompt or tool result with
  no answer yet), the change is refused: "It's working. Change after this
  turn, or stop it now?" (HTTP 409 `busy`). **After this turn**
  (`--after-turn`, `when: "after-turn"`) waits for the turn to end, up to
  30 minutes, and then switches (the API answers 202 `pending` at once;
  the record marks it `pendingPersona` while it waits). The wait lives in
  the server's memory: if Den restarts first, the change is dropped, the
  mark is cleared at start, and the audit trail records "persona change
  cancelled: Den restarted";
  **Stop it now** (`--now`, `when: "now"`) stops it and switches.

  How Den reads "mid-turn" (D39): from the end of the transcript, the
  last user or assistant record that starts a turn. Records that start
  none are passed over: a compaction's summary, a person's `!` command
  and its output, and a local command such as `/cost` with its output.
  Den reads back 64 KB first and four times more each try, at most
  `agents.turn_read_max_mb` (default 8). If it finds no turn within that,
  it can't tell: a persona change asks first, Write handoff goes ahead,
  and an automatic relaunch waits. Each verdict is kept while the
  transcript's size and modification time stay the same.

  ```yaml
  agents:
    turn_read_max_mb: 8 # a number of MB, above 0 and at most 4096
  ```

- **A person's only.** An agent could widen its own permissions with it,
  so an agent's token is refused (403), the CLI refuses inside an agent's
  session, and there is no MCP tool.
- Only a runtime that can resume offers it (`personaChange: true` on the
  agent's row); others can't.
- The record keeps each change in `personaChanges` (from, to, when, and
  who), and the audit trail records "persona <id> in <ws>: <from> → <to>,
  by <who>".
- Route: `POST /api/workspaces/<ws>/agents/<id>/persona` `{ persona, model?,
version?, when? }`.

### On the Workspaces page

The selected workspace's agents are listed under its repo table, one row
per agent: its id and persona, runtime, state (`running`, `stopping`,
`stopped`, `ended` or `exited (<code>)`), directory, and when its session
started. The workspace header counts them ("2 agents").

- **Stop** sends its session TERM, as `agents stop` does; the row reads
  `stopping…` until the session has gone. **Resume** shows only when
  `agents resume` would run: the runtime declares resume and the agent is
  not running.
- **+ Start agent** picks a persona (Den's pack, then
  `agents.persona_packs`) and a runtime (the persona's own unless you pick
  one; one that can't run here is listed, disabled), then Start. Under the
  runtime a line says what Start will run, with its version and path
  ("Starts Claude Code 2.1.0 from ~/.local/bin/claude"). When that runtime
  can't run here, Start is disabled and the line says why and how to fix
  it: where it looked, then "Install it, or set
  `agents.runtimes.<id>.bin` to its path in <your user.yml>, or run
  `<cli> agents doctor`" (see [Runtimes](#runtimes)). Nothing fails only
  after Start.
- **Folder** (optional) is where the agent runs: a folder inside the
  workspace's own, or a repo's folder of the workspace (relative to the
  workspace's folder, or absolute). Empty, it runs in the workspace's
  folder. A folder outside the workspace is refused (403). The service
  panel's **Start agent here** fills it with the repo's folder.
- The page and the CLI call the same operations and read the same agent
  records, so an agent started in one is listed in the other. A workspace
  lists its own agents only.
- Start, Stop and Resume never ask for the admin password (it is for
  sudo, and no agent action runs sudo), are capped by
  `agents.max_concurrent`, and are refused for an agent (agents don't
  start agents from the page). Each one is in the
  server log's activity, with you as its actor. The agent's environment is
  the one below, built from the web server's environment.
- **Open in Agents →** (the section header) opens the Agents tab for the
  workspace, and **Open** on a row with a session opens its terminal there.

The routes: `GET /api/workspaces/<ws>/agents`, `POST
/api/workspaces/<ws>/agents` (`{ persona, runtime?, model?, version?,
permission?, allow?, instruction?, id?, folder? }`, see
[The Start dialog](#the-start-dialog)), `POST
/api/workspaces/<ws>/agents/<id>/stop` and `…/resume`, `POST
/api/workspaces/<ws>/sessions` (a plain session), `GET /api/personas`
(personas, runtimes with their models and permission translation, roles
and categories), and the persona routes under
[Personas](#personas). Errors are the usual
`{ ok: false, error, code, requestId }`: `cap` (429),
`conflict` (409, e.g. already running, or no resume), `not_found` (404),
`exited_at_once` (502, with the session's last lines).

### The Start dialog

**+ Start agent** on the Agents tab (or `/agents?start=1`) opens the Start
dialog:

- **Persona**: a list you can search (name, role, description), with
  category chips (only the categories that have personas) and source chips
  (built-in, distribution, mine). With no filter set it is grouped by
  category. Each row is the persona's name ("Rita (reviewer)", else its
  id), its source badge and its one-line description, and "not installed"
  when its runtime isn't. **Plain session** is pinned last: your login
  shell in the workspace's folder, no agent. **What's a persona?** explains
  the idea; **Details** shows the selected persona's instructions, runtime,
  model and version, permission mode, role preset and extra commands.
  **+ New persona**, **Duplicate** and (for your own) **Edit** open the
  persona editor, and the dialog picks what you saved.
- **Runtime** and **Workspace**. Installed runtimes come first; the rest
  are listed, disabled, and named under the field ("Not found on this
  machine: …"). A persona whose runtime isn't installed starts on the first
  one that is, and the dialog says so. The line under the runtime says what
  will run (see below).
- **First instruction** (optional, up to 8000 characters): the agent's
  first message. Den types it into the agent's session once the session is
  ready (it has printed and gone quiet, or after 30 s), through the session
  host, as a bracketed paste when the runtime asked for one, then Enter. It
  is never a command-line argument and never stored; the audit log records
  its length only.
- **Advanced** (collapsed): **Model** and **Version** (the runtime's own
  list; "Persona default" first), the **Permission mode** (Ask for
  everything, Auto-approve edits in the worktree, Auto-approve all), the
  role's command preset as chips, **Extra allowed commands** (plain command
  prefixes, one per line, no patterns), and a preview of exactly what the
  runtime will be given. A command a runtime can't take says "not supported
  on <runtime>", and a pattern says "use a plain prefix"; neither is ever
  dropped silently. "Edit raw runtime config…" is not there yet.

What you change in Advanced applies to that launch only, and the session's
row is tagged: "model: haiku", "pinned claude-opus-4-8", "auto-approve
edits", "custom tools", the runtime, and always "auto-approve all" for an
agent started so. An agent pinned to an older version says "newer
available".

Every field is checked on the server, not only in the page. The model and
version must be ones the runtime lists, the permission one of `ask`,
`edits` or `all`, and `allow` a list of at most 32 plain prefixes (letters,
digits, single spaces and `. _ / : = @ % + , -`, at most 120 characters
each). An unknown field is refused. A person's start only: an agent's
token gets 403.

**How each runtime takes the choices.** den-claude (Claude Code): a model is
`--model <alias>` (`opus`, `sonnet`, `haiku`), a pinned version is `--model
<full id>`. The model list is a catalog shipped with each Den release,
because `claude` can't list its models. The permission mode is
`--permission-mode` (`default`, `acceptEdits`, `bypassPermissions`), and
each command prefix becomes two allow rules, `Bash(<prefix>)` and
`Bash(<prefix> *)`, in the agent's settings file beside Den's deny rules
(deny wins). Codex CLI, Gemini CLI, Grok Build and generic take no model,
mode or commands from Den yet: the dialog says "not supported on <runtime>"
and the start is refused if you set one.

### The Agents tab

"Agents" in the rail (Develop, after Graph) is `/agents`: every session and
agent of the workspaces in view, and their terminals in the browser.

- **The list** is grouped by workspace and follows the scope bar (or the
  page's `?ws=<ws>`, which "Open in Agents →" sets). A `?ws=` is never
  replaced by All. A workspace that isn't active gets one line, "Workspace
  west isn't active · Switch to west", and the list shows it alone.
  Switch makes it active and views it, as the top bar's Workspace menu
  does. A name no workspace has gets the same line, an empty list, and no
  "+ Start agent".
  `GET /api/sessions?ws=<ws>` lists that workspace even when it isn't
  active, and says `requested: { workspace, active, known }`. Each row has its
  state, persona (a `sessions start` session is labelled "session"),
  runtime and directory, and "waiting" when it waits on you (once the
  session host can tell, AG-6a; not yet). An agent whose
  token `web logout --all` revoked says "token revoked": stop and resume
  it, or start it again.
- **A pane** is the session's terminal: it shows the scrollback, then the
  live output, and your keys go to the session; its size follows the
  pane. Up to four are open at once (a fifth closes the oldest). The URL
  holds the open panes (`/agents?open=<id>,<id>`), so a link, a reload or
  Back reopens them. The list and the panes fill the window down to the
  runs dock.
- **A link to one agent** is `/agents?agent=<id>&ws=<workspace>`, for
  another tool to link an agent's name to (D43). A running agent's pane
  opens and takes the keyboard. A stopped agent's details open by its row.
  An agent that isn't there gets a short note and nothing opens. The link
  is used once: the URL then keeps `?ws=` and `?open=`, not `?agent=`.
- **Layouts.** The switch in the page header picks one, or ⌃⇧1, ⌃⇧2, ⌃⇧3
  (Ctrl+Shift+1/2/3 on every OS; ⌘1-9 and Ctrl+1-9 stay the browser's, for
  its tabs), or ⌘K "Layout: Focus", "Layout: Tabs", "Layout: Tile". Inside
  a terminal those keys switch the layout and never reach the agent:
  - **Focus** (the default) shows one pane. A click replaces it;
    Shift-click or ⌘-click adds one alongside.
  - **Tabs** shows one pane under a strip of tabs. Each tab has the
    agent's name, then its persona and workspace ("reviewer · north"), and
    a dot when it is waiting.
  - **Tile** shows the open panes in a grid: one fills it, two sit side
    by side, three or four make a 2×2.

  At phone width, Focus and Tile show as Tabs. The choice is yours: it is
  saved in `config/local/user.yml` as `agents.layout` (`POST /api/settings
{ agents_layout: "focus" | "tabs" | "tile" | null }`, also in Settings ›
  Agents). The URL says it too (`&layout=tabs`); a link's layout is used
  for that page and saves nothing.

- **Rename an agent** by double-clicking its tab: Enter saves, Esc keeps
  the old name. The name (trimmed, up to 40 characters, no control
  characters) is stored in the agent's record as `displayName`, and the
  list, its pane, ⌘K and `agents list --json` show it. The agent's id
  never changes. Clear the name to go back to the id. The route is `POST
/api/workspaces/<ws>/agents/<id>/name` (`{ name: string | null }`), for
  a person only.
- **Close** (×) detaches, as leaving the page does: the session keeps
  running, and opening it again replays what you missed. **Stop** (an
  agent only) is `agents stop`. **+ Start agent** (or
  `/agents?start=1`) starts one and opens its pane; under All it asks for
  the workspace. It says before Start whether the runtime can run, as the
  Workspaces page's form does. It never asks for the admin password.
- **Shift+Enter** adds a soft newline instead of submitting. It sends the
  runtime's `softNewline` from the runtime catalog: `esc-cr` (ESC CR, the
  default; Claude Code and Gemini CLI), `lf` (Ctrl+J; Codex CLI) or `none`
  (Enter itself). A plain session's Shift+Enter is Enter. A catalog entry
  a distribution or `user.yml` adds may set `softNewline`.
- **The session's name.** A runtime may name its conversation: Claude
  Code's `/rename` writes a `custom-title` record to its transcript, and
  Den reads the latest one (the catalog marks this source `unofficial`:
  the format is undocumented, so a name that can't be read is simply
  none). It reads on from where it last stopped, never the whole file at
  once. The most recent rename wins, Den's (a tab's) or the runtime's. The
  pane header adds ` · <name>` after the runtime, and the tab, the list and
  ⌘K add it too, when it is not empty and says more than the agent's own
  name or persona. `GET /api/sessions`, `agents list --json` and the start
  and resume answers (MCP `agent_resume`) carry it as `sessionTitle`
  (0.4.12: `sessionName`, which is the record's session handle). A
  `/rename "api spike"` shows as api spike: one pair of quotes around the
  whole name is dropped, for display only.
  Codex CLI, Gemini CLI and Grok Build have no name of their own yet. A
  catalog entry's `titleFromOsc: true` marks a runtime whose terminal
  title (OSC 0/2) names the session; no built-in runtime sets it, and the
  session host doesn't read titles yet.
- **Links.** A URL in a pane, and an OSC 8 hyperlink, open on ⌘-click
  (Ctrl-click on Windows and Linux) in a new tab, with `noopener`. Only
  `http:` and `https:` open; an OSC 8 link with any other scheme
  (`javascript:`, `file:`) is no link. A plain click selects text as
  ever. A file path an agent prints (`src/foo.ts:42`, `./a/b.js:3:7`, an
  absolute path) is a link when it exists inside the agent's workspace
  (its directory, or the agent's own folder) or its uploads, resolved
  against the agent's folder; one outside it never is. The server checks with `GET
/api/workspaces/<ws>/agents/<id>/paths?p=<path>&p=…` (stat only, nothing
  is read; at most 64 at once), which answers each path's absolute path
  or null. ⌘-click opens a menu at the pointer:
  - **Download** brings the file to the browser's machine, which may not
    be the agent's (AG-DROP-2). `GET
/api/workspaces/<ws>/agents/<id>/file?p=<path>` sends a regular file
    inside the same folders, or the agent's uploads, as an attachment.
    Anything else gets 404, and nothing of it is sent. Every download,
    and every refusal, is audited.
  - **Open in <editor>**, when Settings › Editor & terminal › "Open file
    links in" names one (`editor_open` in `config/local/user.yml` and
    `/api/settings`: `vscode`, `cursor` or `zed`): its URL scheme, at the
    line.
  - **Copy path** copies its absolute path and says "Copied".
- ⌘K lists each as "Agents › <ws> / <name>", and "Start agent…".
- Several browsers and `<cli> sessions attach` can attach to one session
  at once and each sees every byte; the terminal's size is the last
  one's to change it.
- Terminals need the optional PTY module (`<cli> doctor`); without it the
  page lists what there is and says so.
- **Who can open one.** The terminal is shell-grade: on localhost the
  page's own Origin and CSRF token, beyond loopback a signed-in browser
  (the list says "Sign in to open terminals" otherwise), and an agent's
  token only its own session's. Each attach and detach is in the server
  log's activity, with its actor.

The routes: `GET /api/sessions` (`{ sessions, workspaces, host, backend,
io }`) and the WebSocket `/api/sessions/<id>/io` (subprotocol `den.io`, the
CSRF token as `den.csrf.<token>`): binary frames are output and input, a
text frame `{"type":"resize","cols":c,"rows":r}` resizes, and the server
sends `{"type":"session",…}` first and `{"type":"exit","exitCode":n}` when
the session ends.

The terminal route checks the person and the agent, not whether the
agent's workspace is active: an agent in a workspace you've switched away
from still opens. A `GET` of the io path (not a WebSocket) says why one
would be refused: `401` when you're signed out (the pane then says "Sign
in"), `404` with the reason when there is no such session here, and `426`
when the upgrade would be allowed. The pane shows that reason, not "Sign
in", for any refusal but the first.

The pane's header and the workspace's heading in the list link to the
Workspaces page focused on that workspace (`/local-dev?ws=<ws>`), and ⌘K
has "Go to workspace <ws>" for each workspace with agents.

### Helpers: what an agent started in its own session

An agent can start helpers of its own: Claude Code's Agent and Workflow
subagents (D32). They run inside the agent's session, so Den shows them
but can't stop or steer them. To change what they do, tell the agent.

Where they show:

- **The Agents tab.** Every running agent's row counts its running
  helpers. Under the agent in front (its pane showing), its active
  helpers, running and idle, are listed: running first, a helper's own
  helpers under it, each with what it was asked to do, its state and
  when; at most `row_max` (4), then **All helpers (n)**, which opens the
  Helpers list. Done, failed and stopped helpers are never listed under
  the row; they are in the Helpers list. Select another agent and the
  first one's rows go.
- **A pane's bar.** **Helpers (n)** opens the list, with a count while any
  run. Helpers from the agent's earlier conversations (before a relaunch)
  are folded under "Earlier (n)".
- **A helper's transcript.** Click a helper: what it was asked, its
  answers, and its tool calls in a few words, the newest at the bottom.
  Never its thinking.
- **The rail.** The Agents item counts the helpers running now, on every
  page.

**Clear done** (D34), in an agent's Helpers list, hides
every helper of that agent that is done, failed or stopped, in this
conversation and earlier ones. Running and idle helpers stay, and a helper
that ends later shows as usual. **Show cleared (n)** in the list shows
them again, read-only. Den keeps one mark per agent,
`agent-files/<id>/helpers-cleared.json` under its state, so the clear
survives restarts, relaunches and rotations; Claude Code's own files are
never touched. Clearing is a person's: an agent's token is refused it.

A helper's state comes from Claude Code's files, best evidence first: the
person stopped it, its workflow said, the agent was told it ended, its
result is in the agent's transcript, its own files say it finished, its
last answer went quiet, or recent activity. A helper with no activity for
`active_minutes` that isn't known to be done shows **idle**. When the
agent isn't running, none of its helpers are. Hover a state to see which
evidence it came from.

From the CLI and MCP:

```sh
<cli> agents helpers <id>              # this conversation's helpers
<cli> agents helpers <id> --all        # earlier conversations' and cleared ones too
<cli> agents helpers <id> <helper>     # one helper's transcript
<cli> agents helpers <id> <helper> --limit 50 --json
```

The MCP tool `agent_helpers` reads the same, in the agent's own workspace
or one it is granted; cleared helpers are only counted (`clearedCount`)
unless it asks with `all: true`. The routes are `GET
/api/workspaces/<ws>/agents/<id>/helpers[/<helper>]` (`?all=1` lists the
cleared ones as `cleared`) and `GET /api/sessions/helpers` (the running
count). All of them only read. `POST
/api/workspaces/<ws>/agents/<id>/clear-helpers` is Clear done, a person's
only, and audited.

Settings, under `agents.helpers` in the org config:

```yaml
agents:
  helpers:
    active_minutes: 10 # no activity this long, not known done: idle
    row_max: 4 # active helpers under the agent in front
    collapse_done_minutes: 30 # deprecated (0.4.29): ignored
```

| Key                     | Values                     | Default |
| ----------------------- | -------------------------- | ------- |
| `active_minutes`        | minutes, above 0 to 100000 | 10      |
| `row_max`               | a whole number, 1 to 1000  | 4       |
| `collapse_done_minutes` | deprecated, ignored        | 30      |

`collapse_done_minutes` no longer does anything (0.4.29): finished helpers
stay in the list until a person clears them. It is still accepted, so a
config that sets it keeps working, and `<cli> doctor` notes it.

### Files dropped onto an agent's terminal

Drag one or more files onto an agent's terminal pane, paste a copied file
or screenshot into it, or press **Attach** in its pane bar (the way in on
a touch screen). The browser may be on another machine than Den: the file
travels over Den's own HTTPS, with no shared folder or file sync. Den
writes it on the agent's machine and types its absolute path at the
cursor, as a native terminal's drop does. Several files are typed
space-separated, each shell-quoted when it needs to be, with a trailing
space and no Enter. A paste of plain text stays a normal paste.

- Each file goes to `<state>/uploads/<session id>/<time>-<name>`: the
  file 0600, its folder 0700, outside every repo. The name keeps only
  letters, digits, spaces and `._+@()-`, never a folder part.
- While a file is over the pane, it says "Drop to attach to <agent>". Each
  file gets a chip with its progress, then "attached" or the reason it
  wasn't (too big, the session ended, the upload failed).
- The route is `POST /api/sessions/<id>/uploads?name=<file>`, the body the
  file's bytes. It answers `{ ok, path, bytes }`. It is shell-grade, with
  the terminal's own checks: CSRF, a signed-in person beyond loopback, and
  an agent's token for its own session only. Every upload, and every
  refusal, is audited with the actor.
- Files older than `keep_days` are removed (checked at most once an hour,
  on an upload).
- `<cli> agents files <id> [-w <ws>] [--json]` lists an agent's uploads,
  newest first: when, size and path. A path the agent prints, an upload's
  among them, downloads from its ⌘-click menu (see Links, above).

```yaml
agents:
  uploads:
    max_bytes: 26214400 # 25 MB; a bigger file is refused, naming this key
    keep_days: 7 # then pruned
    # dir: /absolute/path # default <state>/uploads
```

| Key         | Values                            | Default           |
| ----------- | --------------------------------- | ----------------- |
| `max_bytes` | bytes, a whole number, 1 to 4 GiB | 26214400 (25 MB)  |
| `keep_days` | days, above 0 to 3650             | 7                 |
| `dir`       | an absolute path                  | `<state>/uploads` |

### Subagents' model and claude.ai connectors

Claude Code's subagents (the Agent tool's, Explore and general-purpose
among them) otherwise run on whatever their definition or the call says,
often the agent's own model. Den runs every subagent of a den-claude
agent on Sonnet by default, Explore included. It passes the model forced
(`CLAUDE_CODE_SUBAGENT_MODEL` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`,
Claude Code 2.1.257 or later), so a subagent's own definition can't pick
a costlier one.

Den's agents also leave out the account's claude.ai connectors by
default: an agent has Den's MCP and nothing the account added on
claude.ai.

```yaml
agents:
  subagents:
    model: sonnet # every subagent, Explore too; `inherit`: the runtime decides
  claude_ai_connectors: false # true: agents load the account's claude.ai connectors
```

| Key                           | Values                                                   | Default  |
| ----------------------------- | -------------------------------------------------------- | -------- |
| `agents.subagents.model`      | `sonnet`, `haiku`, `opus`, a full model id, or `inherit` | `sonnet` |
| `agents.claude_ai_connectors` | `true` or `false`                                        | `false`  |

Both keys are the org's: set in a person's `config/local/user.yml` they
do nothing, and `<cli> doctor` says so. A persona's `subagent_model` wins
over `agents.subagents.model`; its `inherit` turns Den's off for that
persona. On a Claude Code older than 2.1.257 the model is a fallback
only (Explore may still run on the agent's model); `agents doctor` warns
(`--json`: `subagents.forced`). A change applies when an
agent next starts or resumes. `<cli> agents doctor` shows the org's model,
connectors, each persona that overrides it, and each agent's model as it
last started (`--json`: `subagents`). The agents list (`subagentModel`,
`subagentModelFrom`) and the agent's pane bar show it too.

A bad key under `agents:` stops listing agents and reading their helpers,
on the CLI and the web, until it is fixed; stopping an agent still works.
A bad key under `sessions:` matters only when a plain session starts (its
cap); `validate` and `doctor` name it.

A runtime other than Claude Code shows no helpers: Den says it can't tell
which helpers that agent started.

### Stopped agents: Resume, Start fresh, Remove

An agent that stops stays in the list, below the running ones (AG-14, the
stopped-agents slice), in one **Stopped (n)** group at the bottom. The
group starts open with 3 or fewer and closed with more, and stays as a
person left it (in this browser). Each row is one line: a hollow dot, the
name, a chip (**Stopped**, **Exited** or **Interrupted**, when Den or the
machine restarted under it), when, **Resume**, and **⋯** with Start fresh
and Remove. Its persona, id, runtime, folder and why it stopped ("Stopped
by you 22:13", "Exited (code 1)") are in its tooltip, and in its pane,
which opens as before with Resume and the same ⋯. A stopped agent shows no
helpers. What the actions do:

- **Resume** continues the same conversation. Den runs the runtime's own
  resume with the conversation id it saved (Claude Code: `--resume <id>`).
  The agent comes back in the folder it had, with its workspace and its
  grants. A grant you took out of the config since is gone; one you added
  is not taken. Resume is never a new conversation fed the old prompt.
  Den decides before it launches. For Claude Code it looks for the
  conversation's transcript (`<id>.jsonl` under
  `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`): if it is
  there, or someone typed in the last session, the resume is
  `--resume <id>`. If not, nobody ever typed, so Den starts fresh under the
  same id, folder and scope, and says "nothing to resume yet; started
  fresh" (the route adds `fresh: true`). For a runtime Den can't check,
  the record decides: every launch marks it `launched: true`, and a
  launched record resumes. As a backstop, if the runtime still says there
  is no conversation, Den starts fresh once and says so.
  If a fresh start says the id is already in use, Den resumes once
  instead. If both fail, the CLI exits 1 and the route answers 502 with
  code `resume_failed`, naming the id and Start fresh.
- **Start fresh** starts a new conversation: same persona, workspace and id.
- **Remove** takes the row away in one click. The toast offers **Undo** for
  10 seconds. Den keeps the removed record for an hour, then forgets it. It
  never touches the runtime's own history.

**Stop waits for the agent to end.** `agents stop <id>` returns once the
session has ended, so a resume right after it works. It waits up to 5
seconds. If the session is still running then, it prints `<id> is still
stopping` and exits 1. `--no-wait` returns once TERM is sent. The route
`POST /api/workspaces/<ws>/agents/<id>/stop` answers the same way: 200
with `{ ok, agent, wasRunning, stopped: true }` once the session has
ended, or 202 with `stopped: false, stillStopping: true`.

A runtime that can't resume (codex, gemini, grok), or an agent with no
saved conversation id, shows Start fresh in Resume's place (⋯ has
Remove), and says why in its tooltip. **Clear
stopped**, beside + Start agent, removes every stopped agent in view. A
running agent is never removed: stop it first. None of this asks for the
admin password.

**After a restart**, the agents it cut off show Interrupted, and one line
sits above the list: "2 agents were interrupted when Acme restarted ·
Resume all · Review". Resume all resumes each one that can. Review marks
them and moves to the first. Agents whose persona is `standing: true`, or
has `resume_on_restart: true`, resume on their own when the web server
starts.

**Removed on their own.** Stopped agents can go after a while:

```yaml
# config/local/user.yml
agents:
  remove_stopped_after: 7d # never (the default), 1d or 7d
```

An interrupted agent is never removed this way. Any other value fails,
naming the key.

The CLI does the same:

```sh
./bin/acme agents list --stopped            # only the stopped ones
./bin/acme agents resume planner            # the same conversation
./bin/acme agents resume --all-interrupted  # every interrupted one that can
./bin/acme agents rm planner                # one stopped agent
./bin/acme agents rm --stopped [-w north]   # every stopped one
```

The routes (a person's only, audited): `POST
/api/workspaces/<ws>/agents/<id>/resume`, `…/fresh` and `…/remove`, and
`POST /api/agents/clear-stopped` (`{ workspaces }`), `/api/agents/restore`
(`{ agents }`, the Undo) and `/api/agents/resume-interrupted` (`{
workspaces }`).

### An agent's environment

An agent's environment starts empty and gets, in order:

1. `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM` (default
   `xterm-256color`), `COLORTERM`, `LANG`, `LC_*`, `TZ` and `TMPDIR` from
   yours (`PATH` with the login shell's and the runtimes' install
   directories added: [Runtimes](#runtimes));
2. the variables its runtime names (`envPassthrough`; den-claude:
   `CLAUDE_CONFIG_DIR`);
3. the runtime's launch env;
4. `DEN_AGENT=agent:<id>` and `DEN_ACTOR_TOKEN` (below).

Then every runtime's `scrubEnv` is removed (den-claude: `CLAUDECODE` and
`CLAUDE_CODE_*`), whatever put it there. Nothing else of yours reaches it:
not your tokens, not your shell's other variables, and not the Claude Code
session you started it from (its session id, messaging socket and token,
and the child-session marker that turns transcripts off). The agent record
still holds no env. The agent's MCP server gets the distribution's location
(`DEN_ROOT`, `<PREFIX>_ROOT`, `<PREFIX>_HOME`, when set) in its own config,
so it reaches the same distribution.

`<cli> doctor --probe` checks this through the real session host: it runs a
short probe session for a plain session and for each available runtime's
agent env (built as `agents start` builds it, running the probe instead of
the runtime's CLI). The probe prints key names and whether each is
credential-shaped, never values. Doctor exits 1, one row per finding, when a
runtime's `scrubEnv` name or a credential-shaped variable reaches either.
Without the PTY module it says the probe is unavailable; that is not a
failure. Plain `doctor` never spawns anything; when agents are configured it
adds a note to run `<cli> doctor --probe`.

### An agent's token

`agents start` (the CLI or the Workspaces page) mints a random `den_at_…`
token for the agent and puts it in the session as `DEN_ACTOR_TOKEN`. Den
keeps only its hash (`actor-tokens.json`, 0600, in the state dir) with the
agent, its workspace, its grants and its session. Stop revokes it, and so
does the session's end; resume mints a new one and the old one stops
working. The `<cli>` and the MCP server Den starts for the agent send it, so
the server audits their calls as the agent, from the token, never from a
header (agent headers without the token are recorded as an unverified
claim).

An agent's token reaches only its own session's routes, and never a
shell-grade route, `/api/web/*`, sign-in or sign-out, or the admin
password's routes: it can't set the admin password, use it for sudo or
start another agent (403
`agent_forbidden`). A person's credential never reaches a session:
`DEN_PERSON_TOKEN`, a person token's value and a path to `web.secret` are
always removed, and `sessions start --keep-env` of one is refused and logged.
An agent runs as your OS user, so it could still read `web.secret` itself;
the token keeps what Den does on its behalf attributable and bounded.
**The boundary is the server's token rules** (above), not a deny list.

**The deny list is a convenience, not the boundary.** den-claude passes
Claude Code a settings file (`--settings`) whose `permissions.deny` lists
`Read` of `<state dir>/web.secret` and `<state dir>/sessions/**`, and
`Bash` rules in Claude Code's wildcard form for the path
(`Bash(*<state dir>/web.secret*)`, and each of `cat`, `head`, `tail`,
`less`, `more`, `xxd`, `od`, `strings`, `base64` and `cp` followed by it),
spelled as an absolute path, under `~` and under `$HOME`, with a path that
has spaces also backslash-escaped. It binds cooperating agents only: an
agent that ignores its permission config can read the files anyway. And
it does not catch every spelling: a path relative to the agent's cwd
(`cat ../.den/web.secret`, say), another program, a script or a copy under
another name all get past it. The server's token rules (above)
are the boundary: whatever an agent reads, its token reaches only its own
session's routes, never a shell-grade route or the admin password's.
OS-user isolation
(a separate user, a container, a sandbox) is not in 0.4.x. `web logout
--all` revokes every agent's token (above, under Signing in).

**What the scope does not do.** An agent's MCP scope binds cooperating
agents only. A runtime with a shell can still run `<cli>` itself, outside
the scoped MCP server, and reach other workspaces (with its own token, so
it is audited as the agent); WS-3a closes that later. And the user's own Claude Code settings and hooks
(`~/.claude/settings.json`, its hooks, a project's `.claude/`) load in a
den-claude agent, as in any `claude` you start.

### Personas

A persona is a markdown file: YAML front matter, then the role prompt. It is
a Claude Code agent file, read as it is, plus a few keys of Den's own:

```markdown
---
name: planner # the id (or `id:`; default: the file name)
display_name: Rita # optional; shown as "Rita (reviewer)"
role: planner # a role (see Roles); a sentence here is the description
category: engineering # see Categories; default: the role's
description: Writes stories and their acceptance criteria. # one line
model: some-model # optional; `inherit` means none
version: latest # or a pinned version of the model
subagent_model: haiku # its subagents' model, over agents.subagents.model; `inherit`: the runtime decides
allowed_commands: [npm test] # extra plain prefixes allowed without asking
tools: Read, Grep # hints for the runtime; Den restricts nothing with them
standing: true # starts with its workspace (later slices)
context: [docs/specs, the design system] # what to read first
runtime: generic # default den-claude
permission_mode: ask # ask, edits or all (Claude Code's own modes still read)
den_hooks: false # Den's guardrail hooks for this persona (see Guardrails)
den_instructions: false # Den's shared instructions for this persona
argv: ["some-cli", "--model", "{model}", "--mcp-config", "{mcp_config}"]
---

You are the planner. …
```

Den ships a default pack: `planner` and `orchestrator` (standing), `fe-dev`,
`be-dev` and `devops` (role `sde`), `reviewer`, `tester` and `ux-designer`
(role `designer`, category Design). Add your own packs, read in order after
Den's; a persona with the same id replaces the earlier one:

```yaml
agents:
  persona_packs: [personas, ../some-plugin] # relative to the distribution root
```

A pack is a directory of persona files. A pack with an `agents/` directory
inside (a Claude Code plugin) is read from there, so a plugin's agents are
used without converting them. Files without front matter (a README) are
skipped; two files with one id in a pack, or a pack that isn't a directory,
are errors naming the file or the key.

**Your own personas** live in `<stateDir>/personas/<id>.md` (0600), in the
same format, read last: one wins over a pack's persona of the same id.
Settings › Personas lists every persona with the Start dialog's search and
chips: **View** (or **Edit** for your own), **Duplicate**, **Delete** (your
own only) and **+ New persona**. A built-in or distribution persona is
read-only; Duplicate makes your own copy to edit. "newer available" marks a
persona pinned to an older version, with **Use latest** for your own. The
routes: `GET /api/personas/<id>` (with its instructions), `POST
/api/personas` (new), `POST /api/personas/<id>` (edit; 409 `read_only` for
one that isn't yours) and `DELETE /api/personas/<id>`. Each field is
checked: the role, category, runtime, model and version must be registered,
the description one line of at most 200 characters, the name at most 40,
the instructions at most 20000 characters with no control characters but
newlines and tabs. An agent's token can't create, change or delete a
persona (403); a person sets what agents may do.

**Roles.** A role is a template and a key: default instructions, a
permission mode and a command preset (read-only commands, allowed without
asking). Den's roles are `planner`, `orchestrator`, `sde`, `reviewer`,
`tester` and `designer`. Picking a role in New persona fills the form in,
never over text you typed; a role adds nothing hidden to an agent's prompt.
A distribution adds roles, and may extend a Den role's preset but not
redefine it:

```yaml
agents:
  roles:
    copywriter:
      description: Drafts release notes and site copy.
      instructions: Draft copy in the house voice. Leave drafts for review.
      mode: ask # ask, edits or all
      preset: [vale]
      category: marketing
    reviewer:
      preset: [semgrep] # added to Den's preset
```

**Categories** group personas in the Start list and Settings › Personas.
Den's are Engineering, Design, Product, Marketing and Operations; a
distribution adds more:

```yaml
agents:
  categories:
    - { id: legal, label: Legal }
```

### Guardrails: hooks, shared instructions, hand-backs

Every persona in Den's default pack gets two things with no setup: Den's
**shared persona instructions** and, on den-claude, Den's **hooks**. Both
are Den's own files, in `src/shared/agents/guardrails/` of the package.

**Shared instructions** (`instructions.md`) are appended to the role prompt
(den-claude's `--append-system-prompt`; any runtime that takes the role
prompt gets them). They say:

- write to people plainly, in short sentences;
- never name an issue or ID without saying what it is;
- ask each decision as a numbered yes/no question;
- no caveat sections, and nothing the person doesn't need in order to act;
- read a slice of a log, or hand it to a subagent; don't poll with `sleep`;
- end a hand-back with the template below.

**Hooks** (`hooks.json`, a Claude Code settings fragment) go in the agent's
own settings file, `--settings <stateDir>/agent-files/<id>/settings.json`.
Den never writes your `~/.claude`; your own hooks still run.

- `PreToolUse` on `Bash|Read` (`pretooluse.mjs`, plain Node, no imports)
  blocks, with a reason Claude sees (exit 2):
  - reading all of a log or a large file into the conversation: a `Read`
    with no `limit`, or `cat`, `less`, or `tail` from a line (`tail +1`,
    `tail -n +1`), whose output reaches the conversation. A log is `*.log` or `*.log.<N>`, a `.jsonl` under
    `.dev-metrics/`, or a `.jsonl` under `.claude/projects/` (a transcript).
    Large is over 256 KB. `cat x.log | grep …`, `cat x.log > y`, a plain
    `tail x.log` (10 lines) and `tail -n 100 x.log` pass. The reason says to read a slice or hand the
    file to a subagent.
  - `sleep` in the foreground, alone or in an `until …; do sleep …; done`,
    `while` or `for` loop. A Bash call with `run_in_background`, and
    `sleep … &`, pass. The reason says to run in the background or use a
    wait primitive. Recent Claude Code versions have their own sleep guard,
    which answers first (and also stops `sleep … &`). The sleep is blocked
    either way; Den's hook covers runtimes and versions without that guard.
  - Nothing else. Quoted text, heredoc bodies and other tools always pass,
    and a hook that can't read its input lets the call through.
- `Stop` (`stop-hook.ts`) checks a turn's last message, which is what the
  person reads. With a `Hand-back` heading it gets the whole hand-back
  check; any other message gets the plain-writing part only (every ID
  explained). If the check fails, Claude is told what to fix and keeps
  going (Claude Code's `decision: "block"`). It never blocks twice in a
  row (`stop_hook_active`), so it can't loop. Den adds no `SubagentStop` hook: a subagent reports to its parent
  agent, not to a person.
- `PreCompact`, and `SessionStart` after a compaction or on resume
  (`rotation-hook.ts`), count the conversation's compactions (on
  `SessionStart` after a compaction only) and ask for a handoff once a
  rotation is due. See Session rotation, below. While one is
  due, the `Stop` hook also blocks once until `handoff.md` passes.

**Services agents reach only through their API (D47).** A repo's manifest
can say its service is reached through its API and nothing else:

```yaml
name: vault
agents: api_only
data_paths: [var/db] # relative to the repo, or absolute; ~ is home
machine: vault-vm # when it runs in an OrbStack machine
```

Den gathers these from every workspace's checkouts into one rules file
(`<stateDir>/agents/api-only.json`), and every den-claude agent's
`PreToolUse` hook reads it on each call, so a change applies without a
restart. A persona with `den_hooks: false` still gets this check, and only
it. With rules, the hook also sees `Write`, `Edit`, `MultiEdit`,
`NotebookEdit`, `Grep` and `Glob`. It denies, with a reason the agent sees
("use its API or its MCP tools instead"):

- `docker exec`, `attach`, `export` and `cp` into the service's containers
  (`<project>-<service>-<n>` for each service in its compose files, or a
  `container_name` there), and `docker compose exec|cp|run|attach` on its
  project, picked as compose picks it (`-p`, `COMPOSE_PROJECT_NAME`, the
  compose file's `name:`, then the folder's name);
- `docker run|create` that mounts its volumes (`<project>_<volume>`, or a
  volume's `name:`) or its data paths, `--volumes-from` its containers,
  and `docker volume inspect|rm|cp|export` on its volumes;
- reading or writing its data paths, with a tool or in a shell command;
- with a `machine`: `orb`/`orbctl` on that machine (or with no machine
  named: the default one), `ssh`/`scp`/`rsync` to `<machine>.orb.local`
  or `<machine>@orb`, Docker on that machine's context
  (`--context`, `DOCKER_CONTEXT`, `DOCKER_HOST`), and `~/OrbStack` and
  `~/.orbstack`.

It is about the service instance, matched by name, never by where a
command runs. Another instance from the same repo under its own compose
project (`vault-dev` beside `vault`, with its own data) is not held to it:
declare only the instance whose data must go through the API.

It reads a command's words the way a shell splits them, through
`sh -c`, `$( )`, `eval`, `env`, `sudo`, `timeout` and `xargs`. Each denial
is written to `<stateDir>/audit/api-only.jsonl` (0600): when, which agent,
which tool and service, and what, never the whole command.
`agents doctor` lists the services, the runtimes that enforce it, and the
last denial. A running den-claude agent's pane says "API only: <names>";
a codex or gemini agent's pane says "API-only not enforced".

**It is a guardrail, not a security boundary.** An agent that can reach
the Docker engine can still get around it, for example with a program
that calls the Docker API itself, or a container id typed in place of its
name. The hard boundary is an agent that can't reach that engine: run the
service in its own machine or VM, with its own Docker engine. Only
den-claude enforces it; for codex and gemini, `agents doctor` says
"API-only isn't enforced for this runtime".

**The hand-back template**, which the check enforces:

```markdown
## Hand-back

- URL: <the full link the person opens, with https://>
- Machine: <the machine it runs on>
- Branch: <the branch>
- What changed: <what is different now>
- What to click: <the steps to see it working>
- Decisions:
  1. <a question the person answers yes or no>?
```

`<cli> agents handback-check <file|-> [--json]` runs the same check on a
file or stdin: exit 0 when the hand-back passes, 1 with each problem. It
rejects a hand-back when:

- a part is missing or empty. A part is a line starting with its label and
  a colon (bold is fine), or a heading that is its label. URL must hold a
  link (`://`), or say `none` for work with no page (`URL: none — a CLI
change` is fine). `Decisions: none` is allowed.
- an ID is bare. An ID is `#<digits>`, or 1 to 4 capitals, an optional `-`,
  digits and an optional `.<digits>` (`R12`, `AG-14`, `KB-4.1`). Links,
  `inline code`, code blocks, and the URL and Branch parts are not checked.
  An ID is explained (glossed) when
  1. a parenthetical of two or more words follows it: `#5 (the hooks issue)`;
  2. a colon or a spaced dash and two or more words follow it:
     `R12: plain writing`;
  3. it sits in a parenthetical of IDs only, right after a word:
     `plain writing (R12)`, `the issues (#5, #6)`;
  4. or the same ID was explained earlier in the text.
- a decision isn't a numbered yes/no question: each item must be numbered
  (`1.` or `1)`), end in `?`, not start with what, which, how, why, when,
  where or who, and not offer a choice (`or`).

**Turning them off or on.** They are on for Den's default pack and off for
your own packs. A pack's setting applies to each of its personas; a
persona's front matter (`den_hooks`, `den_instructions`) wins over it:

```yaml
agents:
  default_pack: { hooks: false } # Den's pack: no hooks, instructions kept
  persona_packs:
    - personas # your pack: neither
    - { path: more-personas, hooks: true, instructions: true } # both
```

A persona of yours that replaces a default one (same id) takes your
pack's setting, not Den's pack's. Anything but `true` or `false`, or an
unknown key, is an error naming the key.

### Session rotation: one session per objective

A session that never ends re-reads its whole context on every call. So a
session ends when its pull request merges, or after a few compactions. Its
role then relaunches in a fresh conversation, from a handoff the session
wrote. This is rule R2 (one session per objective) of the agent-loop
report. It works on den-claude for personas with Den's hooks on.

**How it works.**

1. Den's hooks count compactions. A `SessionStart` hook with source
   `compact` (`guardrails/rotation-hook.ts`) adds one to
   `<stateDir>/agent-files/<id>/rotation.json` after every compaction,
   manual or automatic. It fires only once a compaction happened.
   `PreCompact` does not count: it also runs for a `/compact` that does
   nothing ("Not enough messages to compact"). The count belongs to one
   conversation, and starts at 0 for a new one.
2. A trigger fires. Either the count reaches
   `agents.rotate.after_compactions` (default 3), or the agent's pull
   request merged (the `prMerged` outcome that `<cli> usage agents` saves).
   A merge is never taken from text. The agent must have run `gh pr merge`
   as a command (after any `cd` or `VAR=value` prefix; not `--help`, not
   `echo gh pr merge`), and it must have exited 0. Then `usage` asks
   `gh pr view <ref> --json number,state` in the agent's folder, and only
   `MERGED` counts. With no gh, or on any error, it is not marked. That
   query is the one thing `usage` asks outside this machine; it says so
   when it does.
3. Den tells the agent. The `PreCompact` hook's output asks the compaction
   summary to keep the instruction. A `SessionStart` hook (after a
   compaction, or on resume) adds it to the context. The `Stop` hook blocks
   the turn once while the handoff is missing or fails the check. The
   instruction: write `handoff.md` in the agent's files folder, then end
   the turn.
4. Den relaunches the role, by itself unless the settings say otherwise
   (`on_due`, below). A relaunch starts a fresh conversation (a new
   conversation id) with the same name, persona, workspace, folder and
   grants. Its first prompt is the handoff. The handoff moves to
   `agent-files/<id>/handoffs/`, the record notes the rotation, and the
   old conversation is kept.

**The handoff** has five parts, each a heading, each filled in. Write it
plainly, and explain every ID, as in a hand-back. It must stay under 20,000
characters, since it becomes a first prompt.

```markdown
## Objective

<what the work is for>

## State

<what is done, and where it is: branch, pull request, files>

## Open items

<what is left; or none>

## How to QA

<the steps to see it working>

## Next step

<the one thing to do first>
```

`<cli> agents handoff-check <id|file|-> [--json]` runs the check, on an
agent's `handoff.md` (by its id), a file, or stdin: exit 0 when
it passes, 1 with each missing or empty part and each unexplained ID. A
part can also be a line such as `Next step: open the PR`.

**What happens when a rotation is due** (`on_due`):

- `auto` (the default). At the agent's next idle, never mid-turn, Den
  types the instruction into its session: write the handoff. Once the
  handoff passes the check and the agent is idle, Den relaunches it. The
  page shows a toast ("Relaunched <id> from its handoff after 3
  compactions. The old conversation <id> is kept.") and the audit log
  records it. Den asks at most twice, two minutes apart. If the handoff
  still fails, it falls back to `ask`.
- `ask`. Nothing happens by itself. The agent's callout has the buttons.
- `off`. Nothing happens, and no callout shows. Resume goes on with the
  same conversation.

**The callout** shows on a due agent's row (running or stopped) and in its
pane bar. It says what happens next and where the settings come from
("Rotates after 3 compactions (persona planner); when due: relaunch by
itself (default)"). Its buttons:

- **Relaunch now**: from the handoff when it passes. Otherwise Den asks
  for it first (a stopped agent resumes to write it) and relaunches it
  once it passes, whatever `on_due` says.
- **Write handoff**: on a running agent without one, types the
  instruction. It is refused mid-turn.
- **Keep this conversation**: the compaction count starts again. With
  "Don't ask again for this agent", that agent's `after_compactions` is
  set to `never`. A person's only.
- **Settings**: Settings › Agents › Rotation.

**Resume and Start on a due agent** follow `on_due`. Under `auto`, Resume
relaunches it from its handoff once the handoff passes. Under `ask`,
`<cli> agents resume <id>` refuses (exit 1) and names
`<cli> agents relaunch <id>`, and the resume route answers 409 with code
`rotated`. `<cli> agents relaunch <id> [-w <ws>]` and
`POST /api/workspaces/<ws>/agents/<id>/relaunch` relaunch it at any time
(a running agent is stopped first; a missing or failing handoff is a 409
`no_handoff`). After a restart, a standing persona that rotated relaunches
on its own.

**Settings.** Three keys:

| Key                 | Values                 | Default |
| ------------------- | ---------------------- | ------- |
| `after_compactions` | 1 to 100, or `never`   | 3       |
| `on_due`            | `auto`, `ask` or `off` | `auto`  |
| `on_pr_merged`      | `true` or `false`      | `true`  |

Each key comes from the most specific scope that sets it: the agent, the
persona in a workspace, the persona, the workspace, the service (the
workspace service whose folder holds the agent's folder), this install,
the org config, then Den's default. A change applies to running agents
too, at their next look (about every 15 seconds).

The org's values go in the org config:

```yaml
agents:
  rotate:
    after_compactions: 3 # 1 to 100, or never
    on_due: auto # auto, ask or off
    on_pr_merged: true
```

This install's values and every override are set in Settings › Agents ›
Rotation, or from the command line, and kept in
`<stateDir>/agent-rotation.json`:

```bash
<cli> agents rotate                                  # every value and override
<cli> agents rotate on_due ask                       # this install
<cli> agents rotate --persona planner after_compactions never
<cli> agents rotate --persona planner -w notes after_compactions 5  # that persona in notes
<cli> agents rotate --workspace notes on_due off
<cli> agents rotate --service shop on_pr_merged false
<cli> agents rotate --agent art --unset after_compactions
<cli> agents rotate art --show                       # its values, and where each comes from
<cli> agents keep <id> [--never]                     # Keep this conversation
<cli> agents handoff <id>                            # Write handoff
```

`agents rotate` and `agents keep` are refused inside an agent's session.
den#4's `standing: false` still works: standing personas never rotate,
unless a persona or agent override says otherwise. Set it per persona
instead (`--persona planner after_compactions never`).

### Runtimes

`<cli> doctor` lists the runtime kind. Den knows the runtimes in its
**catalog** (below); two are special:

- **`den-claude`** (the default) runs Claude Code's `claude`, found as
  below; `<cli> doctor` reads its version from the install, without running
  it. It runs `claude --session-id
<id> --mcp-config <file> --strict-mcp-config --settings <file> [--model <m>]
--append-system-prompt <role prompt>`, so Den's MCP server is the agent's
  only one, and resumes with `claude --resume <id>`. Permission prompts stay
  in the agent's terminal: it passes `--permission-mode default` unless the
  persona's `permission_mode` sets one of `default`, `acceptEdits`, `plan` or
  `bypassPermissions` (anything else is an error naming the key).
  `bypassPermissions` prints a one-line warning at every start.
- **`generic`** runs the persona's `argv` template. `{model}` is the agent's
  model (an error when the template uses it and there is none);
  `{mcp_config}` is the path of the agent's MCP config, written only when the
  template references it. It declares no resume. It is startable only for
  a persona that has an `argv`.

**The runtime catalog.** Den ships, as data, every vendor CLI it knows how
to find. Each entry was checked against the vendor's own docs or installer:

| id           | Vendor    | CLI                   | Found in (after PATH)                                            | Source                                                                                             |
| ------------ | --------- | --------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `den-claude` | Anthropic | Claude Code, `claude` | `~/.local/bin`, `~/.claude/local`, system dirs                   | [setup](https://code.claude.com/docs/en/setup)                                                     |
| `codex`      | OpenAI    | Codex CLI, `codex`    | `$CODEX_INSTALL_DIR`, `~/.local/bin`, system dirs                | [openai/codex](https://github.com/openai/codex), [installer](https://chatgpt.com/codex/install.sh) |
| `gemini`     | Google    | Gemini CLI, `gemini`  | system dirs                                                      | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)                            |
| `grok`       | xAI       | Grok Build, `grok`    | `$GROK_BIN_DIR`, `~/.grok/bin`, `~/.local/bin`, `/usr/local/bin` | [Grok Build](https://docs.x.ai/build/overview), [installer](https://x.ai/cli/install.sh)           |

"System dirs" are `/opt/homebrew/bin`, `/usr/local/bin` and npm's global
bin. Each one's version is `<bin> --version`. Every vendor here publishes
an official CLI, so none is left out; a vendor without one is left out
rather than guessed at (community CLIs, such as third-party "grok" CLIs,
are not xAI's and are not in the catalog).

Claude Code runs as `den-claude` (above). Every other installed runtime
runs its own interactive CLI (`codex`, `gemini`, `grok`) in the
workspace's directory; Den's tools (MCP) and permission modes are coming
for them, and lists tag them **Den tools: coming**. A runtime is offered
as startable only when it can start here: installed (or, for `generic`,
with the persona's `argv`).

A distribution adds entries with `agents.runtime_catalog` in its config,
and a person with the same key in `config/local/user.yml`. Both go
through the validator the built-in entries pass; an entry can't reuse a
catalog id (set a path instead, below):

```yaml
agents:
  runtime_catalog:
    - id: aider # lowercase, starts with a letter
      vendor: Aider
      name: Aider
      bins: [aider] # executable names, no paths
      version:
        args: [--version]
        identity: # at least one: how a path is known to be it
          output: "aider" # a pattern its version output matches
          # package: aider-chat        (the npm package it resolves into)
          # realpath_under: [~/.aider] (where it really lives)
      dirs: [~/.local/bin, $AIDER_DIR, "{system}"]
      launch:
        argv: ["{bin}"] # "{bin}" first: the path found
      # Optional, how it behaves in an Agents tab pane (AG-4b):
      softNewline: esc-cr # what Shift+Enter sends: esc-cr (default), lf, none
      titleFromOsc: false # its terminal title (OSC 0/2) names the session
      # sessionName: official | unofficial  (built-in adapters only)
```

**Where a runtime's CLI is found.** As your terminal would find it, not
only on the web server's own PATH (a launchd service's PATH leaves out
`~/.local/bin`, where Claude Code's native installer puts `claude`). The
first match wins:

1. **A workspace's own path**, `<ws>.agents.runtimes.<id>.bin` in
   `config/local/workspaces.yml`, for that workspace's agents. Checked the
   same way as the next one.
2. **`agents.runtimes.<id>.bin`** in `config/local/user.yml`: the absolute
   path of the runtime's CLI. Paths are per machine, so it is read from
   user.yml only, never from the distribution's config. A bad value (not
   absolute, missing, not an executable file) makes the runtime
   unavailable with that reason; Den doesn't fall back to a search.

   ```yaml
   # config/local/user.yml (gitignored)
   agents:
     runtimes:
       den-claude:
         bin: /Users/me/.local/bin/claude
   ```

3. **Your login shell's PATH**: the web server asks `$SHELL -lc` once at
   start, in the background, under a 3-second timeout. On a timeout or
   any failure it is left out.
4. **The server's own PATH.**
5. **The runtime's install directories** (its catalog entry's; for
   den-claude: `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`,
   `/usr/local/bin` and npm's global bin, `$npm_config_prefix/bin` and
   node's own directory). Den never runs npm to find it.
6. **Your interactive shell's PATH**, only while a catalog runtime is
   still not found: `$SHELL -ilc` once (stdin closed, 3-second timeout,
   the answer kept), for a PATH set only in an interactive startup file
   such as `~/.zshrc`. Its source is `interactive-shell`.

Paths are this machine's only: Den reads them from `config/local` files,
never from the distribution's config. **Settings › Agents › Runtimes**
shows each runtime's status, version, the path in use and its source.
**Set path…** runs the runtime's version command and refuses a path that
isn't that runtime (its output, npm package or install location must name
it); **Clear** removes it. The **Paths for** selector switches between
every workspace (`user.yml`) and one workspace (`workspaces.yml`). Only a
person sets a path, never an agent (`POST /api/agents/runtimes/<id>/path`,
audited).

Sessions and agents Den starts get the same directories on their PATH
(and a configured CLI's own directory), so the runtime's own tools are
found too. Two engine variables override the search for tests and
diagnosis: `DEN_LOGIN_SHELL` (the shell to ask instead of `$SHELL`; `off`
for none) and `DEN_RUNTIME_DIRS` (a PATH-style list that replaces every
runtime's install directories; empty for none).

**`<cli> agents doctor`** prints, for each runtime (installed first), its
status, the CLI it runs and where that came from (the workspace's or the
user.yml `agents.runtimes` setting, the login shell's PATH, PATH, an
install directory, or the interactive shell's PATH), its version (`claude
--version`, run once under a timeout), the directories it searched (names
only, never an environment value), and the fix when it's missing. It
resolves the login shell's PATH first, as the web server does. It exits 1
when the default runtime is unavailable; `-w <ws>` uses that workspace's
paths; `--json` prints what the Start dialog gets. A search list the same
as the one above it prints once.

```
den-claude (Claude Code, Anthropic)  [default]
  status    ✗ unavailable: claude not found (searched 5 directories)
  searched  /usr/bin
            /bin
            …
  fix       install Claude Code, or set agents.runtimes.den-claude.bin to its absolute path in /…/config/local/user.yml
            then run `<cli> agents doctor` again
```

`GET /api/personas` and `GET /api/agents/runtimes` (each with an optional
`?workspace=<ws>`) give each runtime its `vendor`, `denTools`, `version`,
`path`, `source` (`workspace`, `setting`, `login-shell`, `PATH`,
`well-known` or `interactive-shell`), `searched`, `setting` (the user.yml
key) and `workspaceSetting` (the workspaces.yml key), and `userConfig`,
the user.yml to edit.

### Workspace scope and grants

An agent's MCP config, `<stateDir>/agent-files/<id>/mcp.json` (0600), runs
`<cli> mcp --workspace <ws> --actor agent:<id>`: the agent sees and acts on
its own workspace only, and every action is recorded as `agent:<id>` (see
[Scoped to one workspace](#scoped-to-one-workspace)). A grant widens one
agent's scope. It is config in git, reviewed like code; an agent can't give
itself one:

```yaml
agents:
  planner:
    grants: [other-workspace]
```

`start` then adds `--grant other-workspace`, and each call into it is audited
with both workspaces named. Any key of `agents:` other than `max_concurrent`
and `persona_packs` is an agent id, and its only key is `grants`. A grant
naming a workspace that doesn't exist stops `start`, naming the key.

## Dev metrics: local unless you opt in

Den records each command it runs (its name, surface, duration and exit
code, never arguments or values) as one JSON line in
`.dev-metrics/events.jsonl` under the distribution root. That file stays
on the machine.

Nothing is sent anywhere unless the engineer opts in, per machine:

```yaml
# config/local/user.yml (gitignored)
metrics:
  share: true
```

Each line also records `cwd`: where the command ran, relative to the
distribution root (`.` for the root), or `outside` for anywhere else. It is
never an absolute or home path. [`<cli> doctor`](#doctor) uses it to warn
about polling loops.

Only the boolean `true` counts. With it, and a Sentry DSN in
`DEV_METRICS_SENTRY_DSN` (or a synced `dev-metrics.config`), each line is
also sent, best effort. A DSN on its own never sends. `CI=true` and
`DEV_METRICS_DISABLED=1` stop sending even when opted in.

## Agent usage: tokens and outcomes, read locally

`<cli> usage agents [-w <ws>] [--json]` reads each agent's transcripts on
this machine and saves its tokens and outcome in its record: the pull
request it opened, whether it merged, whether its last test run passed,
and its wall-clock time. It matches transcripts to agents by the
conversation id Den saved at start. It prints the share of agents with
both. Transcripts never leave the machine, and their text is never kept:
only counts. "Whether it merged" is checked: when an agent ran
`gh pr merge`, `usage` asks `gh pr view <ref> --json number,state` to confirm it.
That query, the pull request's number or URL, is the only thing it asks
outside, and the output says when it asked (or that it couldn't, because
gh is not installed). A merge gh confirmed is kept in the record
(`prMergeConfirmed`, the pull request's ref or, for a bare `gh pr merge`,
the number gh gave) and not asked about again. A mark gh no longer
confirms is dropped, with the "PR merged" rotation it made due.

`<cli> usage report [--days 7] [--json]` writes a weekly summary to
`<state dir>/usage/<date>.json` and `.md`, compared with the last one:
calls, cache re-reads, polls, sleeps, compactions, corrections and the
attributed share.

For session rotation, `usage agents` also shows each agent's compactions
(in its current conversation) and rotations (how many times Den relaunched
it from a handoff). A merged pull request makes the agent's rotation due.
`usage report` adds three numbers:

- `long_session_context_k`: the highest average tokens per call of any
  session in the window, in thousands. A call's tokens are its input,
  cache reads and cache writes.
- `never_ending_reread_pct`: the share of cache re-reads that came from
  never-ending sessions. A never-ending session compacted more often than
  `agents.rotate.after_compactions`.
- `rotations`: relaunches from a handoff, over the agents listed.

Den reads Claude Code's transcripts (`$CLAUDE_CONFIG_DIR/projects`, else
`~/.claude/projects`). A plugin can add a reader for another runtime with
the `usage` kind (server tier). A runtime with no reader shows "no usage
source reads <runtime>".

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
