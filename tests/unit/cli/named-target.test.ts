/**
 * B3: a remote service the user named directly is a failed command; one
 * reached through a workspace or app run is not.
 */
import { describe, expect, it } from "@jest/globals";
import { isNamedTarget } from "../../../src/ui/cli/named-target.js";

describe("isNamedTarget", () => {
  it("matches the address or the repo it belongs to", () => {
    expect(isNamedTarget("core", ["core"])).toBe(true);
    expect(isNamedTarget("core/api", ["core"])).toBe(true);
    expect(isNamedTarget("core/api", ["core/api"])).toBe(true);
  });

  it("does not match other services or prefixes of a name", () => {
    expect(isNamedTarget("core/api", ["core/web"])).toBe(false);
    expect(isNamedTarget("core-api", ["core"])).toBe(false);
    expect(isNamedTarget("core", ["core/api"])).toBe(false);
  });

  it("nothing named (workspace or app run) matches nothing", () => {
    expect(isNamedTarget("core", [])).toBe(false);
  });
});
