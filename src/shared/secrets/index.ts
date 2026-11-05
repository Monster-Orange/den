/**
 * Secrets strategy selection.
 *
 * Resolution order for the backend:
 *   1. DEN_SECRETS_PROVIDER env var (none | doppler | 1password | env)
 *   2. `secrets.provider` in config/local/user.yml (per-engineer)
 *   3. `secrets.provider` in the org config (team default)
 *   4. "doppler" — implicit and deprecated: a warning says to set it.
 *
 * Every backend is a strategy registered in the strategy registry
 * (./strategies.ts); a new one registers there, like a plugin.
 *
 * Den assumes nothing about where a distribution keeps its secrets: no
 * vault, item, field or account is built in. The engine's own named secrets
 * (`sudo`, `journeys_agent_key`) exist only when `secrets.refs.<name>` says
 * where they are; otherwise the feature reports "not configured".
 */
import { readDenConfig, readUserConfig } from "../den-config.js";
import type { DetectResult } from "../strategies/registry.js";
import { notConfiguredMessage, SecretsNotConfiguredError } from "./none.js";
import { secretsStrategy, type SecretsStrategy } from "./strategies.js";
import type {
  PreflightResult,
  SecretRef,
  SecretsProvider,
  SecretsProviderName,
} from "./types.js";

import { envKey, product } from "../product.js";
export * from "./types.js";
export { flatKeyFor, toEnvName, refPath } from "./keys.js";
export { DopplerProvider } from "./doppler.js";
export { EnvProvider } from "./env.js";
export { NoneProvider } from "./none.js";
export { OnePasswordProvider } from "./onepassword.js";
export { notConfiguredMessage, SecretsNotConfiguredError } from "./none.js";
export { secretsStrategy, secretsStrategyIds } from "./strategies.js";
export type { SecretsStrategy, SecretsSetupContext } from "./strategies.js";
export * from "./secret-env.js";

export interface SecretsConfig {
  provider?: SecretsProviderName;
  /**
   * When true, `den up` / `make web` refuse to start until the backend is
   * ready. Default false: a missing backend is a warning, because each repo's
   * own `make up` manages its own secrets and den only needs this backend
   * for test logins and the saved sudo password.
   */
  required?: boolean;
  doppler?: { project?: string; config?: string };
  onepassword?: { account?: string };
  /** `"vault/item/field": FLAT_KEY` overrides for doppler/env. */
  keys?: Record<string, string>;
  /**
   * Where the engine's own named secrets live (see {@link namedSecretRef}).
   * There are no built-in defaults: a name with no entry here is "not
   * configured" and its feature stays off. Names in use: `sudo` (the saved
   * local-dev sudo password) and `journeys_agent_key` (the journeys
   * pillar's agent API key).
   *
   *   refs:
   *     sudo: { vault: Private, item: Dev Keys, field: ACME_LOCAL_ADMIN_PWD }
   *     journeys_agent_key: { key: CURSOR_API_KEY }   # doppler / env
   */
  refs?: Record<string, Partial<SecretRef>>;
  /**
   * The per-engineer developer keys `make <cli>-setup-1password` collects
   * into the developer-keys item (see scripts/setup-1password.ts). Default:
   * only the keys the engine itself uses.
   */
  developer_keys?: DeveloperKeysConfig;
}

/** One developer key the setup script prompts for. */
export interface DeveloperKeyDef {
  /** Field label in the item (= the env-var name). */
  field: string;
  description?: string;
  /** Where to create one. */
  url?: string;
  required?: boolean;
}

export interface DeveloperKeysConfig {
  /** The 1Password vault holding the developer-keys item (no default). */
  vault?: string;
  /** The developer-keys item (no default). */
  item?: string;
  /**
   * A dotenv file (relative to the den root, e.g. an app checkout's
   * `.env`) whose values are offered as defaults.
   */
  env_file?: string;
  fields?: DeveloperKeyDef[];
}

export const SECRETS_PROVIDERS: readonly SecretsProviderName[] = [
  "none",
  "doppler",
  "1password",
  "env",
];

/** The backend an unset `secrets.provider` falls back to (deprecated). */
export const IMPLICIT_SECRETS_PROVIDER: SecretsProviderName = "doppler";

function isProviderName(v: unknown): v is SecretsProviderName {
  return (
    typeof v === "string" &&
    (SECRETS_PROVIDERS as string[]).includes(v) &&
    secretsStrategy(v) !== undefined
  );
}

/** Effective secrets config (team file, then per-engineer override). */
export function readSecretsConfig(): SecretsConfig {
  let team: SecretsConfig = {};
  let user: SecretsConfig = {};
  try {
    team = readDenConfig().secrets ?? {};
  } catch {
    /* unreadable config → defaults */
  }
  try {
    user = readUserConfig().secrets ?? {};
  } catch {
    /* no user config */
  }
  return {
    ...team,
    ...user,
    doppler: { ...team.doppler, ...user.doppler },
    onepassword: { ...team.onepassword, ...user.onepassword },
    keys: { ...team.keys, ...user.keys },
    refs: { ...team.refs, ...user.refs },
  };
}

