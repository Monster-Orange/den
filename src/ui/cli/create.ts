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
import { checkWebUrl } from "../../shared/web-url-check.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ENGINE_PACKAGE, getEngineRoot } from "../../shared/paths.js";
import { profileFrom } from "../../shared/profile.js";
import { parse as parseYaml } from "yaml";
import { plural } from "../../shared/plural.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { pickFreePort } from "../../shared/port-pick.js";

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
  /**
   * D17: `web.allowed_github_org`: the GitHub org whose members may claim
   * an instance of it (each developer's own). Unset: a commented line.
   */
  githubOrg?: string;
}

const GITHUB_ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The GitHub owner of a git remote URL (https or ssh), or null:
 * `git@github.com:acme/acme-den.git` → `acme`.
 */
export function githubOwnerOfRemote(url: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\//i.exec(
      url.trim(),
    );
  return m && GITHUB_ORG.test(m[1]) ? m[1] : null;
}

/**
 * The GitHub owner of the repo `dir` is in (its nearest existing folder's
 * `origin`), or null: no repo, no origin, not GitHub.
 */
export function githubOrgOfDir(dir: string): string | null {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    const url = execFileSync("git", ["-C", d, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return githubOwnerOfRemote(url);
  } catch {
    return null;
  }
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
  if (opts.githubOrg !== undefined && !GITHUB_ORG.test(opts.githubOrg))
    throw new Error(
      `--github-org "${opts.githubOrg}" must be a GitHub org name (letters, digits and dashes)`,
    );
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
    "# Unset, Den lists no GitHub repos (and never calls gh for them). E.g.",
    "# github_org: example-org",
    "",
    "# Who may claim an instance. Each developer runs their own and opens it",
    "# in the browser; a member of this GitHub org connects their GitHub",
    "# account there, on their own computer, and owns that instance.",
    ...(opts.githubOrg
      ? ["web:", `  allowed_github_org: ${opts.githubOrg}`]
      : ["# web:", "#   allowed_github_org: your-github-org"]),
    "",
    "# Secrets backend: none (this distribution needs no secrets store), or",
    "# env (plain environment variables), doppler or 1password. A backend's",
    "# refs say where Den's own features find their secrets, e.g.",
    `#   refs: { sudo: { key: ${prefix}_LOCAL_ADMIN_PWD } }`,
    "secrets:",
    "  provider: none",
    "",
    "# This instance's edge: <service>.<domain>, one Traefik for its routes.",
    "edge:",
    `  org: ${name}`,
    `  domain: ${name}.localhost`,
    "  # TLS: none serves http only. For https, pick a strategy:",
    "  #   tls: { strategy: mkcert }                  # a local CA, per machine",
    "  #   tls: { strategy: mkcert, ca: ~/path/to/ca } # an existing mkcert CA",
    "  #   tls: { strategy: files, include: edge/dynamic, mounts: { <host>: <container> } }",
    "  #     # your own certs, in included Traefik config",
    "  tls: none",
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
  /** `--yes`: never prompt (create never does; accepted so agents can say so). */
  yes: boolean;
  /** `--json`: print one JSON object on stdout, nothing else. */
  json: boolean;
  /** `--port <n>`: the web UI's port, taken as given (no search). */
  port?: number;
  /** D80 `--url <address>`: this install's address (web.url). */
  url?: string;
}

/** Where create finds web.allowed_github_org when --github-org isn't given. */
export interface CreateOrgOptions {
  /** The GitHub owner of the repo the new folder is in (default: git's). */
  githubOrgOf?: (dir: string) => string | null;
}

const CREATE_USAGE =
  "usage: den create <name> [dir] [--title <title>] [--cli <cli>] [--env-prefix <PREFIX>] [--port <n>] [--github-org <org>] [--url <address>] [--yes] [--json]";

/** Parse `create` argv (after the word `create`). `cwd` resolves the dir. */
export function parseCreateArgs(argv: string[], cwd: string): ParsedCreateArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let yes = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") {
      yes = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    const m = /^--(title|cli|env-prefix|port|github-org|url)(?:=(.*))?$/.exec(
      a,
    );
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
    ...(flags["github-org"] !== undefined
      ? { githubOrg: flags["github-org"].replace(/^@/, "") }
      : {}),
    yes,
    json,
    ...(flags.port !== undefined ? { port: parsePortFlag(flags.port) } : {}),
    ...(flags.url !== undefined ? { url: parseUrlFlag(flags.url) } : {}),
  };
}

function parseUrlFlag(v: string): string {
  const ok = checkWebUrl(v);
  if (!("url" in ok)) throw new Error(`--url: ${ok.error}\n${CREATE_USAGE}`);
  return ok.url;
}

function parsePortFlag(v: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 1 || n > 65535)
    throw new Error(`--port must be a port number\n${CREATE_USAGE}`);
  return n;
}

