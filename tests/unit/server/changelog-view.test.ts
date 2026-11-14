/**
 * The version pop-up shows the newest release only, with one button that
 * lists every earlier version in the same pop-up (and collapses back).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { changelogView } from "../../../src/ui/server/public/changelog-view.js";

const entries = [
  { version: "0.3.0" },
  { version: "0.2.4" },
  { version: "0.2.3" },
];

describe("changelogView", () => {
  it("shows only the newest release by default", () => {
    const v = changelogView(entries, false);
    expect(v.shown.map((e) => e.version)).toEqual(["0.3.0"]);
    expect(v.toggle).toEqual({
      label: "Show all versions (2 earlier)",
      expanded: false,
    });
  });

  it("lists every version when expanded, and offers to collapse", () => {
    const v = changelogView(entries, true);
    expect(v.shown.map((e) => e.version)).toEqual(["0.3.0", "0.2.4", "0.2.3"]);
    expect(v.toggle).toEqual({ label: "Show latest only", expanded: true });
  });

  it("singular wording for one earlier version; no button with none", () => {
    expect(changelogView(entries.slice(0, 2), false).toggle?.label).toBe(
      "Show all versions (1 earlier)",
    );
    expect(changelogView(entries.slice(0, 1), false).toggle).toBeNull();
    expect(changelogView([], false)).toEqual({ shown: [], toggle: null });
  });

  it("the header renders through it and opens collapsed", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../src/ui/server/public/header.js"),
      "utf-8",
    );
    expect(src).toMatch(/changelogView\(entries, _clShowAll\)/);
    expect(src).toMatch(
      /openChangelog = function \(\) \{\s*_clShowAll = false;/,
    );
    expect(src).toMatch(/aria-expanded/);
    // In the fixed footer, so it is visible however long the newest entry.
    // FB (den#81): Report first, as in every pop-up.
    expect(src).toMatch(
      /class="cl-footer">'[\s\S]{0,120}reportButton[\s\S]{0,120}<button type="button" class="cl-more-btn" id="cl-more"/,
    );
  });

  it("is served to the browser", () => {
    const assets = fs.readFileSync(
      path.resolve(__dirname, "../../../src/ui/server/ui-assets.ts"),
      "utf-8",
    );
    expect(assets).toMatch(/"\/changelog-view\.js"/);
  });
});
