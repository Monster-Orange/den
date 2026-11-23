/**
 * Issue 786: the global test setup (tests/setup.ts) loads its modules in
 * every suite's registry before the suite's own jest.mock("fs"). A module
 * that writes files, loaded there, keeps the real fs: a suite that mocks
 * fs then writes for real (into the checkout's config/local). So the
 * setup's import graph never reaches a module that writes.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");
const WRITES =
  /\b(?:writeFileSync|writeFileAtomic|appendFileSync|renameSync|promises\.writeFile)\b/;

function graph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(
      /(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      const p = path.resolve(path.dirname(f), m[1]);
      const hit = [p.replace(/\.js$/, ".ts"), `${p}.ts`, p].find(
        (c) => /\.(ts|js|mjs)$/.test(c) && fs.existsSync(c),
      );
      if (hit) stack.push(hit);
    }
  }
  return [...seen].map((f) => path.relative(ROOT, f));
}

describe("the global test setup loads no module that writes files", () => {
  it("tests/setup.ts's import graph", () => {
    const files = graph(path.join(ROOT, "tests", "setup.ts"));
    expect(files.length).toBeGreaterThan(3);
    const writers = files.filter(
      (f) =>
        f.startsWith("src/") &&
        WRITES.test(fs.readFileSync(path.join(ROOT, f), "utf8")),
    );
    expect(writers).toEqual([]);
  });
});
