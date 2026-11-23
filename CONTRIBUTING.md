# Contributing to Den

## The one rule

Den is organisation-agnostic. No org, product, distribution, customer, host,
account or repo name goes into this repo — not in code, tests, comments,
fixtures or docs. Anything org-specific is configuration (the org config,
`config/environments/<env>.json`, manifests) or a strategy a distribution
selects. Examples use neutral names (`acme`, `example.com`, `shop`, `web`,
`api`).

The org-name gate enforces this in CI. Its patterns come from the
`DEN_ORG_NAMES` secret, never from the repo, and its output names only the
file, line and pattern number.

Locally, git hooks run the same checks before anything leaves the machine:
`commit-msg` checks each message, and `pre-push` checks the new commits'
messages and the pushed commit's files. They read the patterns from
`DEN_ORG_NAMES`, `DEN_ORG_NAMES_FILE` or the per-user file
`~/.config/den-dev/org-names.txt` (git hooks don't see an agent session's
shell variables, so the file is the reliable one). Without any of them the
hooks pass quietly. A file that is named but missing stops the push.

## Layout

| Path                                                      | What lives there                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/profile.ts`, `product.ts`, `paths.ts`         | Who the running distribution is (`den.yml`) and where its files are. Every product-named value comes from here.                                                                                |
| `src/shared/den-config.ts`                                | The org config (`config/<name>.yml`).                                                                                                                                                          |
| `src/shared/environment-manager/`                         | Workspaces, the service runner, the derived dependency graph.                                                                                                                                  |
| `src/shared/secrets/`, `src/shared/auth/token-providers/` | The secrets and test-user token strategies.                                                                                                                                                    |
| `src/shared/edge/`                                        | The local HTTPS edge.                                                                                                                                                                          |
| `src/pillars/<pillar>/`                                   | Test pillars: smoke, browser, api, journeys, perf, security, suites. Den ships the runners; suites come from distributions and repos.                                                          |
| `src/ui/cli/`, `src/ui/server/`                           | The CLI and the web UI. Pages under `src/ui/server/public/` are product-neutral: product names in them are placeholders (`__DEN_CLI__`, `__DEN_TITLE__`, …) the server fills from the profile. |
| `make/`                                                   | Make fragments a distribution's Makefile includes.                                                                                                                                             |
| `examples/demo/`                                          | Three small demo repos with manifests.                                                                                                                                                         |

## Gates

Run before every push; CI runs the same:

```bash
npm ci
npm run typecheck
npm run lint
npm test
DEN_ORG_NAMES_FILE=<patterns file> node scripts/org-name-gate.mjs
```

A new test, lint rule or gate must be seen failing before it is trusted.

Browser tests and live checks (`tests/**/*.browser.*`, `gate/*.mjs`) never
gain a fixed sleep, a positional pick, a class selector or an English-text
assert (issue 839). On a pull request, `scripts/brittle-ratchet.mjs` counts
each file the change touched at its merge base and at HEAD, and fails only
when a count goes up; files the change didn't touch are never judged, and
there is no baseline file to update. Run it before a push with
`node scripts/brittle-ratchet.mjs --base origin/main`; `--report` prints the
totals per kind and never fails.

### What runs first

The static checks that fail most often run first, in seconds: version
sync, the words gate, the colour and kit tokens, i18n parity, the
settings inventory, the pop-up and dialog ratchets, and the kit-copy
check. The list is `scripts/fast-checks.json`; one script runs it:

```bash
node scripts/fast-checks.mjs          # about 10 s
node scripts/fast-checks.mjs --list   # what it runs
```

In CI it is the `fast` job, under a minute. The test jobs and shards wait
for it, so one of these failing shows in a minute or two, not after a
ten-minute shard. The `pre-push` hook runs the same list before the
org-name checks. `DEN_PREPUSH_FAST=0` skips it for one push, as a hatch
for a person only: agents and lanes never set it (the same rule as never
using `--no-verify`), and CI's `fast` job runs the same list anyway. A check
belongs on the list only when it reads the repo and nothing else (no
server, browser, Docker or network) and takes seconds.

On a busy machine, fewer jest workers means fewer flakes from load:
`DEN_TEST_WORKERS` sets how many (a number, or a percentage such as
`50%`). Unset, jest picks its own. `npm run preflight` uses 8 unless it is
set.

The sign-in smoke (`tests/unit/server/d17-claim.browser.test.ts`) runs in
Chromium by default; `DEN_D17_BROWSER=firefox` or `webkit` runs it in the
others. WebKit on macOS needs a GUI session: when `launchctl managername`
doesn't say `Aqua` (an ssh or background shell), the launch hangs. Run
WebKit from Playwright's Linux image instead, at the version in
`package-lock.json`:

```bash
docker run -d --rm --name pw --init -p 127.0.0.1:3917:3917 \
  mcr.microsoft.com/playwright:v<version>-noble \
  npx -y playwright@<version> run-server --port 3917 --host 0.0.0.0
DEN_PW_WS=ws://localhost:3917/ DEN_D17_BROWSER=webkit \
  npx jest tests/unit/server/d17-claim.browser.test.ts
docker stop pw
```

The browser's `localhost` and `*.localhost` are this machine's
(`exposeNetwork`), so the test runs as it would locally.

### Quarantined tests

`tests/quarantine.json` lists flaky tests. On a pull request, CI leaves
them out of the blocking test steps and runs them in a last step that
can't block. Each step's job summary has a table of them, passed or
failed, with their age. On a push to main and in `release.yml` the list
is ignored: every test blocks.

The switch is `DEN_TEST_QUARANTINE`: unset runs everything (the default),
`exclude` skips the listed tests, `only` runs just them.

To add an entry, you need evidence: the same sha failed, then passed.

```bash
node scripts/flake-evidence.mjs <red run id>
```

It reads the Actions API (read-only) and prints an entry per failing test.
If no other run on that sha passed, it says so in `evidence.note`; it
never makes one up. Paste the entries for the flaky tests, not the ones
that are really broken. Each entry has `file`, `test` (the full name
jest prints, or the test's own title, exactly; `/regex/` matches the full
name), `issue`, `added` (YYYY-MM-DD) and `evidence`.

To remove an entry, delete it in the PR that fixes the test.

The weekly rule: each entry is fixed or deleted within `max_age_days`
(14 by default; `DEN_QUARANTINE_MAX_AGE_DAYS` overrides it).
`tests/unit/test-infra/quarantine.test.ts` fails on an older entry, or on
one with no issue or no evidence.

### The tests a pull request runs

A push to `main` and a release run every test on both Nodes. A pull
request runs the same checks, then the tests the change affects, on
both Nodes. To see the list and the reason for each:

```bash
node scripts/affected-tests.mjs origin/main HEAD
```

- **related**: the tests that import a changed file (`jest --findRelatedTests`);
- **mapped**: from `tests/affected-map.json`: the browser specs of a changed
  page (a spec opens pages by URL, so imports never reach it), and tests
  that read files by path (docs, the changelog, `examples/`, `public/`);
  a change to a UI catalog (`public/i18n/*.js`) also runs the tests that
  import the English-catalog helper, and the specs that name a changed key
  or its English text;
- **smoke**: a few fast, broad tests, every time;
- **everything**: a change to a shared file (the shell, the kit, the request
  guard, `package.json`, jest or test setup, CI) runs them all.

`node scripts/affected-map.mjs` rewrites the map's page rules from the code
(CI also adds them fresh, so a new spec is never left out).
`scripts/ci-replay.mjs` replays the last 30 days of red CI runs and fails if
the subset would have missed a real failure;
`tests/fixtures/ci-replay-cases.json` keeps those failures, and
`tests/unit/test-infra/affected-tests.test.ts` fails if the map stops
catching one.

### Playwright in CI

Every job that runs browser tests installs Playwright through
`scripts/ci-pw-install.sh`, never `playwright install` directly (a test keeps
it so). The script splits the install in two, each with a time limit and one
retry:

- the system packages (`playwright install-deps`, apt). They run as root, so a
  cut-off try can't be killed and goes on holding dpkg's lock; the retry
  waits for it to finish first;
- the browsers (`playwright install`).

One cache step, keyed by the OS and Playwright's version, keeps both the
browsers (`~/.cache/ms-playwright`) and apt's downloaded packages
(`~/.cache/den-apt`). Once one job has them, later runs skip the Ubuntu mirror.
The limits are settings: `CI_PW_DEPS_SECONDS` (default 240) and
`CI_PW_INSTALL_SECONDS` (default 90).

## Merging

A pull request merges once its own run is green. When only main moved
under it, it merges **without another run**, if:

- it still merges cleanly into main, and
- none of the files it changes were changed on main since the commit its
  green run tested (no overlap with what landed).

Otherwise main is merged into the branch and it runs again. Main's own
full run (every test, every Node version, quarantine ignored) is the
backstop: if main goes red after such a merge, fix it forward within 30
minutes or revert that merge. A red main blocks other merges until then.

## Live checks

Each pull request that closes a clause of an issue also ships a live
check, `gate/<issue>.mjs`, written next to its red-first test (reuse the
end-to-end spec where it fits). A harness runs every file in `gate/`
against a bed (a running Den, by its URL and its CLI) on each dev tag,
with no one in the loop, and reports PASS or FAIL per clause.

```js
// gate/406.mjs
export const issue = 406;
export const clauses = [
  "two lines when the person has a name",
  "the person signs in on a second device",
];
// Optional: run once per cell; expect then gets [{ cell, result }].
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 120000; // optional; a cell over it is ok: false
// Optional: it changes nothing in Den, so it may run beside others.
export const readOnly = true;
// Optional: other release items whose clauses it proves, its own issue first.
// One line: the bed reads it from the source to plan a tag's items.
export const items = [406, 991];
export async function setup(ctx) {} // prepare the bed; returns state
export async function run(ctx, state) {} // act; returns what it saw
export async function teardown(ctx, state) {} // optional; always called
export function expect(cells) {
  return [
    { clause: clauses[0], ok: true, evidence: ["entry-1280"] },
    { clause: clauses[1], ok: null, skip: "person" }, // not run, and why
  ];
}
```

- `issue` matches the file name. `clauses` names each clause the check
  proves, as the issue words it, and `expect` answers each one once.
- The harness reads a row's `detail:` (what was seen), never `note:`.
- `ok` is `true`, `false`, or `null` for "not run". `null` always comes
  with `skip`: `"person"` for a person's own act (an Allow, an answer, an
  approval), or `"needs-<thing>"` for what the bed lacks (for example
  `"needs-signed-in-cli"`). A check never presses a person's decision.
- `teardown` runs even when `run` throws. A check only reads, or makes
  what it needs under its own names and removes them; it never changes
  the bed's settings for good, and never touches a live install.
- Names stay neutral (the one rule above applies here too).

### Read-only checks

A check that changes nothing in Den says so, with a one-line comment
naming what it reads:

```js
// Read only (issue 845): reads doctor and Settings › Agents.
export const readOnly = true;
```

The bed runs read-only checks together, a few at a time, each in its own
browser context, inside one test slot. Every other check runs alone, one
after another, and the ones that restart or reconfigure Den run last.

A read-only check may sign in as the fixture person, read the API and the
CLI's reads (`doctor`, `agents list`, `gate status`, ...), open pages, and
click what only changes the page's view. It never:

- writes settings or config (`POST /api/settings`, `config`, user.yml);
- starts, stops, removes or drives an agent (`ctx.agent`, `ctx.stub`);
- restarts or takes down Den, its web server, edge, host or address;
- writes to Hub, asks for a held write, or files a notification or report;
- asks for a gate slot, writes files, starts a process or signs out;
- fakes a request with `page.route` (a missed route is a real write).

Leave it off when in doubt, and when the check depends on what another
check could change mid-run (exact counts of agents or bell items) or on
fixed ports or names. Leaving it off is always safe: the check just runs
alone. `tests/unit/test-infra/gate-readonly-modules.test.ts` reads every
check marked read-only and fails, naming the check, the line and the
call, on any write it finds.

What the harness passes in `ctx`:

|                                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.url`                                                                     | the bed's address as the browser reaches it: for pages (`goto`, links), never a module's own `fetch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ctx.hostUrl`                                                                 | the bed's address as the host reaches it (`http://127.0.0.1:<port>`), for a module's own plain `fetch`. A plain `fetch` runs on the host, where `ctx.url` reaches the live edge: the harness refuses it, and `gate-shape` flags it                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ctx.cli(args, { timeout?, env? })`                                           | runs the bed's CLI: `{ code, out, err }`, one-time codes already masked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ctx.api(path, init?)`                                                        | a signed-in `fetch` against the bed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ctx.page`, `ctx.browser`, `ctx.width`                                        | with a `matrix`: a signed-in page in this cell                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ctx.shot(name, { mask? })`                                                   | a screenshot into the evidence folder; pairing and device codes masked by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ctx.evidence(name)`                                                          | an absolute path in this tag's evidence folder, for logs and files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ctx.agent(id)`                                                               | the bed's stub agent: `start(persona)`, `running(ms)`, `stop()`, `restart()`, `remove()`, `state()`, `waiting(why)`, `askHuman(q)`, `permissionRequest(tool)`, `askUserQuestion(q)` (a pending AskUserQuestion as Claude Code sends it: its PermissionRequest with `questions`, then the `permission_prompt` notice), `notice(type, text)` (a Notification of any `notification_type`, such as `elicitation_dialog`), `idlePrompt()`, `sessionStart(kind)`, `print(text)`, `hook(event, input)`, `exit()`, `typed({ since })` (what Den typed into it), `sh(cmd, ms)` (a command run inside its own session: `{ status, out, err }`) |
| `ctx.fetch(path, init?)`                                                      | like `api`, keeping the status: `{ status, headers, body }` (refusals are judged by status)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ctx.readBed(rel)`                                                            | a file under the bed's folder, or its state folder with a `state:` prefix (`state:agents/<id>.json`), read only: its text (codes masked), or null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ctx.listBed(rel = '.')`                                                      | the names in a folder under the bed's folder, or its state folder with a `state:` prefix, sorted, read only; or null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ctx.goto(page, path)`, `ctx.sleep(ms)`, `ctx.now()`                          | open a bed page; wait; the harness's clock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ctx.until(fn, ms)`                                                           | waits for `fn` to be true: the ms it took, or null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ctx.bell(page)`                                                              | `{ badge, unread, waiting[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ctx.notifications`, `ctx.waiting`                                            | the bed's notifications, and what waits on the person, as the bell reads them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ctx.edge`                                                                    | the bed's own edge: `inspect()`, `swap({ image, accessLog })`, `restore()`, `status(path)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ctx.signedIn`, `ctx.signedOut(browser, width)`                               | a signed-in page; a page with no session: `{ ctx, page }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ctx.pageApi`                                                                 | an API call through the page's own sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ctx.sessions`                                                                | the bed's terminal and agent sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ctx.addressDead({ keepSeconds, maxMs })`                                     | takes the bed's address down for a while, to see what the page and sessions do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ctx.stub`, `ctx.stubLog(name, { k? })`                                       | the stub runtime the bed's agents run; its log (codes masked)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ctx.stub.nextStart({ mode, shape?, default? })`, `ctx.stub.clearNextStart()` | how the next stub start (a start, Resume or relaunch) behaves, that start only: `mode: 'unwritten'` exits 1 before writing any conversation; `mode: 'trust'` draws the folder-trust question first (`shape` `'a'` "1. Yes, I trust this folder" or `'b'` "1. Yes, proceed"; `default` `'yes'` or `'no'`, the choice a bare Enter picks) and writes nothing until Yes. Clear it in `teardown`                                                                                                                                                                                                                                         |
| `ctx.stub.trust(id, yes)`                                                     | the stub's own stand-in for the person on its trust screen (its control channel, never Den's terminal or page)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| stub verbs (typed in as a message from the page, `POST …/agents/<id>/say`)    | `/bg <secs> [name]`: the stub forks a detached shell under its own process that sources `$STUB_HOME/shell-snapshots/snapshot-zsh-<id>.sh` and sleeps `<secs>` (a background shell as Claude Code's look to Den), and its turn ends at once; `/bg-stop` ends them, as the stub's exit does                                                                                                                                                                                                                                                                                                                                            |
| `ctx.transcriptPath(id)`                                                      | the stub agent's conversation file, or null while none is written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ctx.hub`                                                                     | the bed's Hub: `url`, `team`, `by`, `deliveries(after?)`, `doc({ agent, workspace, title })`, `comment({ agent, text, slug? })` → `{ id, slug }`, `delivery(id)` → `{ state, ack, ackedAt, acked, from }` (`acked`: it has left Hub's unanswered list; Hub's list doesn't show `ack` yet). For a stronger check, also read Den's side (the agent's row, or doctor's held list)                                                                                                                                                                                                                                                       |
| `ctx.hubs.a`, `ctx.hubs.b`                                                    | the two test Hubs (`fixture: true`), for a check that moves the bed from one Hub to the other: `url`, `team`, `companies` (the test companies seeded there, `[]` until seeded), `by`, and `comment({ agent, text, slug?, workspace?, company? })`, `doc`, `deliveries`, `delivery` as on `ctx.hub` (those three only on the Hub the bed is bound to now). Allowed by test fixture: only on the test Hubs, only in test companies                                                                                                                                                                                                     |
| `ctx.den2()`                                                                  | a throwaway second Den on its own dir, state dir and loopback port, at the bed's commit, pointed at the first Postgres test Hub, so a check can change a Den's Hub without touching the bed's own Den. A full ctx of its own (`api`, `fetch`, `cli`, `agent`, `readBed('state:…')`, `hubs`, `hubConnect`, `hubTokenSnapshot`, `hubTokenStatus`); its `close()` disconnects it (Hub revokes), checks its last token answers 401 and removes it. Call `close()` in `teardown`                                                                                                                                                          |
| `ctx.hubConnect(key, { company? })`                                           | the fixture Connect to `ctx.hubs[key]`: Allow pressed as the fixture person, for `company` (default: the Hub's own pick). `{ ok, company }`, never a code or token. Absent until Hub's fixture connect-allow exists: skip with `"needs Hub fixture connect-allow"`                                                                                                                                                                                                                                                                                                                                                                   |
| `ctx.hubTokenSnapshot()`, `ctx.hubTokenStatus(id, key)`                       | keep the bed's Hub token now, in the harness's memory only (an id back, never the token); later, the HTTP status of Hub's `/connect/whoami` with it on `ctx.hubs[key]` (200, or 401 once revoked). Throws on an unknown id or key                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ctx.pairing`, `ctx.loginLink(…)`                                             | a pairing code and a one-time sign-in link, in memory only: never log them, never return them from `run`, never put them in a row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ctx.shotOf(page, name, { mask? })`                                           | `shot` for another page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Names in a row's `evidence` are written into the verdict next to it.
Anything else on `ctx` is the harness's internals and may change: never
use it. Setup's state reaches `expect` only through what `run` returns.

### The bed signs in as a fixture person

Live checks run as an agent, and Den never signs an agent in as the
person. On a bed, the runner signs in as a **fixture person** instead:
neither the person nor an agent, logged and audited as "fixture person".
It works only on a **test install**, which needs all four of these:

1. The mark, set by hand by a person in the bed's distribution config
   (`config/den.yml`). Settings, `config` and agents can't set it, and
   agents are denied edits to that file.

   ```yaml
   web:
     test_install: true
     fixture_session_minutes: 60 # optional: how long a fixture session lasts
   ```

2. The launcher's test-only flag in the server's own start environment,
   `<PREFIX>_TEST_INSTALL=1` (`DEN_TEST_INSTALL=1` for Den). No file can
   set it, and the server drops it from what it passes on.
3. Its own state folder (`<PREFIX>_HOME`), never the product's default
   one.
4. No owner and no other person: no GitHub sign-in, setup link or
   pairing code ever used on it, and no one signed in by a `web login`
   link except the person who pressed **Set up test person**.

Then:

1. Signed in (a `web login` link), the person opens Settings › Access ›
   Test install in their browser and presses **Set up test person**,
   once. It is a button only: every command-line call and agent is
   refused. The server writes a key in the bed's state folder (0600),
   sealed with the install's own secret, so a key it didn't write is
   refused. Pressing it again replaces the key and ends every older
   fixture session.
2. The runner gets a one-time sign-in link as the fixture person:

   ```sh
   <cli> web fixture-login [--next <path>] [--origin <url>]
   ```

Anywhere else the fixture sign-in and its setup are refused, and an
agent's own `web login` stays refused everywhere. A fixture session
counts as an agent at every person-only check, reaches only the pages and
the few writes live checks need, never opens a terminal, and ends as soon
as the install stops being a test install, the key goes, or its time is
up.

### A new test install, and the test operator

A test install can also be **created** as one. Start the server with the
launcher's flag on a state folder that is missing or empty, with the mark
already in the distribution config. At that first start the server claims
the folder (a creation record, sealed for that folder), and gives the
install its fixture person: no one presses Set up test person, and
`web fixture-login` works at once. Adding the mark to an install that
already ran never does this.

On such an install, bound to loopback only, the fixture session is also
the **test operator** for a few person-only requests the live checks
need, each audited as `test:operator`:

| Request                                                 | For                                |
| ------------------------------------------------------- | ---------------------------------- |
| `POST /api/workspaces/:ws/sessions` (no `cwd`)          | Terminal opens a terminal; the cap |
| WebSocket `/api/sessions/:id/io`, its own, by host id   | typing into it, taking focus       |
| `POST /api/sessions/:id/close`, its own                 | closing what a check opened        |
| `POST /api/workspaces/:ws/agents/:id/say`, project only | a message to an agent              |
| `POST /api/workspaces/:ws/agents/:id/relaunch`, project | Resume after a relaunch            |

Its terminal is never a shell: it is Den's fixed stub, which echoes what
is typed and does nothing else, in the project's folder. Say and relaunch
reach project agents only, never the server agent. A request through the
edge, a LAN name or a proxy is refused. Everything else stays the fixture
person's: no shell, no Allow on a held write, no person-only setting, no
Hub, no sign-in or device routes, no runtime path. Clauses that need
those keep skipping as `person` and are covered by CI.

`node scripts/gate-shape.mjs` checks every file has this shape, and
`tests/unit/test-infra/gate-checks.test.ts` runs it in CI, along with
the rules for `expect`'s rows (`checkRows`).

## Adding a strategy

- **Secrets backend:** implement `SecretsProvider`
  (`src/shared/secrets/types.ts`) and register it in
  `src/shared/secrets/index.ts`.
- **Identity provider:** add a token provider under
  `src/shared/auth/token-providers/`, selected by `auth.provider` in an
  environment file.

Anything a provider needs from an org (domains, audiences, client ids, vault
items) is read from config, with no org default.

## Releasing

`.github/workflows/release.yml` publishes `@monster-orange/den` with npm
trusted publishing (no token anywhere):

- A PR that changes `packages/den-ui` bumps the kit's version (its
  `package.json` and its `package-lock.json` entry together):
  `scripts/kit-version.mjs` fails the PR's checks and the release's den-ui
  job otherwise, since npm already has the old version.
- A release publishes the exact tree of the dev tag that passed its test
  bed, never `main`'s HEAD (issue 922; docs/releasing.md). Start
  `release.yml` by hand, from `main`, with `promote` set to the release's version commit
  on its release branch: its parent is the signed dev tag, whose commit has
  the bed's PASS (the `release/bed` commit status). Then the gates, the
  tarball (with `release.json`) and its SHA256SUMS (naming the dev tag and
  its commit), the tag `v<version>` on that commit, `npm publish` with
  provenance, and a GitHub release.
- A push to `main` publishes nothing, so `main` takes merges at any time.
  Merge the release branch into `main` after the release: `v<version>`
  already tags its version commit, so nothing publishes again.
- The gates run on both ends of the supported Node range, the lowest that
  `engines` allows and the Node installs run, and both must pass. The
  tarball is built on the lowest. `ci.yml` runs the same matrix on every
  push and pull request.
- npm can take about 20 minutes to serve a version after accepting it. The
  publish job waits for it (up to 30 minutes) before the GitHub release.
  Don't rerun publish in that window: npm answers 409 for a staged version.
- A prerelease version (`0.1.0-dev.N`) never publishes, so `main` can carry
  work toward a version.
- Bump the prerelease number (`-dev.N`) for every tarball handed to a
  distribution, so npm never serves a cached older copy.
- Tag each tarball handed to a gate `v<version>-dev.N` on the commit it
  was packed from, and push the tag. The release job checks that every
  such tag of the version is in the release commit's history
  (`scripts/release-ancestry.sh`): a candidate of the same version that
  passed its gate but isn't in the promoted commit stops the release.
- Every pushed dev tag starts the release's dry run
  (`.github/workflows/release-dry-run.yml`, issue 615). It applies the
  release commit's edits to the runner's copy only
  (`scripts/release-dry-run.mjs`): Den's version without `-dev.N` in
  `package.json`, `package-lock.json` and
  `examples/distribution/package.json`, the kit's version, and the
  changelog entry's date. Then it runs the release's own checks, tests and
  pack (`release-gates.yml`, which `release.yml` calls too). It never tags,
  publishes or makes a GitHub release, and has no token. Its result is a
  check on the candidate's commit, beside the bed run: a failure there
  would fail the release.
- The kit's version (`packages/den-ui`) is decided in the candidate,
  never in the release commit. When a candidate changes the kit and npm
  already has its version, bump the kit's version (its `package.json` and
  its entry in `package-lock.json`) in the candidate before the dev tag.
  The dry run fails and says so otherwise.
- The release commit changes only Den's version and the changelog entry's
  date: everything else was in the candidate the dry run checked.
- Bump the version in `package.json`, `package-lock.json` and
  `CHANGELOG.md` together; the changelog entry lists the **Migrations** a
  distribution must make.
