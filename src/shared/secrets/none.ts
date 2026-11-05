/**
 * The `none` strategy: no secrets backend. What a distribution gets when it
 * sets no `secrets.provider`. It resolves nothing, never spawns a CLI, and
 * every secret-backed feature reports "not configured" instead of failing.
 */
import { product } from "../product.js";
import type { PreflightResult, SecretRef, SecretsProvider } from "./types.js";

/**
 * "not configured: set secrets.provider and secrets.refs.<name> in
 * config/<cli>.yml" — the one message every surface shows for a secret Den
 * has no configured place for.
 */
export function notConfiguredMessage(refName = "<name>"): string {
  return `not configured: set secrets.provider and secrets.refs.${refName} in ${product().configFile}`;
}

/** Thrown when a secret is asked of a backend or ref that is not configured. */
export class SecretsNotConfiguredError extends Error {
  readonly code = "not-configured";
  constructor(message = notConfiguredMessage()) {
    super(message);
    this.name = "SecretsNotConfiguredError";
  }
}

export class NoneProvider implements SecretsProvider {
  readonly name = "none" as const;

  async isReady(): Promise<boolean> {
    return false;
  }

  async get(ref: SecretRef): Promise<string> {
    throw new SecretsNotConfiguredError(
      `${ref.field || "secret"}: no secrets backend is configured (${notConfiguredMessage()})`,
    );
  }

  async tryGet(): Promise<string | null> {
    return null;
  }

  async set(): Promise<void> {
    throw new SecretsNotConfiguredError();
  }

  async preflight(): Promise<PreflightResult> {
    // Nothing to sign in to: `up` and `web` run as they are.
    return { ok: true, message: "no secrets backend configured" };
  }

  runPrefix(): string[] {
    return [];
  }
}
