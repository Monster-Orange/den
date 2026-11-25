/**
 * Issue 1527: every browser test that compares a render against a stored
 * reference carries `@visual-reference` in its top comment, so the gate
 * sends it only to a box serving its references' Chromium build.
 *
 * Such a test writes its reference with a capture switch
 * (DEN_UI_…CAPTURE…) or reads the nav inventory's stored references. A
 * new one without the tag fails here.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { hasVisualTag } from "../../../src/shared/gates/visual.js";

const ROOT = path.resolve(__dirname, "..", "..", "..");

/** What marks a test as comparing against a stored reference. */
const COMPARES_STORED =
  /\bDEN_UI_\w*CAPTURE\w*\b|inventory\/reference\b|\breferenceFile\(/;

function browserTests(): string[] {
  return execFileSync("git", ["ls-files", "tests/**/*.browser.test.ts"], {
    cwd: ROOT,
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);
}

describe("visual-reference tests are tagged", () => {
  it("every browser test that compares against a stored reference carries the tag", () => {
    const untagged = browserTests().filter((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), "utf-8");
      return COMPARES_STORED.test(text) && !hasVisualTag(text);
    });
    expect(untagged).toEqual([]);
  });

  it("the three that compare stored references today are found and tagged", () => {
    for (const f of [
      "tests/unit/den-ui/shell-kit-parity.browser.test.ts",
      "tests/unit/den-ui/nav-inventory.browser.test.ts",
      "tests/unit/den-ui/kit-button-menu-row.browser.test.ts",
    ]) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf-8");
      expect({ f, compares: COMPARES_STORED.test(text) }).toEqual({
        f,
        compares: true,
      });
      expect({ f, tagged: hasVisualTag(text) }).toEqual({ f, tagged: true });
    }
  });

  it("the rule catches a new one without the tag", () => {
    const text =
      "/** A new parity test. */\nconst CAPTURE = process.env.DEN_UI_CAPTURE_NEW === '1';\n";
    expect(COMPARES_STORED.test(text) && !hasVisualTag(text)).toBe(true);
  });
});
