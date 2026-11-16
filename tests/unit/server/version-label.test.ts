/**
 * The header's version pill names the running build, prerelease suffix and
 * all: a 0.3.0-dev.5 build says "v0.3.0-dev.5", not the changelog's "0.3.0".
 */
import { describe, expect, it } from "@jest/globals";
// Issue 95: the version chip is the UI kit's (den-ui version.js).
import { versionLabel } from "../../../packages/den-ui/src/version.js";

describe("versionLabel", () => {
  const changelog = [{ version: "0.3.0" }, { version: "0.2.2" }];
  it("shows the running version with its prerelease suffix", () => {
    expect(versionLabel("0.3.0-dev.5", changelog)).toBe("v0.3.0-dev.5");
  });
  it("falls back to the changelog's newest version", () => {
    expect(versionLabel(null, changelog)).toBe("v0.3.0");
    expect(versionLabel(undefined, [])).toBeNull();
  });
});
