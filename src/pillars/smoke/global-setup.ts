/**
 * Smoke Test Global Setup
 *
 * Runs once before any smoke test worker starts:
 *   1. Checks API reachability (same VPN-aware logic as integration global-setup)
 *   2. Pre-warms JWT tokens for all roles declared in the service manifest
 *   3. Exports tokens to process.env so workers inherit them at fork time
 *
 * Environment variables read:
 *   E2E_ENVIRONMENT   — which env config to load (default: local)
 *   SMOKE_SERVICE     — service name from the manifest (default: api)
 *   SMOKE_REPO        — repo name from .den/ (required)
 *   BASE_API_URL      — override the API base URL
 *
 * Environment variables written (inherited by workers):
 *   SMOKE_ADMIN_TOKEN      — API JWT for admin role      (required)
 *   SMOKE_USER_TOKEN       — API JWT for user role       (required)
 *   SMOKE_BETA_TOKEN       — API JWT for beta role       (optional — warns if missing)
 *   SMOKE_ROOT_ADMIN_TOKEN — API JWT for root_admin role (optional — warns if missing)
 */

import { type FullConfig } from "@playwright/test";
import { envSelector } from "../../shared/environment/env-selector.js";
import { getApiToken } from "../../shared/auth/api-token.js";
import { findManifest, resolveRepoPath, resolveService } from "./discover.js";
import type { Environment } from "../../shared/types/index.js";
import { resolveSmokeBaseUrlForService } from "./base-url.js";
import { assertStorageAdminProbe } from "./admin-probe.js";
import {
  resolveSmokeCleanupFixture,
  resolveSmokeStorageFixture,
} from "./fixtures.js";
import { acquireFixture, fixtureInstanceId } from "./cleanup.js";
import {
  registerSmokeFixtureReleaseHandles,
  smokeFixtureConsumerKey,
  writeSmokeFixtureHandoff,
  type SmokeFixtureHandoffPayload,
} from "./global-teardown.js";
import { smokeRepoName } from "./smoke-repo.js";

