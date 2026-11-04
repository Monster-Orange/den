/**
 * Playwright Configuration for Smoke Tests
 *
 * Dynamically configured from the service's .den.json manifest.
 * The testDir, testMatch, and baseURL are all resolved at config time
 * from the manifest discovered in .den/<repo>/.den.json.
 *
 * Environment variables:
 *   SMOKE_SERVICE     — service name in the manifest (default: api)
 *   SMOKE_REPO        — repo name in .den/ (required)
 *   E2E_ENVIRONMENT   — env config to load (default: local)
 *   BASE_API_URL      — override base URL (useful for one-off runs)
 */

import { defineConfig } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { findManifest, resolveService } from "./discover.js";
import { getDistRoot } from "../../shared/paths.js";
import { distPath, enginePath } from "../../shared/engine.js";
import {
  resolveManifestSmokeBaseUrl,
  resolveSmokeBaseUrl,
} from "./base-url.js";
import { smokeRepoName } from "./smoke-repo.js";

import { product } from "../../shared/product.js";
// Den-root anchored in lockstep with setup.ts (the .smoke-run writer).
const PROJECT_ROOT = getDistRoot();

function resolveConfig() {
  const serviceName = process.env.SMOKE_SERVICE || "api";
  const repoName = smokeRepoName();
  const environment = process.env.E2E_ENVIRONMENT || "local";

  // Discover the repo manifest
  const discovered = findManifest(repoName);
  if (!discovered) {
    console.error(
      `\n❌ Smoke config: no manifest found for repo "${repoName}" in .${product().name}/`,
    );
    console.error(`   Run: make smoke-link repo=${repoName}\n`);
    process.exit(1);
  }

  const svc = resolveService(discovered, serviceName);
  if (!svc) {
    const available = Object.keys(discovered.manifest.smoke ?? {}).join(", ");
    console.error(
      `\n❌ Smoke config: service "${serviceName}" not found in ${repoName}/${product().manifestJson}`,
    );
    console.error(`   Available services: ${available}\n`);
    process.exit(1);
  }

  // Load environment config for the base URL
  const configPath = path.resolve(
    PROJECT_ROOT,
    `config/environments/${environment}.json`,
  );
  let envConfig: { baseUrls: { api: string; web: string } };
  try {
    envConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    console.error(
      `\n❌ Smoke config: no env config found for "${environment}"`,
    );
    console.error(`   Expected: config/environments/${environment}.json\n`);
    process.exit(1);
  }

  const configuredUrl =
    svc.baseUrlKey === "api" ? envConfig.baseUrls.api : envConfig.baseUrls.web;
  const manifestUrl = resolveManifestSmokeBaseUrl({
    manifest: discovered.manifest,
    repoName,
    serviceName,
    environment: environment as
      | "local"
      | "dev"
      | "sandbox"
      | "staging"
      | "production",
    baseUrlKey: svc.baseUrlKey,
  });
  const baseUrl = resolveSmokeBaseUrl({
    baseUrlKey: svc.baseUrlKey,
    configuredUrl,
    manifestUrl,
    overrideUrl: process.env.BASE_API_URL,
  });

  // Use the staged test dir (.smoke-run/{repo}-{service}/) which has a
  // node_modules shim pointing to den's playwright. This prevents the
  // "Requiring @playwright/test second time" error caused by the repo's own
  // @playwright/test in node_modules being found during test file loading.
  const stagingDir = path.resolve(
    PROJECT_ROOT,
    `.smoke-run/${repoName}-${serviceName}`,
  );
  if (!fs.existsSync(stagingDir)) {
    console.error(
      `\n❌ Staging dir not found: .smoke-run/${repoName}-${serviceName}/`,
    );
    console.error(
      `   The setup step runs automatically via make targets. If running`,
    );
    console.error(
      `   playwright directly, run: SMOKE_SERVICE=${serviceName} SMOKE_REPO=${repoName} npx tsx src/pillars/smoke/setup.ts\n`,
    );
    process.exit(1);
  }

  return { svc: { ...svc, testDir: stagingDir }, baseUrl };
}

const { svc, baseUrl } = resolveConfig();

export default defineConfig({
  testDir: svc.testDir,
  testMatch: svc.testMatch,

  globalSetup: enginePath("src/pillars/smoke/global-setup.ts"),
  globalTeardown: enginePath("src/pillars/smoke/global-teardown.ts"),

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: [
    [
      "html",
      {
        outputFolder:
          process.env.PLAYWRIGHT_HTML_REPORT || distPath("playwright-report"),
        open: "never",
      },
    ],
    ["list"],
    ["junit", { outputFile: distPath("reports", "junit-smoke-results.xml") }],
  ],

  use: {
    baseURL: baseUrl,
    // JSON headers only for API services; web tests use a headless browser
    ...(svc.baseUrlKey === "api"
      ? {
          extraHTTPHeaders: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      : {}),
    timeout: 30000,
  },

  projects: [{ name: "smoke", use: {} }],

  timeout: 60000,
  expect: { timeout: 10000 },
});
