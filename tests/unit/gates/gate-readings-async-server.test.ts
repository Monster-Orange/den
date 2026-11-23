/**
 * Issue 1349 (the memory readings): a gate settle asks for swap in use and
 * free memory, and what it reads decides whether a run here may start.
 *
 *   1. An unknown reading (NaN: it should be read and couldn't be) holds,
 *      never grants, with "memory reading unavailable". The CLI's path and
 *      the server's alike.
 *   2. Not measured (null: a platform with no reading) never holds, and
 *      says so: "memory isn't measured on this platform: memory holds
 *      don't apply" in gate status, the view and doctor.
 *   3. backgroundReading (the server's): the last value at once; a stale
 *      one read again in the background, one read at a time; after a
 *      failed read the last good value stands for keepMs
 *      (memory_reading_keep_seconds, default 30), then it is unknown.
 *   4. The server's readers are primed with one synchronous read when made
 *      (before the server serves), then never start a process
 *      synchronously. DEN_GATE_SWAP_GB and DEN_GATE_FREE_MEM still win.
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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GATE_DEFAULTS,
  MEMORY_NOT_MEASURED_WORDS,
  memoryHold,
  swapHold,
  type GateEntry,
  type MachineReading,
} from "../../../src/shared/gates/rules.js";
import {
  GateStore,
  backgroundReading,
  checkGatePatch,
  realFreeMemory,
  realSwapUsedGb,
  serverFreeMemory,
  serverSwapUsedGb,
} from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import {
  machineLines,
  memoryHoldWords,
  swapHoldWords,
} from "../../../src/ui/cli/gate-command.js";
import { memoryMeasureLines } from "../../../src/ui/cli/doctor-command.js";

const dirs: string[] = [];
const ENV = { ...process.env };
const PLATFORM = process.platform;
afterEach(() => {
  process.env = { ...ENV };
  Object.defineProperty(process, "platform", { value: PLATFORM });
  syncCalls.splice(0);
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A read the test settles by hand, oldest first. */
function manual() {
  const pending: {
    res: (v: MachineReading) => void;
    rej: (e: Error) => void;
  }[] = [];
  let calls = 0;
  return {
    read: () =>
      new Promise<MachineReading>((res, rej) => {
        calls++;
        pending.push({ res, rej });
      }),
    give: (v: MachineReading) => pending.shift()!.res(v),
    fail: () => pending.shift()!.rej(new Error("no")),
    calls: () => calls,
  };
}
const settle = () => new Promise((r) => setImmediate(r));

/** A server-like store whose readings are these (cpu slots 2). */
function storeWith(swap: () => MachineReading, free: () => MachineReading) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1349r-"));
  dirs.push(dir);
  const store = new GateStore({
    platform: "linux",
    dir,
    alive: () => true,
    load: () => 0,
    cores: () => 18,
    free,
    swap,
    vms: () => null,
    lockWaitMs: 0,
  });
  const c = checkGatePatch({ cpu_slots: 2 });
  if (c.ok) store.writeSettings(c.patch);
  const ask = (label: string) =>
    store.ask({
      kind: "cpu",
      who: "den · a person",
      label,
      pid: 1,
      estimateMin: 5,
    });
  return { store, ask };
}

const going = [{ id: "a", grantedAt: "2026-11-23T00:00:00Z" } as GateEntry];

