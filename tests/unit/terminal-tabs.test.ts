import { describe, expect, it } from "@jest/globals";
import {
  resolveTerminalApp,
  shellQuote,
} from "../../src/shared/terminal/tabs.js";

describe("terminal tab helpers", () => {
  it("shell-quotes paths safely for tab commands", () => {
    expect(shellQuote("/tmp/repo with ' quote")).toBe(
      "'/tmp/repo with '\\'' quote'",
    );
  });

  it("refuses Ghostty tab mode with a clear error", () => {
    expect(() => resolveTerminalApp("ghostty")).toThrow(/Ghostty/);
  });

  it("accepts supported terminal keys", () => {
    expect(resolveTerminalApp("iterm2")).toBe("iterm2");
    expect(resolveTerminalApp("terminal")).toBe("terminal");
  });
});
