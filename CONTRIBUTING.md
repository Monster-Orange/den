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

### Static tests run first

`tests/static-tests.json` lists the static tests: no server, no browser,
no Docker, no child process (version-sync, the token and words checks,
and the like). CI runs them first, in one short job on Node 22, on pull
requests and on push; every job that runs tests waits for it, so one of
them failing shows in about a minute, not after the shards. The checks
and the install smoke run beside it.

The list is picked by a rule (`scripts/static-tests.js`): the file and
everything it imports from this repo reach no child-process, server,
browser or Docker module, and each file runs in under `max_seconds` on
CI (the job fails on a slower one, and its summary has the slowest files
and its wall time). `tests/unit/test-infra/static-tests.test.ts` checks
the rule. To see every file the rule allows:

```bash
node scripts/static-tests.mjs --candidates
```

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
name), `issue`, `owner` (who fixes or deletes it; `den-builder` by
default), `added` (YYYY-MM-DD) and `evidence`. `--attempt N` reads an
earlier attempt of a run that was re-run green.

To remove an entry, delete it in the PR that fixes the test.

The weekly rule: each entry is fixed or deleted within `max_age_days`
(14 by default; `DEN_QUARANTINE_MAX_AGE_DAYS` overrides it).
`tests/unit/test-infra/quarantine.test.ts` fails on an older entry, or on
one with no issue or no evidence.

### Flaky on retry

On a pull request, a test file that fails runs once more, alone, in a
fresh jest (`scripts/flake-retry.js`). If it passes then, the step
passes, but never silently: the job summary has a "Flaky on retry"
table, the `flaky-on-retry-*` artifact has each file with the tests that
failed first, the sha, run and job, and a warning names every such file
that `tests/quarantine.json` doesn't list. A file red twice blocks. A
push to `main`, the nightly run and a release never retry.

### The tests a pull request runs

A push to `main`, the nightly run of `main` and a release run every test
and check on both Nodes. A pull request runs the tests the change affects
on both Nodes too (#398's replay found real failures on one Node only, on
each side), but its checks and the install smoke on Node 22 only: none
failed on one Node alone. A change to `package.json` (`engines` too),
`package-lock.json`, `.nvmrc` or a workspace package's `package.json`
runs them on both (`scripts/pr-nodes.js`). A release is made only from a
commit whose push run passed on both Nodes (`scripts/release-ci-green.js`
in `release.yml`'s check job; it waits up to `RELEASE_CI_WAIT_MINUTES`,
45 by default). To see the list and the reason for each:

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
  push to `main` and nightly, and the release waits for that push run to
  pass on both Nodes.
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