describe("the rule: unknown holds, not measured doesn't (issue 1349)", () => {
  it("NaN with a run here going: held, unavailable; with none going the next starts", () => {
    expect(memoryHold(going, {}, NaN)).toMatchObject({
      why: "memory",
      unavailable: true,
    });
    expect(swapHold(going, {}, NaN)).toMatchObject({
      why: "swap",
      unavailable: true,
    });
    expect(memoryHold([], {}, NaN)).toBeUndefined();
    expect(swapHold([], {}, NaN)).toBeUndefined();
  });

  it("null (not measured here) and a hold turned off never hold", () => {
    expect(memoryHold(going, {}, null)).toBeUndefined();
    expect(swapHold(going, {}, null)).toBeUndefined();
    expect(memoryHold(going, { memoryFreeMinPercent: 0 }, NaN)).toBeUndefined();
    expect(swapHold(going, { swapHoldGb: 0 }, NaN)).toBeUndefined();
  });

  it("the words: unavailable, with no number", () => {
    const m = memoryHold(going, {}, NaN)!;
    const s = swapHold(going, {}, NaN)!;
    for (const w of [memoryHoldWords(m), swapHoldWords(s)]) {
      expect(w).toContain("memory reading unavailable");
      expect(w).not.toContain("NaN");
    }
  });

  it("the setting: memory_reading_keep_seconds, default 30, 0 to 3600", () => {
    expect(GATE_DEFAULTS.memoryReadingKeepSeconds).toBe(30);
    expect(checkGatePatch({ memory_reading_keep_seconds: 60 }).ok).toBe(true);
    expect(checkGatePatch({ memory_reading_keep_seconds: -1 }).ok).toBe(false);
    expect(checkGatePatch({ memory_reading_keep_seconds: 3601 }).ok).toBe(
      false,
    );
  });
});

describe("the CLI's readings (issue 1349)", () => {
  it("a failed read is unknown, and a second run waits", () => {
    const { ask, store } = storeWith(
      () => NaN,
      () => 91,
    );
    expect(ask("a").grantedAt).toBeDefined();
    const b = ask("b");
    expect(b.grantedAt).toBeUndefined();
    expect(gateView(store).slots.find((x) => x.id === b.id)).toMatchObject({
      swapHold: { usedGb: null, unavailable: true },
    });
  });

  it("a platform with no reading: not measured (null), never unknown", () => {
    delete process.env.DEN_GATE_SWAP_GB;
    delete process.env.DEN_GATE_FREE_MEM;
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(realSwapUsedGb()).toBeNull();
    expect(realFreeMemory()).toBeNull();
  });
});

describe("not measured says so (issue 1349)", () => {
  it("gate status, the view and doctor: the guard is off here, no healthy number", () => {
    const { ask, store } = storeWith(
      () => null,
      () => null,
    );
    ask("a");
    expect(ask("b").grantedAt).toBeDefined();
    const m = gateView(store).machine;
    expect(m).toMatchObject({ notMeasured: true });
    expect(m).not.toHaveProperty("freeMemory");
    expect(m).not.toHaveProperty("swapUsedGb");
    expect(machineLines(m)).toContain(
      `This machine: ${MEMORY_NOT_MEASURED_WORDS}.`,
    );
    expect(MEMORY_NOT_MEASURED_WORDS).toBe(
      "memory isn't measured on this platform: memory holds don't apply",
    );
    expect(memoryMeasureLines(null, null)).toEqual([
      `Gate slots: ${MEMORY_NOT_MEASURED_WORDS}.`,
    ]);
    expect(memoryMeasureLines(80, 1)).toEqual([]);
  });
});

describe("backgroundReading (issue 1349)", () => {
  it("at once: NaN before the first read, then the last value; one read at a time", async () => {
    let now = 0;
    const m = manual();
    const r = backgroundReading(m.read, { now: () => now });
    expect(r()).toBeNaN();
    expect(r()).toBeNaN();
    expect(m.calls()).toBe(1);
    m.give(7);
    await settle();
    expect(r()).toBe(7);
    now = 1_000;
    expect(r()).toBe(7);
    expect(m.calls()).toBe(1);
    now = 2_500;
    expect(r()).toBe(7);
    expect(m.calls()).toBe(2);
    m.give(9);
    await settle();
    expect(r()).toBe(9);
  });

  it("a failed read keeps the last good value for keepMs, then it is unknown", async () => {
    let now = 0;
    const m = manual();
    const r = backgroundReading(m.read, { now: () => now, keepMs: 30_000 });
    r();
    m.give(12);
    await settle();
    now = 3_000;
    r();
    m.fail();
    await settle();
    // sysctl fails under pressure: the hold stands on the last reading.
    expect(r()).toBe(12);
    now = 31_000;
    expect(r()).toBeNaN();
  });

  it("a value past keepMs with no read landing is unknown", () => {
    let now = 0;
    const m = manual();
    const r = backgroundReading(m.read, {
      first: 2,
      now: () => now,
      keepMs: () => 30_000,
    });
    expect(r()).toBe(2);
    now = 31_000;
    // A read was started and never lands.
    expect(r()).toBeNaN();
  });

  it("primed: the first value before any read lands", () => {
    const m = manual();
    const r = backgroundReading(m.read, { first: 12, now: () => 0 });
    expect(r()).toBe(12);
    expect(m.calls()).toBe(0);
  });

  it("null (not measured) passes through", async () => {
    const m = manual();
    const r = backgroundReading(m.read, { now: () => 5_000 });
    r();
    m.give(null);
    await settle();
    expect(r()).toBeNull();
  });
});

