/**
 * The header's version pill names the running build, prerelease suffix and
 * all: a 0.3.0-dev.5 build says "v0.3.0-dev.5", not the changelog's "0.3.0".
 */
import { describe, expect, it } from "@jest/globals";
import { versionLabel } from "../../../src/ui/server/public/version-label.js";

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
