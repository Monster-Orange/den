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
import {
  hasVisualTag,
  pinnedChromium,
  readVisualEnv,
  visualRecordOf,
} from "../../../src/shared/gates/visual.js";

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

  it("CI's visual job runs the same tagged tests the gate reads (scripts/visual-tests.mjs)", () => {
    const listed = execFileSync("node", ["scripts/visual-tests.mjs"], {
      cwd: ROOT,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean);
    const tagged = browserTests()
      .filter((f) => hasVisualTag(fs.readFileSync(path.join(ROOT, f), "utf-8")))
      .sort();
    expect(listed).toEqual(tagged);
    expect(listed).toHaveLength(3);
  });

  it("the rule catches a new one without the tag", () => {
    const text =
      "/** A new parity test. */\nconst CAPTURE = process.env.DEN_UI_CAPTURE_NEW === '1';\n";
    expect(COMPARES_STORED.test(text) && !hasVisualTag(text)).toBe(true);
  });
});

describe("each tag names the record of where its references were taken", () => {
  const tagged = () =>
    browserTests().filter((f) =>
      hasVisualTag(fs.readFileSync(path.join(ROOT, f), "utf-8")),
    );

  it("every tag names a record that is there, taken on CI's browser: linux/amd64, the pinned Chromium build", () => {
    const pinned = pinnedChromium(ROOT);
    expect(pinned).toBeDefined();
    for (const f of tagged()) {
      const rec = visualRecordOf(fs.readFileSync(path.join(ROOT, f), "utf-8"));
      expect({ f, rec: !!rec }).toEqual({ f, rec: true });
      const env = readVisualEnv(path.join(ROOT, rec!));
      expect({ f, env: typeof env }).toEqual({ f, env: "object" });
      if (typeof env === "string") continue;
      expect({ rec, platform: env.platform, chromium: env.chromium }).toEqual({
        rec,
        platform: "linux/amd64",
        chromium: pinned,
      });
      expect(Object.keys(env.fonts).length).toBeGreaterThan(0);
    }
  });

  it("the references' own notes of their browser agree with their record", () => {
    const build = (ua: string) => /HeadlessChrome\/([\d.]+)/.exec(ua)?.[1];
    // The shell parity fixture keeps its browser's user agent in __env.
    const shell = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "tests/unit/den-ui/fixtures/den-shell-baseline.json"),
        "utf-8",
      ),
    ) as { __env: string };
    const fixtures = readVisualEnv(
      path.join(ROOT, "tests/unit/den-ui/fixtures/visual-env.json"),
    );
    expect(typeof fixtures).toBe("object");
    expect(build(shell.__env)).toBe(
      (fixtures as { chromium: string }).chromium,
    );
    // The nav references keep theirs in env.userAgent, chromium files only.
    const navRec = readVisualEnv(
      path.join(ROOT, "packages/den-ui/inventory/reference/visual-env.json"),
    );
    expect(typeof navRec).toBe("object");
    const dir = path.join(ROOT, "packages/den-ui/inventory/reference");
    for (const f of fs
      .readdirSync(dir)
      .filter((n) => /-chromium-\d+\.json$/.test(n))) {
      const ref = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as {
        env: { userAgent: string };
      };
      expect({ f, build: build(ref.env.userAgent) }).toEqual({
        f,
        build: (navRec as { chromium: string }).chromium,
      });
    }
  });
});