describe("the swap hold on the server's readings (issue 1349)", () => {
  // tests/setup.ts fixes the readings; these use the server's own.
  const unfixed = () => {
    delete process.env.DEN_GATE_SWAP_GB;
    delete process.env.DEN_GATE_FREE_MEM;
  };
  it("a fresh server store, its read not landed, high swap: a second run waits", () => {
    unfixed();
    const m = manual();
    const { ask } = storeWith(
      serverSwapUsedGb({ prime: () => 12, read: m.read }),
      () => 91,
    );
    expect(ask("a").grantedAt).toBeDefined();
    expect(ask("b").grantedAt).toBeUndefined();
  });

  it("a fresh server store whose primed read failed: unknown, a second run waits", () => {
    unfixed();
    const m = manual();
    const { ask } = storeWith(
      serverSwapUsedGb({ prime: () => NaN, read: m.read }),
      () => 91,
    );
    expect(ask("a").grantedAt).toBeDefined();
    expect(ask("b").grantedAt).toBeUndefined();
  });

  it("12 GB read, then a failed read: a second run still waits", async () => {
    let now = 0;
    const m = manual();
    const r = backgroundReading(m.read, { first: 1, now: () => now });
    const { ask } = storeWith(r, () => 91);
    expect(ask("a").grantedAt).toBeDefined();
    now = 3_000;
    r();
    m.give(12);
    await settle();
    now = 6_000;
    r();
    m.fail();
    await settle();
    expect(ask("b").grantedAt).toBeUndefined();
  });

  it("a low reading gone stale past keepMs: unknown, a second run waits", () => {
    let now = 0;
    const m = manual();
    const r = backgroundReading(m.read, {
      first: 1,
      now: () => now,
      keepMs: 30_000,
    });
    const { ask } = storeWith(r, () => 91);
    expect(ask("a").grantedAt).toBeDefined();
    now = 40_000;
    expect(ask("b").grantedAt).toBeUndefined();
  });
});

describe("the server's readers (issue 1349)", () => {
  it("primed when made; after that never a synchronous process, and they read the machine", async () => {
    delete process.env.DEN_GATE_SWAP_GB;
    delete process.env.DEN_GATE_FREE_MEM;
    const swap = serverSwapUsedGb();
    const free = serverFreeMemory();
    // Made (at the server's start): one primed read each, nothing after.
    syncCalls.splice(0);
    const t0 = Date.now();
    const known = (v: MachineReading) => v !== null && Number.isFinite(v);
    while ((!known(swap()) || !known(free())) && Date.now() - t0 < 5_000)
      await new Promise((r) => setTimeout(r, 20));
    expect(syncCalls).toEqual([]);
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(known(swap())).toBe(true);
      expect(known(free())).toBe(true);
    }
  });

  it("the fixed readings still win", () => {
    process.env.DEN_GATE_SWAP_GB = "3";
    process.env.DEN_GATE_FREE_MEM = "42";
    expect(serverSwapUsedGb()()).toBe(3);
    expect(serverFreeMemory()()).toBe(42);
  });
});
