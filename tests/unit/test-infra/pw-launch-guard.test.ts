/**
 * Every test that drives a browser gets it from openBrowser()
 * (tests/unit/server/helpers/browser.ts), so DEN_PW_WS sends all of them
 * to a remote Playwright server. A test file that launches its own
 * browser would start one on this machine even with DEN_PW_WS set.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");
const TESTS = path.join(ROOT, "tests");
const HELPER = "tests/unit/server/helpers/browser.ts";

/**
 * Files that must launch a browser here, each with its reason. Empty:
 * every browser test can use a remote one.
 */
const MUST_LAUNCH_LOCALLY: Record<string, string> = {};

/** Starting or connecting a browser by hand, not through openBrowser(). */
const DIRECT =
  /\.launch\(|\blaunchPersistentContext\(|\blaunchServer\(|\bconnectOverCDP\(|exposeNetwork/;
/** Uses Playwright at run time (a type-only import doesn't count). */
const USES_PLAYWRIGHT =
  /import\(\s*["'](?:@playwright\/test|playwright)["']\s*\)|^import\s+(?!type\b)[^;]*from\s+["'](?:@playwright\/test|playwright)["']|require\(\s*["'](?:@playwright\/test|playwright)["']\s*\)/m;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") out.push(...files(p));
    } else if (/\.(?:[cm]?[jt]s)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("browser tests get their browser from openBrowser()", () => {
  const all = files(TESTS).map((f) => path.relative(ROOT, f));
  const self = path.relative(ROOT, __filename);

  it("no test file launches or connects a browser itself", () => {
    const offenders = all.filter((rel) => {
      if (rel === HELPER || rel === self) return false;
      if (rel in MUST_LAUNCH_LOCALLY) return false;
      const src = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      // A mocked Playwright (jest.mock) never starts a browser.
      if (/jest\.mock\(\s*["'](?:@playwright\/test|playwright)["']/.test(src))
        return false;
      return USES_PLAYWRIGHT.test(src) && DIRECT.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("every *.browser.test.ts uses openBrowser()", () => {
    const missing = all.filter(
      (rel) =>
        rel.endsWith(".browser.test.ts") &&
        !(rel in MUST_LAUNCH_LOCALLY) &&
        !/\bopenBrowser\(/.test(fs.readFileSync(path.join(ROOT, rel), "utf-8")),
    );
    expect(missing).toEqual([]);
  });

  it("the helper itself connects to DEN_PW_WS with loopback exposed", () => {
    const src = fs.readFileSync(path.join(ROOT, HELPER), "utf-8");
    expect(src).toMatch(/process\.env\.DEN_PW_WS/);
    expect(src).toMatch(/exposeNetwork:\s*"<loopback>"/);
  });
});
