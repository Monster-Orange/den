import type {
  Environment,
  RawManifest,
  ServiceHealthConfig,
} from "./types/index.js";

export interface ResolveManifestBaseUrlOptions {
  manifest: RawManifest;
  repoName: string;
  serviceName: string;
  environment: Environment;
  baseUrlKey: "api" | "web";
}

export interface ResolveServiceBaseUrlOptions {
  baseUrlKey: "api" | "web";
  configuredUrl: string;
  manifestUrl?: string | null;
  overrideUrl?: string | null;
}

function healthUrlForConfig(healthConfig?: ServiceHealthConfig): string | null {
  if (!healthConfig) {
    return null;
  }

  if ("type" in healthConfig && healthConfig.type === "shell") {
    return null;
  }

  return healthConfig.url;
}

function normalizeServiceBaseUrl(
  healthUrl: string,
  baseUrlKey: "api" | "web",
): string {
  if (baseUrlKey !== "api") {
    return healthUrl;
  }

  const url = new URL(healthUrl);
  url.pathname =
    url.pathname.replace(/\/(healthz|readyz|version)\/?$/, "") || "/";

  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Derive a base URL from the manifest's `services.*.health.<env>` entry.
 *
 * Lookup order: `services[serviceName]`, then `services[repoName]`, then the
 * manifest's declared `entrypoint`.
 *
 * The entrypoint step matters because `serviceName` here is the *pillar module*
 * name (smoke passes `svcName` from `smoke.<name>`, perf passes
 * `moduleConfig.service`), which need not match any `services:` key. A repo
 * whose modules are named for what they test rather than for the service —
 * `tier1`, `search`, `ingest` — matched neither of the first two lookups, so
 * this returned null and callers silently fell back to
 * `config/environments/<env>.json -> baseUrls.api`, i.e. shop's API. Repos
 * appeared to work only when a module happened to share the service's name.
 *
 * `entrypoint` is precisely the manifest's statement of which service is the
 * front door, and `service-runner.ts` already resolves an ambiguous subsystem
 * the same way.
 *
 * For `baseUrlKey === "api"`, strips trailing `/healthz`, `/readyz`, or
 * `/version` so the health endpoint becomes a usable API root.
 */
export function resolveManifestBaseUrl({
  manifest,
  repoName,
  serviceName,
  environment,
  baseUrlKey,
}: ResolveManifestBaseUrlOptions): string | null {
  const entrypointConfig = manifest.entrypoint
    ? manifest.services?.[manifest.entrypoint]
    : undefined;
  const serviceConfig =
    manifest.services?.[serviceName] ??
    manifest.services?.[repoName] ??
    entrypointConfig;
  const healthConfig = serviceConfig?.health?.[environment];
  const healthUrl = healthUrlForConfig(healthConfig);
  if (!healthUrl) {
    return null;
  }

  return normalizeServiceBaseUrl(healthUrl, baseUrlKey);
}

/**
 * Precedence-based URL resolver shared across pillars.
 *
 * 1. Explicit override (`BASE_API_URL` env, only for `baseUrlKey === "api"`)
 * 2. Manifest-derived URL from `services.*.health.<env>`
 * 3. Configured URL from `config/environments/<env>.json`
 */
export function resolveServiceBaseUrl({
  baseUrlKey,
  configuredUrl,
  manifestUrl,
  overrideUrl,
}: ResolveServiceBaseUrlOptions): string {
  const trimmedOverride = baseUrlKey === "api" ? overrideUrl?.trim() : "";
  if (trimmedOverride) {
    return trimmedOverride;
  }

  const trimmedManifestUrl = manifestUrl?.trim();
  if (trimmedManifestUrl) {
    return trimmedManifestUrl;
  }

  return configuredUrl;
}
