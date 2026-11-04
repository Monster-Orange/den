/**
 * Pillar Structure Tests
 *
 * Verifies that all four pillars (api, browser, smoke, perf) have their key
 * files in the right locations after the pillars/ restructure.
 *
 * These tests run fast (no I/O, just existsSync) and catch:
 *   - Accidental file deletions
 *   - Mis-named or mis-moved config files
 *   - Missing setup/discover scripts
 *
 * For Playwright config *loading* validation (fixtures, globalSetup paths, etc.)
 * see `make preflight` step 4 which runs `playwright --list` as a dry-run.
 */

import { describe, it, expect } from "@jest/globals";
import { existsSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const p = (...parts: string[]) => join(ROOT, ...parts);

describe("pillars/api", () => {
  it("playwright.config.ts exists", () => {
    expect(existsSync(p("src/pillars/api/playwright.config.ts"))).toBe(true);
  });
  it("global-setup.ts exists", () => {
    expect(existsSync(p("src/pillars/api/global-setup.ts"))).toBe(true);
  });
  it("fixtures/index.ts exists", () => {
    expect(existsSync(p("src/pillars/api/fixtures/index.ts"))).toBe(true);
  });
  it("tests/ directory exists", () => {
    expect(existsSync(p("src/pillars/api/tests"))).toBe(true);
  });
  it("at least one spec file exists", () => {
    expect(existsSync(p("src/pillars/api/tests/health/health.spec.ts"))).toBe(
      true,
    );
  });
});

describe("pillars/browser", () => {
  it("playwright.config.ts exists", () => {
    expect(existsSync(p("src/pillars/browser/playwright.config.ts"))).toBe(
      true,
    );
  });
  it("setup.ts exists", () => {
    expect(existsSync(p("src/pillars/browser/setup.ts"))).toBe(true);
  });
  it("global-setup.ts exists", () => {
    expect(existsSync(p("src/pillars/browser/global-setup.ts"))).toBe(true);
  });
  it("fixtures/index.ts exists", () => {
    expect(existsSync(p("src/pillars/browser/fixtures/index.ts"))).toBe(true);
  });
});

describe("pillars/smoke", () => {
  it("playwright.config.ts exists", () => {
    expect(existsSync(p("src/pillars/smoke/playwright.config.ts"))).toBe(true);
  });
  it("playwright-all.config.ts exists", () => {
    expect(existsSync(p("src/pillars/smoke/playwright-all.config.ts"))).toBe(
      true,
    );
  });
  it("setup.ts exists", () => {
    expect(existsSync(p("src/pillars/smoke/setup.ts"))).toBe(true);
  });
  it("global-setup.ts exists", () => {
    expect(existsSync(p("src/pillars/smoke/global-setup.ts"))).toBe(true);
  });
  it("discover.ts exists", () => {
    expect(existsSync(p("src/pillars/smoke/discover.ts"))).toBe(true);
  });
});

describe("pillars/perf", () => {
  it("k6.config.js exists", () => {
    expect(existsSync(p("src/pillars/perf/k6.config.js"))).toBe(true);
  });
  it("run.ts harness exists", () => {
    expect(existsSync(p("src/pillars/perf/run.ts"))).toBe(true);
  });
  it("the engine ships no k6 suites (they come from the distribution)", () => {
    expect(existsSync(p("src/pillars/perf/tests"))).toBe(false);
  });
});

describe("pillars/journeys", () => {
  it("run.ts entrypoint exists", () => {
    expect(existsSync(p("src/pillars/journeys/run.ts"))).toBe(true);
  });
  it("discover.ts exists", () => {
    expect(existsSync(p("src/pillars/journeys/discover.ts"))).toBe(true);
  });
  it("spec/schema.ts exists", () => {
    expect(existsSync(p("src/pillars/journeys/spec/schema.ts"))).toBe(true);
  });
  it("runner.ts exists", () => {
    expect(existsSync(p("src/pillars/journeys/runner.ts"))).toBe(true);
  });
  it("report modules exist", () => {
    expect(existsSync(p("src/pillars/journeys/report/results.ts"))).toBe(true);
    expect(existsSync(p("src/pillars/journeys/report/junit.ts"))).toBe(true);
    expect(existsSync(p("src/pillars/journeys/report/friction.ts"))).toBe(true);
  });
});

describe("shared infrastructure", () => {
  it("shared/auth/api-token.ts exists", () => {
    expect(existsSync(p("src/shared/auth/api-token.ts"))).toBe(true);
  });
  it("shared/auth/headless-login.ts exists", () => {
    expect(existsSync(p("src/shared/auth/headless-login.ts"))).toBe(true);
  });
  it("shared/environment/env-selector.ts exists", () => {
    expect(existsSync(p("src/shared/environment/env-selector.ts"))).toBe(true);
  });
  it("config/environments/local.json exists", () => {
    expect(existsSync(p("config/environments/local.json"))).toBe(true);
  });
  it("config/environments/staging.json exists", () => {
    expect(existsSync(p("config/environments/staging.json"))).toBe(true);
  });
  it("config/environments/production.json exists", () => {
    expect(existsSync(p("config/environments/production.json"))).toBe(true);
  });
});
