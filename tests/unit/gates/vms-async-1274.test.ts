/**
 * Issue 1274, review of slice 2: the Gate page's request reads the gate
 * view, and the view showed the VMs. Reading them ran `orbctl` and `docker`
 * synchronously, up to 5 s each, on the web server's request path; under
 * memory pressure those are what turn slow. Now a request never shells out:
 * the view reads the last VM reading, and a stale one starts a refresh in
 * the background (one at a time, at most every 30 s). `gate status` and
 * doctor still read them on the spot.
 * Invented names only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import {
  peekVms,
  resetVmCache,
  type VmReading,
} from "../../../src/shared/gates/vms.js";

const GB = 1024 ** 3;
const reading: VmReading = {
  ramBytes: 48 * GB,
  share: 1,
  vms: [
    {
      runtime: "orbstack",
      name: "ci-a",
      running: true,
      memBytes: 32 * GB,
      cpus: 12,
    },
  ],
  notCounted: [],
};

/** A reader that answers only when told to. */
function slowReader() {
  let calls = 0;
  let answer: (r: VmReading) => void = () => {};
  const read = () => {
    calls++;
    return new Promise<VmReading>((r) => (answer = r));
  };
  return { read, calls: () => calls, answer: (r: VmReading) => answer(r) };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => resetVmCache());

describe("the VM reading never blocks a request (issue 1274)", () => {
  it("nothing read yet: null at once, and one background read starts", () => {
    const r = slowReader();
    expect(peekVms(1, r.read, 0)).toBeNull();
    expect(peekVms(1, r.read, 10)).toBeNull();
    expect(r.calls()).toBe(1);
  });

  it("once the read lands it is returned, and not read again within 30 s", async () => {
    const r = slowReader();
    peekVms(1, r.read, 0);
    r.answer(reading);
    await flush();
    expect(peekVms(1, r.read, 1_000)).toEqual(reading);
    expect(peekVms(1, r.read, 29_000)).toEqual(reading);
    expect(r.calls()).toBe(1);
  });

  it("stale: the last reading is returned while a new one is read", async () => {
    const r = slowReader();
    peekVms(1, r.read, 0);
    r.answer(reading);
    await flush();
    expect(peekVms(1, r.read, 31_000)).toEqual(reading);
    expect(r.calls()).toBe(2);
  });

  it("a read that fails leaves the last reading, and is tried again later", async () => {
    let calls = 0;
    const fail = () => {
      calls++;
      return Promise.reject(new Error("orbctl hung"));
    };
    expect(peekVms(1, fail, 0)).toBeNull();
    await flush();
    expect(peekVms(1, fail, 1_000)).toBeNull();
    expect(calls).toBe(1);
    peekVms(1, fail, 31_000);
    expect(calls).toBe(2);
  });

  describe("the gate view (what the Gate page's request reads)", () => {
    const tmps: string[] = [];
    const saved = process.env.DEN_GATE_VMS;
    beforeEach(() => {
      delete process.env.DEN_GATE_VMS;
    });
    afterEach(() => {
      process.env.DEN_GATE_VMS = saved;
      for (const d of tmps.splice(0))
        fs.rmSync(d, { recursive: true, force: true });
    });

    it("with a reader that never answers, it returns at once without the VMs", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1274a-"));
      tmps.push(dir);
      const r = slowReader();
      const store = new GateStore({
        platform: "linux",
        dir,
        load: () => 0,
        cores: () => 18,
        free: () => 50,
        swap: () => 0,
        vmsAsync: r.read,
      });
      const t = Date.now();
      const v = gateView(store);
      expect(Date.now() - t).toBeLessThan(500);
      expect(v.machine).toEqual({ freeMemory: 50 });
      expect(r.calls()).toBe(1);
    });
  });
});
