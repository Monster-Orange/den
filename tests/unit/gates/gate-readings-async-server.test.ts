/**
 * Issue 1349 (the sysctl part): a gate settle asks for swap in use and free
 * memory. Their default readers run `sysctl` with execFileSync (a 2 s
 * timeout), which on the server's one thread stalls every request while
 * the machine is slow to start a process.
 *
 *   1. backgroundReading(read): answers at once with the last value (NaN
 *      before the first read, which holds nothing back); a value older
 *      than its interval is read again in the background, one read at a
 *      time; a failed read is NaN.
 *   2. The server's readers (serverSwapUsedGb, serverFreeMemory) never
 *      start a process synchronously, and do read the machine.
 *   3. The fixed readings (DEN_GATE_SWAP_GB, DEN_GATE_FREE_MEM) still win.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";

const syncCalls: string[] = [];
jest.mock("child_process", () => {
  const real =
    jest.requireActual<typeof import("child_process")>("child_process");
  return {
    ...real,
    execFileSync: (...a: Parameters<typeof real.execFileSync>) => {
      syncCalls.push(String(a[0]));
      return real.execFileSync(...a);
    },
  };
});

import {
  backgroundReading,
  serverFreeMemory,
  serverSwapUsedGb,
} from "../../../src/shared/gates/store.js";

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  syncCalls.splice(0);
});

/** A read the test settles by hand, oldest first. */
function manual() {
  const pending: { res: (v: number) => void; rej: (e: Error) => void }[] = [];
  let calls = 0;
  return {
    read: () =>
      new Promise<number>((res, rej) => {
        calls++;
        pending.push({ res, rej });
      }),
    give: (v: number) => pending.shift()!.res(v),
    fail: () => pending.shift()!.rej(new Error("no")),
    calls: () => calls,
  };
}
const settle = () => new Promise((r) => setImmediate(r));

describe("backgroundReading (issue 1349)", () => {
  it("at once: NaN before the first read, then the last value; one read at a time", async () => {
    let now = 0;
    const m = manual();
    const r = backgroundReading(m.read, 2_000, () => now);
    expect(r()).toBeNaN();
    expect(r()).toBeNaN();
    expect(m.calls()).toBe(1);
    m.give(7);
    await settle();
    expect(r()).toBe(7);
    // Fresh: no new read.
    now = 1_000;
    expect(r()).toBe(7);
    expect(m.calls()).toBe(1);
    // Stale: read again in the background; the old value meanwhile.
    now = 2_500;
    expect(r()).toBe(7);
    expect(m.calls()).toBe(2);
    m.give(9);
    await settle();
    expect(r()).toBe(9);
  });

  it("a failed read is NaN (unread: no hold)", async () => {
    let now = 0;
    const m = manual();
    const r = backgroundReading(m.read, 2_000, () => now);
    r();
    m.give(5);
    await settle();
    now = 3_000;
    r();
    m.fail();
    await settle();
    expect(r()).toBeNaN();
  });
});

describe("the server's readers (issue 1349)", () => {
  it("never start a process synchronously, and do read the machine", async () => {
    delete process.env.DEN_GATE_SWAP_GB;
    delete process.env.DEN_GATE_FREE_MEM;
    const swap = serverSwapUsedGb();
    const free = serverFreeMemory();
    swap();
    free();
    const t0 = Date.now();
    while (
      (!Number.isFinite(swap()) || !Number.isFinite(free())) &&
      Date.now() - t0 < 5_000
    )
      await new Promise((r) => setTimeout(r, 20));
    expect(syncCalls).toEqual([]);
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(Number.isFinite(swap())).toBe(true);
      expect(Number.isFinite(free())).toBe(true);
    }
  });

  it("the fixed readings still win", () => {
    process.env.DEN_GATE_SWAP_GB = "3";
    process.env.DEN_GATE_FREE_MEM = "42";
    expect(serverSwapUsedGb()()).toBe(3);
    expect(serverFreeMemory()()).toBe(42);
    expect(syncCalls).toEqual([]);
  });
});
