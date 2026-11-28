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

  it.each([
    ["no pid, past the setting", null, 15],
    ["a gone holder's pid", 2 ** 22 + 7, 1],
    ["any lock past 30 s", process.pid, 40],
  ])(
    "two waiters judge the same %s: the one that took it second never removes the other's fresh lock",
    (_what, pid, ageS) => {
      const { dir, lock } = pidless(ageS);
      if (pid !== null) {
        fs.writeFileSync(path.join(lock, "pid"), String(pid));
        const t = (Date.now() - ageS * 1000) / 1000;
        fs.utimesSync(lock, t, t);
      }
      let inside = 0;
      // Waiter B, between A's judgment and A's take-back: it takes the old
      // lock back and holds a fresh one of its own (a live holder's pid).
      const a = new GateStore({
        platform: "linux",
        dir,
        lockWaitMs: 0,
        onLockJudged: () => {
          fs.rmSync(lock, { recursive: true, force: true });
          fs.mkdirSync(lock);
          fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
          inside++; // B is inside the lock now
        },
      });
      let ran = false;
      try {
        a.list();
        ran = true;
      } catch (e) {
        expect(e).toBeInstanceOf(GateLockBusy);
      }
      expect({
        inside: inside + (ran ? 1 : 0),
        bHolds: fs.readFileSync(path.join(lock, "pid"), "utf-8"),
      }).toEqual({ inside: 1, bHolds: String(process.pid) });
      // Nothing left beside it.
      expect(fs.readdirSync(dir).filter((n) => n.startsWith("lock."))).toEqual(
        [],
      );
    },
  );

  it("a moved-aside lock left behind (its rename back failed) is removed once older than 60 s; a fresh one is kept", () => {
    const { dir, lock } = pidless(15);
    const old = path.join(dir, "lock.old-4242-aaaa");
    const fresh = path.join(dir, "lock.old-4243-bbbb");
    fs.mkdirSync(old);
    fs.mkdirSync(fresh);
    const t = (Date.now() - 90_000) / 1000;
    fs.utimesSync(old, t, t);
    const s = new GateStore({ platform: "linux", dir, lockWaitMs: 0 });
    expect(s.list()).toEqual([]);
    expect(fs.existsSync(lock)).toBe(false);
    expect(
      fs
        .readdirSync(dir)
        .filter((n) => n.startsWith("lock."))
        .sort(),
    ).toEqual(["lock.old-4243-bbbb"]);
  });
});
