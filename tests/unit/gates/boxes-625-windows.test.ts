/**
 * Issue 625 follow-up: a test box's time window, its on/off switch, and
 * its own recheck time. Outside its window, or turned off, a box gets no
 * slot and Den makes no contact with it (no hold-file read, no TCP
 * connect). A held or unreachable box is contacted at most once per its
 * recheck_seconds. A run that holds a box's slot finishes across the
 * window's close. An old settings.json with boxes loads unchanged. The
 * box check is a counting fake: nothing reaches a real box. Times are the
 * gate host's local time, as the window is.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  boxOff,
  checkBox,
  type BoxProbe,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { boxLines } from "../../../src/ui/cli/doctor-boxes.js";
import {
  boxStatusLines,
  cmdGate,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-boxwin-"));
  tmps.push(d);
  return d;
};

/** A local time on one day (the window is the host's local time). */
const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();

function storeWith(
  boxes: Partial<GateBox>[],
  start: number,
  answer: Awaited<ReturnType<BoxProbe>>["state"] = "open",
) {
  let now = start;
  const contacts: string[] = [];
  const probe: BoxProbe = (b) => {
    contacts.push(b.name);
    return Promise.resolve({
      state: answer,
      ...(answer === "held" ? { reason: "its hold file is there" } : {}),
    });
  };
  const dir = tmp();
  const store = new GateStore({
    dir,
    alive: () => true,
    now: () => now,
    probe,
  });
  for (const b of boxes) store.setBox({ ssh: "ci@b.test", ...b });
  return {
    store,
    dir,
    contacts,
    tick: (ms: number) => (now += ms),
    set: (t: number) => (now = t),
  };
}

const ask = (store: GateStore, where = "box1") =>
  store.ask({
    kind: "browser",
    who: "t",
    label: "e2e",
    pid: 1,
    estimateMin: 10,
    where,
  });

describe("a box's settings: window, on/off, recheck", () => {
  it("checks a window, an on/off switch and a recheck time; says what is wrong", () => {
    const c = checkBox({
      name: "box1",
      ssh: "ci@b.test",
      window: " 22:00 - 06:00 ",
      enabled: false,
      recheck_seconds: 600,
    });
    expect(c.ok && c.box).toMatchObject({
      window: "22:00-06:00",
      enabled: false,
      recheck_seconds: 600,
    });
    const bad = (more: Record<string, unknown>) => {
      const r = checkBox({ name: "box1", ssh: "ci@b.test", ...more });
      return r.ok ? "" : r.error;
    };
    expect(bad({ window: "25:00-08:00" })).toMatch(/window is HH:MM-HH:MM/);
    expect(bad({ window: "08:00-08:00" })).toMatch(/opens and closes/);
    expect(bad({ enabled: "no" })).toMatch(/enabled is true or false/);
    expect(bad({ recheck_seconds: 0 })).toMatch(/recheck_seconds/);
  });

  it("an old settings.json with boxes loads unchanged: on, no window, the global recheck", () => {
    const dir = tmp();
    const old = [
      { name: "box1", ssh: "ci@b.test", browser_slots: 2, hold_file: "h" },
      { name: "box2", playwright: "ws://b2.test:3000", browser_slots: 1 },
    ];
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ cpu_slots: 2, boxes: old }),
    );
    const store = new GateStore({ dir, alive: () => true });
    expect(store.boxes()).toEqual(old);
    for (const b of store.boxes()) expect(boxOff(b, at(12))).toBeNull();
    // Saving a box on, with no window, writes nothing new.
    store.setBox({ ...old[0], enabled: true });
    const file = JSON.parse(
      fs.readFileSync(path.join(dir, "settings.json"), "utf-8"),
    ) as { boxes: Record<string, unknown>[] };
    for (const b of file.boxes) {
      expect(b).not.toHaveProperty("enabled");
      expect(b).not.toHaveProperty("window");
      expect(b).not.toHaveProperty("recheck_seconds");
    }
  });
});

