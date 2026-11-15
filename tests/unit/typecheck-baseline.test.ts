/**
 * den#145: tsconfig.typecheck.json's baseline (files the type check skips
 * for errors that predate it) only shrinks. The web server's and the CLI's
 * entry files were on it, so a missing import there passed the check.
 *
 * An entry on it now is one of those below, or names its reason and an
 * issue (`den#N`) in the comment right above it.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const FILE = path.join(__dirname, "../../tsconfig.typecheck.json");

/** The baseline as it stands: each is fixed, then deleted here. */
const KNOWN = [
  "src/pillars/api/playwright.config.ts",
  "src/pillars/browser/playwright.config.ts",
  "src/pillars/smoke/playwright.config.ts",
  "src/shared/auth/token-injection.ts",
  "src/pillars/browser/fixtures/index.ts",
];

/** Each baseline entry, with the comment lines right above it. */
function baseline(): { entry: string; comment: string }[] {
  const lines = fs.readFileSync(FILE, "utf-8").split("\n");
  const at = lines.findIndex((l) => /Baseline exclusions/.test(l));
  expect(at).toBeGreaterThan(0);
  const out: { entry: string; comment: string }[] = [];
  let comment: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const t = l.trim();
    if (t.startsWith("//")) comment.push(t);
    else if (/^"[^"]+",?$/.test(t)) {
      out.push({
        entry: t.replace(/^"|",?$/g, ""),
        comment: comment.join(" "),
      });
    } else if (t === "]") break;
    else if (t === "") comment = [];
  }
  return out;
}

describe("the type check's baseline (den#145)", () => {
  it("never takes back the web server's or the CLI's entry files, or the manifest schema", () => {
    const entries = baseline().map((b) => b.entry);
    for (const f of [
      "src/ui/server/index.ts",
      "src/ui/cli/index.ts",
      "src/shared/manifest/schema.ts",
      "src/shared/manifest/validate-manifest.ts",
      "src/shared/manifest/migrate-manifest.ts",
    ])
      expect(entries).not.toContain(f);
  });

  it("only shrinks: a new entry names its reason and an issue right above it", () => {
    const unexplained = baseline()
      .filter((b) => !KNOWN.includes(b.entry))
      .filter((b) => !/den#\d+/.test(b.comment))
      .map((b) => b.entry);
    expect(unexplained).toEqual([]);
  });
});
