/**
 * Playwright Configuration for Staged Synthetic Tests
 *
 * Runs test files from .synth-run/<repo>/ (staged by pillars/browser/setup.ts).
 *   - chromium             regular tests (no saved auth)
 *   - chromium-admin       admin-named tests (saved admin session)
 *   - chromium-user        user-named tests (saved user session)
 *   - firefox              cross-browser (no saved auth)
 *   - webkit               cross-browser (no saved auth)
 *   - chromium-last        *.last.spec.ts tests, run LAST (via dependencies) —
 *                          for suites that change shared state other tests read
 */

import { defineConfig, devices } from "@playwright/test";
import type {
  Reporter,
  TestCase,
  TestResult as PlaywrightTestResult,
} from "@playwright/test/reporter";
import * as fs from "fs";
import * as path from "path";
import { getDistRoot } from "../../shared/paths.js";
import { distPath } from "../../shared/engine.js";
import { fileURLToPath } from "url";
import { resultWriter } from "../../shared/results/result-writer.js";
import {
  resolveAuthPath,
  resolveEnv,
} from "../../shared/environment/playwright-env.js";
import * as os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auto-detect: SYNTH_REPO env, or the first directory in .synth-run/
const repoName = (() => {
  if (process.env.SYNTH_REPO) return process.env.SYNTH_REPO;
  const synthRunDir = distPath(".synth-run");
  try {
    const entries = fs.readdirSync(synthRunDir, { withFileTypes: true });
    const dir = entries.find((e) => e.isDirectory());
    if (dir) return dir.name;
  } catch {
    /* .synth-run doesn't exist yet */
  }
  throw new Error(
    "SYNTH_REPO is not set and nothing is staged in .synth-run/ — run the " +
      "synthetic setup for a repo first (make test-syn repo=<name>).",
  );
})();
const env = resolveEnv("local");
// The distribution root: setup.ts stages .synth-run there; auth lives there.
const repoRoot = getDistRoot();

const adminAuthPath = resolveAuthPath("admin", env, repoRoot);
const userAuthPath = resolveAuthPath("user", env, repoRoot);
const betaAuthPath = resolveAuthPath("beta", env, repoRoot);

// repoRoot-anchored in lockstep with setup.ts (the .synth-run writer).
const stagingDir = path.resolve(repoRoot, `.synth-run/${repoName}`);

// Specs that must run after every other project (they change shared state).
const LAST_SPECS = /.*\.last\.spec\.ts$/;

// Inline JSONL Reporter
class JSONLReporter implements Reporter {
  async onTestEnd(test: TestCase, result: PlaywrightTestResult) {
    try {
      const environment = (process.env.E2E_ENVIRONMENT || "local") as any;
      const testTitle = test.titlePath().slice(1).join(" › ");
      const testFile =
        test.location.file
          .split(`/.synth-run/${repoName}/`)[1]
          ?.replace(/\.spec\.ts$/, "") ||
        path.basename(test.location.file, ".spec.ts");

      let status: "passed" | "failed" | "skipped";
      if (result.status === "passed") status = "passed";
      else if (result.status === "skipped") status = "skipped";
      else status = "failed";

      const screenshot = result.attachments.find(
        (a) => a.name === "screenshot" || a.contentType?.startsWith("image/"),
      )?.path;
      const trace = result.attachments.find(
        (a) => a.name === "trace" || a.contentType?.includes("zip"),
      )?.path;

      await resultWriter.writeResult({
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment,
        test: `${testFile} › ${testTitle}`,
        status,
        duration: result.duration,
        user: process.env.USER || os.userInfo().username || "unknown",
        error: result.error?.message,
        screenshot,
        trace,
        metadata: {
          browser: test.parent.project()?.name,
          retries: result.retry,
        },
      });
    } catch (error) {
      console.warn(
        `[JSONL Reporter] Failed to write result: ${(error as Error).message}`,
      );
    }
  }
}

export default defineConfig({
  testDir: stagingDir,

  globalSetup: path.resolve(__dirname, "./global-setup.ts"),
  globalTeardown: path.resolve(__dirname, "./global-teardown.ts"),

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: [
    ["html", { outputFolder: distPath("playwright-report") }],
    ["list"],
  ],

  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
    actionTimeout: 10000,
    navigationTimeout: 60000,
  },

  projects: [
    // Regular tests (no saved auth)
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [
        /.*user.*\.spec\.ts$/,
        /.*admin.*\.spec\.ts$/,
        /.*beta.*\.spec\.ts$/,
        LAST_SPECS,
      ],
    },

    // Admin tests (saved admin session)
    {
      name: "chromium-admin",
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthPath,
      },
      testMatch: /.*admin.*.spec.ts/,
    },

    // User tests (saved user session)
    {
      name: "chromium-user",
      use: {
        ...devices["Desktop Chrome"],
        storageState: userAuthPath,
      },
      testMatch: /.*user.*\.spec\.ts$/,
    },

    // Beta tests (saved beta session) — restricted-access user
    {
      name: "chromium-beta",
      use: {
        ...devices["Desktop Chrome"],
        storageState: betaAuthPath,
      },
      testMatch: /.*beta.*\.spec\.ts$/,
    },

    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: [LAST_SPECS, /.*beta.*\.spec\.ts$/],
    },

    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: [LAST_SPECS, /.*beta.*\.spec\.ts$/],
    },

    // *.last.spec.ts — runs AFTER all others complete
    {
      name: "chromium-last",
      use: { ...devices["Desktop Chrome"] },
      testMatch: LAST_SPECS,
      dependencies: [
        "chromium",
        "chromium-admin",
        "chromium-user",
        "chromium-beta",
        "firefox",
        "webkit",
      ],
    },
  ],

  timeout: 60000,
  expect: { timeout: 10000 },
  outputDir: distPath("test-results"),
});
