import { describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";

// Neutral example names (acme, shop, …) belong in tests, docs and examples.
// Capitalised, they read as a product name: in src/ they leak into banners,
// page titles and bot names that every distribution shows its users.
const FIXTURE_NAMES = /\b(Shop|Acme|Globex)\b/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|js|mjs|cjs|html|css)$/.test(e.name) &&
      !/\.test\.ts$/.test(e.name)
      ? [p]
      : [];
  });
}

describe("product text", () => {
  it("never shows an example name as a product name", () => {
    const hits = files(path.resolve("src")).flatMap((f) =>
      fs
        .readFileSync(f, "utf-8")
        .split("\n")
        .map((line, i) => ({ f, i, line }))
        // Comments may use example names to explain config (e.g. "Acme Dev").
        .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .filter(({ line }) => FIXTURE_NAMES.test(line))
        .map(({ f, i }) => `${path.relative(process.cwd(), f)}:${i + 1}`),
    );
    expect(hits).toEqual([]);
  });
});
