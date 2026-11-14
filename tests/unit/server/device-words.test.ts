/**
 * 0.4.45: a linked device's name in Settings › Access is in the page's
 * language. The server names it in English ("Chrome on Linux"); the page
 * says it with its own words, keeping the browser's and the system's
 * names as they are.
 */
import { describe, expect, it } from "@jest/globals";
import { deviceWords } from "../../../src/ui/server/public/settings-registry.js";

const tr = (k: string, _en: string, v?: Record<string, string>) =>
  `[${k}${v ? ` ${Object.values(v).join("|")}` : ""}]`;

describe("a device's name, in the page's words", () => {
  it("<browser> on <system>, a browser on <system>, unknown", () => {
    expect(deviceWords("Chrome on Linux", tr)).toBe(
      "[set.ui.deviceOn Chrome|Linux]",
    );
    expect(deviceWords("A browser on macOS", tr)).toBe(
      "[set.ui.aBrowserOn macOS]",
    );
    expect(deviceWords("Unknown browser", tr)).toBe("[set.ui.unknownBrowser]");
    expect(deviceWords("", tr)).toBe("[set.ui.unknownBrowser]");
    // A browser alone (no system known) is a name.
    expect(deviceWords("curl", tr)).toBe("curl");
  });
});
