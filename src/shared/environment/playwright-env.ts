/**
 * Playwright Config Helpers — environment resolution for sync `defineConfig` callers.
 *
 * The async `envSelector` (see env-selector.ts) is the canonical loader at
 * runtime, but Playwright's `defineConfig` is synchronous and runs before
 * any test fixtures, so it cannot await. These helpers centralize the small
 * amount of env-resolution logic Playwright configs need at config-load
 * time:
 *
 *   - resolveEnv      → which `Environment` is this run targeting?
 *   - resolveAuthPath → where is the saved browser storageState for {role,env}?
 *   - resolveBrowserBaseUrl → canonical web URL from config/environments/<env>.json
 *
 * `resolveBrowserBaseUrl` reads the env JSON synchronously (readFileSync)
 * because it runs at module-eval time inside the Playwright config. This is
 * the same source of truth `envSelector.loadEnvironment` consumes — just the
 * sync flavour.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import type { Environment, EnvironmentConfig } from "../types/index.js";
import { getDistRoot } from "../paths.js";

export type Role = "admin" | "user" | "beta";

/**
 * Resolve the target environment from `E2E_ENVIRONMENT`, falling back to
 * `defaultEnv` (typically "local").
 */
export function resolveEnv(defaultEnv: Environment = "local"): Environment {
  const fromEnv = process.env.E2E_ENVIRONMENT;
  return (fromEnv && fromEnv.length > 0 ? fromEnv : defaultEnv) as Environment;
}

/**
 * Absolute path to the saved browser storageState file for a given role+env.
 *
 * Convention: `<repoRoot>/playwright/.auth/<role>-<env>.json`. Mirrors the
 * pattern used in `pillars/browser/global-setup.ts` when sessions are minted.
 */
export function resolveAuthPath(
  role: Role,
  env: Environment,
  repoRoot: string,
): string {
  return resolve(repoRoot, `playwright/.auth/${role}-${env}.json`);
}

/**
 * Canonical browser-facing base URL for `env`, read synchronously from
 * `config/environments/<env>.json`. Same source of truth as the async
 * `envSelector.loadEnvironment(env).baseUrls.web`.
 *
 * Throws if the env config is missing/malformed — fail fast at config-load
 * rather than letting Playwright proceed with a bogus baseURL.
 */
export function resolveBrowserBaseUrl(env: Environment): string {
  // read-only fail-fast lookup, den-root anchored for determinism
  const configPath = resolve(getDistRoot(), `config/environments/${env}.json`);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (error) {
    throw new Error(
      `[playwright-env] Cannot read environment config for "${env}" at ${configPath}: ${(error as Error).message}`,
    );
  }
  let cfg: EnvironmentConfig;
  try {
    cfg = JSON.parse(raw) as EnvironmentConfig;
  } catch (error) {
    throw new Error(
      `[playwright-env] Invalid JSON in ${configPath}: ${(error as Error).message}`,
    );
  }
  if (!cfg.baseUrls || !cfg.baseUrls.web) {
    throw new Error(
      `[playwright-env] Env config ${configPath} is missing baseUrls.web`,
    );
  }
  return cfg.baseUrls.web;
}
