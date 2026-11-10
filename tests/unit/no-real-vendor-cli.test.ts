/**
 * No test reaches this machine's real launchctl, gh or vendor CLIs, even
 * through a spawn that passes no `env` (it then uses the real process
 * environment, not the test's sandboxed process.env, which setup.ts's PATH
 * change alone never reached). jest's globalSetup puts the inert stand-ins
 * first on the real PATH, so every worker inherits them.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";

describe("the real PATH every spawn inherits", () => {
  it.each(["launchctl", "gh", "claude", "codex", "gemini", "grok"])(
    "%s is an inert stand-in",
    (bin) => {
      const r = spawnSync("sh", ["-c", `command -v ${bin}`], {
        encoding: "utf-8",
      });
      expect(r.stdout.trim()).toMatch(/\/no-vendor-cli\//);
    },
  );
});
