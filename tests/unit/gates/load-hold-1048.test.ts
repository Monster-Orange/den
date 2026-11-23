/**
 * Issue 1048: at 12:00 PT on 11-22 the build machine reached load 104 on 18
 * cores. One cpu slot ran a test runner with ~18 workers beside 8 lanes'
 * type checks: a slot was granted with no regard to how heavy its run is.
 *   1. A cpu slot's run gets DEN_GATE_WORKERS = max(2, floor(cores / cpu_slots)).
 *   2. New cpu grants wait while the 5-minute load is over
 *      load_hold_per_core × cores (default 3; 0 turns it off), but only
 *      while another cpu run is going. Release runs and holders never wait.
 */
import { describe, expect, it } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { GateStore, realLoad } from "../../../src/shared/gates/store.js";
import {
  cmdGate,
  slotLine,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";
import {
  GATE_DEFAULTS,
  gateWorkers,
  loadHold,
} from "../../../src/shared/gates/rules.js";
import { gateView } from "../../../src/shared/gates/view.js";
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
  it("the default hold is 3 times the cores (Vision 11-22)", () => {
    expect(GATE_DEFAULTS.loadHoldPerCore).toBe(3);
  });

  const store = (load5: () => number, cores = 18) =>
    new GateStore({ dir: tmp(), load: load5, cores: () => cores });

  it("over the hold, a new cpu ask waits while another cpu run is going, and starts once the load drops", () => {
    let load5 = 1;
    const s = store(() => load5);
    const c = checkGatePatch({ cpu_slots: 2 });
    if (c.ok) s.writeSettings(c.patch);
    const a = ask(s, "a");
    expect(a.grantedAt).toBeDefined();
    load5 = 60; // over 3 × 18 = 54
    const b = ask(s, "b");
    expect(b.grantedAt).toBeUndefined();
    const why = loadHold(s.list(), s.settings(), s.load(), s.cores());
    expect(why).toEqual({
      why: "cores",
      load: 60,
      limit: 54,
      perCore: 3,
      cores: 18,
    });
    load5 = 40;
    expect(s.get(b.id)?.grantedAt).toBeDefined();
  });

  it("never stalls the line: with no cpu run going, the next one starts whatever the load", () => {
    const s = store(() => 500);
    expect(ask(s, "a").grantedAt).toBeDefined();
  });

  it("the build machine's normal load (about 40 on 18 cores) holds nothing", () => {
    const s = store(() => 40);
    const c = checkGatePatch({ cpu_slots: 4 });
    if (c.ok) s.writeSettings(c.patch);
    for (const id of ["a", "b", "c"])
      expect(ask(s, id).grantedAt).toBeDefined();
  });

  it("a release cpu ask never waits on it", () => {
    let load5 = 1;
    const s = store(() => load5);
    const c = checkGatePatch({ cpu_slots: 2 });
    if (c.ok) s.writeSettings(c.patch);
    ask(s, "a");
    load5 = 100;
    const r = s.ask({
      kind: "cpu",
      who: "r",
      label: "release",
      pid: process.pid,
      estimateMin: 5,
      priority: { reason: "release 0.4.86" },
    });
    expect(r.grantedAt).toBeDefined();
  });

  it("a holder is never stopped by a high load", () => {
    let load5 = 1;
    const s = store(() => load5);
    const e = ask(s, "a");
    load5 = 100;
    expect(s.get(e.id)?.grantedAt).toBeDefined();
  });

  it("load_hold_per_core 0 never holds", () => {
    const s = store(() => 500);
    const c = checkGatePatch({ load_hold_per_core: 0, cpu_slots: 2 });
    if (c.ok) s.writeSettings(c.patch);
    ask(s, "a");
    expect(ask(s, "b").grantedAt).toBeDefined();
  });

  it("load_hold_per_core is a setting from 0 to 64", () => {
    expect(checkGatePatch({ load_hold_per_core: 2.5 }).ok).toBe(true);
    expect(checkGatePatch({ load_hold_per_core: -1 }).ok).toBe(false);
    expect(checkGatePatch({ load_hold_per_core: 65 }).ok).toBe(false);
  });

  it("gate status says why a run waits", () => {
    let load5 = 1;
    const s = store(() => load5);
    const c = checkGatePatch({ cpu_slots: 2 });
    if (c.ok) s.writeSettings(c.patch);
    ask(s, "a");
    load5 = 60;
    const b = ask(s, "b");
    const line = slotLine(b, s.list(), Date.now(), {
      ...s.settings(),
      load: s.load(),
      cores: s.cores(),
    });
    expect(line).toContain(
      "waiting: this machine's load is 60.0, over 3 × 18 cores (54), while another unit test run is going",
    );
    expect(gateView(s).slots.find((x) => x.id === b.id)?.loadHold).toEqual({
      why: "cores",
      load: 60,
      limit: 54,
      perCore: 3,
      cores: 18,
    });
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
    expect(realLoad({ DEN_GATE_LOAD5: "40" })).toBe(40);
    expect(realLoad({})).toBe(os.loadavg()[1]);
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
      load: () => 0,
      cores: () => 18,
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
