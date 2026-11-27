/**
 * Issue 144 GATE-SLOT: the queue rules and the machine's store. The store
 * lives in a temp DEN_GATE_DIR; no Den runs and no suite runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BOX_DEFAULTS } from "../../../src/shared/gates/boxes.js";
import {
  GATE_DEFAULTS,
  expectedStart,
  grants,
  overrun,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import {
  GateStore,
  checkGatePatch,
  gateDir,
} from "../../../src/shared/gates/store.js";
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
  // Issue 751: at cpu_slots_beside_browser 0, a browser run runs alone.
  const ALONE = { ...GATE_DEFAULTS, cpuSlotsBesideBrowser: 0 };

  it("a browser run holds the machine alone at 0 beside; the next one waits", () => {
    expect(grants([entry("a", "browser", 0)], GATE_DEFAULTS)).toEqual(["a"]);
    expect(
      grants(
        [entry("a", "browser", 0, 0), entry("b", "browser", 1)],
        GATE_DEFAULTS,
      ),
    ).toEqual([]);
    expect(
      grants([entry("a", "browser", 0, 0), entry("c", "cpu", 1)], ALONE),
    ).toEqual([]);
  });

  it("cpu runs share up to cpu_slots", () => {
    const q = [
      entry("a", "cpu", 0),
      entry("b", "cpu", 1),
      entry("c", "cpu", 2),
    ];
    expect(grants(q, GATE_DEFAULTS)).toEqual(["a", "b"]);
    expect(grants(q, { ...GATE_DEFAULTS, cpuSlots: 3 })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("at 0 beside, a browser run waits for cpu to drain, and stops new cpu grants", () => {
    const q = [
      entry("a", "cpu", 0, 0),
      entry("b", "browser", 1),
      entry("c", "cpu", 2),
    ];
    expect(grants(q, ALONE)).toEqual([]);
    expect(grants(q.slice(1), ALONE)).toEqual(["b"]);
  });

  it("a waiter sees when it may start; an overrun is flagged past the margin", () => {
    const q = [
      entry("a", "browser", 0, 0, 6),
      entry("b", "browser", 1, undefined, 4),
      entry("c", "browser", 2),
    ];
    expect(expectedStart(q, "b", T0)).toBe(T0 + 6 * 60_000);
    expect(expectedStart(q, "c", T0)).toBe(T0 + 10 * 60_000);
    expect(overrun(q[0]!, GATE_DEFAULTS, T0 + 20 * 60_000)).toBe(false);
    expect(overrun(q[0]!, GATE_DEFAULTS, T0 + 22 * 60_000)).toBe(true);
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
    const s = new GateStore({ dir: tmp() });
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
    const s = new GateStore({ dir: tmp(), now: () => now });
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
    const s = new GateStore({ dir: tmp(), alive: (p) => pids.has(p) });
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
    const s = new GateStore({ dir: tmp() });
    ask(s, "browser", exited);
    expect(s.list()).toEqual([]);
    expect(s.events().map((e) => e.event)).toContain("taken-back-gone");
  });

  it("a holder whose wrapper died keeps the slot while its run goes on", () => {
    const pids = new Set([100, 200]);
    const s = new GateStore({ dir: tmp(), alive: (p) => pids.has(p) });
    const a = ask(s, "browser", 100);
    s.setRunPid(a.id, 200);
    pids.delete(100);
    expect(s.get(a.id)?.grantedAt).toBeDefined();
    pids.delete(200);
    expect(s.get(a.id)).toBeNull();
  });

  it("a live holder is never taken back, however long it is quiet", () => {
    let now = T0;
    const s = new GateStore({ dir: tmp(), now: () => now });
    const a = ask(s, "cpu");
    now += 24 * 60 * 60_000;
    expect(s.list().map((e) => e.id)).toEqual([a.id]);
  });

  it("an overdue slot is flagged once, recorded, never removed", () => {
    let now = T0;
    const s = new GateStore({ dir: tmp(), now: () => now });
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
    const s = new GateStore({ dir: tmp() });
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

  it("settings: permissive defaults, null clears, nonsense ignored", () => {
    const s = new GateStore({ dir: tmp() });
    expect(s.settings()).toEqual({ ...GATE_DEFAULTS, ...BOX_DEFAULTS });
    s.writeSettings({ cpu_slots: 4 });
    expect(s.settings().cpuSlots).toBe(4);
    s.writeSettings({ cpu_slots: null, overrun_margin_minutes: -3 });
    expect(s.settings()).toEqual({ ...GATE_DEFAULTS, ...BOX_DEFAULTS });
  });

  it("the grant waits for the lock; a stale lock (30 s) is taken back", () => {
    const dir = tmp();
    const s = new GateStore({ dir, lockWaitMs: 200 });
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
      dir,
      lockWaitMs: 200,
      alive: (pid) => pid !== 999999,
    });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "pid"), "999999");
    // A killed process left a fresh lock: no 30 s wait for it.
    expect(ask(dead, "cpu").grantedAt).toBeDefined();
    expect(fs.existsSync(lock)).toBe(false);
    const live = new GateStore({ dir, lockWaitMs: 200, alive: () => true });
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
