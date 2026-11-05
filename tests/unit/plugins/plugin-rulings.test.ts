/**
 * PL-SPEC draft 4 §0 rulings on dev.7:
 * - rule 1 for themes: a den-theme.json's `author` is its maintainer; none
 *   is an error;
 * - a `den` range that excludes the running Den fails validate, naming it;
 * - a dev.2 lock entry with a file:// source warns in `list` (never fails).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { denRangeIssue } from "../../../src/shared/theme/contract.js";
import { validatePluginDir } from "../../../src/shared/plugins/manifest.js";
import { cmdPlugin } from "../../../src/ui/cli/plugin-command.js";
import { cmdTheme } from "../../../src/ui/cli/theme-command.js";

const ROOT = path.resolve(__dirname, "../../..");
const DEN_THEME = path.join(ROOT, "themes", "den");
let tmp: string;
const lines: string[] = [];
const log = (l: string) => lines.push(l);

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-rule-")));
  process.env.DEN_ENGINE_ROOT = ROOT;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A copy of the bundled den theme as plugins/<id>/, manifest patched. */
function themeDir(
  distRoot: string,
  id: string,
  patch: Record<string, unknown>,
): string {
  const dir = path.join(distRoot, "plugins", id);
  fs.cpSync(DEN_THEME, dir, { recursive: true });
  const f = path.join(dir, "den-theme.json");
  const m = { ...(JSON.parse(fs.readFileSync(f, "utf-8")) as object), id };
  for (const [k, v] of Object.entries(patch))
    if (v === undefined) delete (m as Record<string, unknown>)[k];
    else (m as Record<string, unknown>)[k] = v;
  fs.writeFileSync(f, JSON.stringify(m));
  return dir;
}

describe("rule 1 for a theme: author is the maintainer", () => {
  it("a den-theme.json with an author passes; without one it fails", () => {
    const d = fs.mkdtempSync(path.join(tmp, "d"));
    expect(validatePluginDir(themeDir(d, "with-author", {})).ok).toBe(true);
    const r = validatePluginDir(
      themeDir(d, "no-author", { author: undefined }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          at: "/author",
          message: expect.stringMatching(/maintainer/),
        }),
      ]),
    );
  });

  it("theme new sets the author, so a new theme validates", async () => {
    const d = fs.mkdtempSync(path.join(tmp, "d"));
    expect(await cmdTheme(["new", "team-x"], { distRoot: d, log })).toBe(0);
    const m = JSON.parse(
      fs.readFileSync(
        path.join(d, "plugins", "team-x", "den-theme.json"),
        "utf-8",
      ),
    ) as { author?: string };
    expect(m.author?.trim()).toBeTruthy();
    expect(validatePluginDir(path.join(d, "plugins", "team-x")).ok).toBe(true);
  });
});

describe("den range", () => {
  it("is checked against the running Den, prereleases included", () => {
    expect(denRangeIssue(undefined, "0.3.0-dev.7")).toBeNull();
    expect(denRangeIssue(">=0.3.0-0 <0.4.0", "0.3.0-dev.7")).toBeNull();
    expect(denRangeIssue(">=0.4.0", "0.3.0-dev.7")).toMatch(
      /needs Den >=0.4.0; this is 0.3.0-dev.7/,
    );
    expect(denRangeIssue("not a range", "0.3.0")).toMatch(/not a semver/);
  });

  it("validate fails a plugin whose range excludes this Den, naming it", () => {
    const d = fs.mkdtempSync(path.join(tmp, "d"));
    const r = validatePluginDir(themeDir(d, "future", { den: ">=99.0.0" }));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.message).join()).toMatch(/needs Den >=99/);
  });
});

describe("a dev.2 file:// lock entry", () => {
  it("list warns with the fix and does not fail because of it", async () => {
    const d = fs.mkdtempSync(path.join(tmp, "d"));
    fs.writeFileSync(
      path.join(d, "plugins.lock.json"),
      JSON.stringify({ plugins: {} }),
    );
    lines.length = 0;
    expect(await cmdPlugin(["list"], { distRoot: d, log })).toBe(0);
    const clean = lines.join("\n");
    // Now the same, plus a leftover entry (its dir present and matching
    // would need a real add; the warning is about the source alone).
    fs.writeFileSync(
      path.join(d, "plugins.lock.json"),
      JSON.stringify({
        plugins: {
          old: {
            id: "old",
            name: "Old",
            version: "1.0.0",
            source: "file:///Users/someone/themes//themes/old",
            ref: "old/v1.0.0",
            commit: "0".repeat(40),
            sha256: "0".repeat(64),
            kinds: ["theme"],
            approved_capabilities: [],
          },
        },
      }),
    );
    lines.length = 0;
    await cmdPlugin(["list"], { distRoot: d, log });
    const out = lines.join("\n");
    expect(out).toMatch(/old was added from file:\/\//);
    expect(out).toMatch(/re-add it from a remote, or make it a local plugin/);
    expect(clean).not.toMatch(/file:\/\//);
  });
});
