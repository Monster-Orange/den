/**
 * Integration Test Global Setup
 *
 * Checks API reachability before any tests run.
 * Fails fast with clear, actionable messages so developers immediately
 * know whether the issue is a missing VPN connection, Docker service down,
 * or a network problem — rather than watching all tests fail with cryptic errors.
 *
 * Non-local environments (dev/sandbox/staging/production) use internal VPN URLs
 * (api.internal.ENV.example.dev). Connect to VPN before running integration tests
 * against those environments.
 */

import { type FullConfig } from "@playwright/test";
import { envSelector } from "../../shared/environment/env-selector.js";
import { getApiToken } from "../../shared/auth/api-token.js";
import type { Environment } from "../../shared/types/index.js";

import { product } from "../../shared/product.js";
async function globalSetup(_config: FullConfig) {
  const environment = (process.env.E2E_ENVIRONMENT as Environment) || "local";
  const envConfig = await envSelector.loadEnvironment(environment);

  // BASE_API_URL env var takes precedence (useful for one-off overrides)
  const apiUrl = process.env.BASE_API_URL || envConfig.baseUrls.api;

  console.log(`\n🔌 Integration API Health Check`);
  console.log(`   Environment: ${environment}`);
  console.log(`   API URL:     ${apiUrl}\n`);

  // ── Reachability check ──────────────────────────────────────────────────
  const isDockerUrl =
    apiUrl.includes("localhost") || apiUrl.startsWith("http://");
  const needsVpn = apiUrl.includes(".internal.");

  try {
    // Try /healthz first (standard health endpoint), fall back to root
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/healthz`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      response = await fetch(apiUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
    }

    // Any HTTP response (including 401, 403, 404) means the server is up
    console.log(`✅ API is reachable (status: ${response.status})`);
  } catch (error: unknown) {
    console.error(`❌ Cannot reach API: ${apiUrl}`);
    console.error(`   Error: ${(error as Error).message}`);

    if (isDockerUrl) {
      console.error(`\n💡 API service appears to be down.`);
      console.error(
        `   Start it first (for example: ${product().cli} up, or the API repo's own make up).\n`,
      );
    } else if (needsVpn) {
      console.error(`\n💡 Cannot reach VPN-protected API at ${apiUrl}.`);
      console.error(`   Check that your VPN is connected and try again.`);
      console.error(`\n   Note: Synthetic (browser) tests do NOT require VPN.`);
      console.error(`         Run: make test-syn-all env=${environment}\n`);
    } else {
      console.error(`\n💡 Check network connectivity and try again.\n`);
    }

    process.exit(1);
  }

  // ── Pre-warm JWT token cache ─────────────────────────────────────────────
  // Fetch tokens once here so all parallel workers get a cache hit.
  // Without this, workers race to fetch on first run — parallel token mints
  // can hit IdP rate limits or lose the write race.
  console.log(`\n🔑 Warming JWT token cache...`);
  for (const role of ["admin", "user"] as const) {
    try {
      await getApiToken(role, environment);
    } catch (err: unknown) {
      if ((err as Error).message?.includes("No credentials available")) {
        // Credentials not present — unauthenticated tests can still run
        console.warn(
          `  ⚠  No credentials for ${role} — authenticated ${role} tests will fail`,
        );
        console.warn(
          `     eval $(op signin) && make auth-configure (admin) or verify 1Password vault`,
        );
      } else {
        // Token mint failure, IdP misconfiguration, etc. — fail fast
        console.error(
          `\n❌ Failed to fetch ${role} JWT: ${(err as Error).message}\n`,
        );
        process.exit(1);
      }
    }
  }
  console.log();
}

export default globalSetup;
