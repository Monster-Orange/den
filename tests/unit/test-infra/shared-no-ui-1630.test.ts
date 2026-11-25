import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");

const FIXED = [
  "src/shared/alerts.ts",
  "src/shared/edge/address-check.ts",
  "src/shared/edge/address-words.ts",
  "src/shared/gates/browser-container.ts",
];

function uiImports(file: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, file), "utf-8");
  const out: string[] = [];
  const re = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    const target = path.resolve(path.dirname(path.join(ROOT, file)), m[1]);
    const rel = path.relative(ROOT, target).split(path.sep).join("/");
    if (m[1].startsWith(".") && rel.startsWith("src/ui/")) out.push(m[1]);
  }
  return out;
}

describe("shared files import nothing from src/ui", () => {
  it.each(FIXED)("%s", (file) => {
    expect(uiImports(file)).toEqual([]);
  });

  it("src/shared/ui-language.ts holds the UI's language list, and the old path only re-exports it", () => {
    expect(fs.existsSync(path.join(ROOT, "src/shared/ui-language.ts"))).toBe(
      true,
    );
    expect(
      fs.readFileSync(path.join(ROOT, "src/ui/server/ui-language.ts"), "utf-8"),
    ).toBe('export * from "../../shared/ui-language.js";\n');
  });
});
