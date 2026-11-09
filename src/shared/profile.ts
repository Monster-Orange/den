/**
 * The product profile: who this distribution is.
 *
 * Den is one engine; each distribution runs it under its own name. Everything product-named comes from here: the CLI, the env-var
 * prefix, the config and manifest file names, and the state, services and
 * workspaces directories. The profile lives in `den.yml` at the
 * distribution root:
 *
 *   product:
 *     name: acme              # everything below derives from it by default
 *     # cli: acme
 *     # env_prefix: ACME
 *     # config: config/acme.yml
 *     # manifest: .acme.yml   (.json is also read)
 *     # state_dir: ~/.acme
 *     # services_dir: .acme-services
 *     # workspaces_dir: acme-workspaces
 *
 * `DEN_PROFILE` may point at another profile file (tests use this). With no
 * profile at all, Den runs under its own name.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export const PROFILE_FILE = "den.yml";

export interface ProductProfile {
  /** Display and slug name ("acme"). */
  name: string;
  /** The command a person types. */
  cli: string;
  /** Upper-case env-var prefix, without the trailing "_" ("ACME"). */
  envPrefix: string;
  /** Org config, relative to the distribution root. */
  configFile: string;
  /** Manifest file names probed in a repo, first match wins. */
  manifestFiles: string[];
  /** Per-user state directory (absolute, `~` expanded). */
  stateDir: string;
  /** Managed clones, relative to the distribution root. */
  servicesDir: string;
  /** Workspace checkouts, relative to the distribution root. */
  workspacesDir: string;
}

interface RawProduct {
  name?: unknown;
  cli?: unknown;
  env_prefix?: unknown;
  config?: unknown;
  manifest?: unknown;
  state_dir?: unknown;
  services_dir?: unknown;
  workspaces_dir?: unknown;
}

const SLUG = /^[a-z][a-z0-9-]*$/;
/**
 * A path the pages show (config, manifest, services and workspaces dirs):
 * letters, digits, ".", "_", "-" and "/". The web pages carry these
 * names as placeholders filled when served (product.ts productTokens), so
 * a quote, backslash, "$" or "<" in one would break a page's script.
 */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const PREFIX = /^[A-Z][A-Z0-9_]*$/;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const expandHome = (p: string): string =>
  p === "~"
    ? os.homedir()
    : p.startsWith("~/")
      ? path.join(os.homedir(), p.slice(2))
      : p;

/**
 * A profile from a `product:` block; unset fields derive from the name. A
 * relative `state_dir` resolves against `baseDir`: the directory holding
 * den.yml (the distribution root), never the cwd, so an agent's CLI or MCP
 * server started elsewhere reads the same state.
 */
export function profileFrom(
  raw: RawProduct = {},
  baseDir: string = process.cwd(),
): ProductProfile {
  const name = str(raw.name) ?? "den";
  if (!SLUG.test(name))
    throw new Error(
      `den.yml: product.name "${name}" must be lower-case letters, digits and "-", starting with a letter`,
    );
  const envPrefix =
    str(raw.env_prefix) ?? name.toUpperCase().replace(/-/g, "_");
  if (!PREFIX.test(envPrefix))
    throw new Error(
      `den.yml: product.env_prefix "${envPrefix}" must be upper-case letters, digits and "_"`,
    );
  const cli = str(raw.cli) ?? name;
  if (!SLUG.test(cli))
    throw new Error(
      `den.yml: product.cli "${cli}" must be lower-case letters, digits and "-", starting with a letter`,
    );
  for (const key of [
    "config",
    "manifest",
    "services_dir",
    "workspaces_dir",
  ] as const) {
    const v = str(raw[key]);
    if (v !== undefined && !SAFE_PATH.test(v))
      throw new Error(
        `den.yml: product.${key} "${v}" may use only letters, digits, ".", "_", "-" and "/"`,
      );
  }
  const manifest = str(raw.manifest) ?? `.${name}.yml`;
  const json = manifest.replace(/\.ya?ml$/, ".json");
  return {
    name,
    cli,
    envPrefix,
    configFile: str(raw.config) ?? `config/${name}.yml`,
    manifestFiles: json === manifest ? [manifest] : [manifest, json],
    stateDir: path.resolve(
      baseDir,
      expandHome(str(raw.state_dir) ?? `~/.${name}`),
    ),
    servicesDir: str(raw.services_dir) ?? `.${name}-services`,
    workspacesDir: str(raw.workspaces_dir) ?? `${name}-workspaces`,
  };
}

/** Read a profile file; a missing file is Den's own profile. */
export function readProfileFile(file: string): ProductProfile {
  let raw: { product?: RawProduct } | null;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf-8")) as typeof raw;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return profileFrom();
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  return profileFrom(raw?.product ?? {}, path.dirname(path.resolve(file)));
}

let cached: { key: string; profile: ProductProfile } | null = null;

/**
 * The profile for a distribution root: `DEN_PROFILE` if set, else
 * `<root>/den.yml`, else Den's own. Cached per file.
 */
export function loadProfile(root: string): ProductProfile {
  const file = process.env.DEN_PROFILE?.trim() || path.join(root, PROFILE_FILE);
  if (cached?.key !== file)
    cached = { key: file, profile: readProfileFile(file) };
  return cached.profile;
}

const resetHooks: (() => void)[] = [];

/** Run `hook` whenever resetProfileCache runs (caches derived from it). */
export function onProfileCacheReset(hook: () => void): void {
  resetHooks.push(hook);
}

export function resetProfileCache(): void {
  cached = null;
  for (const hook of resetHooks) hook();
}

/** `${PREFIX}_${key}`: the env-var name this distribution uses for `key`. */
export function envName(profile: ProductProfile, key: string): string {
  return `${profile.envPrefix}_${key}`;
}

/** The value of `${PREFIX}_${key}`, or undefined. */
export function readEnv(
  profile: ProductProfile,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[envName(profile, key)];
}
