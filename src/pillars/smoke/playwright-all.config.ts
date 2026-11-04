/**
 * Playwright Configuration — All Smoke Services
 *
 * Used by: make test-smk-all
 *
 * Creates one Playwright project per service in the linked repo's manifest.
 * Each project gets its own testDir (.smoke-run/<repo>-<service>/) and
 * baseURL, so api and web tests can coexist in a single run and produce
 * a single combined report.
 *
 * Environment variables:
 *   SMOKE_REPO        — repo name in .den/ (required)
 *   E2E_ENVIRONMENT   — env config to load (default: local)
 *   BASE_API_URL      — override API base URL
 */

import { defineConfig } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { findManifest } from "./discover.js";
import {
  resolveManifestSmokeBaseUrl,
  resolveSmokeBaseUrl,
} from "./base-url.js";
import type { Environment } from "../../shared/types/index.js";
import { getDistRoot } from "../../shared/paths.js";
import { smokeRepoName } from "./smoke-repo.js";

import { product } from "../../shared/product.js";
// Den-root anchored in lockstep with setup.ts (the .smoke-run writer).
const PROJECT_ROOT = getDistRoot();

const repoName = smokeRepoName();
const environment = (process.env.E2E_ENVIRONMENT || "local") as Environment;

const discovered = findManifest(repoName);
if (!discovered) {
  console.error(
    `\n❌ playwright-all.config: no manifest found for repo "${repoName}" in .${product().name}/`,
  );
  console.error(`   Run: make smoke-link repo=${repoName}\n`);
  process.exit(1);
}

const configPath = path.resolve(
  PROJECT_ROOT,
  `config/environments/${environment}.json`,
);
let envConfig: { baseUrls: { api: string; web: string } };
try {
  envConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch {
  console.error(
    `\n❌ playwright-all.config: no env config found for "${environment}"`,
  );
  console.error(`   Expected: config/environments/${environment}.json\n`);
  process.exit(1);
}

const smokeServicesFilter = process.env.SMOKE_SERVICES
  ? new Set(process.env.SMOKE_SERVICES.split(",").map((s) => s.trim()))
  : null;

const projects = Object.entries(discovered.manifest.smoke ?? {})
  .filter(
    ([svcName]) => !smokeServicesFilter || smokeServicesFilter.has(svcName),
  )
  .map(([svcName, svc]) => {
    const stagingDir = path.resolve(
      PROJECT_ROOT,
      `.smoke-run/${repoName}-${svcName}`,
    );
    if (!fs.existsSync(stagingDir)) {
      console.error(
        `\n❌ Staging dir not found: .smoke-run/${repoName}-${svcName}/`,
      );
      console.error(
        `   Run setup first: SMOKE_SERVICE=${svcName} SMOKE_REPO=${repoName} npx tsx src/pillars/smoke/setup.ts\n`,
      );
      process.exit(1);
    }

    const configuredUrl =
      svc.baseUrlKey === "api"
        ? envConfig.baseUrls.api
        : envConfig.baseUrls.web;
    const manifestUrl = resolveManifestSmokeBaseUrl({
      manifest: discovered.manifest,
      repoName,
      serviceName: svcName,
      environment,
      baseUrlKey: svc.baseUrlKey,
    });
    const baseUrl = resolveSmokeBaseUrl({
      baseUrlKey: svc.baseUrlKey,
      configuredUrl,
      manifestUrl,
      overrideUrl: process.env.BASE_API_URL,
    });

    return {
      name: svcName,
      testDir: stagingDir,
      testMatch: svc.testMatch,
      use: {
        baseURL: baseUrl,
        timeout: 30000,
        ...(svc.baseUrlKey === "api"
          ? {
              extraHTTPHeaders: {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
            }
          : {}),
      },
    };
  });

export default defineConfig({
  globalSetup: path.resolve(
    PROJECT_ROOT,
    "src/pillars/smoke/global-setup-all.ts",
  ),
  globalTeardown: path.resolve(
    PROJECT_ROOT,
    "src/pillars/smoke/global-teardown-all.ts",
  ),

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: [
    [
      "html",
      {
        outputFolder:
          process.env.PLAYWRIGHT_HTML_REPORT || "../../../playwright-report",
        open: "never",
      },
    ],
    ["list"],
    ["junit", { outputFile: "../../reports/junit-smoke-results.xml" }],
  ],

  projects,

  timeout: 60000,
  expect: { timeout: 10000 },
});
