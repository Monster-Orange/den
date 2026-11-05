/**
 * `den create <name> [dir]`: scaffold a new distribution.
 *
 * A distribution is a small repo that installs Den as a package and holds
 * everything that makes it yours: den.yml (the product profile), config/
 * (brand, secrets, edge), manifests/, tests/pillars/, a Makefile that
 * includes Den's make fragment, and a bin/<cli> shim. See
 * docs/distributions.md.
 *
 * This module imports nothing that needs a distribution root: it runs before
 * one exists. examples/distribution/ is exactly `den create acme`; a unit
 * test regenerates it, so the two cannot drift.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ENGINE_PACKAGE, getEngineRoot } from "../../shared/paths.js";
import { profileFrom } from "../../shared/profile.js";
import { plural } from "../../shared/plural.js";

export interface CreateOptions {
  /** Product name: lower-case `[a-z][a-z0-9-]*`. */
  name: string;
  /** Display name for the brand; defaults to the name in Title Case. */
  title?: string;
  /** The command people type; defaults to the name. */
  cli?: string;
  /** Upper-case env-var prefix; defaults to the name upper-cased. */
  envPrefix?: string;
  /** The Den version the distribution pins (exact). */
  denVersion: string;
}

const NAME = /^[a-z][a-z0-9-]*$/;

