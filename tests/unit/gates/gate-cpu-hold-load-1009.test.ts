/**
 * Issue 1009: while this machine's 5-minute load average is at or above
 * `cpu_hold_load` (default cores × 4 / 3; 0 turns it off) and a
 * release-priority browser run holds a browser slot, cpu asks wait. A
 * holder is never stopped; a grant goes ahead on the next pass once either
 * condition stops. The waiting ask's line says why.
 *
 * The load is a stubbed reader (GateStoreOpts.load): nothing here reads
 * the real machine's load.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assign } from "../../../src/shared/gates/boxes.js";
import {
  GATE_DEFAULTS,
  grants,
  loadHold,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { slotLine } from "../../../src/ui/cli/gate-command.js";
import { readSettingsSources } from "../server/helpers/settings-sources.js";

const T0 = Date.parse("2026-11-22T17:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const at = (min: number) => T0 + min * 60_000;
const entry = (
  id: string,
  kind: "browser" | "cpu",
  askedMin: number,
  o: { granted?: number; release?: boolean; box?: string } = {},
): GateEntry => ({
  id,
  kind,
  who: id,
  label: id,
  pid: 1,
  askedAt: iso(askedMin),
  estimateMin: 10,
  ...(o.granted !== undefined ? { grantedAt: iso(o.granted) } : {}),
  ...(o.release ? { priority: { for: "release" as const, reason: "r" } } : {}),
  ...(o.box ? { box: o.box } : {}),
});

// One cpu run may run beside a release browser run, so only the load
// rule can hold the cpu ask back.
const S = {
  ...GATE_DEFAULTS,
  cpuSlotsBesideReleaseBrowser: 1,
  cpuHoldLoad: 24,
};
const release = [
  entry("rel", "browser", 0, { granted: 0, release: true }),
  entry("c1", "cpu", 1),
];
const plain = [entry("b", "browser", 0, { granted: 0 }), entry("c1", "cpu", 1)];

describe("the rule (pure)", () => {
  it("load 30 ≥ 24 with a release browser holder: the cpu ask waits", () => {
    expect(grants(release, S, at(2), 30)).toEqual([]);
    expect(assign(release, S, at(2), [], 30)).toEqual([]);
    expect(loadHold(release, S, 30)).toEqual({
      why: "release",
      load: 30,
      limit: 24,
    });
  });

  it("a release run on a test box holds too (its app runs here)", () => {
    const boxed = [
      entry("rel", "browser", 0, { granted: 0, release: true, box: "mini" }),
      entry("c1", "cpu", 1),
    ];
    expect(grants(boxed, S, at(2), 30)).toEqual([]);
    expect(grants(boxed, S, at(2), 20)).toEqual(["c1"]);
  });

  it("load 30 with an ordinary browser holder: granted", () => {
    expect(grants(plain, S, at(2), 30)).toEqual(["c1"]);
    expect(assign(plain, S, at(2), [], 30)).toEqual([{ id: "c1" }]);
    expect(loadHold(plain, S, 30)).toBeUndefined();
  });

  it("load 20 with a release browser holder: granted", () => {
    expect(grants(release, S, at(2), 20)).toEqual(["c1"]);
    expect(assign(release, S, at(2), [], 20)).toEqual([{ id: "c1" }]);
  });

  it("setting 0: granted", () => {
    const off = { ...S, cpuHoldLoad: 0 };
    expect(grants(release, off, at(2), 99)).toEqual(["c1"]);
    expect(assign(release, off, at(2), [], 99)).toEqual([{ id: "c1" }]);
  });

  it("a release cpu ask goes through it; a plain one waits", () => {
    // A release run's own next step (typecheck beside its browser run)
    // never waits on the release run itself.
    const q = [
      entry("rel", "browser", 0, { granted: 0, release: true }),
      entry("c1", "cpu", 1),
      entry("rc", "cpu", 2, { release: true }),
    ];
    expect(grants(q, S, at(3), 30)).toEqual(["rc"]);
    expect(assign(q, S, at(3), [], 30)).toEqual([{ id: "rc" }]);
    const all = q;
    const line = (id: string) =>
      slotLine(all.find((e) => e.id === id)!, all, at(3), { ...S, load: 30 });
    expect(line("c1")).toContain("waiting: load 30 ≥ 24");
    expect(line("rc")).not.toContain("waiting: load");
  });

  it("a browser waiter isn't held by it", () => {
    const q = [
      entry("rel", "browser", 0, { granted: 0, release: true, box: "mini" }),
      entry("b2", "browser", 1),
    ];
    expect(grants(q, S, at(2), 99)).toEqual(["b2"]);
  });

  it("no load given (an older caller): granted as before", () => {
    expect(grants(release, S, at(2))).toEqual(["c1"]);
  });
});

describe("the setting", () => {
  it("defaults to cores × 4 / 3, and the server checks it (0 to 1024)", () => {
    const cores = os.availableParallelism?.() ?? os.cpus().length;
    expect(GATE_DEFAULTS.cpuHoldLoad).toBe(Math.round((cores * 4) / 3));
    expect(checkGatePatch({ cpu_hold_load: 0 })).toMatchObject({
      ok: true,
      patch: { cpu_hold_load: 0 },
    });
    expect(checkGatePatch({ cpu_hold_load: 30.5 }).ok).toBe(true);
    expect(checkGatePatch({ cpu_hold_load: -1 }).ok).toBe(false);
  });
});

describe("the store, with a stubbed load", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  function setup(load: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1009-"));
    tmps.push(dir);
    const box = { load };
    const store = new GateStore({
      platform: "linux",
      dir,
      now: () => T0,
      alive: () => true,
      load: () => box.load,
    });
    store.writeSettings({ cpu_slots_beside_release_browser: 1 });
    store.writeSettings({ cpu_hold_load: 24 });
    const rel = store.ask({
      kind: "browser",
      who: "den · a person",
      label: "release e2e",
      pid: 1,
      estimateMin: 10,
      priority: { reason: "0.4.85" },
    });
    const cpu = store.ask({
      kind: "cpu",
      who: "den · a person",
      label: "unit",
      pid: 1,
      estimateMin: 5,
    });
    return { store, box, rel, cpu };
  }

  const granted = (s: GateStore, id: string) =>
    !!s.list().find((e) => e.id === id)?.grantedAt;

  it("load 30: the cpu ask waits, and status gives the reason", () => {
    const { store, rel, cpu } = setup(30);
    expect(granted(store, rel.id)).toBe(true);
    expect(granted(store, cpu.id)).toBe(false);
    const all = store.list();
    const line = slotLine(all.find((e) => e.id === cpu.id)!, all, T0, {
      ...store.settings(),
      load: 30,
    });
    expect(line).toContain(
      "waiting: load 30 ≥ 24 while a release run holds the browser slot",
    );
    const v = gateView(store, T0).slots.find((s) => s.id === cpu.id)!;
    expect(v.loadHold).toEqual({ why: "release", load: 30, limit: 24 });
  });

  it("load drops: granted on the next pass; the holder never stopped", () => {
    const { store, box, rel, cpu } = setup(30);
    expect(granted(store, cpu.id)).toBe(false);
    box.load = 12;
    expect(granted(store, cpu.id)).toBe(true);
    expect(granted(store, rel.id)).toBe(true);
    // Load back up: a holder keeps its slot.
    box.load = 40;
    expect(granted(store, cpu.id)).toBe(true);
  });
});

describe("the Gate page and the setting's words", () => {
  const pub = path.join(process.cwd(), "src/ui/server/public");
  const read = (f: string) => fs.readFileSync(path.join(pub, f), "utf-8");

  it("the panel's row has the reason in en, es and ja", () => {
    expect(read("gate-chip.js")).toMatch(/t\("gate\.loadHold"/);
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      expect(read(f)).toMatch(
        /"gate\.loadHold":\s*"[^"]*\{load\}[^"]*\{limit\}/,
      );
  });

  it("the Settings row has its words in en, es and ja", () => {
    expect(readSettingsSources()).toContain('"gate_slots.cpu_hold_load"');
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      expect(read(f)).toContain('"set.server.gate_cpu_hold_load":');
      expect(read(f)).toContain('"set.server.gate_cpu_hold_load.d":');
    }
  });
});
