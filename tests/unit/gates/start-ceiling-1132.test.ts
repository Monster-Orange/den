/**
 * Issue 1132, clauses 3 and 4: no run starts above a load ceiling.
 *
 * `gates.max_start_load` is the 5-minute load average (the total, not per
 * core; default cores × 1.5, under where the machine stalls; 0 turns it
 * off). A granted run whose machine is at or over it doesn't start its
 * command: it waits, with the reason shown, until the load is under it.
 * After `gates.max_start_wait_minutes` (default 10; issue 460's wait
 * limit) it starts anyway, and its record says it started busy.
 *
 * `gates.reap_grace_seconds` (default 10) is how long a stopped run's
 * leftovers get between TERM and KILL (clause 1; the real-process tests
 * are in reap-1132.test.ts).
 *
 * The load is a stubbed reader (GateStoreOpts.load): nothing here reads
 * the real machine's load, and no real command runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GATE_DEFAULTS,
  maxStartLoadDefault,
  startHold,
} from "../../../src/shared/gates/rules.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import {
  cmdGate,
  slotLine,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";
import {
  leftoverWords,
  startHoldWords,
} from "../../../src/ui/server/public/gate-chip.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("the rule and its settings (pure)", () => {
  it("the defaults: ceiling cores × 1.5, wait 10 min, grace 10 s", () => {
    const cores = os.availableParallelism?.() ?? os.cpus().length;
    expect(maxStartLoadDefault()).toBe(Math.round(Math.max(1, cores) * 1.5));
    expect(GATE_DEFAULTS.maxStartLoad).toBe(maxStartLoadDefault());
    expect(GATE_DEFAULTS.maxStartWaitMinutes).toBe(10);
    expect(GATE_DEFAULTS.reapGraceSeconds).toBe(10);
  });

  it("at or over the ceiling holds; under it, off, or unread does not", () => {
    expect(startHold({ maxStartLoad: 27 }, 30)).toEqual({
      load: 30,
      limit: 27,
    });
    expect(startHold({ maxStartLoad: 27 }, 27)).toEqual({
      load: 27,
      limit: 27,
    });
    expect(startHold({ maxStartLoad: 27 }, 26.9)).toBeUndefined();
    expect(startHold({ maxStartLoad: 0 }, 999)).toBeUndefined();
    expect(startHold({ maxStartLoad: 27 }, NaN)).toBeUndefined();
    expect(startHold({ maxStartLoad: 27 }, undefined)).toBeUndefined();
  });

  it("the three settings are checked at the boundary", () => {
    expect(
      checkGatePatch({
        max_start_load: 30,
        max_start_wait_minutes: 0,
        reap_grace_seconds: 5,
      }),
    ).toEqual({
      ok: true,
      patch: {
        max_start_load: 30,
        max_start_wait_minutes: 0,
        reap_grace_seconds: 5,
      },
    });
    expect(checkGatePatch({ max_start_load: 2000 }).ok).toBe(false);
    expect(checkGatePatch({ max_start_load: -1 }).ok).toBe(false);
    expect(checkGatePatch({ reap_grace_seconds: 0.5 }).ok).toBe(false);
    expect(checkGatePatch({ reap_grace_seconds: -1 }).ok).toBe(false);
    expect(checkGatePatch({ max_start_wait_minutes: 1.5 }).ok).toBe(false);
  });

  it("a written setting is read back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1132-"));
    tmps.push(dir);
    const store = new GateStore({ platform: "linux", dir, load: () => 0 });
    store.writeSettings(
      { max_start_load: 33, max_start_wait_minutes: 4, reap_grace_seconds: 2 },
      "test",
    );
    const s = store.settings();
    expect(s.maxStartLoad).toBe(33);
    expect(s.maxStartWaitMinutes).toBe(4);
    expect(s.reapGraceSeconds).toBe(2);
  });
});

/** A gate run with a fake runner, clock and load; nothing real runs. */
function rig(o: { load: number; ceiling?: number; waitMin?: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1132-"));
  tmps.push(dir);
  const box = { load: o.load, now: Date.parse("2026-11-22T20:00:00Z") };
  const store = new GateStore({
    platform: "linux",
    dir,
    alive: () => true,
    load: () => box.load,
    now: () => box.now,
  });
  store.writeSettings(
    {
      max_start_load: o.ceiling ?? 27,
      ...(o.waitMin !== undefined
        ? { max_start_wait_minutes: o.waitMin }
        : {}),
    },
    "test",
  );
  const err: string[] = [];
  const ran: { sleeps: number }[] = [];
  let sleeps = 0;
  const onSleep: ((n: number) => void)[] = [];
  const d: GateDeps = {
    store,
    env: {},
    out: () => {},
    err: (l) => err.push(l),
    now: () => box.now,
    sleep: () => {
      sleeps++;
      box.now += 2_000;
      for (const f of onSleep) f(sleeps);
      return Promise.resolve();
    },
    exec: () => {
      ran.push({ sleeps });
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
  };
  const run = () =>
    cmdGate(
      ["run", "--kind", "cpu", "--label", "unit", "--", "npx", "jest"],
      d,
    );
  return { store, box, err, ran, onSleep, run };
}

describe("gate run under the ceiling", () => {
  it("over it: granted, but the command waits, says why, and starts once the load drops", async () => {
    const r = rig({ load: 40 });
    const seen: unknown[] = [];
    r.onSleep.push((n) => {
      if (n === 1) {
        seen.push(r.store.list()[0]?.startHold);
        seen.push(gateView(r.store, r.box.now).slots[0]?.startHold);
        seen.push(
          slotLine(r.store.list()[0]!, r.store.list(), r.box.now, {
            ...r.store.settings(),
          }),
        );
      }
      if (n === 3) r.box.load = 20;
    });
    expect(await r.run()).toBe(0);
    expect(r.ran).toHaveLength(1);
    expect(r.ran[0]!.sleeps).toBeGreaterThanOrEqual(3);
    expect(seen[0]).toMatchObject({ load: 40, limit: 27 });
    expect(seen[1]).toMatchObject({ load: 40, limit: 27 });
    expect(String(seen[2])).toContain("waiting for the load (40) to drop under 27");
    expect(r.err.join("\n")).toContain(
      "waiting for the load (40) to drop under 27",
    );
    const ev = r.store.events().map((e) => e.event);
    expect(ev).toContain("start-held");
    expect(ev).not.toContain("started-busy");
    // Started: the hold is gone from the record.
    expect(r.store.list()).toEqual([]);
  });

  it("under it: starts at once", async () => {
    const r = rig({ load: 10 });
    expect(await r.run()).toBe(0);
    expect(r.ran).toEqual([{ sleeps: 0 }]);
    expect(r.store.events().map((e) => e.event)).not.toContain("start-held");
  });

  it("off (0): starts at once whatever the load", async () => {
    const r = rig({ load: 999, ceiling: 0 });
    expect(await r.run()).toBe(0);
    expect(r.ran).toEqual([{ sleeps: 0 }]);
  });

  it("past the wait limit it starts anyway, and the record says busy, with the load", async () => {
    const r = rig({ load: 40, waitMin: 1 });
    expect(await r.run()).toBe(0);
    expect(r.ran).toHaveLength(1);
    // 2 s per sleep: about 30 sleeps to reach a minute, never far past it.
    expect(r.ran[0]!.sleeps).toBeGreaterThanOrEqual(30);
    expect(r.ran[0]!.sleeps).toBeLessThanOrEqual(32);
    const busy = r.store.events().find((e) => e.event === "started-busy");
    expect(busy).toMatchObject({ load: 40, limit: 27 });
    expect(r.err.join("\n")).toContain("starting anyway");
  });
});

describe("the Gate page's words", () => {
  const t = (k: string, v: Record<string, unknown> = {}) =>
    k + JSON.stringify(v);

  it("a run held by the ceiling says the load and the ceiling", () => {
    expect(
      startHoldWords({ startHold: { load: 40, limit: 27 } }, t),
    ).toBe('gate.startHold{"load":"40","limit":"27"}');
    expect(startHoldWords({}, t)).toBe("");
  });

  it("stopped leftovers say how many, the command and the run", () => {
    expect(
      leftoverWords(
        { count: 3, cmd: "node", label: "unit", reason: "gone", at: "x" },
        t,
      ),
    ).toBe('gate.leftovers{"n":3,"cmd":"node","label":"unit"}');
  });

  const pub = path.join(process.cwd(), "src/ui/server/public");
  const read = (f: string) => fs.readFileSync(path.join(pub, f), "utf-8");

  it("en, es and ja have the words, and the Settings rows", () => {
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = read(f);
      expect(src).toMatch(/"gate\.startHold":\s*"[^"]*\{load\}[^"]*\{limit\}/);
      const left = /"gate\.leftovers":\s*"([^"]*)"/.exec(src)?.[1] ?? "";
      for (const v of ["{n}", "{cmd}", "{label}"]) expect(left).toContain(v);
      for (const k of [
        "gate_max_start_load",
        "gate_max_start_wait_minutes",
        "gate_reap_grace_seconds",
      ]) {
        expect(src).toContain(`"set.server.${k}":`);
        expect(src).toContain(`"set.server.${k}.d":`);
      }
    }
    const reg = read("settings-registry.js");
    for (const k of [
      "max_start_load",
      "max_start_wait_minutes",
      "reap_grace_seconds",
    ])
      expect(reg).toContain(`"gate_slots.${k}"`);
  });
});

describe("gate status", () => {
  it("--json lists a held run's ceiling and the stopped leftovers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1132-"));
    tmps.push(dir);
    const store = new GateStore({ platform: "linux", dir, load: () => 0 });
    store.noteStopped({
      id: "g-1",
      kind: "cpu",
      who: "lane",
      label: "unit",
      cmd: "node",
      count: 3,
      reason: "gone",
    });
    const v = gateView(store, Date.now());
    expect(v.leftovers).toEqual([
      expect.objectContaining({
        count: 3,
        cmd: "node",
        label: "unit",
        reason: "gone",
      }),
    ]);
    const out: string[] = [];
    await cmdGate(["status"], {
      store,
      env: {},
      out: (l) => out.push(l),
      err: () => {},
      now: Date.now,
      sleep: () => Promise.resolve(),
      exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 1,
      cwd: "/x",
      lang: "en",
    });
    expect(out.join("\n")).toContain(
      "stopped 3 leftover processes of unit (node)",
    );
  });
});
