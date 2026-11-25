/**
 * `gate run` starts its command through a shim that waits for
 * a line on fd 3, sent once the command's group is recorded. Then it
 * becomes the command (the same pid, group and start time). If gate run
 * is gone before it sends the line, the command never runs.
 */
import { describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Writable } from "stream";
import {
  GATE_HOLD_NEVER_STARTED,
  GATE_HOLD_SHIM,
} from "../../../src/ui/cli/gate-command.js";

const posix = process.platform !== "win32";

function held(cmd: string, args: string[]) {
  const k = spawn(
    "/bin/sh",
    ["-c", GATE_HOLD_SHIM, "den-gate-hold", cmd, ...args],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  let out = "";
  k.stdout!.on("data", (d: Buffer) => (out += String(d)));
  const done = new Promise<number | null>((r) => k.on("exit", (c) => r(c)));
  return { k, go: k.stdio[3] as Writable, done, out: () => out };
}

(posix ? describe : describe.skip)("the gate run hold (issue 1575)", () => {
  it("nothing runs until the line comes; then the command runs as the same process, its arguments intact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hold-"));
    const mark = path.join(dir, "ran");
    try {
      const h = held("/bin/sh", [
        "-c",
        'echo "$$|$1|$2"; : > "$3"',
        "x",
        "a b",
        "$HOME",
        mark,
      ]);
      await new Promise((r) => setTimeout(r, 500));
      expect(fs.existsSync(mark)).toBe(false);
      expect(h.k.exitCode).toBeNull();
      h.go.end("go\n");
      expect(await h.done).toBe(0);
      expect(fs.existsSync(mark)).toBe(true);
      // exec kept the pid the group was recorded under
      expect(h.out().trim()).toBe(`${h.k.pid}|a b|$HOME`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gate run gone before the line (the pipe closes): the command never runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hold-"));
    const mark = path.join(dir, "ran");
    try {
      const h = held("/bin/sh", ["-c", ': > "$1"', "x", mark]);
      h.go.end();
      expect(await h.done).toBe(GATE_HOLD_NEVER_STARTED);
      expect(fs.existsSync(mark)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a command that isn't there fails as a shell says, 127", async () => {
    const h = held("/no/such/den-command", []);
    h.go.end("go\n");
    expect(await h.done).toBe(127);
  });
});