export const CREATE_HELP = `${CREATE_USAGE}

Scaffold a new Den distribution in [dir] (default ./<name>):
den.yml, package.json (pinning this Den's exact version), bin/<cli>,
a Makefile including Den's make targets, config/<name>.yml,
config/environments/local.json, manifests/ and tests/pillars/.

  --title <title>        brand name shown to people (default: <Name>)
  --cli <cli>            the command people type (default: <name>)
  --env-prefix <PREFIX>  env-var prefix (default: <NAME>)
  --port <n>             the web UI's port (default: ${DEFAULT_PORT}, or the next
                         free one above it when that is in use)
  --github-org <org>     web.allowed_github_org: members of this GitHub org
                         connect their GitHub account to their own instance
                         (default: the owner of the GitHub repo [dir] is in)
  --url <address>        this install's address (web.url), the one people
                         open, for example https://<cli>.local.example.com.
                         Without it, set it next: <cli> web url <address>
  --yes, -y              never prompt (create never does; for agents)
  --json                 print one JSON object: { ok, dir, cli, existed, port, next }

Safe to re-run: a [dir] that already holds this distribution answers ok
(existed: true) and writes nothing.`;

/**
 * Whether `dir` already holds the distribution `create` would make: its
 * den.yml names this product (and this cli, when one was given).
 */
export function existingDistribution(
  dir: string,
  opts: { name: string; cli?: string },
): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "den.yml"), "utf-8");
  } catch {
    return false;
  }
  const name = /^\s+name:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (name !== opts.name) return false;
  const cli = /^\s+cli:\s*(\S+)\s*$/m.exec(text)?.[1] ?? opts.name;
  return cli === (opts.cli ?? opts.name);
}

/** What `create --json` prints. */
export interface CreateJson {
  ok: boolean;
  dir?: string;
  cli?: string;
  existed?: boolean;
  files?: number;
  /** The web UI's port for this distribution. */
  port?: number;
  /** Set when DEFAULT_PORT was in use and `port` was picked instead. */
  portPicked?: { wanted: number; file: string };
  /** D17: web.allowed_github_org as written, or null when it wasn't known. */
  githubOrg?: string | null;
  next?: string[];
  error?: string;
  fix?: string;
  ask?: string;
}

function cdPathFor(cwd: string, dir: string): string {
  // Relative only when the new directory is under the caller's cwd; a
  // path that climbs out (../../..) is harder to read than the absolute one.
  const rel = path.relative(cwd, dir);
  return rel === ""
    ? "."
    : rel.startsWith("..") || path.isAbsolute(rel)
      ? dir
      : rel;
}

/** The web port a distribution at `dir` is set to (user, then team, config). */
export function configuredWebPort(dir: string, name: string): number {
  for (const rel of [
    path.join("config", "local", "user.yml"),
    path.join("config", `${name}.yml`),
  ]) {
    try {
      const doc = parseYaml(fs.readFileSync(path.join(dir, rel), "utf-8")) as {
        web?: { port?: unknown };
      } | null;
      const p = doc?.web?.port;
      if (typeof p === "number" && Number.isInteger(p)) return p;
    } catch {
      /* absent or unreadable: next layer */
    }
  }
  return DEFAULT_PORT;
}

export interface CreatePortOptions {
  /**
   * The port to start from: DEFAULT_PORT unless a test passes a port of its
   * own (so no test probes the real default). The CLI reads it from
   * DEN_WEB_PORT_START.
   */
  startPort?: number;
  inUse?: (port: number) => Promise<boolean>;
}

/** DEN_WEB_PORT_START, for tests and CI: never probe the real default. */
export function startPortFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const v = env.DEN_WEB_PORT_START?.trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

/**
 * `create` as data: never prompts, never throws. A dir that already holds
 * this distribution is ok (existed); any other non-empty dir is an error
 * that names a fix.
 *
 * The web port: `--port` as given; else the default when it is free, else
 * the next free port above it (never a reserved Den port), written to the
 * new distribution's config/local/user.yml as `web.port`. Checking a port
 * sends nothing to whoever holds it (port-pick.ts). A re-run reports the
 * port the distribution is set to and picks nothing.
 */
