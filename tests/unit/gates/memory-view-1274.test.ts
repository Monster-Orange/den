/**
 * Issue 1274, slice 2: what the gate sees of memory is shown where people
 * look. A run waiting on low memory says so (gate status, the Gate pop-up,
 * the JSON); the machine block lists free memory and what running VMs have
 * reserved, beside the slots, and says when they promise more than the
 * share of RAM allows. A runtime that couldn't be read is "not counted".
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import type { VmReading } from "../../../src/shared/gates/vms.js";
import { machineLines, slotLine } from "../../../src/ui/cli/gate-command.js";

const GB = 1024 ** 3;
const T0 = Date.parse("2026-11-22T21:00:00Z");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const reading = (over: boolean): VmReading => ({
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
    {
      runtime: "orbstack",
      name: "ci-b",
      running: over,
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
  ],
  notCounted: ["docker"],
});

function setup(free: number, vms: VmReading | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1274v-"));
  tmps.push(dir);
  const box = { free };
  const store = new GateStore({
    platform: "linux",
    dir,
    now: () => T0,
    alive: () => true,
    load: () => 0,
    cores: () => 18,
    free: () => box.free,
    vms: () => vms,
  });
  const c = checkGatePatch({ cpu_slots: 2 });
  if (c.ok) store.writeSettings(c.patch);
  const ask = (id: string) =>
    store.ask({
      kind: "cpu",
      who: "den · a person",
      label: id,
      pid: 1,
      estimateMin: 5,
    });
  return { store, box, ask };
}

describe("a run waiting on memory says so (issue 1274)", () => {
  it("the JSON: the waiter carries memoryHold; the holder doesn't", () => {
    const { store, box, ask } = setup(60, null);
    const a = ask("a");
    box.free = 4;
    const b = ask("b");
    const v = gateView(store, T0);
    expect(v.slots.find((s) => s.id === b.id)?.memoryHold).toEqual({
      free: 4,
      limit: 10,
    });
    expect(v.slots.find((s) => s.id === a.id)?.memoryHold).toBeUndefined();
  });

  it("gate status: the waiter's line says why", () => {
    const { store, box, ask } = setup(60, null);
    ask("a");
    box.free = 4;
    const b = ask("b");
    const all = store.list();
    const line = slotLine(store.get(b.id)!, all, T0, {
      ...store.settings(),
      load: 0,
      cores: 18,
      freeMemory: store.freeMemory(),
    });
    expect(line).toMatch(/4% of its memory free, under 10%/);
  });
});

describe("the machine block: free memory and VMs (issue 1274)", () => {
  it("lists running VMs and what they promise; over the share says so", () => {
    const { store } = setup(30, reading(true));
    const m = gateView(store, T0).machine;
    expect(m).toEqual({
      freeMemory: 30,
      ramBytes: 48 * GB,
      share: 1,
      promisedBytes: 64 * GB,
      over: true,
      vms: [
        { runtime: "orbstack", name: "ci-a", memBytes: 32 * GB, cpus: 12 },
        { runtime: "orbstack", name: "ci-b", memBytes: 32 * GB, cpus: 12 },
      ],
      notCounted: ["docker"],
    });
  });

  it("under the share: not over", () => {
    const { store } = setup(30, reading(false));
    expect(gateView(store, T0).machine?.over).toBe(false);
  });

  it("no VM reading (DEN_GATE_VMS=0): free memory only", () => {
    const { store } = setup(30, null);
    expect(gateView(store, T0).machine).toEqual({ freeMemory: 30 });
  });

  it("gate status prints the machine's lines", () => {
    const { store } = setup(30, reading(true));
    const text = machineLines(gateView(store, T0).machine).join("\n");
    expect(text).toMatch(/30% of memory free/);
    expect(text).toMatch(
      /⚠ VMs here promise 64 GB, over 48 GB \(1 × 48 GB RAM\)/,
    );
    expect(text).toMatch(/ci-a \(orbstack\) 32 GB, 12 cpus/);
    expect(text).toMatch(/docker: not counted/);
  });
});

describe("the Gate pop-up and its words (issue 1274)", () => {
  const pub = path.join(process.cwd(), "src/ui/server/public");
  const read = (f: string) => fs.readFileSync(path.join(pub, f), "utf-8");
  it("the pop-up says a memory wait, and the VMs, from the view", () => {
    const js = read("gate-chip.js");
    expect(js).toMatch(/t\("gate\.memoryHold"/);
    expect(js).toMatch(/t\("gate\.vmsOver"/);
    expect(js).toMatch(/t\("gate\.vms"/);
    expect(js).toMatch(/t\("gate\.vmsNotCounted"/);
    expect(js).toMatch(/body\.machine/);
  });
  it("en, es and ja each have the words, with their numbers", () => {
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const s = read(f);
      expect(s).toMatch(/"gate\.memoryHold":\s*"[^"]*\{free\}[^"]*\{limit\}/);
      expect(s).toMatch(/"gate\.vms":\s*"[^"]*\{promised\}[^"]*\{limit\}/);
      expect(s).toMatch(/"gate\.vmsOver":\s*"[^"]*\{promised\}[^"]*\{limit\}/);
      expect(s).toMatch(/"gate\.vmsNotCounted":\s*"[^"]*\{runtime\}/);
      expect(s).toMatch(/"gate\.freeMemory":\s*"[^"]*\{free\}/);
    }
  });
});
