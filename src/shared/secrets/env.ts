/**
 * Environment-variable strategy — reads flat keys from process.env.
 * Selected with `secrets.provider: env`. Intended for CI and for engineers who
 * inject secrets themselves (direnv, `doppler run -- den …`, CI secrets).
 */
import { flatKeyFor } from "./keys.js";
import type { PreflightResult, SecretRef, SecretsProvider } from "./types.js";

export class EnvProvider implements SecretsProvider {
  readonly name = "env" as const;

  constructor(
    private readonly keys: Record<string, string> = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  keyFor(ref: SecretRef): string {
    return flatKeyFor(ref, this.keys);
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async get(ref: SecretRef): Promise<string> {
    const key = this.keyFor(ref);
    const v = this.env[key];
    if (!v) throw new Error(`Secret ${key} is not set in the environment`);
    return v;
  }

  async tryGet(ref: SecretRef): Promise<string | null> {
    return this.env[this.keyFor(ref)] || null;
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    // Process-local only: the env backend has no durable store.
    this.env[this.keyFor(ref)] = value;
  }

  async preflight(): Promise<PreflightResult> {
    return { ok: true };
  }

  runPrefix(): string[] {
    return [];
  }
}
