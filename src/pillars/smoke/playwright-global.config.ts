/**
 * Playwright Configuration — All Smoke Tests, All Repos
 *
 * Used by: make test-smk-global
 *
 * Creates one Playwright project per service per registered repo.
 * All results appear in a single combined report.
 *
 * Environment variables:
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
import { distPath, enginePath } from "../../shared/engine.js";

import { product } from "../../shared/product.js";
// Den-root anchored in lockstep with setup-global.ts (the manifest writer).
const PROJECT_ROOT = getDistRoot();
const SMOKE_RUN_DIR = path.resolve(PROJECT_ROOT, ".smoke-run");
const environment = (process.env.E2E_ENVIRONMENT || "local") as Environment;

const configPath = path.resolve(
  PROJECT_ROOT,
  `config/environments/${environment}.json`,
);
let envConfig: { baseUrls: { api: string; web: string } };
try {
  envConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch {
  console.error(
    `\n❌ playwright-global.config: no env config for "${environment}"`,
  );
  console.error(`   Expected: config/environments/${environment}.json\n`);
  process.exit(1);
}

// Read exactly what setup-global.ts staged — no second discoverRepos() call
const globalManifestPath = path.join(SMOKE_RUN_DIR, "global-manifest.json");
if (!fs.existsSync(globalManifestPath)) {
  console.error(
    `\n❌ No staged smoke tests found. Run: make test-smk-global\n`,
  );
  process.exit(1);
}
const staged: Array<{
  repo: string;
  svc: string;
  dir: string;
  testMatch: string;
  baseUrlKey: string;
}> = JSON.parse(fs.readFileSync(globalManifestPath, "utf-8"));

if (!staged.length) {
  console.error(
    `\n❌ No smoke services staged. Check your ${product().manifestYml} smoke: keys.\n`,
  );
  process.exit(1);
}

const projects = staged.map(({ repo, svc, dir, testMatch, baseUrlKey }) => {
  if (!fs.existsSync(dir)) {
    console.error(`\n❌ Staging dir missing: ${dir}`);
    console.error(`   Re-run: make test-smk-global\n`);
    process.exit(1);
  }

  const configuredUrl =
    baseUrlKey === "web" ? envConfig.baseUrls.web : envConfig.baseUrls.api;
  const discovered = findManifest(repo);
  if (!discovered) {
    console.error(
      `\n❌ No manifest found for repo "${repo}" in .${product().name}/`,
    );
    console.error(`   Run: make register-repos\n`);
    process.exit(1);
  }
  const manifestUrl = resolveManifestSmokeBaseUrl({
    manifest: discovered.manifest,
    repoName: repo,
    serviceName: svc,
    environment,
    baseUrlKey: baseUrlKey === "web" ? "web" : "api",
  });
  const baseUrl = resolveSmokeBaseUrl({
    baseUrlKey: baseUrlKey === "web" ? "web" : "api",
    configuredUrl,
    manifestUrl,
    overrideUrl: process.env.BASE_API_URL,
  });

  return {
    name: `${repo}/${svc}`,
    testDir: dir,
    testMatch,
    use: {
      baseURL: baseUrl,
      timeout: 30000,
    },
  };
});

export default defineConfig({
  globalSetup: enginePath("src/pillars/smoke/global-setup-global.ts"),
  globalTeardown: enginePath("src/pillars/smoke/global-teardown-global.ts"),

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
    [
      "junit",
      { outputFile: distPath("reports", "junit-smoke-global-results.xml") },
    ],
  ],

  projects,

  timeout: 60000,
  expect: { timeout: 10000 },
});
