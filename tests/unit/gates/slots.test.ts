/**
 * 0.4.49 GATE-SLOT (den#144): the queue rules and the machine's store.
 * The store lives in a temp DEN_GATE_DIR; no Den runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
  aliveAt: iso(grantedMin ?? askedMin),
  estimateMin,
  ...(grantedMin !== undefined ? { grantedAt: iso(grantedMin) } : {}),
});

describe("the queue rules", () => {
  it("a browser run holds the machine alone; the next one waits", () => {
    expect(grants([entry("a", "browser", 0)], GATE_DEFAULTS)).toEqual(["a"]);
    expect(
      grants(
        [entry("a", "browser", 0, 0), entry("b", "browser", 1)],
        GATE_DEFAULTS,
      ),
    ).toEqual([]);
    expect(
      grants(
        [entry("a", "browser", 0, 0), entry("c", "cpu", 1)],
        GATE_DEFAULTS,
      ),
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

  it("a browser run waits for cpu to drain, and stops new cpu grants", () => {
    const q = [
      entry("a", "cpu", 0, 0),
      entry("b", "browser", 1),
      entry("c", "cpu", 2),
    ];
    expect(grants(q, GATE_DEFAULTS)).toEqual([]);
    expect(grants(q.slice(1), GATE_DEFAULTS)).toEqual(["b"]);
  });

  it("a waiter sees when it may start; an overrun is flagged", () => {
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
  const ask = (s: GateStore, kind: "browser" | "cpu", pid = process.pid) =>
    s.ask({ kind, who: "me", label: "suite", pid, estimateMin: 5 });

  it("lives in DEN_GATE_DIR, else one place per machine user", () => {
    expect(gateDir({ DEN_GATE_DIR: "/x/y" })).toBe("/x/y");
    expect(gateDir({ HOME: "/h" })).toMatch(/^\/h\/.*den\/gate-slots$/);
  });

  it("grants, queues, and grants the next on release, each recorded", () => {
    const s = new GateStore({ dir: tmp() });
    const a = ask(s, "browser");
    const b = ask(s, "browser");
    expect(a.grantedAt).toBeDefined();
    expect(b.grantedAt).toBeUndefined();
    expect(s.release(a.id)).toBe(true);
    expect(s.list().find((e) => e.id === b.id)?.grantedAt).toBeDefined();
    expect(s.events().map((e) => e.event)).toEqual([
      "asked",
      "granted",
      "asked",
      "released",
      "granted",
    ]);
  });

  it("a holder whose process is gone is taken back on the next read", () => {
    const gone = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const s = new GateStore({ dir: tmp() });
    const a = ask(s, "browser", gone);
    expect(s.list().some((e) => e.id === a.id)).toBe(false);
    expect(s.events().map((e) => e.event)).toContain("taken-back-gone");
  });

  it("a holder quiet past the lease is taken back; renewing keeps it", () => {
    let now = T0;
    const s = new GateStore({ dir: tmp(), now: () => now });
    s.writeSettings({ lease_minutes: 10 });
    const a = ask(s, "cpu");
    now += 9 * 60_000;
    expect(s.renew(a.id)).not.toBeNull();
    now += 9 * 60_000;
    expect(s.list().map((e) => e.id)).toEqual([a.id]);
    now += 2 * 60_000;
    expect(s.list()).toEqual([]);
    expect(s.events().at(-1)).toMatchObject({ event: "taken-back-quiet" });
  });

  it("an overrun is flagged, never removed", () => {
    let now = T0;
    const s = new GateStore({ dir: tmp(), now: () => now });
    s.writeSettings({ lease_minutes: 600 });
    const a = ask(s, "browser");
    now += 60 * 60_000;
    const [held] = s.list();
    expect(held?.id).toBe(a.id);
    expect(overrun(held!, s.settings(), now)).toBe(true);
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
  });

  it("settings: permissive defaults, null clears, nonsense ignored", () => {
    const s = new GateStore({ dir: tmp() });
    expect(s.settings()).toEqual(GATE_DEFAULTS);
    s.writeSettings({ cpu_slots: 4 });
    expect(s.settings().cpuSlots).toBe(4);
    s.writeSettings({ cpu_slots: null, lease_minutes: -3 });
    expect(s.settings()).toEqual(GATE_DEFAULTS);
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
      checkGatePatch({
        cpu_slots: 3.7,
        lease_minutes: null,
        overrun_margin_minutes: 0,
      }),
    ).toEqual({
      ok: true,
      patch: { cpu_slots: 3, lease_minutes: null, overrun_margin_minutes: 0 },
    });
    expect(checkGatePatch({ cpu_slots: 0 })).toEqual({
      ok: false,
      error: "gate_slots.cpu_slots is a number from 1 to 64, or null",
    });
    expect(checkGatePatch({ lease_minutes: "30" })).toMatchObject({
      ok: false,
    });
    expect(checkGatePatch([])).toMatchObject({ ok: false });
  });

  it("is a person's only", () => {
    expect(PERSON_ONLY_SETTINGS).toContain("gate_slots");
  });
});