export async function createResult(
  args: ParsedCreateArgs,
  cwd: string,
  denVersion: string = runningDenVersion(),
  portOpts: CreatePortOptions & CreateOrgOptions = {},
): Promise<CreateJson> {
  const cli = args.cli ?? args.name;
  const next = (dir: string, org?: string | null): string[] => [
    `cd ${cdPathFor(cwd, dir)}`,
    "npm install",
    ...(org === null
      ? [
          `set web.allowed_github_org: <your GitHub org> in config/${args.name}.yml (who may claim an instance)`,
        ]
      : []),
    // D80: this install's address, the one people open (a person's to give).
    ...(args.url
      ? []
      : [
          `./bin/${cli} web url https://${cli}.<your domain>   (this install's address, the one people open)`,
        ]),
    `./bin/${cli} repo add <path|git-url> --json`,
  ];
  try {
    validateCreateOptions({ ...args, denVersion });
    if (existingDistribution(args.dir, args))
      return {
        ok: true,
        dir: args.dir,
        cli,
        existed: true,
        port: configuredWebPort(args.dir, args.name),
        next: next(args.dir),
      };
    // Refuse a busy dir before looking for a port.
    if (
      fs.existsSync(args.dir) &&
      fs.statSync(args.dir).isDirectory() &&
      fs.readdirSync(args.dir).length > 0
    )
      writeDistribution(args.dir, { ...args, denVersion }); // throws "not empty"
    const wanted = args.port ?? portOpts.startPort ?? DEFAULT_PORT;
    const port =
      args.port ??
      (await pickFreePort({ start: wanted, inUse: portOpts.inUse })) ??
      wanted;
    // D17: the org whose members may claim an instance: --github-org, else
    // the owner of the GitHub repo the folder is in.
    const githubOrg =
      args.githubOrg ??
      (portOpts.githubOrgOf ?? githubOrgOfDir)(args.dir) ??
      undefined;
    const written = writeDistribution(args.dir, {
      ...args,
      denVersion,
      ...(githubOrg ? { githubOrg } : {}),
    });
    let portPicked: CreateJson["portPicked"];
    // Written when the port differs from what the distribution would use
    // anyway (an explicit --port that isn't the default, or a picked one).
    const writePort =
      port !== (args.port !== undefined ? DEFAULT_PORT : wanted);
    if (writePort || args.url) {
      const rel = path.join("config", "local", "user.yml");
      const file = path.join(args.dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const why = [
        ...(writePort
          ? [
              args.port !== undefined
                ? "--port"
                : `port ${wanted} was in use on this machine`,
            ]
          : []),
        ...(args.url ? ["--url"] : []),
      ].join(", ");
      fs.writeFileSync(
        file,
        `# Yours, not the team's (gitignored). Set by create: ${why}.\nweb:\n` +
          (writePort ? `  port: ${port}\n` : "") +
          (args.url ? `  url: ${args.url}\n` : ""),
        { encoding: "utf-8", flag: "wx" },
      );
      written.push(rel);
      if (writePort && args.port === undefined)
        portPicked = { wanted, file: rel };
    }
    return {
      ok: true,
      dir: args.dir,
      cli,
      existed: false,
      files: written.length,
      port,
      ...(portPicked ? { portPicked } : {}),
      githubOrg: githubOrg ?? null,
      next: next(args.dir, githubOrg ?? null),
    };
  } catch (e) {
    const error = (e as Error).message;
    if (/is not empty/.test(error))
      return {
        ok: false,
        error,
        fix: `npx ${ENGINE_PACKAGE}@latest create ${args.name} ${path.join(path.dirname(args.dir), `${args.name}-den`)} --yes --json`,
        ask: `${args.dir} already has files that are not a ${args.name} distribution. Which new or empty folder should the distribution go in?`,
      };
    return {
      ok: false,
      error,
      ask: "Which name should the distribution have? Lower-case letters, digits and dashes, starting with a letter.",
    };
  }
}

/** Run `create` end to end; resolves to the process exit code. */
export async function runCreate(
  argv: string[],
  cwd: string,
  portOpts: CreatePortOptions = { startPort: startPortFromEnv() },
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(CREATE_HELP);
    return 0;
  }
  const json = argv.includes("--json");
  let args: ParsedCreateArgs;
  try {
    args = parseCreateArgs(argv, cwd);
  } catch (e) {
    if (json) {
      console.log(
        JSON.stringify({
          ok: false,
          error: (e as Error).message.split("\n")[0],
          fix: `npx ${ENGINE_PACKAGE}@latest create <name> [dir] --yes --json`,
        } satisfies CreateJson),
      );
    } else console.error(`create: ${(e as Error).message}`);
    return 1;
  }
  const r = await createResult(args, cwd, runningDenVersion(), portOpts);
  if (json) {
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  if (!r.ok) {
    console.error(`create: ${r.error}`);
    return 1;
  }
  const dir = r.dir ?? args.dir;
  console.log(
    r.existed
      ? `${args.name} is already in ${dir}: nothing to do.`
      : `Created ${args.name} in ${dir} (${plural(r.files ?? 0, "file")}).`,
  );
  console.log(
    r.portPicked
      ? `Web UI port: ${r.port} (${r.portPicked.wanted} is in use here; set in ${r.portPicked.file}).`
      : `Web UI port: ${r.port}.`,
  );
  if (!r.existed)
    console.log(
      r.githubOrg
        ? `GitHub org: ${r.githubOrg} (web.allowed_github_org: its members connect their GitHub account to their own instance).`
        : `GitHub org: not known. Set web.allowed_github_org in config/${args.name}.yml, or pass --github-org <org>, so your team can connect GitHub from the browser.`,
    );
  console.log("");
  console.log("Next:");
  console.log(`  cd ${cdPathFor(cwd, dir)}`);
  console.log("  npm install");
  console.log(`  ./bin/${r.cli} --help`);
  return 0;
}
