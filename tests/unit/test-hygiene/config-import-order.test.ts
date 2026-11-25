/**
 * Issue 1356: a test file that sets DEN_ROOT and calls one of den-config's
 * writers must import den-config dynamically, after setting it. den-config
 * resolves its paths once, when it loads (ROOT, USER_CONFIG_PATH), so a
 * static import writes wherever the root resolved first: once, another
 * checkout's config/local/user.yml.
 *
 * Reads are fine (product() re-resolves the root); only the writers are
 * flagged. The write guard (write-guard.ts) catches the rest at run time.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const WRITERS = /\b(write[A-Z]\w*Config|setUser[A-Z]\w*)\s*\(/;
const SETS_ROOT = /process\.env\.DEN_ROOT\s*=(?!=)/;
const STATIC_CONFIG =
  /^import\s[^;]*?from\s+["'][^"']*\/den-config(\.js)?["']/m;

/** Why `src` (a test file's text) is flagged, or null. */
export function importOrderProblem(src: string): string | null {
  if (!SETS_ROOT.test(src) || !WRITERS.test(src)) return null;
  if (!STATIC_CONFIG.test(src)) return null;
  return 'sets DEN_ROOT and calls a den-config writer, but imports den-config statically: set DEN_ROOT first, then `await import(".../den-config.js")`';
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "fixtures") testFiles(p, out);
    } else if (/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("den-config import order (issue 1356)", () => {
  it("flags a static import with a writer, and passes a dynamic one or a read", () => {
    const writer = `import { setUserAgentSandbox } from "../../src/shared/den-config.js";
beforeAll(() => { process.env.DEN_ROOT = tmp; });
it("x", () => setUserAgentSandbox("bo", false));`;
    expect(importOrderProblem(writer)).toMatch(/imports den-config statically/);
    const dynamic = `beforeAll(async () => { process.env.DEN_ROOT = tmp;
  ({ setUserAgentSandbox } = await import("../../src/shared/den-config.js")); });
it("x", () => setUserAgentSandbox("bo", false));`;
    expect(importOrderProblem(dynamic)).toBeNull();
    const read = `import { readAgentsConfig } from "../../src/shared/den-config.js";
process.env.DEN_ROOT = dist; readAgentsConfig();`;
    expect(importOrderProblem(read)).toBeNull();
  });

  it("no test file in the repo does it", () => {
    const bad = testFiles(path.join(ROOT, "tests"))
      .map((f) => ({ f, why: importOrderProblem(fs.readFileSync(f, "utf-8")) }))
      .filter((x) => x.why)
      .map((x) => `${path.relative(ROOT, x.f)}: ${x.why}`);
    expect(bad).toEqual([]);
  });
});
