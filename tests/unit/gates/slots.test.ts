/**
 * Issue 144 GATE-SLOT: the queue rules and the machine's store. The store
 * lives in a temp DEN_GATE_DIR; no Den runs and no suite runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  expectedStart,
  gateDefaults,
  waitReason,
  grants,
  overrun,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import {
  GateStore,
  checkGatePatch,
  gateDir,
} from "../../../src/shared/gates/store.js";
import { FAKE_MACHINE } from "./fake-machine.js";
import { PERSON_ONLY_SETTINGS } from "../../../src/shared/settings-cli-rows.js";

const tmps: string[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-"));
  tmps.push(d);
  return d;
};

/** The defaults on a machine with 8 cores (one cpu run beside a browser). */
const S8 = gateDefaults(8);

const T0 = Date.parse("2026-11-15T06:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const entry = (
  id: string,
  kind: "browser" | "cpu",
  askedMin: number,
  grantedMin?: number,
  estimateMin = 10,
): GateEntry => ({
  id,
  kind,
  who: id,
  label: id,
  pid: 1,
  askedAt: iso(askedMin),
  estimateMin,
  ...(grantedMin !== undefined ? { grantedAt: iso(grantedMin) } : {}),
});

describe("the queue rules", () => {
  it("a browser run holds the machine alone; the next one waits", () => {
    expect(grants([entry("a", "browser", 0)], S8)).toEqual(["a"]);
    expect(
      grants([entry("a", "browser", 0, 0), entry("b", "browser", 1)], S8),
    ).toEqual([]);
    // With cpu_beside_browser 0 (issue 462), no cpu run starts beside it.
    expect(
      grants([entry("a", "browser", 0, 0), entry("c", "cpu", 1)], {
        ...S8,
        cpuBesideBrowser: 0,
      }),
    ).toEqual([]);
  });

  it("cpu runs share up to cpu_slots", () => {
    const q = [
      entry("a", "cpu", 0),
      entry("b", "cpu", 1),
      entry("c", "cpu", 2),
    ];
    expect(grants(q, S8)).toEqual(["a", "b"]);
    expect(grants(q, { ...S8, cpuSlots: 3 })).toEqual(["a", "b", "c"]);
  });

  it("a browser run waits for cpu to drain, and stops new cpu grants", () => {
    const q = [
      entry("a", "cpu", 0, 0),
      entry("b", "browser", 1),
      entry("c", "cpu", 2),
    ];
    expect(grants(q, S8)).toEqual([]);
    expect(grants(q.slice(1), { ...S8, cpuBesideBrowser: 0 })).toEqual(["b"]);
    // Issue 462: once b starts, c may start beside it (it fits).
    const now = Date.parse(iso(2));
    expect(grants(q.slice(1), S8, { now, loadPerCore: 0 })).toEqual(["b", "c"]);
  });

  describe("issue 462: cpu runs beside a browser hold (backfill)", () => {
    // The browser "a" holds from minute 0 for 30 min; now is minute 5, so
    // it is expected to end at minute 30, and the margin (15) makes 45.
    const now = T0 + 5 * 60_000;
    const at = { now, loadPerCore: 0.5 };

    it("(a) one browser holding, one cpu waiting: the cpu starts", () => {
      const q = [entry("a", "browser", 0, 0, 30), entry("c", "cpu", 1)];
      expect(grants(q, S8, at)).toEqual(["c"]);
    });

    it("only cpu_beside_browser of them, and within cpu_slots", () => {
      const q = [
        entry("a", "browser", 0, 0, 30),
        entry("c", "cpu", 1),
        entry("d", "cpu", 2),
      ];
      expect(grants(q, S8, at)).toEqual(["c"]);
      expect(grants(q, { ...S8, cpuBesideBrowser: 2 }, at)).toEqual(["c", "d"]);
      expect(
        grants(q, { ...S8, cpuBesideBrowser: 4, cpuSlots: 1 }, at),
      ).toEqual(["c"]);
      // One already beside it: no more.
      const held = [entry("a", "browser", 0, 0, 30), entry("c", "cpu", 1, 1)];
      expect(grants([...held, entry("d", "cpu", 2)], S8, at)).toEqual([]);
    });

    it("(b) a browser waits too: a cpu that fits before the hold ends starts", () => {
      const q = [
        entry("a", "browser", 0, 0, 30),
        entry("b", "browser", 1),
        entry("c", "cpu", 2, undefined, 40), // ends at 45: fits exactly
      ];
      expect(grants(q, S8, at)).toEqual(["c"]);
    });

    it("(c) the same with an estimate that doesn't fit: it waits", () => {
      const q = [
        entry("a", "browser", 0, 0, 30),
        entry("b", "browser", 1),
        entry("c", "cpu", 2, undefined, 41), // ends at 46: would delay b
      ];
      expect(grants(q, S8, at)).toEqual([]);
      // A shorter one behind it may still fit.
      expect(
        grants([...q, entry("d", "cpu", 3, undefined, 5)], S8, at),
      ).toEqual(["d"]);
    });

    it("(d) load above max_load_per_core: it waits", () => {
      const q = [entry("a", "browser", 0, 0, 30), entry("c", "cpu", 1)];
      expect(grants(q, S8, { now, loadPerCore: 2.5 })).toEqual([]);
      expect(
        grants(q, { ...S8, maxLoadPerCore: 3 }, { now, loadPerCore: 2.5 }),
      ).toEqual(["c"]);
    });

    it("(e) cpu_beside_browser 0: today's behaviour", () => {
      const off = { ...S8, cpuBesideBrowser: 0 };
      expect(
        grants(
          [entry("a", "browser", 0, 0, 30), entry("c", "cpu", 1)],
          off,
          at,
        ),
      ).toEqual([]);
      expect(
        grants(
          [
            entry("a", "browser", 0, 0, 30),
            entry("b", "browser", 1),
            entry("c", "cpu", 2, undefined, 5),
          ],
          off,
          at,
        ),
      ).toEqual([]);
    });

    it("a held cpu still blocks a browser waiter; nothing is pre-empted", () => {
      const q = [entry("c", "cpu", 1, 1), entry("b", "browser", 2)];
      expect(grants(q, S8, at)).toEqual([]);
    });
  });

  describe("issue 511: browser slots", () => {
    const now = T0 + 5 * 60_000;
    const quiet = { now, loadPerCore: 0.5, ptys: { used: 100, max: 511 } };
    const two = { ...S8, browserSlots: 2 };
    const q = () => [entry("a", "browser", 0, 0, 30), entry("b", "browser", 1)];

    it("defaults: 1 below 8 cores; floor(cores / 8) from 8, at most 3", () => {
      expect(gateDefaults(4).browserSlots).toBe(1);
      expect(gateDefaults(7).browserSlots).toBe(1);
      expect(gateDefaults(8).browserSlots).toBe(1);
      expect(gateDefaults(16).browserSlots).toBe(2);
      expect(gateDefaults(18).browserSlots).toBe(2);
      expect(gateDefaults(24).browserSlots).toBe(3);
      expect(gateDefaults(64).browserSlots).toBe(3);
      expect(gateDefaults(8).ptyHeadroom).toBe(50);
    });

    it("browser_slots 2: a second browser run starts at once while load and PTYs are low", () => {
      expect(grants(q(), two, quiet)).toEqual(["b"]);
      expect(grants(q(), S8, quiet)).toEqual([]);
      expect(waitReason(q(), S8, quiet, "b")).toBe(
        "all 1 browser slots are held",
      );
    });

    it("waits while the load per core is above max_load_per_core, and says so", () => {
      const busy = { ...quiet, loadPerCore: 2.5 };
      expect(grants(q(), two, busy)).toEqual([]);
      expect(waitReason(q(), two, busy, "b")).toBe(
        "the load is 2.50 per core, above 2",
      );
      // The first browser run too.
      expect(grants([entry("b", "browser", 1)], two, busy)).toEqual([]);
    });

    it("waits while the PTYs in use are not more than 50 below the limit, and says so", () => {
      const ptys = { ...quiet, ptys: { used: 461, max: 511 } };
      expect(grants(q(), two, ptys)).toEqual([]);
      expect(waitReason(q(), two, ptys, "b")).toBe(
        "461 of 511 PTYs are in use; a browser run needs more than 50 free",
      );
      expect(
        grants(q(), two, { ...quiet, ptys: { used: 460, max: 511 } }),
      ).toEqual(["b"]);
      expect(grants(q(), { ...two, ptyHeadroom: 0 }, ptys)).toEqual(["b"]);
    });

    it("a browser run still waits for a cpu run to end", () => {
      const held = [entry("c", "cpu", 0, 0), entry("b", "browser", 1)];
      expect(grants(held, two, quiet)).toEqual([]);
      expect(waitReason(held, two, quiet, "b")).toBe("a cpu run holds");
    });

    it("the release slot is counted apart; it never takes nor blocks an ordinary slot", () => {
      const r = { ...entry("r", "browser", 2), kind: "release" as const };
      const r2 = { ...entry("r2", "browser", 3), kind: "release" as const };
      // Both browser slots are full; the release slot is free.
      expect(grants([...q(), r, r2], S8, quiet)).toEqual(["r"]);
      const rHeld = { ...r, grantedAt: iso(2) };
      expect(grants([rHeld, entry("b", "browser", 3)], S8, quiet)).toEqual([
        "b",
      ]);
      expect(waitReason([rHeld, r2], S8, quiet, "r2")).toBe(
        "the release slot is held",
      );
    });
  });

  it("a waiter sees when it may start; an overrun is flagged past the margin", () => {
    const q = [
      entry("a", "browser", 0, 0, 6),
      entry("b", "browser", 1, undefined, 4),
      entry("c", "browser", 2),
    ];
    expect(expectedStart(q, "b", T0)).toBe(T0 + 6 * 60_000);
    expect(expectedStart(q, "c", T0)).toBe(T0 + 10 * 60_000);
    expect(overrun(q[0]!, S8, T0 + 20 * 60_000)).toBe(false);
    expect(overrun(q[0]!, S8, T0 + 22 * 60_000)).toBe(true);
  });
});