import { product } from "../../shared/product.js";
async function globalSetup(_config: FullConfig) {
  const environment = (process.env.E2E_ENVIRONMENT as Environment) || "local";
  const serviceName = process.env.SMOKE_SERVICE || "api";
  const repoName = smokeRepoName();

  const envConfig = await envSelector.loadEnvironment(environment);

  // Resolve the service manifest to get baseUrlKey and auth roles
  const discovered = findManifest(repoName);
  if (!discovered) {
    console.error(
      `\n❌ No manifest found for repo "${repoName}" in .${product().name}/`,
    );
    console.error(`   Run: make smoke-link repo=${repoName}\n`);
    process.exit(1);
  }

  const svc = resolveService(discovered, serviceName);
  if (!svc) {
    const available = Object.keys(discovered.manifest.smoke ?? {}).join(", ");
    console.error(
      `\n❌ Service "${serviceName}" not found in ${repoName}/${product().manifestJson}`,
    );
    console.error(`   Available: ${available}\n`);
    process.exit(1);
  }

  const baseUrl = resolveSmokeBaseUrlForService(
    discovered.manifest,
    repoName,
    serviceName,
    svc,
    environment,
    envConfig,
    process.env.BASE_API_URL,
  );
  const needsVpn = baseUrl.includes(".internal.");

  console.log(`\n💨 Smoke Test Setup`);
  console.log(`   Repo:        ${repoName}`);
  console.log(`   Service:     ${serviceName}`);
  console.log(`   Environment: ${environment}`);
  console.log(`   Base URL:    ${baseUrl}\n`);

  // ── Reachability check ──────────────────────────────────────────────────
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      response = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    }
    console.log(`✅ Service is reachable (status: ${response.status})`);
  } catch (error: unknown) {
    console.error(`❌ Cannot reach service: ${baseUrl}`);
    console.error(`   Error: ${(error as Error).message}`);
    if (needsVpn) {
      console.error(
        `\n💡 VPN-protected URL. Check that your VPN is connected.`,
      );
      console.error(
        `   Synthetic (browser) tests do NOT require VPN — only smoke/API tests do.\n`,
      );
    }
    process.exit(1);
  }

  // Handoff bookkeeping shared by the storage + cleanup fixture blocks; the
  // handoff file is written once, after every fixture has been acquired.
  const consumersInAcquireOrder: string[] = [];
  const bindings: SmokeFixtureHandoffPayload["bindings"] = [];

  // ── Storage smoke fixtures (acquire + env for workers) ─────────────────────
  if (svc.fixtures?.storage?.[environment]) {
    const workerCount = _config.workers;
    if (!Number.isInteger(workerCount) || workerCount <= 0) {
      throw new Error(
        "Smoke fixture teardown requires a positive Playwright worker count",
      );
    }
    const useLocalCheckout = process.env.USE_LOCAL_CHECKOUT === "1";
    const lifecycle = resolveSmokeStorageFixture(
      discovered.manifest,
      serviceName,
      environment,
    );
    if (lifecycle.adminProbePath) {
      await assertStorageAdminProbe({
        baseUrl,
        adminProbePath: lifecycle.adminProbePath,
        label: `${repoName} / ${serviceName}`,
        ...(lifecycle.adminProbe403Hint
          ? { hintOn403: () => lifecycle.adminProbe403Hint! }
          : {}),
      });
    }
    const cwd = resolveRepoPath(discovered, environment, useLocalCheckout);
    const resolvedBaseUrl = baseUrl;
    const fixtureEnv = {
      ...process.env,
      BASE_API_URL: resolvedBaseUrl,
      SMOKE_BASE_URL: resolvedBaseUrl,
      ...lifecycle.envVars,
      SMOKE_WORKER_COUNT: String(workerCount),
    };
    const release = await acquireFixture({
      fixtureKey: lifecycle.fixtureKey,
      resolvedPayload: lifecycle.resolvedPayload as unknown as Record<
        string,
        unknown
      >,
      cwd,
      env: fixtureEnv,
      setup: lifecycle.setup,
      teardown: lifecycle.teardown,
    });
    Object.assign(process.env, fixtureEnv);
    const consumerKey = smokeFixtureConsumerKey(repoName, serviceName);
    registerSmokeFixtureReleaseHandles(consumerKey, [release]);
    consumersInAcquireOrder.push(consumerKey);
    bindings.push({
      consumerKey,
      fixtureInstanceId: fixtureInstanceId(
        lifecycle.fixtureKey,
        lifecycle.resolvedPayload as unknown as Record<string, unknown>,
      ),
    });
  }

  // ── Pre-warm JWT tokens ─────────────────────────────────────────────────
  // Tokens are written to process.env here. Worker processes inherit env at
  // fork time (after globalSetup completes), so they all get cache hits.
  // Required roles: admin + user — fatal if credentials or token fetch fails.
  // Optional roles: beta + root_admin — warn and continue (accounts may not exist in all envs).
  const optionalRoles = new Set(["beta", "root_admin"]);
  const roles = (svc.auth ?? ["admin", "user"]) as (
    | "admin"
    | "user"
    | "beta"
    | "root_admin"
  )[];

  if (roles.length > 0) {
    console.log(`\n🔑 Warming JWT token cache...`);
    for (const role of roles) {
      const isOptional = optionalRoles.has(role);
      try {
        const token = await getApiToken(role, environment);
        process.env[`SMOKE_${role.toUpperCase()}_TOKEN`] = token;
      } catch (err: unknown) {
        const msg = (err as Error).message ?? String(err);
        if (isOptional) {
          console.warn(
            `  ⚠  No token for ${role} — ${role} tests will be skipped`,
          );
        } else {
          console.error(`\n❌ Failed to fetch ${role} JWT: ${msg}\n`);
          process.exit(1);
        }
      }
    }
  }

  // ── Cleanup smoke fixture (teardown-only sweep) ─────────────────────────────
  // Acquired AFTER token warming on purpose: the fixture env is snapshotted at
  // acquire time, so the teardown command inherits SMOKE_*_TOKEN — required by
  // repos whose sweep authenticates against JWT-guarded APIs.
  const cleanupLifecycle = resolveSmokeCleanupFixture(
    discovered.manifest,
    serviceName,
    environment,
  );
  if (cleanupLifecycle) {
    const workerCount = _config.workers;
    if (!Number.isInteger(workerCount) || workerCount <= 0) {
      throw new Error(
        "Smoke fixture teardown requires a positive Playwright worker count",
      );
    }
    const useLocalCheckout = process.env.USE_LOCAL_CHECKOUT === "1";
    if (cleanupLifecycle.adminProbePath) {
      await assertStorageAdminProbe({
        baseUrl,
        adminProbePath: cleanupLifecycle.adminProbePath,
        label: `${repoName} / ${serviceName}`,
        ...(cleanupLifecycle.adminProbe403Hint
          ? { hintOn403: () => cleanupLifecycle.adminProbe403Hint! }
          : {}),
      });
    }
    const cwd = resolveRepoPath(discovered, environment, useLocalCheckout);
    const fixtureEnv = {
      ...process.env,
      BASE_API_URL: baseUrl,
      SMOKE_BASE_URL: baseUrl,
      ...cleanupLifecycle.envVars,
      SMOKE_WORKER_COUNT: String(workerCount),
    };
    const release = await acquireFixture({
      fixtureKey: cleanupLifecycle.fixtureKey,
      resolvedPayload: cleanupLifecycle.resolvedPayload,
      cwd,
      env: fixtureEnv,
      setup: cleanupLifecycle.setup,
      teardown: cleanupLifecycle.teardown,
    });
    const consumerKey = smokeFixtureConsumerKey(repoName, serviceName);
    registerSmokeFixtureReleaseHandles(consumerKey, [release]);
    consumersInAcquireOrder.push(consumerKey);
    bindings.push({
      consumerKey,
      fixtureInstanceId: fixtureInstanceId(
        cleanupLifecycle.fixtureKey,
        cleanupLifecycle.resolvedPayload,
      ),
    });
    console.log(
      `🧹 Cleanup fixture armed for ${repoName}/${serviceName} (${environment})`,
    );
  }

  if (consumersInAcquireOrder.length > 0) {
    writeSmokeFixtureHandoff({ consumersInAcquireOrder, bindings });
  }

  console.log();
}

export default globalSetup;
