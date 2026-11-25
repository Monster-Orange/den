/**
 * Issue 1440: the gate-slot lock is taken in two steps, mkdir(lock) and then
 * lock/pid. A holder killed between them leaves a lock with no pid file.
 * holderGone() can't judge it, so only the 30 s rule freed it, and every
 * store waited (list() threw GateLockBusy after lockWaitMs).
 *
 * Now a lock with no pid file older than gates.lock_no_pid_seconds (a
 * Setting, default 10) is taken back. Measured: the mkdir-to-pid gap was at
 * most 50 ms on macOS with the CPU saturated and 80 ms on 2 Linux CPUs at 3x
 * load, so 10 s is over 100x the worst case.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateLockBusy, GateStore } from "../../../src/shared/gates/store.js";
import { GATE_DEFAULTS } from "../../../src/shared/gates/rules.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A gates folder holding a lock with no pid file, `ageS` seconds old. */
function pidless(ageS: number, settings?: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1440-"));
  tmps.push(dir);
  if (settings)
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  const lock = path.join(dir, "lock");
  fs.mkdirSync(lock);
  const t = (Date.now() - ageS * 1000) / 1000;
  fs.utimesSync(lock, t, t);
  return { dir, lock };
}

describe("a gate lock with no pid file", () => {
  it("defaults to 10 s, well under the 30 s rule", () => {
    expect(GATE_DEFAULTS.lockNoPidSeconds).toBe(10);
  });

  it("older than the setting: taken back at once", () => {
    const { dir, lock } = pidless(15);
    const s = new GateStore({ platform: "linux", dir, lockWaitMs: 0 });
    expect(s.list()).toEqual([]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("younger than the setting: still waited for (its holder may be writing the pid)", () => {
    const { dir, lock } = pidless(1);
    const s = new GateStore({ platform: "linux", dir, lockWaitMs: 0 });
    expect(() => s.list()).toThrow(GateLockBusy);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("the setting moves the line", () => {
    const short = pidless(4, { lock_no_pid_seconds: 3 });
    expect(
      new GateStore({
        platform: "linux",
        dir: short.dir,
        lockWaitMs: 0,
      }).list(),
    ).toEqual([]);
    const long = pidless(15, { lock_no_pid_seconds: 25 });
    expect(() =>
      new GateStore({ platform: "linux", dir: long.dir, lockWaitMs: 0 }).list(),
    ).toThrow(GateLockBusy);
  });

  it("a lock whose pid file names a live holder is never taken back early", () => {
    const { dir, lock } = pidless(15);
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    const t = (Date.now() - 15_000) / 1000;
    fs.utimesSync(lock, t, t);
    const s = new GateStore({ platform: "linux", dir, lockWaitMs: 0 });
    expect(() => s.list()).toThrow(GateLockBusy);
  });

  it("the setting is shown and checked like the others", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1440-"));
    tmps.push(dir);
    const s = new GateStore({ platform: "linux", dir });
    expect(s.settings().lockNoPidSeconds).toBe(10);
    expect(
      s.settings({ lock_no_pid_seconds: 4 } as never).lockNoPidSeconds,
    ).toBe(4);
  });
});
