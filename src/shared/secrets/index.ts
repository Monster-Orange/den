/**
 * Secrets strategy selection.
 *
 * Resolution order for the backend:
 *   1. DEN_SECRETS_PROVIDER env var (doppler | 1password | env)
 *   2. `secrets.provider` in config/local/user.yml (per-engineer)
 *   3. `secrets.provider` in config/den.yml (team default)
 *   4. "doppler"
 *
 * Adding a backend = implement SecretsProvider and register it in FACTORIES.
 */
import { OP_ACCOUNT_DEFAULT, OP_CLI_TIMEOUT_MS } from "../constants.js";
import { readDenConfig, readUserConfig } from "../den-config.js";
import { DopplerProvider } from "./doppler.js";
import { EnvProvider } from "./env.js";
import { OnePasswordProvider } from "./onepassword.js";
import type {
  SecretRef,
  SecretsProvider,
  SecretsProviderName,
} from "./types.js";

import { envKey } from "../product.js";
export * from "./types.js";
export { flatKeyFor, toEnvName, refPath } from "./keys.js";
export { DopplerProvider } from "./doppler.js";
export { EnvProvider } from "./env.js";
export { OnePasswordProvider } from "./onepassword.js";

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
   * Where the engine's own named secrets live, overriding the built-in
   * defaults field by field (see {@link namedSecretRef}). Names in use:
   * `sudo` (the saved local-dev sudo password) and `journeys_agent_key`
   * (the journeys pillar's agent API key).
   *
   *   refs:
   *     journeys_agent_key: { vault: Shared, item: CI Keys }
   */
  refs?: Record<string, Partial<SecretRef>>;
  /**
   * The per-engineer developer keys `make den-setup-1password` collects
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
  /**
   * A dotenv file (relative to the den root, e.g. an app checkout's
   * `.env`) whose values are offered as defaults.
   */
  env_file?: string;
  fields?: DeveloperKeyDef[];
}

export const SECRETS_PROVIDERS: readonly SecretsProviderName[] = [
  "doppler",
  "1password",
  "env",
];

const FACTORIES: Record<
  SecretsProviderName,
  (c: SecretsConfig) => SecretsProvider
> = {
  doppler: (c) => new DopplerProvider({ ...c.doppler, keys: c.keys }),
  "1password": (c) =>
    new OnePasswordProvider({
      account: c.onepassword?.account ?? OP_ACCOUNT_DEFAULT,
      timeoutMs: OP_CLI_TIMEOUT_MS,
    }),
  env: (c) => new EnvProvider(c.keys),
};

function isProviderName(v: unknown): v is SecretsProviderName {
  return typeof v === "string" && (SECRETS_PROVIDERS as string[]).includes(v);
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

/**
 * The engine-named secret `name`: `defaults` with any configured
 * `secrets.refs.<name>` fields laid over them. The engine never hard-wires
 * an org's vault or item names; the defaults are neutral placeholders.
 */
export function namedSecretRef(
  name: string,
  defaults: SecretRef,
  cfg: SecretsConfig = readSecretsConfig(),
): SecretRef {
  const override = cfg.refs?.[name] ?? {};
  const pick = (v: unknown, d: string): string =>
    typeof v === "string" && v.trim() ? v.trim() : d;
  const ref: SecretRef = {
    vault: pick(override.vault, defaults.vault),
    item: pick(override.item, defaults.item),
    field: pick(override.field, defaults.field),
  };
  const key = override.key ?? defaults.key;
  if (key) ref.key = key;
  return ref;
}

export function resolveProviderName(
  cfg: SecretsConfig,
  env: NodeJS.ProcessEnv = process.env,
): SecretsProviderName {
  const fromEnv = env.DEN_SECRETS_PROVIDER;
  if (fromEnv) {
    if (!isProviderName(fromEnv)) {
      throw new Error(
        `${envKey("SECRETS_PROVIDER")}="${fromEnv}" is not one of ${SECRETS_PROVIDERS.join(", ")}`,
      );
    }
    return fromEnv;
  }
  if (cfg.provider !== undefined && !isProviderName(cfg.provider)) {
    throw new Error(
      `secrets.provider "${String(cfg.provider)}" is not one of ${SECRETS_PROVIDERS.join(", ")}`,
    );
  }
  return cfg.provider ?? "doppler";
}

export function createSecretsProvider(
  name: SecretsProviderName,
  cfg: SecretsConfig = {},
): SecretsProvider {
  return FACTORIES[name](cfg);
}

let cached: SecretsProvider | null = null;
let cachedKey = "";

/** The configured backend. Re-resolves when DEN_SECRETS_PROVIDER changes. */
export function getSecretsProvider(): SecretsProvider {
  const cfg = readSecretsConfig();
  const name = resolveProviderName(cfg);
  const key = `${name}|${JSON.stringify(cfg)}`;
  if (!cached || key !== cachedKey) {
    cached = createSecretsProvider(name, cfg);
    cachedKey = key;
  }
  return cached;
}

/** Test hook. */
export function resetSecretsProviderCache(): void {
  cached = null;
  cachedKey = "";
}