describe("the window", () => {
  it("inside its window a box gets a slot; outside, none and no contact", async () => {
    const s = storeWith([{ name: "box1", window: "00:00-08:00" }], at(9));
    const a = ask(s.store);
    for (let i = 0; i < 5; i++) {
      await s.store.checkBoxes();
      s.tick(60_000);
    }
    expect(s.store.get(a.id)?.grantedAt).toBeUndefined();
    expect(s.contacts).toEqual([]);
    s.set(at(3));
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.box).toBe("box1");
    expect(s.contacts).toEqual(["box1"]);
  });

  it("an overnight window (22:00-06:00) is open late and early, closed midday", () => {
    const b = { name: "box1", browser_slots: 1, window: "22:00-06:00" };
    expect(boxOff(b, at(23))).toBeNull();
    expect(boxOff(b, at(5, 59))).toBeNull();
    expect(boxOff(b, at(6))).toMatchObject({ why: "window", opens: "22:00" });
    expect(boxOff(b, at(12))).toMatchObject({ why: "window", opens: "22:00" });
  });

  it("an overnight box takes a run at 23:00 and none at noon", async () => {
    const s = storeWith([{ name: "box1", window: "22:00-06:00" }], at(12));
    const a = ask(s.store);
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.grantedAt).toBeUndefined();
    expect(s.contacts).toEqual([]);
    s.set(at(23));
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.box).toBe("box1");
  });

  it("a run holding a box's slot finishes across the close; no new slot after it", async () => {
    const s = storeWith(
      [{ name: "box1", window: "00:00-08:00", browser_slots: 2 }],
      at(7, 59),
    );
    const a = ask(s.store);
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.box).toBe("box1");
    s.set(at(8, 30));
    const b = ask(s.store);
    await s.store.checkBoxes();
    expect(s.store.get(a.id)).toMatchObject({ box: "box1" });
    expect(s.store.get(a.id)?.grantedAt).toBeDefined();
    expect(s.store.get(b.id)?.grantedAt).toBeUndefined();
    expect(s.contacts).toEqual(["box1"]);
    // The queue still counts the running slot, and says why the box is skipped.
    const v = gateView(s.store).boxes[0]!;
    expect(v).toMatchObject({ held: 1, state: "window", opens: "00:00" });
  });

  it("a run that may go anywhere takes this machine, never a closed box", async () => {
    const s = storeWith([{ name: "box1", window: "00:00-08:00" }], at(12));
    const here = s.store.ask({
      kind: "browser",
      who: "t",
      label: "a",
      pid: 1,
      estimateMin: 10,
    });
    expect(s.store.get(here.id)?.grantedAt).toBeDefined();
    const any = ask(s.store, "any");
    await s.store.checkBoxes();
    expect(s.store.get(any.id)?.grantedAt).toBeUndefined();
    expect(s.contacts).toEqual([]);
  });
});

describe("on and off", () => {
  it("a box turned off gets no slot and no contact; turned on, it does", async () => {
    const s = storeWith([{ name: "box1", enabled: false }], at(12));
    const a = ask(s.store);
    for (let i = 0; i < 5; i++) {
      await s.store.checkBoxes();
      s.tick(60_000);
    }
    expect(s.store.get(a.id)?.grantedAt).toBeUndefined();
    expect(s.contacts).toEqual([]);
    expect(s.store.setBoxEnabled("box1", true)?.enabled).toBeUndefined();
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.box).toBe("box1");
    expect(s.store.setBoxEnabled("box1", false)?.enabled).toBe(false);
    expect(s.store.setBoxEnabled("nope", false)).toBeNull();
  });
});

