# Den

Den is a config-driven local development appliance. It starts the repos you
work on in dependency order, puts them behind a local HTTPS edge, gives you a
web UI and a CLI over all of it, and runs smoke, browser, API, journey,
security and performance suites against the environments you declare.

Den knows nothing about any particular organisation. Everything specific to
yours — product name, repos, environments, hosts, secrets backend, test
accounts — lives in **your distribution**, not in Den.

> **Status: 0.2.0**: `npm install @monster-orange/den`. Den is pre-1.0; each release lists the changes a distribution makes under **Migrations** in [CHANGELOG.md](CHANGELOG.md).

## Make it your own

1. **Create** a distribution named after your product:

   ```sh
   npx @monster-orange/den create acme      # → ./acme
   cd acme && npm install
   ```

2. **Name** it: `den.yml` holds `product: { name: acme }`, so the CLI is
   `./bin/acme`, env vars are `ACME_*`, state lives in `~/.acme`. Pass
   `--cli`, `--env-prefix` or `--title` to `create`, or edit `den.yml`.
3. **Brand** it: `brand:` in `config/acme.yml` sets the name, tagline and
   banner people see in the CLI and web UI.
4. **Point it at your repos**: set `github_org` in `config/acme.yml`, then
   `./bin/acme register ../shop-api` (or add a manifest per repo under
   `manifests/`).
5. **Run** it: `./bin/acme up`, `./bin/acme web`, `make test`.

Every field, the bin shim, the make fragment and upgrading are in
[docs/distributions.md](docs/distributions.md);
[examples/distribution/](examples/distribution) is what `create acme` writes.

## Distributions

You run Den through a small repo of your own (a _distribution_):

```
my-dev/
├── den.yml               # who this distribution is (below)
├── package.json          # pins an exact @monster-orange/den version
├── config/<name>.yml     # your org config
├── config/environments/  # one <env>.json per environment
├── manifests/            # manifests for repos that don't carry their own
├── tests/pillars/<pillar>/   # your own suites (e.g. tests/pillars/perf/<module>/test.js)
├── bin/<cli>             # shim: DEN_ROOT=<this dir> exec node_modules/@monster-orange/den/bin/den
└── Makefile              # include node_modules/@monster-orange/den/make/den.mk
```

`den.yml` names the product. Every runtime name derives from it:

```yaml
product:
  name:
    acme # CLI "acme", env vars ACME_*, config/acme.yml,
    # manifests .acme.yml, state ~/.acme,
    # managed clones .acme-services/, workspaces acme-workspaces/
  # Override any of them: cli, env_prefix, config, manifest, state_dir,
  # services_dir, workspaces_dir
```

Den's own checkout is a distribution named `den`, so in this repo the CLI is
`./bin/den`, the config is `config/den.yml`, and env vars are `DEN_*`.

## Repos opt in with a manifest

A repo joins by carrying a manifest at its root (`.<name>.yml`, e.g.
`.den.yml`) whose commands delegate to the repo's own targets. Den never
reaches inside a repo beyond that. When a repo has no manifest, the
distribution can hold one for it in `manifests/<repo>.<name>.yml`; the repo's
own manifest always wins.

```yaml
# demo-api: a self-contained service. Nothing it calls, so it starts alone.
version: 1
name: demo-api
application: shop # the application this repo belongs to (den apps)
compose:
  files: [docker-compose.yml]
  routes:
    api: api:8080 # https://api.demo-api.<edge domain>
services:
  demo-api:
    commands:
      local:
        setup: make setup
        preflight: make test
# OWASP ZAP target for the security pillar (`make test-sec-api env=local`).
security:
  api:
    hosts:
      local: ["https://api.demo-api.globex.localhost"]
```

That is `examples/demo/demo-api/.den.yml`; the other demo repos are in
[`examples/demo/`](examples/demo/).

## What it does

- **Workspaces.** A workspace is a set of repos. Each is either
  _dev-managed_ (your checkout, your branch) or _managed_ (cloned by Den and
  kept on a tracking branch).
- **Derived dependency graph.** Start and stop order comes from real signals in
  each repo — SDK imports, `*_URL` env vars, IaC references, event rules,
  readiness probes — tuned in config with `graph.aliases`, `graph.edges` and
  an optional shared local-infra repo (`graph.infra`).
- **Local HTTPS edge.** One local proxy routes `https://<route>.<domain>` to
  each service, with an optional project CA.
- **Test pillars.** `smoke`, `browser` (synthetic Playwright), `api`,
  `journeys` (agent-driven), `perf` (k6), `security` (OWASP ZAP against hosts
  you own) and `suites` (a repo's own commands).
- **Releases.** A release view over the repos and deploy workflows your config
  lists.
- **Web UI and CLI** over the same state.

## Strategies

Concerns that vary by org are strategies selected in config, never hard-wired:

| Concern          | Built-in choices                        | Chosen in                                                                                                            |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Secrets backend  | `none`, `env`, `doppler`, `1password`   | `secrets.provider` in the org config; per engineer in `config/local/user.yml`; per shell `<PREFIX>_SECRETS_PROVIDER` |
| Test-user tokens | `local-jwt`, `cognito`, `auth0`, `none` | `auth.provider` in `config/environments/<env>.json`                                                                  |

A new secrets backend implements `SecretsProvider`
(`src/shared/secrets/types.ts`) and registers as a strategy
(`src/shared/secrets/strategies.ts`); a distribution needs no store at all
(`none`, see "Secrets" in `docs/distributions.md`). A new identity provider implements a token
provider in `src/shared/auth/token-providers/`.

## CLI

```bash
den up [repo]          # start the repo's derived dependency closure (-x deps only, -n dry run)
den down [repo]        # stop it cleanly (--with-deps: and what it sits on)
den status             # service health for the active workspace
den apps               # Org > Application > Repo > Services
den graph [repo]       # the derived dependency graph
den logs [repo]        # tail a repo's local logs
den use-local [repo]   # use your checkout · use-managed [repo] to switch back
den workspace list     # workspaces (activate · deactivate · use · create · delete)
den run                # run test suites (interactive, or with options)
den web                # the web UI
den --help             # everything else
```

In a distribution the command is that distribution's `cli` name.

## Developing Den

```bash
npm ci
npm run typecheck
npm run lint
npm test
DEN_ORG_NAMES_FILE=<patterns file> node scripts/org-name-gate.mjs
```

CI runs the same gates. The org-name gate fails the build when any file names
an organisation, product, host or account; its patterns are kept out of this
repo (a CI secret) so the list itself is never published. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