/** Whether `ref` gives backend `name` enough to address a secret. */
export function refIsComplete(
  name: SecretsProviderName,
  ref: Partial<SecretRef> | undefined,
): boolean {
  if (!ref || typeof ref !== "object") return false;
  return secretsStrategy(name)?.capabilities.refComplete(ref) ?? false;
}

/**
 * The engine-named secret `name`, exactly as `secrets.refs.<name>` gives it,
 * or null when the distribution has not configured it (or configured too
 * little for the selected backend). There are no built-in defaults: Den
 * never assumes a vault, item, field or key of its own.
 */
export function namedSecretRef(
  name: string,
  cfg: SecretsConfig = readSecretsConfig(),
  provider: SecretsProviderName = resolveProviderName(cfg),
): SecretRef | null {
  const raw = cfg.refs?.[name];
  if (!refIsComplete(provider, raw)) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const ref: SecretRef = {
    vault: str(raw!.vault),
    item: str(raw!.item),
    field: str(raw!.field) || str(raw!.key),
  };
  if (str(raw!.key)) ref.key = str(raw!.key);
  return ref;
}

export interface ResolvedProvider {
  name: SecretsProviderName;
  /** True when nothing chose it: the deprecated implicit doppler default. */
  implicit: boolean;
}

export function resolveProvider(
  cfg: SecretsConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const fromEnv = env.DEN_SECRETS_PROVIDER;
  if (fromEnv) {
    if (!isProviderName(fromEnv)) {
      throw new Error(
        `${envKey("SECRETS_PROVIDER")}="${fromEnv}" is not one of ${SECRETS_PROVIDERS.join(", ")}`,
      );
    }
    return { name: fromEnv, implicit: false };
  }
  if (cfg.provider !== undefined && !isProviderName(cfg.provider)) {
    throw new Error(
      `secrets.provider "${String(cfg.provider)}" is not one of ${SECRETS_PROVIDERS.join(", ")}`,
    );
  }
  return cfg.provider
    ? { name: cfg.provider, implicit: false }
    : { name: IMPLICIT_SECRETS_PROVIDER, implicit: true };
}

export function resolveProviderName(
  cfg: SecretsConfig,
  env: NodeJS.ProcessEnv = process.env,
): SecretsProviderName {
  return resolveProvider(cfg, env).name;
}

/** The registered strategy for `name` (always registered for a valid name). */
export function strategyFor(name: SecretsProviderName): SecretsStrategy {
  const s = secretsStrategy(name);
  if (!s) throw new Error(`secrets strategy "${name}" is not registered`);
  return s;
}

export function createSecretsProvider(
  name: SecretsProviderName,
  cfg: SecretsConfig = {},
): SecretsProvider {
  return strategyFor(name).capabilities.create(cfg);
}

/**
 * The provider behind detect(): while the strategy reports its backend
 * unavailable (its CLI is not on PATH), nothing is spawned. Reads report
 * null / not ready, and get, set and preflight give detect()'s reason
 * instead of a spawn error.
 */
class DetectedProvider implements SecretsProvider {
  constructor(
    private readonly inner: SecretsProvider,
    private readonly strategy: SecretsStrategy,
    private readonly implicit = false,
  ) {}
  get name(): SecretsProviderName {
    return this.inner.name;
  }
  private unavailable(): string | null {
    // The implicit default is resolved lazily: only a secret actually being
    // read or written gets here, and only then does it warn (once).
    if (this.implicit) warnImplicitOnce();
    const d = this.strategy.detect();
    return d.available ? null : `not available: ${d.reason ?? "unavailable"}`;
  }
  async isReady(): Promise<boolean> {
    return this.unavailable() ? false : this.inner.isReady();
  }
  async get(ref: SecretRef): Promise<string> {
    const why = this.unavailable();
    if (why) throw new Error(`${this.name} secrets backend ${why}`);
    return this.inner.get(ref);
  }
  async tryGet(ref: SecretRef): Promise<string | null> {
    return this.unavailable() ? null : this.inner.tryGet(ref);
  }
  async set(ref: SecretRef, value: string): Promise<void> {
    const why = this.unavailable();
    if (why) throw new Error(`${this.name} secrets backend ${why}`);
    return this.inner.set(ref, value);
  }
  async preflight(): Promise<PreflightResult> {
    // Nothing chose a backend, so nothing requires one to be ready.
    if (this.implicit) return { ok: true };
    const why = this.unavailable();
    if (why)
      return {
        ok: false,
        message:
          `${this.strategy.capabilities.label} ${why}.\n` +
          `Install it, or set secrets.provider in ${product().configFile} (none | doppler | 1password | env).`,
      };
    return this.inner.preflight();
  }
  runPrefix(): string[] {
    // Never wrap a command in an implicit backend.
    if (this.implicit) return [];
    return this.unavailable() ? [] : this.inner.runPrefix();
  }
}

