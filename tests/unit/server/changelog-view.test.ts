/**
 * The version pop-up shows the newest release only, with one button that
 * lists every earlier version in the same pop-up (and collapses back).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
// Issue 95: What's new is the UI kit's (den-ui whatsnew.js).
import { changelogView } from "../../../packages/den-ui/src/whatsnew.js";

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

  it("What's new renders through it and opens collapsed", () => {
    // Issue 95: the pop-up is the kit's (den-ui whatsnew.js); header.js
    // opens it.
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../packages/den-ui/src/whatsnew.js"),
      "utf-8",
    );
    expect(src).toMatch(/changelogView\(entries, showAll\)/);
    expect(src).toMatch(
      /export function openWhatsNew\(\) \{[\s\S]{0,900}?\n  showAll = false;/,
    );
    expect(src).toMatch(/aria-expanded/);
    // Issue 793: the kit's dialog frame (a panel), not an overlay of its
    // own. The toggle is in the frame's fixed footer, so it is visible
    // however long the newest entry; FB (den#81): Report first there, as in
    // every pop-up (the frame puts `report` before the actions).
    expect(src).toMatch(/dialogHtml\(\{\s*kind: "panel",\s*id: "cl-overlay",/);
    expect(src).toMatch(
      /report: report \|\| "",[\s\S]{0,200}actions: \[[\s\S]{0,120}type: "button",[\s\S]{0,160}id: "cl-more"/,
    );
    expect(src).not.toMatch(/cl-footer|cl-box/);
    const header = fs.readFileSync(
      path.resolve(__dirname, "../../../src/ui/server/public/header.js"),
      "utf-8",
    );
    expect(header).toMatch(
      /window\.openChangelog = function \(\) \{\s*DenUI\.whatsNew\.open\(\);/,
    );
  });

  it("is served to the browser", () => {
    const assets = fs.readFileSync(
      path.resolve(__dirname, "../../../src/ui/server/ui-assets.ts"),
      "utf-8",
    );
    expect(assets).toMatch(/"whatsnew\.js"/);
  });
});
