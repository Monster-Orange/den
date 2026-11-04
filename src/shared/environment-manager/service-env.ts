/**
 * Shared environment for service commands.
 *
 * Some repos read shared locations from environment variables (e.g. a
 * shared-infra repo's secrets file, defaulting to a sibling path like
 * `../infra/.secrets.yml`). A sibling default breaks when the consumer is a
 * nested managed clone, because `../infra` no longer points at that repo.
 *
 * Rather than patch each repo, den injects the resolved values into every
 * service command (`up`/`down`/`restart`/`setup`). The mapping comes from the
 * org config's `service_env` (`KEY: "{repo:<name>}/<path>"`); den has no
 * built-in entries.
 */

import { readDenConfig } from "../den-config.js";
import { resolveRepoPath } from "./derivation/derive-graph.js";

/**
 * Built-in shared env templates: none. Config (`service_env`) is merged over
 * this; a key set to "" is skipped.
 */
export const DEFAULT_SERVICE_ENV: Record<string, string> = {};

/**
 * Expand `{repo:<name>}` placeholders to the absolute path den resolves
 * `<name>` to (managed clone or dev sibling). Returns null when any placeholder
 * can't be resolved, so the caller skips that variable entirely.
 */
export function expandServiceEnvTemplate(
  template: string,
  resolve: (repoName: string) => string | null = resolveRepoPath,
): string | null {
  const tokens = [...template.matchAll(/\{repo:([^}]+)\}/g)];
  let out = template;
  for (const match of tokens) {
    const repoPath = resolve(match[1]);
    if (!repoPath) return null;
    out = out.split(match[0]).join(repoPath);
  }
  return out;
}

/**
 * Repos that SUPPLY shared values to other repos, derived from the `{repo:X}`
 * tokens in the (config-merged) service_env templates.
 *
 * These are load-bearing for every consumer: if such a repo's own local config
 * is unusable, starting the repos that read from it produces a fleet configured
 * against placeholder values. Config-derived, so den needs no hardcoded
 * knowledge of which repo happens to own the shared secrets.
 */
export function serviceEnvProviderRepos(
  readConfig: () =>
    | { service_env?: Record<string, string> }
    | null
    | undefined = readDenConfig,
): Set<string> {
  const providers = new Set<string>();
  try {
    const templates: Record<string, string> = {
      ...DEFAULT_SERVICE_ENV,
      ...(readConfig()?.service_env ?? {}),
    };
    for (const template of Object.values(templates)) {
      if (!template) continue; // an empty template is skipped
      for (const match of template.matchAll(/\{repo:([^}]+)\}/g)) {
        providers.add(match[1]);
      }
    }
  } catch {
    /* best-effort — an unreadable config just means no known providers */
  }
  return providers;
}

/**
 * Build the shared environment to inject into a service command. Never overrides
 * a variable already present (and non-empty) in `baseEnv` — an explicit value in
 * the caller's shell wins. Variables whose template can't be resolved are
 * omitted (e.g. the providing repo is not in this workspace).
 */
export function buildServiceEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  resolve: (repoName: string) => string | null = resolveRepoPath,
  readConfig: () =>
    | { service_env?: Record<string, string> }
    | null
    | undefined = readDenConfig,
): NodeJS.ProcessEnv {
  // Best-effort: injecting shared env must never break a service command, so any
  // failure to read config / resolve a repo path degrades to "no shared env".
  try {
    const templates: Record<string, string> = {
      ...DEFAULT_SERVICE_ENV,
      ...(readConfig()?.service_env ?? {}),
    };

    const out: NodeJS.ProcessEnv = {};
    for (const [key, template] of Object.entries(templates)) {
      const existing = baseEnv[key];
      if (existing != null && existing !== "") continue; // respect caller-set value
      if (!template) continue; // an empty template is skipped
      const value = expandServiceEnvTemplate(template, resolve);
      if (value !== null) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