let warnedImplicit = false;
function warnImplicitOnce(): void {
  if (warnedImplicit) return;
  warnedImplicit = true;
  console.warn(`⚠️  ${IMPLICIT_PROVIDER_WARNING}`);
}

let cached: SecretsProvider | null = null;
let cachedKey = "";

/**
 * The configured backend, behind its strategy's detect(). Re-resolves when
 * DEN_SECRETS_PROVIDER or the config changes.
 */
export function getSecretsProvider(): SecretsProvider {
  const cfg = readSecretsConfig();
  const { name, implicit } = resolveProvider(cfg);
  const key = `${name}|${implicit}|${JSON.stringify(cfg)}`;
  if (!cached || key !== cachedKey) {
    cached = new DetectedProvider(
      createSecretsProvider(name, cfg),
      strategyFor(name),
      implicit,
    );
    cachedKey = key;
  }
  return cached;
}

export interface SecretsStatus {
  /** The selected strategy id. */
  backend: SecretsProviderName;
  /** Name people see ("1Password"). */
  label: string;
  /** True when secrets.provider is unset (the deprecated doppler default). */
  implicit: boolean;
  /** detect() of the selected strategy. */
  detect: DetectResult;
}

/** The selected strategy and its detect() result. Never spawns, never throws. */
export function secretsStatus(
  cfg: SecretsConfig = readSecretsConfig(),
  env: NodeJS.ProcessEnv = process.env,
  opts: { detect?: boolean } = {},
): SecretsStatus {
  let r: ResolvedProvider;
  try {
    r = resolveProvider(cfg, env);
  } catch (err) {
    return {
      backend: "none",
      label: "none",
      implicit: false,
      detect: { available: false, reason: (err as Error).message },
    };
  }
  const s = strategyFor(r.name);
  return {
    backend: r.name,
    label: s.capabilities.label,
    implicit: r.implicit,
    // detect:false: report the choice without probing (nothing needs it).
    detect:
      opts.detect === false
        ? { available: false, reason: "not checked: nothing needs it" }
        : s.detect(env),
  };
}

/**
 * Env vars the selected strategy gives the processes Den starts (the web
 * server). Only 1password gives any (OP_ACCOUNT, from the distribution's
 * config or the engineer's shell); every other backend gives none.
 */
export function secretsProcessEnv(
  cfg: SecretsConfig = readSecretsConfig(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  let name: SecretsProviderName;
  try {
    name = resolveProviderName(cfg, env);
  } catch {
    return {};
  }
  return strategyFor(name).capabilities.env?.(cfg, env) ?? {};
}

/** The engine's own named refs, for the legacy warning. */
export const ENGINE_SECRET_REFS = ["sudo", "journeys_agent_key"] as const;

export const IMPLICIT_PROVIDER_WARNING =
  "secrets.provider is not set; the implicit doppler default is deprecated and will be removed in a later minor. " +
  "Set it explicitly: doppler, 1password, env or none.";

/**
 * Config warnings about secrets, for the server's startup log and
 * `validate`: a 1password distribution with no refs (the old built-in
 * vault/item/field are gone). The implicit doppler default warns lazily,
 * the first time it resolves a secret (see getSecretsProvider), so a
 * distribution that needs no secrets never hears about it.
 */
export function secretsConfigWarnings(
  cfg: SecretsConfig = readSecretsConfig(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  let r: ResolvedProvider;
  try {
    r = resolveProvider(cfg, env);
  } catch (err) {
    return [(err as Error).message];
  }
  const out: string[] = [];
  if (
    r.name === "1password" &&
    !ENGINE_SECRET_REFS.some((n) => refIsComplete(r.name, cfg.refs?.[n]))
  ) {
    out.push(
      "secrets.provider is 1password but secrets.refs is empty: Den no longer assumes a default vault, item or field. " +
        `Add the refs to ${product().configFile}, e.g.\n` +
        "  secrets:\n" +
        "    refs:\n" +
        "      sudo: { vault: <vault>, item: <item>, field: <field> }\n" +
        "      journeys_agent_key: { vault: <vault>, item: <item>, field: CURSOR_API_KEY }\n" +
        "The vault-backed features (saved sudo password, journeys agent key) stay off until then.",
    );
  }
  return out;
}

/**
 * Throw "not configured" for engine ref `name`, or return it. For features
 * that cannot run without it.
 */
export function requireNamedSecretRef(
  name: string,
  cfg: SecretsConfig = readSecretsConfig(),
): SecretRef {
  const ref = namedSecretRef(name, cfg);
  if (!ref) throw new SecretsNotConfiguredError(notConfiguredMessage(name));
  return ref;
}

/** Test hook. */
export function resetSecretsProviderCache(): void {
  cached = null;
  cachedKey = "";
  warnedImplicit = false;
}