/** "acme-dev" → "Acme Dev". */
export function titleFromName(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Validate options; throws with a message a person can act on. */
export function validateCreateOptions(opts: CreateOptions): void {
  if (!NAME.test(opts.name))
    throw new Error(
      `name "${opts.name}" must start with a lower-case letter and use only a-z, 0-9 and "-"`,
    );
  if (opts.cli !== undefined && !NAME.test(opts.cli))
    throw new Error(
      `--cli "${opts.cli}" must start with a lower-case letter and use only a-z, 0-9 and "-"`,
    );
  if (opts.title !== undefined && !opts.title.trim())
    throw new Error("--title must not be empty");
  if (opts.title !== undefined && /[\n"\\]/.test(opts.title))
    throw new Error("--title must be one line without quotes or backslashes");
  // The profile validates the env prefix the same way den.yml would.
  profileFrom({
    name: opts.name,
    cli: opts.cli,
    env_prefix: opts.envPrefix,
  });
}

function bannerLines(title: string): string[] {
  const spelled = title.toUpperCase().split("").join(" ");
  const bar = "─".repeat(spelled.length + 4);
  return [`  ┌${bar}┐`, `  │  ${spelled}  │`, `  └${bar}┘`];
}

/** Every file `den create` writes, keyed by path relative to the new root. */
export function renderDistribution(
  opts: CreateOptions,
): Record<string, string> {
  validateCreateOptions(opts);
  const { name, denVersion } = opts;
  const title = opts.title?.trim() || titleFromName(name);
  const profile = profileFrom({
    name,
    cli: opts.cli,
    env_prefix: opts.envPrefix,
  });
  const cli = profile.cli;
  const prefix = profile.envPrefix;
  const overrides: string[] = [];
  if (opts.cli !== undefined) overrides.push(`  cli: ${cli}`);
  if (opts.envPrefix !== undefined) overrides.push(`  env_prefix: ${prefix}`);

  const denYml = [
    `# ${title}: a Den distribution. Every name below derives from product.name;`,
    "# uncomment a line to override it. See docs/distributions.md in Den.",
    "product:",
    `  name: ${name}`,
    ...overrides,
    ...(opts.cli === undefined ? [`  # cli: ${cli}`] : []),
    ...(opts.envPrefix === undefined ? [`  # env_prefix: ${prefix}`] : []),
    `  # config: config/${name}.yml`,
    `  # manifest: .${name}.yml`,
    `  # state_dir: ~/.${name}`,
    `  # services_dir: .${name}-services`,
    `  # workspaces_dir: ${name}-workspaces`,
    "",
  ].join("\n");

  const packageJson =
    JSON.stringify(
      {
        name,
        version: "0.0.0",
        private: true,
        description: `${title}: local dev and E2E harness, built on Den`,
        type: "module",
        bin: { [cli]: `./bin/${cli}` },
        scripts: { [cli]: `./bin/${cli}` },
        dependencies: { [ENGINE_PACKAGE]: denVersion },
      },
      null,
      2,
    ) + "\n";

  const shim = [
    "#!/bin/sh",
    `# ${cli}: runs Den from node_modules as this distribution.`,
    'DEN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"',
    `export DEN_ROOT; exec "$DEN_ROOT/node_modules/${ENGINE_PACKAGE}/bin/den" "$@"`,
    "",
  ].join("\n");

  const makefile = [
    `# ${title}: Den's make targets, run from this distribution's root.`,
    "# `make help` lists them. Add your own targets below the include.",
    `DEN_TARGET_PREFIX := ${cli}`,
    `include node_modules/${ENGINE_PACKAGE}/make/den.mk`,
    "",
  ].join("\n");

  const config = [
    `# ${title}: org config. Den reads it from config/${name}.yml (den.yml product.config).`,
    "",
    "# Shown to people: CLI banner, help header and web page titles.",
    "brand:",
    `  name: ${title}`,
    `  tagline: ${title} local dev and E2E harness`,
    "  banner:",
    ...bannerLines(title).map((l) => `    - "${l}"`),
    "",
    "# The GitHub org (or user) that owns the repos Den clones and lists.",
    "github_org: your-github-org",
    "",
    "# Secrets backend: env reads plain environment variables; doppler and",
    "# 1password are the others.",
    "secrets:",
    "  provider: env",
    "",
    "# This instance's HTTPS edge: https://<service>.<domain>.",
    "edge:",
    `  org: ${name}`,
    `  domain: ${name}.localhost`,
    "",
    "environments: [local]",
    "",
  ].join("\n");

  const localEnv =
    JSON.stringify(
      {
        name: "local",
        baseUrls: {
          web: "http://localhost:3000",
          api: "http://localhost:3001",
          services: {},
        },
        timeouts: { api: 30000, pageLoad: 60000 },
      },
      null,
      2,
    ) + "\n";

  const gitignore = [
    "node_modules/",
    "config/local/",
    `.${name}-services/`,
    `${name}-workspaces/`,
    ".smoke-run/",
    ".smoke-clones/",
    ".synth-run/",
    ".journeys-run/",
    "reports/",
    "results/",
    "test-results/",
    "playwright-report/",
    ".env",
    "",
  ].join("\n");

  const readme = [
    `# ${title}`,
    "",
    `${title} is a Den distribution: Den (\`${ENGINE_PACKAGE}\`) is the engine,`,
    "this repo holds what makes it yours.",
    "",
    "## Run",
    "",
    "```sh",
    "npm install",
    `./bin/${cli} --help`,
    `./bin/${cli} status`,
    `./bin/${cli} web          # the web UI`,
    "make help",
    "```",
    "",
    "## Layout",
    "",
    "| Path | What |",
    "| --- | --- |",
    "| `den.yml` | The product profile: name, CLI, env prefix, file and directory names |",
    `| \`config/${name}.yml\` | Brand, GitHub org, secrets backend, edge |`,
    "| `config/environments/` | One JSON file per environment (base URLs, auth, timeouts) |",
    "| `manifests/` | Manifests for repos that do not carry their own |",
    "| `tests/pillars/` | This distribution's own tests, by pillar |",
    `| \`bin/${cli}\` | Runs Den from \`node_modules\` with this repo as its root |`,
    "| `Makefile` | Includes Den's make targets (`make/den.mk`) |",
    "",
    `Environment variables use the \`${prefix}_\` prefix: for example`,
    `\`${prefix}_HOME\` moves the state directory (default \`~/.${name}\`).`,
    "",
    "## Upgrade Den",
    "",
    `\`package.json\` pins an exact Den version. To upgrade, read the`,
    "Migrations section of Den's CHANGELOG for each version in between, then:",
    "",
    "```sh",
    `npm install ${ENGINE_PACKAGE}@<version> --save-exact`,
    "```",
    "",
  ].join("\n");

  return {
    "den.yml": denYml,
    "package.json": packageJson,
    [`bin/${cli}`]: shim,
    Makefile: makefile,
    [`config/${name}.yml`]: config,
    "config/environments/local.json": localEnv,
    "manifests/.gitkeep": "",
    "tests/pillars/.gitkeep": "",
    ".gitignore": gitignore,
    "README.md": readme,
  };
}

/** The version of the Den that is running (its package.json). */
export function runningDenVersion(
  engineRoot: string = getEngineRoot(),
): string {
  const raw = fs.readFileSync(path.join(engineRoot, "package.json"), "utf-8");
  return (JSON.parse(raw) as { version: string }).version;
}

/**
 * Write a distribution into `dir`. Refuses a directory that exists and is not
 * empty; never overwrites a file. Returns the files written (relative).
 */
export function writeDistribution(dir: string, opts: CreateOptions): string[] {
  const files = renderDistribution(opts);
  const root = path.resolve(dir);
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory())
      throw new Error(`${root} exists and is not a directory`);
    if (fs.readdirSync(root).length > 0)
      throw new Error(
        `${root} is not empty: create needs a new or empty directory`,
      );
  }
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // "wx": fail rather than overwrite, even if something appeared meanwhile.
    fs.writeFileSync(file, content, { encoding: "utf-8", flag: "wx" });
    if (rel.startsWith("bin/")) fs.chmodSync(file, 0o755);
    written.push(rel);
  }
  return written;
}

