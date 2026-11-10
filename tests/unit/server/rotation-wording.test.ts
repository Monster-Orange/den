/**
 * Rotation's Settings wording (nits from the 0.4.24 gate): "Pick an agent",
 * never "Pick a agent"; an install select's inherit option is short
 * ("inherit (auto)"), its source in the tag beside it.
 */
import { describe, expect, it } from "@jest/globals";
import {
  rotationHtml,
  withArticle,
} from "../../../src/ui/server/public/settings-registry.js";

describe("rotation wording", () => {
  it("an before a vowel, a before a consonant", () => {
    expect(withArticle("agent")).toBe("an agent");
    expect(withArticle("persona")).toBe("a persona");
    expect(withArticle("workspace")).toBe("a workspace");
  });

  it("the inherit option names the value only; the tag says where it comes from", () => {
    const html = rotationHtml({
      defaults: { on_due: "auto" },
      org: {},
      install: {},
      overrides: {},
    });
    expect(html).toContain(">inherit (auto)</option>");
    expect(html).not.toContain("inherit (default:");
  });
});