describe("no polling a fragile box", () => {
  it("a held box inside its window is contacted at most once per recheck_seconds", async () => {
    const s = storeWith(
      [{ name: "box1", window: "00:00-08:00", recheck_seconds: 300 }],
      at(1),
      "held",
    );
    ask(s.store);
    // A waiter calls in every 10 s for 20 minutes.
    for (let i = 0; i < 120; i++) {
      await s.store.checkBoxes();
      s.tick(10_000);
    }
    expect(s.contacts.length).toBe(4); // at 0, 300, 600 and 900 s
  });

  it("an unreachable box without its own recheck_seconds uses box_recheck_seconds", async () => {
    const s = storeWith([{ name: "box1" }], at(1), "unreachable");
    ask(s.store);
    for (let i = 0; i < 12; i++) {
      await s.store.checkBoxes();
      s.tick(10_000);
    }
    expect(s.contacts.length).toBe(4); // the global 30 s: 0, 30, 60, 90
  });

  it("zero contacts outside its window or turned off, however long a run waits", async () => {
    const s = storeWith(
      [
        { name: "box1", window: "00:00-08:00", recheck_seconds: 5 },
        { name: "box2", enabled: false, recheck_seconds: 5 },
      ],
      at(9),
      "held",
    );
    ask(s.store, "box1");
    ask(s.store, "box2");
    ask(s.store, "any");
    for (let i = 0; i < 120; i++) {
      await s.store.checkBoxes();
      s.tick(10_000);
    }
    expect(s.contacts).toEqual([]);
  });
});

describe("why a box is skipped: gate status, the queue, doctor", () => {
  function deps(store: GateStore) {
    const out: string[] = [];
    const err: string[] = [];
    const d: GateDeps = {
      store,
      env: {},
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => at(12),
      sleep: () => Promise.resolve(),
      exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: "/x/repo",
    };
    return { d, out, err };
  }

  it("each says 'outside its window (opens 00:00)' and 'turned off'", async () => {
    const s = storeWith(
      [
        { name: "box1", window: "00:00-08:00" },
        { name: "box2", enabled: false },
      ],
      at(12),
    );
    const status = boxStatusLines(s.store, s.store.list()).join("\n");
    expect(status).toMatch(
      /box box1: skipped, outside its window \(opens 00:00\)/,
    );
    expect(status).toMatch(/box box2: skipped, turned off/);
    const doctor = boxLines(s.store).lines.join("\n");
    expect(doctor).toMatch(/box1 .*outside its window \(opens 00:00\)/);
    expect(doctor).toMatch(/box2 .*turned off/);
    expect(boxLines(s.store).check.status).toBe("ok");
    const v = gateView(s.store).boxes;
    expect(v[0]).toMatchObject({
      name: "box1",
      state: "window",
      opens: "00:00",
    });
    expect(typeof v[0]!.opensAt).toBe("string");
    expect(v[1]).toMatchObject({ name: "box2", state: "off" });
    const t = deps(s.store);
    expect(await cmdGate(["status"], t.d)).toBe(0);
    expect(t.out.join("\n")).toMatch(/outside its window \(opens 00:00\)/);
  });

  it("`gate box add` takes --window, --off and --recheck-seconds; enable and disable switch it; an agent can't", async () => {
    const s = storeWith([], at(12));
    const t = deps(s.store);
    expect(
      await cmdGate(
        [
          "box",
          "add",
          "box1",
          "--ssh",
          "ci@b.test",
          "--window",
          "22:00-06:00",
          "--off",
          "--recheck-seconds",
          "120",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(s.store.boxes()[0]).toMatchObject({
      window: "22:00-06:00",
      enabled: false,
      recheck_seconds: 120,
    });
    expect(await cmdGate(["box", "enable", "box1"], t.d)).toBe(0);
    expect(s.store.boxes()[0]!.enabled).toBeUndefined();
    expect(await cmdGate(["box", "disable", "box1"], t.d)).toBe(0);
    expect(s.store.boxes()[0]!.enabled).toBe(false);
    expect(await cmdGate(["box", "list"], t.d)).toBe(0);
    expect(t.out.join("\n")).toMatch(
      /box1 .*window 22:00-06:00 \(this machine's time\).*turned off/,
    );
    expect(await cmdGate(["box", "enable", "nope"], t.d)).toBe(1);
    const agent = deps(s.store);
    agent.d.env = { DEN_AGENT: "agent:x" };
    expect(await cmdGate(["box", "disable", "box1"], agent.d)).toBe(2);
    expect(agent.err.join("\n")).toMatch(/only a person/);
  });
});
