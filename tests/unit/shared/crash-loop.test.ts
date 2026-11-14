import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BOOTS_FILE,
  CRASH_LOOP_DEFAULTS,
  crashLoopSettings,
  markCleanStop,
  recordBoot,
  runByServiceManager,
} from "../../../src/shared/crash-loop.js";

const S = { restarts: 3, minutes: 10, maxWaitSeconds: 100 };
const T0 = Date.parse("2026-11-12T16:32:00Z");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-crash-loop-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("crash-loop guard", () => {
  it("waits once a start finds `restarts` unclean starts in the window, doubling to the cap", () => {
    const waits: number[] = [];
    for (let i = 0; i < 7; i++)
      waits.push(recordBoot(dir, S, T0 + i * 15_000, 1000 + i).waitMs);
    expect(waits).toEqual([0, 0, 0, 30_000, 60_000, 100_000, 100_000]);
  });

  it("never counts starts that stopped cleanly (updates, asked-for restarts)", () => {
    for (let i = 0; i < 6; i++) {
      expect(recordBoot(dir, S, T0 + i * 15_000, 2000 + i).waitMs).toBe(0);
      markCleanStop(dir, 2000 + i);
    }
  });

  it("forgets crashes older than the window", () => {
    for (let i = 0; i < 3; i++) recordBoot(dir, S, T0 + i * 1000, 3000 + i);
    expect(recordBoot(dir, S, T0 + 11 * 60_000, 3009)).toEqual({
      crashes: 0,
      waitMs: 0,
    });
  });

  it("keeps the newest 50 starts, 0600, and survives a broken file", () => {
    fs.writeFileSync(path.join(dir, BOOTS_FILE), "{not json");
    for (let i = 0; i < 60; i++) recordBoot(dir, S, T0 - 3_600_000 + i, i);
    const f = path.join(dir, BOOTS_FILE);
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))).toHaveLength(50);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("reads its settings from user.yml web.*, defaults for missing or bad values", () => {
    expect(crashLoopSettings(undefined)).toEqual(CRASH_LOOP_DEFAULTS);
    expect(
      crashLoopSettings({
        crash_loop_restarts: 8,
        crash_loop_minutes: "x",
        crash_loop_max_wait_seconds: 600,
      }),
    ).toEqual({ restarts: 8, minutes: 10, maxWaitSeconds: 600 });
  });

  it("is on only under a service manager, or when DEN_CRASH_LOOP_GUARD says", () => {
    expect(runByServiceManager({}, 1)).toBe(true);
    expect(runByServiceManager({ INVOCATION_ID: "x" }, 400)).toBe(true);
    expect(runByServiceManager({}, 400)).toBe(false);
    expect(runByServiceManager({ DEN_CRASH_LOOP_GUARD: "0" }, 1)).toBe(false);
    expect(runByServiceManager({ DEN_CRASH_LOOP_GUARD: "1" }, 400)).toBe(true);
  });
});
