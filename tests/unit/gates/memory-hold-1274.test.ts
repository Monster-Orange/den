/**
 * Issue 1274: on 11-22 a 128 GB build machine was reset three times by its
 * watchdog. Each panic said the kernel's memory compressor was full (100%
 * of its segments, 79-93 swapfiles). Nine container-runtime VMs, each
 * given 32 GB, had promised more memory than the machine has, and the gate
 * couldn't see them: it granted local runs on top.
 *   1. New local grants wait while free memory is under
 *      memory_free_min_percent (default 10; 0 turns it off), but only while
 *      another local run is going, so the line never stops for good. Test
 *      boxes still take their runs.
 *   2. The gate reads what VMs have reserved (OrbStack machines; Docker's
 *      VM); doctor warns when what running VMs promise is over
 *      vm_memory_share × the machine's RAM (default 1: more than it has).
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import {
  GateStore,
  checkGatePatch,
  freePercentFromMeminfo,
  realFreeMemory,
} from "../../../src/shared/gates/store.js";
import { GATE_DEFAULTS, memoryHold } from "../../../src/shared/gates/rules.js";
import {
  orbReservations,
  vmOvercommit,
  type VmReading,
} from "../../../src/shared/gates/vms.js";
import { vmLines } from "../../../src/ui/cli/doctor-vms.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-1274-"));
const GB = 1024 ** 3;

const store = (free: () => number) =>
  new GateStore({ dir: tmp(), load: () => 0, cores: () => 18, free });
const cpu = (s: GateStore, id: string) =>
  s.ask({ kind: "cpu", who: id, label: id, pid: process.pid, estimateMin: 5 });
const slots = (s: GateStore, n: number) => {
  const c = checkGatePatch({ cpu_slots: n });
  if (c.ok) s.writeSettings(c.patch);
};

describe("new local grants wait while free memory is low (issue 1274)", () => {
  it("the default is 10% free", () => {
    expect(GATE_DEFAULTS.memoryFreeMinPercent).toBe(10);
  });

  it("under it, a new ask waits while another local run is going, and starts once memory frees", () => {
    let free = 60;
    const s = store(() => free);
    slots(s, 2);
    expect(cpu(s, "a").grantedAt).toBeDefined();
    free = 5;
    const b = cpu(s, "b");
    expect(b.grantedAt).toBeUndefined();
    expect(memoryHold(s.list(), s.settings(), s.freeMemory())).toEqual({
      why: "memory",
      free: 5,
      limit: 10,
    });
    free = 40;
    expect(s.get(b.id)?.grantedAt).toBeDefined();
  });

  it("a local browser ask waits too", () => {
    let free = 60;
    const s = store(() => free);
    expect(cpu(s, "a").grantedAt).toBeDefined();
    free = 3;
    const b = s.ask({
      kind: "browser",
      who: "b",
      label: "b",
      pid: process.pid,
      estimateMin: 5,
      where: "local",
    });
    expect(b.grantedAt).toBeUndefined();
  });

  it("never stalls the line: with no local run going, the next one starts", () => {
    const s = store(() => 1);
    expect(cpu(s, "a").grantedAt).toBeDefined();
  });

  it("0 turns it off; the setting takes 0 to 90", () => {
    const s = store(() => 1);
    slots(s, 2);
    const c = checkGatePatch({ memory_free_min_percent: 0 });
    expect(c.ok).toBe(true);
    if (c.ok) s.writeSettings(c.patch);
    cpu(s, "a");
    expect(cpu(s, "b").grantedAt).toBeDefined();
    expect(checkGatePatch({ memory_free_min_percent: 95 }).ok).toBe(false);
  });

  it("no reading: no hold", () => {
    expect(memoryHold([], {}, NaN)).toBeUndefined();
  });
});

describe("reading free memory (issue 1274)", () => {
  it("DEN_GATE_FREE_MEM fixes it; the test setup sets 100", () => {
    expect(realFreeMemory({ DEN_GATE_FREE_MEM: "7" })).toBe(7);
    expect(process.env.DEN_GATE_FREE_MEM).toBe("100");
  });

  it("Linux: MemAvailable over MemTotal", () => {
    expect(
      freePercentFromMeminfo(
        "MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n",
      ),
    ).toBe(25);
    expect(freePercentFromMeminfo("nonsense")).toBeNaN();
  });
});

describe("what VMs have reserved, and doctor's warning (issue 1274)", () => {
  const orb = JSON.stringify([
    {
      name: "ci-a",
      state: "running",
      config: { memory_limit_mib: 32768, cpu_limit: 12 },
    },
    {
      name: "ci-b",
      state: "running",
      config: { memory_limit_mib: 32768, cpu_limit: 12 },
    },
    {
      name: "ci-c",
      state: "stopped",
      config: { memory_limit_mib: 32768, cpu_limit: 12 },
    },
  ]);

  it("reads each OrbStack machine's memory and cpus, and whether it runs", () => {
    expect(orbReservations(orb)).toEqual([
      {
        runtime: "orbstack",
        name: "ci-a",
        running: true,
        memBytes: 32 * GB,
        cpus: 12,
      },
      {
        runtime: "orbstack",
        name: "ci-b",
        running: true,
        memBytes: 32 * GB,
        cpus: 12,
      },
      {
        runtime: "orbstack",
        name: "ci-c",
        running: false,
        memBytes: 32 * GB,
        cpus: 12,
      },
    ]);
    expect(orbReservations("not json")).toBeNull();
  });

  it("two running 32 GB VMs on a 48 GB machine: over; at 16 GB each: not", () => {
    const vms = orbReservations(orb)!;
    expect(vmOvercommit(vms, 48 * GB, 1)).toEqual({
      promised: 64 * GB,
      limit: 48 * GB,
      over: true,
    });
    const small = vms.map((v) => ({ ...v, memBytes: 16 * GB }));
    expect(vmOvercommit(small, 48 * GB, 1).over).toBe(false);
  });

  it("doctor warns and names each running VM; a runtime it can't read is 'not counted'", () => {
    const r: VmReading = {
      ramBytes: 48 * GB,
      share: 1,
      vms: orbReservations(orb)!,
      notCounted: ["docker"],
    };
    const out = vmLines(r);
    expect(out.check.status).toBe("warn");
    expect(out.check.id).toBe("gate_vms");
    const text = out.lines.join("\n");
    expect(text).toMatch(/ci-a/);
    expect(text).toMatch(/ci-b/);
    expect(text).not.toMatch(/ci-c.*32/);
    expect(text).toMatch(/64 GB promised.*48 GB/);
    expect(text).toMatch(/docker: not counted/);
  });

  it("under the share: ok", () => {
    const r: VmReading = {
      ramBytes: 128 * GB,
      share: 1,
      vms: orbReservations(orb)!,
      notCounted: [],
    };
    expect(vmLines(r).check.status).toBe("ok");
  });

  it("vm_memory_share is a setting, default 1, 0.1 to 4", () => {
    expect(GATE_DEFAULTS.vmMemoryShare).toBe(1);
    expect(checkGatePatch({ vm_memory_share: 0.75 }).ok).toBe(true);
    expect(checkGatePatch({ vm_memory_share: 0 }).ok).toBe(false);
  });
});
