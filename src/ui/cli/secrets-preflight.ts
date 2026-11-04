/**
 * Secrets preflight for `den up` / `restart` / `logs`.
 *
 * Backend-agnostic: shells out to `scripts/setup-secrets.ts --gate`, which
 * dispatches to the configured strategy (Doppler, 1Password or env — see
 * src/shared/secrets). A backend that is not ready only warns unless
 * `secrets.required` is true. Synchronous so the CLI can gate before spawning work.
 */
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "child_process";
import * as path from "path";
import { getDistRoot } from "../../shared/paths.js";

import { product } from "../../shared/product.js";
type SpawnSyncLike = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface SecretsPreflightInvocation {
  command: string;
  args: string[];
  cwd: string;
}

export interface SecretsPreflightOptions {
  env?: NodeJS.ProcessEnv;
  root?: string;
  platform?: NodeJS.Platform;
  spawnSyncImpl?: SpawnSyncLike;
  stdio?: SpawnSyncOptionsWithStringEncoding["stdio"];
}

const truthy = (v: string | undefined) => v === "1" || v === "true";

export function shouldSkipSecretsPreflight(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return truthy(env.DEN_SKIP_SECRETS);
}

export function buildSecretsPreflightInvocation(
  root = getDistRoot(),
  platform: NodeJS.Platform = process.platform,
): SecretsPreflightInvocation {
  const tsx = path.join(
    root,
    "node_modules",
    ".bin",
    platform === "win32" ? "tsx.cmd" : "tsx",
  );
  return {
    command: tsx,
    args: [path.join(root, "scripts", "setup-secrets.ts"), "--gate"],
    cwd: root,
  };
}

export function preflightSecrets(options: SecretsPreflightOptions = {}): void {
  const env = options.env ?? process.env;
  if (shouldSkipSecretsPreflight(env)) return;

  const invocation = buildSecretsPreflightInvocation(
    options.root,
    options.platform,
  );
  const result = (options.spawnSyncImpl ?? spawnSync)(
    invocation.command,
    invocation.args,
    {
      cwd: invocation.cwd,
      env: { ...process.env, ...env },
      stdio: options.stdio ?? "inherit",
      encoding: "utf-8",
    },
  );

  if (result.status === 0) return;

  const detail = result.error ? `\n${result.error.message}` : "";
  throw new Error(
    "Developer secrets are not configured or the secrets backend is not signed in.\n" +
      `Run: make ${product().cli}-setup-secrets\n` +
      `Bypass once: ${product().cli} up --skip-secrets or ${product().cli} restart --skip-secrets` +
      detail,
  );
}
