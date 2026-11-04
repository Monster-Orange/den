/**
 * Smoke Test Global Setup — All Services
 *
 * Used by playwright-all.config.ts when running make test-smk-all.
 * Runs once before any worker starts:
 *   1. Health-checks every service's base URL
 *   2. Pre-warms JWT tokens for all unique auth roles across services
 *   3. Exports tokens to process.env so all workers inherit them
 */

import { type FullConfig } from "@playwright/test";
import { envSelector } from "../../shared/environment/env-selector.js";
import { getApiToken } from "../../shared/auth/api-token.js";
import { findManifest, resolveRepoPath } from "./discover.js";
import type { Environment } from "../../shared/types/index.js";
import { assertStorageAdminProbe } from "./admin-probe.js";
import { resolveSmokeBaseUrlForService } from "./base-url.js";
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
async function globalSetupAll(_config: FullConfig) {
  const environment = (process.env.E2E_ENVIRONMENT as Environment) || "local";
  const repoName = smokeRepoName();

  const envConfig = await envSelector.loadEnvironment(environment);

  const discovered = findManifest(repoName);
  if (!discovered) {
    console.error(
      `\n❌ No manifest found for repo "${repoName}" in .${product().name}/`,
    );
    console.error(`   Run: make smoke-link repo=${repoName}\n`);
    process.exit(1);
  }

  const smokeServicesFilter = process.env.SMOKE_SERVICES
    ? new Set(process.env.SMOKE_SERVICES.split(",").map((s) => s.trim()))
    : null;

  const allServices = Object.entries(discovered.manifest.smoke ?? {});
  const services = smokeServicesFilter
    ? allServices.filter(([n]) => smokeServicesFilter.has(n))
    : allServices;

  console.log(`\n💨 Smoke Test Setup — All Services`);
  console.log(`   Repo:        ${repoName}`);
  console.log(`   Environment: ${environment}`);
  console.log(`   Services:    ${services.map(([n]) => n).join(", ")}\n`);

  // ── Resolve base URLs once per service (used for both reachability + admin probe) ─────────
  const baseUrlByService = new Map(
    services.map(([svcName, svc]) => [
      svcName,
      resolveSmokeBaseUrlForService(
        discovered.manifest,
        repoName,
        svcName,
        svc,
        environment,
        envConfig,
        process.env.BASE_API_URL,
      ),
    ]),
  );

  // ── Reachability check per service ───────────────────────────────────────
  for (const [svcName] of services) {
    const baseUrl = baseUrlByService.get(svcName)!;
    const needsVpn = baseUrl.includes(".internal.");

    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        response = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
      }
      console.log(
        `✅ ${svcName} is reachable at ${baseUrl} (status: ${response.status})`,
      );
    } catch (error: unknown) {
      console.error(`❌ Cannot reach ${svcName}: ${baseUrl}`);
      console.error(`   Error: ${(error as Error).message}`);
      if (needsVpn) {
        console.error(
          `\n💡 VPN-protected URL. Check that your VPN is connected.\n`,
        );
      }
      process.exit(1);
    }
  }

  // ── Storage fixtures: one acquire per repo/service consumer; shared identity → one setup
  const workerCount = _config.workers;
  if (!Number.isInteger(workerCount) || workerCount <= 0) {
    throw new Error(
      "Smoke fixture teardown requires a positive Playwright worker count",
    );
  }
  const useLocalCheckout = process.env.USE_LOCAL_CHECKOUT === "1";
  const consumersInAcquireOrder: string[] = [];
  const bindings: SmokeFixtureHandoffPayload["bindings"] = [];
  for (const [svcName, svc] of services) {
    if (!svc.fixtures?.storage?.[environment]) {
      continue;
    }
    const lifecycle = resolveSmokeStorageFixture(
      discovered.manifest,
      svcName,
      environment,
    );
    if (lifecycle.adminProbePath) {
      await assertStorageAdminProbe({
        baseUrl: baseUrlByService.get(svcName)!,
        adminProbePath: lifecycle.adminProbePath,
        label: `${repoName} / ${svcName}`,
        ...(lifecycle.adminProbe403Hint
          ? { hintOn403: () => lifecycle.adminProbe403Hint! }
          : {}),
      });
    }
    const cwd = resolveRepoPath(discovered, environment, useLocalCheckout);
    const resolvedBaseUrl = baseUrlByService.get(svcName)!;
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
    const consumerKey = smokeFixtureConsumerKey(repoName, svcName);
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

  // ── Pre-warm JWT tokens (deduplicated across all services) ───────────────
  const optionalRoles = new Set(["beta", "root_admin"]);
  const allRoles = new Set<"admin" | "user" | "beta" | "root_admin">();
  for (const [, svc] of services) {
    for (const role of svc.auth ?? ["admin", "user"]) {
      allRoles.add(role as "admin" | "user" | "beta" | "root_admin");
    }
  }

  if (allRoles.size > 0) {
    console.log(`\n🔑 Warming JWT token cache...`);
    for (const role of allRoles) {
      const isOptional = optionalRoles.has(role);
      try {
        const token = await getApiToken(role, environment);
        process.env[`SMOKE_${role.toUpperCase()}_TOKEN`] = token;
        console.log(`  ✓ ${role} token ready`);
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

  // ── Cleanup fixtures (teardown-only sweeps) — after token warming so the
  // teardown env snapshot includes SMOKE_*_TOKEN ────────────────────────────
  for (const [svcName, svc] of services) {
    if (!svc.fixtures?.cleanup?.[environment]) {
      continue;
    }
    const cleanupLifecycle = resolveSmokeCleanupFixture(
      discovered.manifest,
      svcName,
      environment,
    );
    if (!cleanupLifecycle) {
      continue;
    }
    if (cleanupLifecycle.adminProbePath) {
      await assertStorageAdminProbe({
        baseUrl: baseUrlByService.get(svcName)!,
        adminProbePath: cleanupLifecycle.adminProbePath,
        label: `${repoName} / ${svcName}`,
        ...(cleanupLifecycle.adminProbe403Hint
          ? { hintOn403: () => cleanupLifecycle.adminProbe403Hint! }
          : {}),
      });
    }
    const cwd = resolveRepoPath(discovered, environment, useLocalCheckout);
    const resolvedBaseUrl = baseUrlByService.get(svcName)!;
    const fixtureEnv = {
      ...process.env,
      BASE_API_URL: resolvedBaseUrl,
      SMOKE_BASE_URL: resolvedBaseUrl,
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
    const consumerKey = smokeFixtureConsumerKey(repoName, svcName);
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
      `🧹 Cleanup fixture armed for ${repoName}/${svcName} (${environment})`,
    );
  }

  if (consumersInAcquireOrder.length > 0) {
    writeSmokeFixtureHandoff({ consumersInAcquireOrder, bindings });
  }

  console.log();
}

export default globalSetupAll;
