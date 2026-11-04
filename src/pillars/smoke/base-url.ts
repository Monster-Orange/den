/**
 * Smoke-specific re-exports of the shared service URL resolution helpers.
 *
 * All smoke consumers import from this module. The underlying logic now lives
 * in `src/shared/service-url.ts` so the perf pillar (and future pillars) can
 * reuse it without importing from `pillars/smoke/`.
 */
import type {
  Environment,
  RawManifest,
  SmokeServiceConfig,
} from "../../shared/types/index.js";
import {
  resolveManifestBaseUrl,
  resolveServiceBaseUrl,
} from "../../shared/service-url.js";

export {
  resolveManifestBaseUrl as resolveManifestSmokeBaseUrl,
  resolveServiceBaseUrl as resolveSmokeBaseUrl,
} from "../../shared/service-url.js";

export type {
  ResolveManifestBaseUrlOptions as ResolveManifestSmokeBaseUrlOptions,
  ResolveServiceBaseUrlOptions as ResolveSmokeBaseUrlOptions,
} from "../../shared/service-url.js";

/** Same precedence as single-service smoke setup: override → manifest health URL → env config. */
export function resolveSmokeBaseUrlForService(
  manifest: RawManifest,
  repoName: string,
  serviceName: string,
  service: SmokeServiceConfig,
  environment: Environment,
  envConfig: { baseUrls: { api: string; web: string } },
  /** Explicit override URL (pass `process.env.BASE_API_URL` at the call site). */
  overrideUrl?: string | null,
): string {
  const configuredUrl =
    service.baseUrlKey === "api"
      ? envConfig.baseUrls.api
      : envConfig.baseUrls.web;
  const manifestUrl = resolveManifestBaseUrl({
    manifest,
    repoName,
    serviceName,
    environment,
    baseUrlKey: service.baseUrlKey,
  });
  return resolveServiceBaseUrl({
    baseUrlKey: service.baseUrlKey,
    configuredUrl,
    manifestUrl,
    overrideUrl,
  });
}
