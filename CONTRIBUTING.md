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
- `ok` is `true`, `false`, or `null` for "not run". `null` always comes
  with `skip`: `"person"` for a person's own act (an Allow, an answer, an
  approval), or `"needs-<thing>"` for what the bed lacks (for example
  `"needs-signed-in-cli"`). A check never presses a person's decision.
- `teardown` runs even when `run` throws. A check only reads, or makes
  what it needs under its own names and removes them; it never changes
  the bed's settings for good, and never touches a live install.
- Names stay neutral (the one rule above applies here too).

What the harness passes in `ctx`:

|                                         |                                                                                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.url`                               | the bed's address                                                                                                                                                                                                            |
| `ctx.cli(args)`                         | runs the bed's CLI: `{ code, out, err }`, one-time codes already masked                                                                                                                                                      |
| `ctx.api(path, init?)`                  | a signed-in `fetch` against the bed                                                                                                                                                                                          |
| `ctx.page`, `ctx.browser`, `ctx.width`  | with a `matrix`: a signed-in page in this cell                                                                                                                                                                               |
| `ctx.shot(name, { mask? })`             | a screenshot into the evidence folder; pairing and device codes masked by default                                                                                                                                            |
| `ctx.evidence(name)`                    | an absolute path in this tag's evidence folder, for logs and files                                                                                                                                                           |
| `ctx.agent(id)`                         | the bed's stub agent: `start(persona)`, `running(ms)`, `stop()`, `restart()`, `remove()`, `state()`, `waiting(why)`, `askHuman(q)`, `permissionRequest(tool)`, `idlePrompt()`, `sessionStart(kind)`, `print(text)`, `exit()` |
| `ctx.fetch(path, init?)`                | like `api`, keeping the status: `{ status, headers, body }` (refusals are judged by status)                                                                                                                                  |
| `ctx.readBed(rel)`                      | a file under the bed's folder or its state folder, read only: its text (codes masked), or null                                                                                                                               |
| `ctx.listBed(rel = '.')`                | the names in a folder under the bed's folder or its state folder, sorted, read only; or null                                                                                                                                 |
| `ctx.goto(page, path)`, `ctx.sleep(ms)` | open a bed page; wait                                                                                                                                                                                                        |
| `ctx.until(fn, ms)`                     | waits for `fn` to be true: the ms it took, or null                                                                                                                                                                           |
| `ctx.bell(page)`                        | `{ badge, unread, waiting[] }`                                                                                                                                                                                               |
| `ctx.edge`                              | the bed's own edge: `inspect()`, `swap({ image, accessLog })`, `restore()`, `status(path)`                                                                                                                                   |
| `ctx.signedOut(browser, width)`         | a page with no session: `{ ctx, page }`                                                                                                                                                                                      |
| `ctx.shotOf(page, name, { mask? })`     | `shot` for another page                                                                                                                                                                                                      |

Names in a row's `evidence` are written into the verdict next to it.
Anything else on `ctx` is the harness's internals and may change: never
use it. Setup's state reaches `expect` only through what `run` returns.

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

- A push to `main` whose `package.json` version is not on npm yet is the
  release: the gates, the tarball and its SHA256SUMS, the tag `v<version>`,
  `npm publish` with provenance, and a GitHub release.
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
  (`scripts/release-ancestry.sh`): a candidate that passed its gate but
  never merged stops the release.
- Bump the version in `package.json`, `package-lock.json` and
  `CHANGELOG.md` together; the changelog entry lists the **Migrations** a
  distribution must make.
