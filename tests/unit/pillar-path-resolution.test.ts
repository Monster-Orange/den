/**
 * Pillar Config Path Resolution Tests
 *
 * Reads the actual string literals from each playwright config and verifies
 * they resolve to the correct project-root directories.
 *
 * These tests catch the class of bug we hit during the src/ restructure:
 *   - outputFolder: "../../playwright-report"  →  wrote to src/playwright-report  (depth -1)
 *   - storageState: "../../playwright/.auth/…" →  looked in src/playwright/.auth  (depth -1)
 *   - CLI building testPath = "integration/"   →  directory no longer exists
 *
 * If any config's depth is wrong, the resolved path won't equal the expected
 * root-level path and the test will fail with a clear diff.
 */

import { describe, it, expect } from "@jest/globals";
import { readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";

const ROOT = process.cwd();

/** Resolve a relative path as if it came from inside the given config file */
function fromConfig(configRelPath: string, relTarget: string): string {
  return resolve(join(ROOT, dirname(configRelPath)), relTarget);
}

/** Extract first capture group from a regex applied to a config file's source */
function extract(configRelPath: string, pattern: RegExp): string {
  const src = readFileSync(join(ROOT, configRelPath), "utf-8");
  const m = src.match(pattern);
  if (!m) throw new Error(`Pattern ${pattern} not found in ${configRelPath}`);
  return m[1];
}

// ─── Expected root-level paths ───────────────────────────────────────────────
const REPORT_DIR = join(ROOT, "playwright-report");
const RESULTS_DIR = join(ROOT, "test-results");
const AUTH_DIR = join(ROOT, "playwright", ".auth");

// ─── outputFolder / outputDir ─────────────────────────────────────────────────
describe("pillar configs: output paths resolve to project root", () => {
  it("browser outputFolder → <root>/playwright-report", () => {
    const rel = extract(
      "src/pillars/browser/playwright.config.ts",
      /outputFolder:\s*["']([^"']+)["']/,
    );
    expect(fromConfig("src/pillars/browser/playwright.config.ts", rel)).toBe(
      REPORT_DIR,
    );
  });

  it("browser outputDir → <root>/test-results", () => {
    const rel = extract(
      "src/pillars/browser/playwright.config.ts",
      /outputDir:\s*["']([^"']+)["']/,
    );
    expect(fromConfig("src/pillars/browser/playwright.config.ts", rel)).toBe(
      RESULTS_DIR,
    );
  });

  it("api outputFolder → <root>/playwright-report", () => {
    const rel = extract(
      "src/pillars/api/playwright.config.ts",
      /PLAYWRIGHT_HTML_REPORT\s*\|\|\s*["']([^"']+)["']/,
    );
    expect(fromConfig("src/pillars/api/playwright.config.ts", rel)).toBe(
      REPORT_DIR,
    );
  });

  it("smoke outputFolder → <root>/playwright-report", () => {
    const rel = extract(
      "src/pillars/smoke/playwright.config.ts",
      /PLAYWRIGHT_HTML_REPORT\s*\|\|\s*["']([^"']+)["']/,
    );
    expect(fromConfig("src/pillars/smoke/playwright.config.ts", rel)).toBe(
      REPORT_DIR,
    );
  });

  it("smoke-all outputFolder → <root>/playwright-report", () => {
    const rel = extract(
      "src/pillars/smoke/playwright-all.config.ts",
      /PLAYWRIGHT_HTML_REPORT\s*\|\|\s*["']([^"']+)["']/,
    );
    expect(fromConfig("src/pillars/smoke/playwright-all.config.ts", rel)).toBe(
      REPORT_DIR,
    );
  });
});

// ─── staging dir ─────────────────────────────────────────────────────────────
describe("pillar configs: staging dir resolves to project root", () => {
  it("browser stagingDir is anchored at the repo root, never process.cwd()", () => {
    const src = readFileSync(
      join(ROOT, "src/pillars/browser/playwright.config.ts"),
      "utf-8",
    );
    // Must use the repoRoot anchor (cwd audit): setup.ts writes .synth-run at
    // the den root, so the reader must resolve the same place from any cwd.
    expect(src).toMatch(/stagingDir\s*=\s*path\.resolve\(repoRoot/);
    expect(src).toMatch(
      /repoRoot\s*=\s*path\.resolve\(__dirname,\s*["']\.\.\/\.\.\/\.\.["']\)/,
    );
    expect(src).not.toMatch(/stagingDir\s*=\s*path\.resolve\(process\.cwd\(\)/);
  });
});

// ─── storageState / auth paths ────────────────────────────────────────────────
describe("pillar configs: auth paths resolve to project root", () => {
  it("browser storageState base → <root>/playwright/.auth", () => {
    // The auth path moved out of playwright.config.ts into the shared
    // resolveAuthPath() helper (commit b60dea3, "extract playwright-env
    // helper"): resolve(repoRoot, `playwright/.auth/${role}-${env}.json`).
    // Assert that repoRoot-relative base resolves to <root>/playwright/.auth.
    const rel = extract(
      "src/shared/environment/playwright-env.ts",
      /resolve\(repoRoot,\s*`(playwright\/\.auth)\//,
    );
    expect(resolve(ROOT, rel)).toBe(AUTH_DIR);
  });
});

// ─── globalSetup paths point to existing files ───────────────────────────────
describe("pillar configs: globalSetup files exist", () => {
  it("api globalSetup exists", () => {
    const rel = extract(
      "src/pillars/api/playwright.config.ts",
      /globalSetup:\s*path\.resolve\(\s*getDistRoot\(\),\s*["']([^"']+)["'],?\s*\)/s,
    );
    expect(existsSync(join(ROOT, rel))).toBe(true);
  });

  it("smoke globalSetup exists", () => {
    const rel = extract(
      "src/pillars/smoke/playwright.config.ts",
      /globalSetup:\s*path\.resolve\(PROJECT_ROOT,\s*["']([^"']+)["']\)/,
    );
    expect(existsSync(join(ROOT, rel))).toBe(true);
  });

  it("smoke-all globalSetup exists", () => {
    const rel = extract(
      "src/pillars/smoke/playwright-all.config.ts",
      /globalSetup:\s*path\.resolve\(\s*PROJECT_ROOT,\s*["']([^"']+)["'],?\s*\)/s,
    );
    expect(existsSync(join(ROOT, rel))).toBe(true);
  });
});

// ─── CLI hard-coded paths exist ───────────────────────────────────────────────
describe("CLI test-runner: hard-coded paths exist", () => {
  const TEST_RUNNER = "src/ui/cli/test-runner.ts";

  it("browser setup.ts path exists", () => {
    const rel = extract(
      TEST_RUNNER,
      /["'](src\/pillars\/browser\/setup\.ts)["']/,
    );
    expect(existsSync(join(ROOT, rel))).toBe(true);
  });

  it("browser playwright.config.ts path exists", () => {
    // Appears as --config=src/pillars/browser/playwright.config.ts
    const rel = extract(
      TEST_RUNNER,
      /--config=?(src\/pillars\/browser\/playwright\.config\.ts)/,
    );
    expect(existsSync(join(ROOT, rel))).toBe(true);
  });

  it("api playwright.config.ts path exists", () => {
    const rel = extract(
      TEST_RUNNER,
      /["'](src\/pillars\/api\/playwright\.config\.ts)["']/,
    );
    expect(existsSync(join(ROOT, rel))).toBe(true);
  });

  it("perf suites resolve under the distribution, not an engine path", () => {
    const src = readFileSync(join(ROOT, TEST_RUNNER), "utf-8");
    expect(src).toMatch(/getPerfTestFile\(/);
    expect(src).not.toMatch(/src\/pillars\/perf\/tests/);
  });
});
