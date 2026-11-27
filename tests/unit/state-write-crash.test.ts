/**
 * Issue 786 clause 6: kill a write midway and the old file is intact. A
 * child Node saves the pins file (shell-prefs, a plain write until 786)
 * with fs.writeFileSync made to write half its body under the state folder
 * and then SIGKILL its own process: a crash or a power loss mid-write. The
 * pins on disk afterwards are the old ones, whole.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  fixturePinsFile,
  readFixturePins,
} from "../../src/ui/server/shell-prefs.js";

const ROOT = path.join(__dirname, "../..");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** The child: half a write under `stateDir`, then a hard kill. */
const CHILD = (stateDir: string) => `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const real = fs.writeFileSync;
fs.writeFileSync = function (file, data, opts) {
  if (typeof file === "string" && file.startsWith(${JSON.stringify(stateDir)})) {
    const buf = Buffer.from(typeof data === "string" ? data : data);
    real.call(fs, file, buf.subarray(0, Math.floor(buf.length / 2)), opts);
    process.kill(process.pid, "SIGKILL");
  }
  return real.apply(fs, arguments);
};
syncBuiltinESMExports();
const { writeFixturePins } = await import(${JSON.stringify(
  path.join(ROOT, "src/ui/server/shell-prefs.ts"),
)});
const pins = [
  { item: "agent:old", project: null },
  { item: "agent:new-${"x".repeat(200)}", project: "p" },
];
writeFixturePins(${JSON.stringify(stateDir)}, pins, pins);
`;

describe("a state write killed midway", () => {
  it("leaves the old file whole", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-crash-"));
    tmps.push(d);
    const stateDir = path.join(d, "state");
    fs.mkdirSync(stateDir);
    const old = [{ item: "agent:old", project: null }];
    fs.writeFileSync(fixturePinsFile(stateDir), JSON.stringify(old));

    const child = path.join(d, "child.mts");
    fs.writeFileSync(child, CHILD(stateDir));
    const r = spawnSync(process.execPath, ["--import", "tsx", child], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.signal).toBe("SIGKILL");
    expect(readFixturePins(stateDir)).toEqual(old);
  });
});
