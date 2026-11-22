/**
 * Issue 1048: at 12:00 PT on 11-22 the build machine reached load 104 on 18
 * cores. One cpu slot ran a test runner with ~18 workers beside 8 lanes'
 * type checks: a slot was granted with no regard to how heavy its run is.
 *   1. A cpu slot's run gets DEN_GATE_WORKERS = max(2, floor(cores / cpu_slots)).
 *   2. New cpu grants wait while the 5-minute load is over load_hold × cores
 *      (default 1.5; 0 turns it off). Holders are never stopped.
 */
import { describe, expect, it } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { GateStore, realLoad } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { GATE_DEFAULTS, gateWorkers } from "../../../src/shared/gates/rules.js";
import { checkGatePatch } from "../../../src/shared/gates/store.js";
import testWorkersModule from "../../test-workers.cjs";
const { testWorkers } = testWorkersModule;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-1048-"));
const ask = (s: GateStore, id: string) =>
  s.ask({ kind: "cpu", who: id, label: id, pid: process.pid, estimateMin: 5 });

describe("a cpu slot's worker cap (issue 1048)", () => {
  it("is the cores shared by the cpu slots, at least 2", () => {
    expect(gateWorkers(18, 2)).toBe(9);
    expect(gateWorkers(18, 4)).toBe(4);
    expect(gateWorkers(4, 4)).toBe(2);
    expect(gateWorkers(1, 1)).toBe(2);
  });
});

describe("new cpu grants wait while the machine is overloaded (issue 1048)", () => {
  it("the default hold is 1.5 times the cores", () => {
    expect(GATE_DEFAULTS.loadHold).toBe(1.5);
  });

  it("a cpu ask waits over the hold, and is granted once the load drops", () => {
    let load5 = 30;
    const s = new GateStore({ dir: tmp(), load: () => ({ load5, cores: 18 }) });
    const e = ask(s, "a");
    expect(e.grantedAt).toBeUndefined();
    expect(s.loadState()).toEqual({
      load5: 30,
      cores: 18,
      hold: 27,
      held: true,
    });
    load5 = 20;
    expect(s.get(e.id)?.grantedAt).toBeDefined();
    expect(s.loadState().held).toBe(false);
  });

  it("a holder is never stopped by a high load", () => {
    let load5 = 1;
    const s = new GateStore({ dir: tmp(), load: () => ({ load5, cores: 18 }) });
    const e = ask(s, "a");
    expect(e.grantedAt).toBeDefined();
    load5 = 100;
    expect(s.get(e.id)?.grantedAt).toBeDefined();
  });

  it("load_hold 0 never holds", () => {
    const dir = tmp();
    const s = new GateStore({ dir, load: () => ({ load5: 500, cores: 18 }) });
    const c = checkGatePatch({ load_hold: 0 });
    expect(c.ok).toBe(true);
    if (c.ok) s.writeSettings(c.patch);
    expect(ask(s, "a").grantedAt).toBeDefined();
    expect(s.loadState().held).toBe(false);
  });

  it("load_hold is a setting from 0 to 64", () => {
    expect(checkGatePatch({ load_hold: 2.5 }).ok).toBe(true);
    expect(checkGatePatch({ load_hold: -1 }).ok).toBe(false);
    expect(checkGatePatch({ load_hold: 65 }).ok).toBe(false);
  });
});

describe("jest follows the slot's cap (issue 1048)", () => {
  it("uses DEN_GATE_WORKERS when DEN_TEST_WORKERS is unset", () => {
    expect(testWorkers({ DEN_GATE_WORKERS: "9" })).toBe("9");
  });

  it("DEN_TEST_WORKERS still wins", () => {
    expect(testWorkers({ DEN_TEST_WORKERS: "3", DEN_GATE_WORKERS: "9" })).toBe(
      "3",
    );
  });

  it("neither set: jest's own default", () => {
    expect(testWorkers({})).toBe("");
  });
});

describe("the real reading (issue 1048)", () => {
  it("DEN_GATE_LOAD5 fixes it; unset, it is the machine's", () => {
    expect(realLoad({ DEN_GATE_LOAD5: "40" }).load5).toBe(40);
    expect(realLoad({}).load5).toBe(os.loadavg()[1]);
    expect(realLoad({}).cores).toBeGreaterThan(0);
  });

  it("the test setup fixes it at 0", () => {
    expect(process.env.DEN_GATE_LOAD5).toBe("0");
  });
});

describe("gate run hands a cpu run its worker cap (issue 1048)", () => {
  it("DEN_GATE_WORKERS reaches a cpu run: its share of the cores", async () => {
    const s = new GateStore({
      platform: "linux",
      dir: tmp(),
      alive: () => true,
      load: () => ({ load5: 0, cores: 18 }),
    });
    const ran: Record<string, string>[] = [];
    const d: GateDeps = {
      store: s,
      env: {},
      out: () => {},
      err: () => {},
      now: Date.now,
      sleep: () => Promise.resolve(),
      exec: (_c, _a, env) => {
        ran.push(env ?? {});
        return { pid: 7001, kill: () => {}, done: Promise.resolve(0) };
      },
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: "/x/r",
      cores: 18,
    };
    expect(
      await cmdGate(["run", "--kind", "cpu", "--", "make", "test"], d),
    ).toBe(0);
    expect(ran[0]!.DEN_GATE_WORKERS).toBe("9");
  });
});
