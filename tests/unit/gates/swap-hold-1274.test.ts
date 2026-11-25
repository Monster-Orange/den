/**
 * Issue 1274: at 21:21 on 11-22 the build machine showed 91% of its memory
 * free (the kernel's own level) while 9.3 of its 10 GB of swap was used,
 * and minutes later swap reached 40 of 40 GB. The free-memory floor alone
 * missed it. New runs here also wait while swap in use is over
 * swap_hold_gb (default 8; 0 turns it off), only while another run here is
 * going, and the waiter says so.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GateStore,
  checkGatePatch,
  realSwapUsedGb,
  swapGbFromMeminfo,
  swapGbFromSysctl,
} from "../../../src/shared/gates/store.js";
import { GATE_DEFAULTS, swapHold } from "../../../src/shared/gates/rules.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { slotLine } from "../../../src/ui/cli/gate-command.js";

const T0 = Date.parse("2026-11-22T21:21:00Z");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function setup(swap: () => number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1274s-"));
  tmps.push(dir);
  const store = new GateStore({
    platform: "linux",
    dir,
    now: () => T0,
    alive: () => true,
    load: () => 0,
    cores: () => 18,
    free: () => 91,
    swap,
    vms: () => null,
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
  return { store, ask };
}

describe("new runs here wait while swap is high (issue 1274)", () => {
  it("the default is 8 GB", () => {
    expect(GATE_DEFAULTS.swapHoldGb).toBe(8);
  });

  it("91% free but 9.3 GB of swap used: a new run waits while another runs, then starts once swap drops", () => {
    let swap = 1;
    const { store, ask } = setup(() => swap);
    expect(ask("a").grantedAt).toBeDefined();
    swap = 9.3;
    const b = ask("b");
    expect(b.grantedAt).toBeUndefined();
    expect(
      swapHold(store.list(), store.settings(), store.swapUsedGb()),
    ).toEqual({
      why: "swap",
      usedGb: 9.3,
      limitGb: 8,
    });
    const v = gateView(store, T0);
    expect(v.slots.find((s) => s.id === b.id)?.swapHold).toEqual({
      usedGb: 9.3,
      limitGb: 8,
    });
    expect(v.machine?.swapUsedGb).toBe(9.3);
    const line = slotLine(store.get(b.id)!, store.list(), T0, {
      ...store.settings(),
      load: 0,
      cores: 18,
      freeMemory: 91,
      swapUsedGb: 9.3,
    });
    expect(line).toMatch(/9\.3 GB of swap in use, over 8 GB/);
    // The slot log keeps the reading that held it.
    const waits = fs
      .readFileSync(store.eventsFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (l) => JSON.parse(l) as { id: string; event: string; held?: unknown },
      )
      .filter((r) => r.id === b.id && r.event === "waits");
    expect(waits.at(-1)?.held).toEqual({ swap: { usedGb: 9.3, limitGb: 8 } });
    swap = 2;
    expect(store.get(b.id)?.grantedAt).toBeDefined();
  });

  it("never stalls the line: with no run here going, the next one starts", () => {
    const { ask } = setup(() => 30);
    expect(ask("a").grantedAt).toBeDefined();
  });

  it("0 turns it off; the setting takes 0 to 1024", () => {
    const { store, ask } = setup(() => 30);
    const c = checkGatePatch({ swap_hold_gb: 0 });
    expect(c.ok).toBe(true);
    if (c.ok) store.writeSettings(c.patch);
    ask("a");
    expect(ask("b").grantedAt).toBeDefined();
    expect(checkGatePatch({ swap_hold_gb: -1 }).ok).toBe(false);
  });
});

describe("reading swap (issue 1274)", () => {
  it("DEN_GATE_SWAP_GB fixes it; the test setup sets 0", () => {
    expect(realSwapUsedGb({ DEN_GATE_SWAP_GB: "12" })).toBe(12);
    expect(process.env.DEN_GATE_SWAP_GB).toBe("0");
  });
  it("macOS: vm.swapusage's used, in GB", () => {
    expect(
      swapGbFromSysctl(
        "total = 10240.00M  used = 9523.12M  free = 716.88M  (encrypted)",
      ),
    ).toBe(9.3);
    expect(swapGbFromSysctl("nonsense")).toBeNaN();
  });
  it("Linux: SwapTotal less SwapFree, in GB", () => {
    expect(
      swapGbFromMeminfo("SwapTotal:  8388608 kB\nSwapFree:   2097152 kB\n"),
    ).toBe(6);
    expect(swapGbFromMeminfo("MemTotal: 1 kB")).toBeNaN();
  });
});

describe("the words (issue 1274)", () => {
  const pub = path.join(process.cwd(), "src/ui/server/public");
  const read = (f: string) => fs.readFileSync(path.join(pub, f), "utf-8");
  it("the pop-up and en, es, ja say a swap wait and the swap in use", () => {
    expect(read("gate-chip.js")).toMatch(/t\("gate\.swapHold"/);
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const s = read(f);
      expect(s).toMatch(/"gate\.swapHold":\s*"[^"]*\{used\}[^"]*\{limit\}/);
      expect(s).toMatch(/"gate\.swapUsed":\s*"[^"]*\{used\}/);
      expect(s).toMatch(/"set\.server\.gate_swap_hold_gb":/);
      expect(s).toMatch(/"set\.server\.gate_swap_hold_gb\.d":/);
    }
  });
});
