/**
 * Secrets strategy — the contract every secrets backend implements.
 *
 * Den never talks to a vault directly. Callers describe WHAT they need as
 * a {@link SecretRef} (a logical vault / item / field triple) and the active
 * {@link SecretsProvider} decides HOW to fetch it: 1Password item fields,
 * Doppler flat keys, or plain environment variables. The backend is selected
 * by configuration (see `resolveSecretsProvider`), never hard-wired.
 */

/** A logical pointer to one secret value. */
export interface SecretRef {
  /** Logical vault/namespace (1Password vault; ignored by flat-key backends). */
  vault: string;
  /** Logical item within the vault (1Password item name or ID). */
  item: string;
  /** Field within the item (e.g. "password", "username", "OPENAI_API_KEY"). */
  field: string;
  /**
   * Flat key for key/value backends (Doppler, env). When omitted it is taken
   * from the `secrets.keys` map in config/den.yml, else derived — see
   * `flatKeyFor`.
   */
  key?: string;
}

export type SecretsProviderName = "doppler" | "1password" | "env";

export interface PreflightResult {
  ok: boolean;
  /** Human-readable remediation when !ok. */
  message?: string;
}

export interface SecretsProvider {
  readonly name: SecretsProviderName;
  /** True when the backend CLI is installed and authenticated. Never throws. */
  isReady(): Promise<boolean>;
  /** Read a secret. Throws when it cannot be resolved. */
  get(ref: SecretRef): Promise<string>;
  /** Read a secret, returning null instead of throwing. */
  tryGet(ref: SecretRef): Promise<string | null>;
  /** Write (create or overwrite) a secret. Throws on failure. */
  set(ref: SecretRef, value: string): Promise<void>;
  /** Check the backend is usable before `den up`/`restart`. */
  preflight(): Promise<PreflightResult>;
  /**
   * argv prefix that runs a child command with secrets injected as env vars,
   * e.g. `["doppler","run","--"]`. Empty when the backend injects nothing.
   */
  runPrefix(): string[];
}
