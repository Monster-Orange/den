/**
 * No test reaches the developer's own apps or config (0.4.48). Test runs
 * opened sign-in tabs in a person's browser, and wrote this checkout's
 * config/local. tests/setup.ts now puts shims for `open`, `osascript`,
 * `xdg-open` and `x-www-browser` first on PATH (spawned CLIs inherit it):
 * each logs the call and fails, and the test file that made one fails.
 * A test file that changes the checkout's config/local fails too.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  clearTripwire,
  configLocalChanges,
  configLocalSnapshot,
  tripwireCalls,
} from "../tripwire.js";

describe("the opener tripwire", () => {
  it("open, osascript, xdg-open and x-www-browser are shims here: logged, failing, a link's query never kept", () => {
    for (const cmd of ["open", "osascript", "xdg-open", "x-www-browser"]) {
      const r = spawnSync(cmd, ["http://den.test/auth?c=SECRETCODE"], {
        encoding: "utf-8",
      });
      expect(r.status).toBe(1);
    }
    const calls = tripwireCalls();
    expect(calls).toEqual([
      "open http://den.test/auth",
      "osascript http://den.test/auth",
      "xdg-open http://den.test/auth",
      "x-www-browser http://den.test/auth",
    ]);
    expect(calls.join("\n")).not.toContain("SECRETCODE");
    // This file meant to trip it: nothing left to fail it.
    clearTripwire();
    expect(tripwireCalls()).toEqual([]);
  });
});

describe("the config/local check", () => {
  it("names a file added, changed or removed under a config/local", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-cfglocal-"));
    try {
      const dir = path.join(root, "config", "local");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "keep.yml"), "a: 1\n");
      fs.writeFileSync(path.join(dir, "gone.yml"), "b: 1\n");
      const before = configLocalSnapshot(root);
      expect(configLocalChanges(root, before)).toEqual([]);
      fs.writeFileSync(path.join(dir, "keep.yml"), "a: 2\n");
      fs.rmSync(path.join(dir, "gone.yml"));
      fs.writeFileSync(path.join(dir, "user.yml"), "x: 1\n");
      expect(configLocalChanges(root, before)).toEqual([
        "changed config/local/keep.yml",
        "removed config/local/gone.yml",
        "added config/local/user.yml",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