describe("the store", () => {
  const ask = (
    s: GateStore,
    kind: "browser" | "cpu",
    pid = process.pid,
    estimateMin = 5,
  ) => s.ask({ kind, who: "me", label: "suite", pid, estimateMin });

  it("lives in DEN_GATE_DIR, else one place per machine user", () => {
    expect(gateDir({ DEN_GATE_DIR: "/x/y" })).toBe("/x/y");
    expect(gateDir({ HOME: "/h" })).toMatch(/^\/h\/.*den\/gate-slots$/);
  });

  it("grants, queues (a wait is recorded), and grants the next on release", () => {
    const s = new GateStore({ ...FAKE_MACHINE, dir: tmp() });
    const a = ask(s, "browser");
    const b = ask(s, "browser");
    expect(a.grantedAt).toBeDefined();
    expect(b.grantedAt).toBeUndefined();
    expect(s.release(a.id)).toBe(true);
    expect(s.get(b.id)?.grantedAt).toBeDefined();
    expect(s.events().map((e) => e.event)).toEqual([
      "asked",
      "granted",
      "asked",
      "waits",
      "released",
      "granted",
    ]);
    // Coach reads the time lost: the wait names who held, and the grant
    // says how long it waited.
    const waits = s.events().find((e) => e.event === "waits")!;
    expect(waits.behind).toEqual([a.id]);
    expect(typeof s.events().at(-1)!.minutes).toBe("number");
  });

  it("two browser asks at once: the second waits and sees the first's expected end; neither is stopped", () => {
    let now = T0;
    const s = new GateStore({ ...FAKE_MACHINE, dir: tmp(), now: () => now });
    const first = ask(s, "browser", process.pid, 6);
    const second = ask(s, "browser", process.pid, 4);
    expect(first.grantedAt).toBe(iso(0));
    expect(second.grantedAt).toBeUndefined();
    now += 3 * 60_000;
    const list = s.list();
    expect(list.map((e) => e.id)).toEqual([first.id, second.id]);
    // The second's expected start is the first's expected end.
    expect(expectedStart(list, second.id, now)).toBe(T0 + 6 * 60_000);
    // Past the first's estimate and margin: still the first's.
    now += 60 * 60_000;
    expect(s.get(first.id)?.grantedAt).toBe(iso(0));
    expect(s.get(second.id)?.grantedAt).toBeUndefined();
  });

  it("an exited holder is released at once, and the next one granted", () => {
    const pids = new Set([100, 200]);
    const s = new GateStore({
      ...FAKE_MACHINE,
      dir: tmp(),
      alive: (p) => pids.has(p),
    });
    const a = ask(s, "browser", 100);
    const b = ask(s, "browser", 200);
    expect(a.grantedAt).toBeDefined();
    expect(b.grantedAt).toBeUndefined();
    pids.delete(100);
    expect(s.get(b.id)?.grantedAt).toBeDefined();
    expect(s.list().map((e) => e.id)).toEqual([b.id]);
    expect(s.events().map((e) => e.event)).toEqual([
      "asked",
      "granted",
      "asked",
      "waits",
      "taken-back-gone",
      "granted",
    ]);
  });

  it("a real process that has exited holds nothing", () => {
    const exited = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const s = new GateStore({ ...FAKE_MACHINE, dir: tmp() });
    ask(s, "browser", exited);
    expect(s.list()).toEqual([]);
    expect(s.events().map((e) => e.event)).toContain("taken-back-gone");
  });

  it("a holder whose wrapper died keeps the slot while its run goes on", () => {
    const pids = new Set([100, 200]);
    const s = new GateStore({
      ...FAKE_MACHINE,
      dir: tmp(),
      alive: (p) => pids.has(p),
    });
    const a = ask(s, "browser", 100);
    s.setRunPid(a.id, 200);
    pids.delete(100);
    expect(s.get(a.id)?.grantedAt).toBeDefined();
    pids.delete(200);
    expect(s.get(a.id)).toBeNull();
  });

  it("a live holder is never taken back, however long it is quiet", () => {
    let now = T0;
    const s = new GateStore({ ...FAKE_MACHINE, dir: tmp(), now: () => now });
    const a = ask(s, "cpu");
    now += 24 * 60 * 60_000;
    expect(s.list().map((e) => e.id)).toEqual([a.id]);
  });

  it("an overdue slot is flagged once, recorded, never removed", () => {
    let now = T0;
    const s = new GateStore({ ...FAKE_MACHINE, dir: tmp(), now: () => now });
    const a = ask(s, "browser");
    now += 19 * 60_000;
    expect(s.get(a.id)?.flaggedAt).toBeUndefined();
    now += 2 * 60_000;
    const held = s.get(a.id)!;
    expect(held.flaggedAt).toBe(new Date(now).toISOString());
    expect(overrun(held, s.settings(), now)).toBe(true);
    now += 60 * 60_000;
    s.list();
    expect(s.list().map((e) => e.id)).toEqual([a.id]);
    expect(s.events().filter((e) => e.event === "overdue")).toHaveLength(1);
  });

  it("ending early is recorded with who", () => {
    const s = new GateStore({ ...FAKE_MACHINE, dir: tmp() });
    const a = ask(s, "browser");
    expect(s.endEarly(a.id, "a person at the terminal")).toMatchObject({
      event: "ended-early",
    });
    expect(s.events().at(-1)).toMatchObject({
      event: "ended-early",
      by: "a person at the terminal",
    });
    expect(s.endEarly(a.id, "again")).toBeNull();
  });

  it("issue 462: a cpu run starts beside a browser hold, marked beside; not under load", () => {
    let load = 0.5;
    const s = new GateStore({
      ...FAKE_MACHINE,
      dir: tmp(),
      loadPerCore: () => load,
      cores: () => 8,
    });
    const a = ask(s, "browser", process.pid, 30);
    const c = ask(s, "cpu", process.pid, 5);
    expect(c.grantedAt).toBeDefined();
    expect(c.beside).toBe(true);
    expect(s.get(a.id)?.beside).toBeUndefined();
    s.release(c.id);
    load = 9;
    expect(ask(s, "cpu", process.pid, 5).grantedAt).toBeUndefined();
  });

  it("issue 462: cpu_beside_browser's default is 1 on 8 or more cores, else 0", () => {
    expect(gateDefaults(7).cpuBesideBrowser).toBe(0);
    expect(gateDefaults(8).cpuBesideBrowser).toBe(1);
    expect(gateDefaults(32).cpuBesideBrowser).toBe(1);
    const small = new GateStore({
      ...FAKE_MACHINE,
      dir: tmp(),
      loadPerCore: () => 0,
      cores: () => 7,
    });
    expect(small.settings().cpuBesideBrowser).toBe(0);
    ask(small, "browser", process.pid, 30);
    expect(ask(small, "cpu", process.pid, 5).grantedAt).toBeUndefined();
    // Still a Setting: a person may turn it on there.
    small.writeSettings({ cpu_beside_browser: 1 });
    expect(small.list().filter((e) => e.grantedAt)).toHaveLength(2);
    const big = new GateStore({ ...FAKE_MACHINE, dir: tmp(), cores: () => 8 });
    expect(big.settings().cpuBesideBrowser).toBe(1);
  });

  it("issue 511: an ordinary ask can't take the release slot; askRelease can", () => {
    const s = new GateStore({ ...FAKE_MACHINE, dir: tmp() });
    expect(() =>
      s.ask({
        kind: "release" as "browser",
        who: "me",
        label: "x",
        pid: process.pid,
        estimateMin: 5,
      }),
    ).toThrow("release slot");
    ask(s, "browser");
    const r = s.askRelease({
      who: "me",
      label: "release check",
      pid: process.pid,
      estimateMin: 5,
    });
    expect(r.kind).toBe("release");
    expect(r.grantedAt).toBeDefined();
  });

  it("issue 511: two browser slots on a quiet machine; the PTY count is read", () => {
    let used = 10;
    const s = new GateStore({
      ...FAKE_MACHINE,
      dir: tmp(),
      ptys: () => ({ used, max: 511 }),
    });
    s.writeSettings({ browser_slots: 2 });
    expect(ask(s, "browser").grantedAt).toBeDefined();
    used = 470;
    const b = ask(s, "browser");
    expect(b.grantedAt).toBeUndefined();
    used = 10;
    expect(s.get(b.id)?.grantedAt).toBeDefined();
  });

  it("settings: permissive defaults, null clears, nonsense ignored", () => {
    const s = new GateStore({ ...FAKE_MACHINE, dir: tmp(), cores: () => 8 });
    expect(s.settings()).toEqual(S8);
    s.writeSettings({ cpu_slots: 4 });
    expect(s.settings().cpuSlots).toBe(4);
    s.writeSettings({ browser_slots: 3, pty_headroom: 80 });
    expect(s.settings()).toMatchObject({ browserSlots: 3, ptyHeadroom: 80 });
    s.writeSettings({ browser_slots: null, pty_headroom: null });
    s.writeSettings({ cpu_beside_browser: 0, max_load_per_core: 4.5 });
    expect(s.settings()).toMatchObject({
      cpuBesideBrowser: 0,
      maxLoadPerCore: 4.5,
    });
    s.writeSettings({
      cpu_slots: null,
      overrun_margin_minutes: -3,
      cpu_beside_browser: null,
      max_load_per_core: null,
    });
    expect(s.settings()).toEqual(S8);
  });

  it("the grant waits for the lock; a stale lock (30 s) is taken back", () => {
    const dir = tmp();
    const s = new GateStore({ ...FAKE_MACHINE, dir, lockWaitMs: 200 });
    fs.mkdirSync(path.join(dir, "lock"));
    expect(() => ask(s, "cpu")).toThrow("the gate-slot lock");
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(path.join(dir, "lock"), old, old);
    expect(ask(s, "cpu").grantedAt).toBeDefined();
  });

  it("issue 275: a lock whose holder is gone is taken back at once; a live holder's is not", () => {
    const dir = tmp();
    const lock = path.join(dir, "lock");
    const dead = new GateStore({
      ...FAKE_MACHINE,
      dir,
      lockWaitMs: 200,
      alive: (pid) => pid !== 999999,
    });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "pid"), "999999");
    // A killed process left a fresh lock: no 30 s wait for it.
    expect(ask(dead, "cpu").grantedAt).toBeDefined();
    expect(fs.existsSync(lock)).toBe(false);
    const live = new GateStore({
      ...FAKE_MACHINE,
      dir,
      lockWaitMs: 200,
      alive: () => true,
    });
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), "999999");
    expect(() => ask(live, "browser")).toThrow("the gate-slot lock");
  });

  it("eight processes asking at once: exactly one browser grant", async () => {
    const dir = tmp();
    const child = path.join(__dirname, "ask-child.ts");
    const at = String(Date.now() + 2_000);
    const outs = await Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7].map(
        () =>
          new Promise<string>((resolve) => {
            const k = spawn(process.execPath, ["--import", "tsx", child], {
              env: {
                ...process.env,
                DEN_GATE_DIR: dir,
                GATE_RACE_AT: at,
                TSX_DISABLE_CACHE: "1",
              },
            });
            kids.push(k);
            let out = "";
            k.stdout.on("data", (d: Buffer) => {
              out += String(d);
              if (out.includes("\n")) resolve(out.trim());
            });
          }),
      ),
    );
    expect(outs.filter((o) => o === "granted")).toHaveLength(1);
    expect(outs.filter((o) => o === "waiting")).toHaveLength(7);
  }, 30_000);
});

