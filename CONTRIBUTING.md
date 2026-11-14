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
