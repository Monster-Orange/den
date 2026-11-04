/**
 * Smoke Test Global Setup — All Repos, All Services
 *
 * Used by playwright-global.config.ts (make test-smk-global).
 * Runs once before any worker starts:
 *   1. Health-checks every service's base URL across all registered repos
 *   2. Pre-warms JWT tokens for all unique auth roles
 *   3. Exports tokens to process.env so all workers inherit them
 */

import { type FullConfig } from "@playwright/test";
import { envSelector } from "../../shared/environment/env-selector.js";
import { getApiToken } from "../../shared/auth/api-token.js";
import { discoverRepos, resolveRepoPath } from "./discover.js";
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

async function globalSetupGlobal(_config: FullConfig) {
  const environment = (process.env.E2E_ENVIRONMENT as Environment) || "local";
  const repos = discoverRepos();

  const envConfig = await envSelector.loadEnvironment(environment);

  const allServices = repos.flatMap((repo) =>
    Object.entries(repo.manifest.smoke ?? {}).map(([svcName, svc]) => ({
      repo: repo.repoName,
      manifest: repo.manifest,
      svcName,
      svc,
    })),
  );

  console.log(`\n💨 Smoke Test Setup — All Repos`);
  console.log(`   Environment: ${environment}`);
  console.log(
    `   Services:    ${allServices.map((s) => `${s.repo}/${s.svcName}`).join(", ")}\n`,
  );

  // ── Resolve base URLs once per service (used for both reachability + admin probe) ─────────
  const baseUrlByService = new Map(
    allServices.map(({ repo, manifest, svcName, svc }) => [
      `${repo}/${svcName}`,
      resolveSmokeBaseUrlForService(
        manifest,
        repo,
        svcName,
        svc,
        environment,
        envConfig,
        process.env.BASE_API_URL,
      ),
    ]),
  );

  // ── Reachability check per service ─────────────────────────────────────────
  for (const { repo, svcName } of allServices) {
    const baseUrl = baseUrlByService.get(`${repo}/${svcName}`)!;
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
        `✅ ${repo}/${svcName} reachable at ${baseUrl} (${response.status})`,
      );
    } catch (error: unknown) {
      console.error(`❌ Cannot reach ${repo}/${svcName}: ${baseUrl}`);
      console.error(`   Error: ${(error as Error).message}`);
      if (needsVpn)
        console.error(`\n💡 VPN-protected URL. Check VPN is connected.\n`);
      process.exit(1);
    }
  }

  const workerCount = _config.workers;
  if (!Number.isInteger(workerCount) || workerCount <= 0) {
    throw new Error(
      "Smoke fixture teardown requires a positive Playwright worker count",
    );
  }
  const useLocalCheckout = process.env.USE_LOCAL_CHECKOUT === "1";
  const repoByName = new Map(repos.map((r) => [r.repoName, r]));
  const consumersInAcquireOrder: string[] = [];
  const bindings: SmokeFixtureHandoffPayload["bindings"] = [];

  for (const { repo, manifest, svcName, svc } of allServices) {
    if (!svc.fixtures?.storage?.[environment]) {
      continue;
    }
    const discoveredRepo = repoByName.get(repo);
    if (!discoveredRepo) {
      throw new Error(
        `Internal error: repo "${repo}" not in discoverRepos() map`,
      );
    }
    const lifecycle = resolveSmokeStorageFixture(
      manifest,
      svcName,
      environment,
    );
    if (lifecycle.adminProbePath) {
      await assertStorageAdminProbe({
        baseUrl: baseUrlByService.get(`${repo}/${svcName}`)!,
        adminProbePath: lifecycle.adminProbePath,
        label: `${repo} / ${svcName}`,
        ...(lifecycle.adminProbe403Hint
          ? { hintOn403: () => lifecycle.adminProbe403Hint! }
          : {}),
      });
    }
    const cwd = resolveRepoPath(discoveredRepo, environment, useLocalCheckout);
    const resolvedBaseUrl = baseUrlByService.get(`${repo}/${svcName}`)!;
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
    const consumerKey = smokeFixtureConsumerKey(repo, svcName);
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

  // ── Pre-warm JWT tokens (deduplicated across all services) ──────────────────
  const optionalRoles = new Set(["beta", "root_admin"]);
  const allRoles = new Set<"admin" | "user" | "beta" | "root_admin">();
  for (const { svc } of allServices) {
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
  // teardown env snapshot includes SMOKE_*_TOKEN ──────────────────────────────
  for (const { repo, manifest, svcName, svc } of allServices) {
    if (!svc.fixtures?.cleanup?.[environment]) {
      continue;
    }
    const discoveredRepo = repoByName.get(repo);
    if (!discoveredRepo) {
      throw new Error(
        `Internal error: repo "${repo}" not in discoverRepos() map`,
      );
    }
    const cleanupLifecycle = resolveSmokeCleanupFixture(
      manifest,
      svcName,
      environment,
    );
    if (!cleanupLifecycle) {
      continue;
    }
    if (cleanupLifecycle.adminProbePath) {
      await assertStorageAdminProbe({
        baseUrl: baseUrlByService.get(`${repo}/${svcName}`)!,
        adminProbePath: cleanupLifecycle.adminProbePath,
        label: `${repo} / ${svcName}`,
        ...(cleanupLifecycle.adminProbe403Hint
          ? { hintOn403: () => cleanupLifecycle.adminProbe403Hint! }
          : {}),
      });
    }
    const cwd = resolveRepoPath(discoveredRepo, environment, useLocalCheckout);
    const resolvedBaseUrl = baseUrlByService.get(`${repo}/${svcName}`)!;
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
    const consumerKey = smokeFixtureConsumerKey(repo, svcName);
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
      `🧹 Cleanup fixture armed for ${repo}/${svcName} (${environment})`,
    );
  }

  if (consumersInAcquireOrder.length > 0) {
    writeSmokeFixtureHandoff({ consumersInAcquireOrder, bindings });
  }

  console.log();
}

export default globalSetupGlobal;
