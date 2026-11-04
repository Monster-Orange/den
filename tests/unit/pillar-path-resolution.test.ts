/**
 * Pillar Config Path Resolution Tests
 *
 * Reads the playwright configs and the CLI test runner and checks how each
 * path is anchored. Two roots (src/shared/engine.ts):
 *   - Den's own files (global setup, configs, pillar scripts) resolve from the
 *     engine root via enginePath() — node_modules/@monster-orange/den in a
 *     distribution.
 *   - Outputs (playwright-report, test-results, reports/, .synth-run, auth)
 *     resolve from the distribution root via distPath()/getDistRoot().
 * A relative path ("../../../playwright-report") resolves against the config
 * file, i.e. inside the engine: in a distribution that is node_modules.
 */

import { describe, it, expect } from "@jest/globals";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");

const CONFIGS = [
  "src/pillars/api/playwright.config.ts",
  "src/pillars/browser/playwright.config.ts",
  "src/pillars/smoke/playwright.config.ts",
  "src/pillars/smoke/playwright-all.config.ts",
  "src/pillars/smoke/playwright-global.config.ts",
];

// ─── outputs: the distribution root ──────────────────────────────────────────
describe("pillar configs: outputs resolve from the distribution root", () => {
  it.each(CONFIGS)("%s has no config-relative output path", (cfg) => {
    expect(read(cfg)).not.toMatch(
      /["']\.\.\/(\.\.\/)*(playwright-report|test-results|reports)/,
    );
  });

  it.each(CONFIGS)("%s writes its HTML report via distPath", (cfg) => {
    expect(read(cfg)).toMatch(
      /outputFolder:[\s\S]{0,80}distPath\("playwright-report"\)/,
    );
  });

  it("browser outputDir is the distribution's test-results", () => {
    expect(read("src/pillars/browser/playwright.config.ts")).toMatch(
      /outputDir:\s*distPath\("test-results"\)/,
    );
  });

  it("browser stagingDir is anchored at the distribution root, never cwd or __dirname", () => {
    const src = read("src/pillars/browser/playwright.config.ts");
    // setup.ts writes .synth-run at the distribution root; the reader must
    // resolve the same place from any cwd and from inside node_modules.
    expect(src).toMatch(/repoRoot\s*=\s*getDistRoot\(\)/);
    expect(src).toMatch(/stagingDir\s*=\s*path\.resolve\(repoRoot/);
    expect(src).not.toMatch(
      /path\.resolve\(__dirname,\s*["']\.\.\/\.\.\/\.\.["']/,
    );
    expect(src).not.toMatch(/stagingDir\s*=\s*path\.resolve\(process\.cwd\(\)/);
  });

  it("auth files resolve from the repo root handed in", () => {
    expect(read("src/shared/environment/playwright-env.ts")).toMatch(
      /resolve\(repoRoot,\s*`playwright\/\.auth\//,
    );
  });
});

// ─── Den's own files: the engine root ────────────────────────────────────────
const engineLiterals = (rel: string): string[] =>
  [...read(rel).matchAll(/(?:enginePath|tsxCommand)\(\s*"(src\/[^"$]+)"/g)].map(
    (m) => m[1],
  );

describe("pillar configs: global setup files are engine files that exist", () => {
  it.each([
    "src/pillars/api/playwright.config.ts",
    "src/pillars/smoke/playwright.config.ts",
    "src/pillars/smoke/playwright-all.config.ts",
    "src/pillars/smoke/playwright-global.config.ts",
  ])("%s", (cfg) => {
    const src = read(cfg);
    expect(src).toMatch(/globalSetup:\s*enginePath\(/);
    const files = engineLiterals(cfg);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(existsSync(join(ROOT, f))).toBe(true);
  });
});

describe("CLI test-runner: engine scripts", () => {
  const TEST_RUNNER = "src/ui/cli/test-runner.ts";

  it("never runs through npx or a cwd-relative src/ path", () => {
    const src = read(TEST_RUNNER);
    expect(src).not.toMatch(/"npx"/);
    expect(src).not.toMatch(/\["tsx",/);
    expect(src).not.toMatch(/"--config=src\//);
  });

  it("every engine path it names exists", () => {
    const files = engineLiterals(TEST_RUNNER);
    expect(files).toEqual(
      expect.arrayContaining([
        "src/pillars/browser/setup.ts",
        "src/pillars/api/playwright.config.ts",
        "src/pillars/smoke/setup.ts",
        "src/pillars/perf/run.ts",
      ]),
    );
    for (const f of files) expect(existsSync(join(ROOT, f))).toBe(true);
  });

  it("perf suites resolve under the distribution, not an engine path", () => {
    const src = read(TEST_RUNNER);
    expect(src).toMatch(/getPerfTestFile\(/);
    expect(src).not.toMatch(/src\/pillars\/perf\/tests/);
  });
});
