# Acme

Acme is a Den distribution: Den (`@monster-orange/den`) is the engine,
this repo holds what makes it yours.

## Run

```sh
npm install
./bin/acme --help
./bin/acme status
./bin/acme web          # the web UI
make help
```

## Layout

| Path | What |
| --- | --- |
| `den.yml` | The product profile: name, CLI, env prefix, file and directory names |
| `config/acme.yml` | Brand, GitHub org, secrets backend, edge |
| `config/environments/` | One JSON file per environment (base URLs, auth, timeouts) |
| `manifests/` | Manifests for repos that do not carry their own |
| `tests/pillars/` | This distribution's own tests, by pillar |
| `bin/acme` | Runs Den from `node_modules` with this repo as its root |
| `Makefile` | Includes Den's make targets (`make/den.mk`) |

Environment variables use the `ACME_` prefix: for example
`ACME_HOME` moves the state directory (default `~/.acme`).

## Upgrade Den

`package.json` pins an exact Den version. To upgrade, read the
Migrations section of Den's CHANGELOG for each version in between, then:

```sh
npm install @monster-orange/den@<version> --save-exact
```