export interface ParsedCreateArgs extends Omit<CreateOptions, "denVersion"> {
  dir: string;
}

const CREATE_USAGE =
  "usage: den create <name> [dir] [--title <title>] [--cli <cli>] [--env-prefix <PREFIX>]";

/** Parse `create` argv (after the word `create`). `cwd` resolves the dir. */
export function parseCreateArgs(argv: string[], cwd: string): ParsedCreateArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(title|cli|env-prefix)(?:=(.*))?$/.exec(a);
    if (m) {
      const value = m[2] ?? argv[++i];
      if (value === undefined)
        throw new Error(`--${m[1]} needs a value\n${CREATE_USAGE}`);
      flags[m[1]] = value;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag ${a}\n${CREATE_USAGE}`);
    } else positional.push(a);
  }
  if (positional.length < 1 || positional.length > 2)
    throw new Error(CREATE_USAGE);
  const [name, dir] = positional;
  return {
    name,
    dir: path.resolve(cwd, dir ?? name),
    title: flags.title,
    cli: flags.cli,
    envPrefix: flags["env-prefix"],
  };
}

export const CREATE_HELP = `${CREATE_USAGE}

Scaffold a new Den distribution in [dir] (default ./<name>):
den.yml, package.json (pinning this Den's exact version), bin/<cli>,
a Makefile including Den's make targets, config/<name>.yml,
config/environments/local.json, manifests/ and tests/pillars/.

  --title <title>        brand name shown to people (default: <Name>)
  --cli <cli>            the command people type (default: <name>)
  --env-prefix <PREFIX>  env-var prefix (default: <NAME>)`;

/** Run `create` end to end; returns the process exit code. */
export function runCreate(argv: string[], cwd: string): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(CREATE_HELP);
    return 0;
  }
  try {
    const args = parseCreateArgs(argv, cwd);
    const written = writeDistribution(args.dir, {
      ...args,
      denVersion: runningDenVersion(),
    });
    const cli = args.cli ?? args.name;
    const rel = path.relative(cwd, args.dir) || ".";
    console.log(
      `Created ${args.name} in ${args.dir} (${plural(written.length, "file")}).`,
    );
    console.log("");
    console.log("Next:");
    console.log(`  cd ${rel}`);
    console.log("  npm install");
    console.log(`  ./bin/${cli} --help`);
    return 0;
  } catch (e) {
    console.error(`create: ${(e as Error).message}`);
    return 1;
  }
}