describe("Settings › Server: the machine's gate settings (POST gate_slots)", () => {
  it("takes numbers in range, null clears; anything else says what is right", () => {
    expect(
      checkGatePatch({ cpu_slots: 3, overrun_margin_minutes: null }),
    ).toEqual({
      ok: true,
      patch: { cpu_slots: 3, overrun_margin_minutes: null },
    });
    expect(checkGatePatch({ cpu_slots: 0 })).toEqual({
      ok: false,
      error: "gate_slots.cpu_slots is a whole number from 1 to 64, or null",
    });
    expect(checkGatePatch({ cpu_slots: 2.5 })).toMatchObject({ ok: false });
    expect(
      checkGatePatch({ cpu_beside_browser: 0, max_load_per_core: 1.5 }),
    ).toMatchObject({ ok: true });
    expect(
      checkGatePatch({ browser_slots: 2, pty_headroom: 50 }),
    ).toMatchObject({ ok: true });
    expect(checkGatePatch({ browser_slots: 0 })).toMatchObject({ ok: false });
    expect(checkGatePatch({ cpu_beside_browser: 1.5 })).toMatchObject({
      ok: false,
    });
    expect(checkGatePatch({ overrun_margin_minutes: "30" })).toMatchObject({
      ok: false,
    });
    expect(checkGatePatch({ lease_minutes: 5 })).toMatchObject({ ok: false });
    expect(checkGatePatch([])).toMatchObject({ ok: false });
  });

  it("is a person's only", () => {
    expect(PERSON_ONLY_SETTINGS).toContain("gate_slots");
  });
});
