/**
 * A daemon command that writes and exits before `tail` opens its log must
 * still have its output streamed. On Linux a refused sudo does exactly this
 * (the shim prints its needs-sudo line in a few milliseconds), and with
 * `tail -n 0` that line was lost, so the web never asked for the password.
 */
import { describe, it, expect } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnDaemon } from "../../../src/shared/process/spawn-streaming.js";

function runOnce(dir: string, n: number): Promise<string[]> {
  const log = path.join(dir, `svc-${n}.log`);
  const lines: string[] = [];
  return new Promise((resolve) => {
    const tail = spawnDaemon(
      `echo early-line-${n}`,
      process.env,
      log,
      (l) => lines.push(l),
      () => {},
      dir,
      () => {
        // Give tail time to read what is already in the file.
        setTimeout(() => {
          tail.kill();
          resolve(lines);
        }, 400);
      },
    );
  });
}

describe("spawnDaemon: a command that exits at once", () => {
  it("streams the lines it wrote before tail started", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-fast-exit-"));
    for (let n = 0; n < 8; n++) {
      const lines = await runOnce(dir, n);
      expect(lines.join("\n")).toContain(`early-line-${n}`);
      // Nothing from before this run's stamp.
      expect(lines.join("\n")).not.toContain(`early-line-${n - 1}`);
    }
  }, 20000);
});
