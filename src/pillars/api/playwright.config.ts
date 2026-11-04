/**
 * Playwright Configuration for Integration Tests
 * API testing configuration
 */

import { defineConfig } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { getDistRoot } from "../../shared/paths.js";
import { distPath, enginePath } from "../../shared/engine.js";

/**
 * Resolve the API base URL from:
 *   1. BASE_API_URL env var (highest priority — use for VPN environments)
 *   2. Environment config file (config/environments/<env>.json)
 *   3. Fallback to localhost:4000
 *
 * Note: global-setup.ts validates reachability and exits early if VPN is
 * required but BASE_API_URL is not set, so tests never run against a
 * VPN_REQUIRED placeholder URL.
 */
function getApiBaseUrl(): string {
  if (process.env.BASE_API_URL) return process.env.BASE_API_URL;

  const env = process.env.E2E_ENVIRONMENT || "local";
  try {
    const configPath = path.join(
      getDistRoot(),
      `config/environments/${env}.json`,
    );
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const url = config.baseUrls?.api;
    if (url) return url;
  } catch {
    // Config not found — fall through to default
  }

  return "http://localhost:4000";
}

export default defineConfig({
  testDir: "./tests",

  // Fail fast: check API reachability + VPN before any tests run
  globalSetup: enginePath("src/pillars/api/global-setup.ts"),

  // Run tests in files in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter configuration (use same report folder as synthetic for consolidated view)
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
    ["junit", { outputFile: distPath("reports", "junit-api-results.xml") }],
    // Note: JSONL reporter not working via config - use manual recording
    // ["../scripts/jsonl-playwright-reporter.js"],
  ],

  // Shared settings for all the projects below
  use: {
    // Base URL for API requests — resolved from env config or BASE_API_URL override
    baseURL: getApiBaseUrl(),

    // Extra HTTP headers
    extraHTTPHeaders: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },

    // Default timeout for API requests
    timeout: 30000,
  },

  // Configure projects (no browser needed for API tests)
  projects: [
    {
      name: "api",
      use: {},
    },
  ],

  // Global timeout for each test
  timeout: 60000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },
});
