/**
 * The web UI's LaunchAgent must not run as a Background process: macOS
 * gives those efficiency cores and throttled I/O, so a UI people wait on
 * stalls for seconds whenever the machine is busy. `service/install.sh
 * print` writes the plist without touching launchd.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "../../..");

describe("web UI LaunchAgent plist", () => {
  it("runs as an Interactive process, never Background", () => {
    const r = spawnSync(
      "bash",
      [path.join(root, "service", "install.sh"), "print"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          DEN_ROOT: path.join(root, "examples", "distribution"),
        },
      },
    );
    expect(r.status).toBe(0);
    const m = /<key>ProcessType<\/key>\s*<string>([^<]*)<\/string>/.exec(
      r.stdout,
    );
    expect(m?.[1]).toBe("Interactive");
    expect(r.stdout).not.toMatch(/<string>Background<\/string>/);
  });

  it("service status shows launchd's spawn type", () => {
    const src = fs.readFileSync(
      path.join(root, "service", "install.sh"),
      "utf-8",
    );
    const status = src.slice(src.indexOf("  status)"));
    expect(status).toMatch(/spawn type/);
  });
});
