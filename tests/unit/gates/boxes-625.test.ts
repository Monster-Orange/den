/**
 * Issue 625: a browser slot per test box. The boxes are Settings; a box
 * is checked (its hold file, or that it answers) only when a slot on it
 * is about to be given, through an injected probe: nothing here reaches
 * a real box. A temp DEN_GATE_DIR; no Den runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assign,
  boxEnv,
  checkBox,
  type BoxProbe,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";
import {
  GATE_DEFAULTS,
  grants,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { boxLines } from "../../../src/ui/cli/doctor-boxes.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-box-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-20T06:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const entry = (
  id: string,
  kind: "browser" | "cpu",
  askedMin: number,
  more: Partial<GateEntry> = {},
): GateEntry => ({
  id,
  kind,
  who: id,
  label: id,
  pid: 1,
  askedAt: iso(askedMin),
  estimateMin: 10,
  ...more,
});

/** A probe whose answer per box the test sets; it counts its calls. */
function fakeProbe() {
  const answers: Record<
    string,
    { state: "open" | "held" | "unreachable"; reason?: string }
  > = {};
  const calls: string[] = [];
  const probe: BoxProbe = (box) => {
    calls.push(box.name);
    return Promise.resolve(answers[box.name] ?? { state: "open" });
  };
  return { probe, answers, calls };
}

const box = (name: string, more: Partial<GateBox> = {}): GateBox => ({
  name,
  ssh: `ci@${name}.test`,
  browser_slots: 1,
  hold_file: "heavy.hold",
  ...more,
});

function storeWith(boxes: GateBox[]) {
  const f = fakeProbe();
  let now = T0;
  const store = new GateStore({
    platform: "linux",
    dir: tmp(),
    alive: () => true,
    now: () => now,
    probe: f.probe,
  });
  for (const b of boxes) store.setBox(b);
  return { store, ...f, tick: (ms: number) => (now += ms) };
}

const ask = (store: GateStore, where?: string, kind: "browser" = "browser") =>
  store.ask({
    kind,
    who: "t",
    label: "e2e",
    pid: 1,
    estimateMin: 10,
    ...(where ? { where } : {}),
  });

describe("assign (the queue rules with boxes)", () => {
  it("with no boxes it gives exactly what grants gives", () => {
    const cases: GateEntry[][] = [
      [entry("a", "browser", 0), entry("b", "cpu", 1), entry("c", "cpu", 2)],
      [entry("a", "cpu", 0), entry("b", "cpu", 1), entry("c", "cpu", 2)],
      [
        entry("a", "cpu", 0, { grantedAt: iso(0) }),
        entry("b", "browser", 1),
        entry("c", "cpu", 2),
      ],
      [
        entry("a", "browser", 0, { grantedAt: iso(0) }),
        entry("b", "cpu", 1),
        entry("c", "browser", 2, { where: "any" }),
      ],
    ];
    for (const q of cases)
      expect(assign(q, GATE_DEFAULTS, T0).map((a) => a.id)).toEqual(
        grants(q, GATE_DEFAULTS, T0),
      );
  });

  it("two boxes: two browser runs hold one each, a third waits", () => {
    const boxes = [
      { name: "b1", slots: 1, open: true },
      { name: "b2", slots: 1, open: true },
    ];
    const q = [
      entry("x", "browser", 0, { grantedAt: iso(0) }), // this machine's
      entry("a", "browser", 1, { where: "any" }),
      entry("b", "browser", 2, { where: "any" }),
      entry("c", "browser", 3, { where: "any" }),
    ];
    expect(assign(q, GATE_DEFAULTS, T0, boxes)).toEqual([
      { id: "a", box: "b1" },
      { id: "b", box: "b2" },
    ]);
  });

  it("a run that needs this machine waits, and never blocks a later run from a box", () => {
    const boxes = [{ name: "b1", slots: 1, open: true }];
    const q = [
      entry("x", "browser", 0, { grantedAt: iso(0) }),
      entry("local", "browser", 1),
      entry("any", "browser", 2, { where: "any" }),
    ];
    expect(assign(q, GATE_DEFAULTS, T0, boxes)).toEqual([
      { id: "any", box: "b1" },
    ]);
  });

  it("first come, first served on a box: a waiter keeps the box from the runs behind it", () => {
    const boxes = [{ name: "b1", slots: 1, open: true }];
    const q = [
      entry("h", "browser", 0, { grantedAt: iso(0), box: "b1" }),
      entry("w1", "browser", 1, { where: "b1" }),
      entry("w2", "browser", 2, { where: "any" }),
    ];
    // w2 may run here (the machine is free); the box stays w1's.
    expect(assign(q, GATE_DEFAULTS, T0, boxes)).toEqual([{ id: "w2" }]);
  });

  it("a box not checked open gives no slot", () => {
    const q = [
      entry("x", "browser", 0, { grantedAt: iso(0) }),
      entry("a", "browser", 1, { where: "any" }),
    ];
    expect(
      assign(q, GATE_DEFAULTS, T0, [{ name: "b1", slots: 1, open: false }]),
    ).toEqual([]);
  });
});

describe("the store with boxes", () => {
  it("with no boxes set, nothing is checked and the queue is as before", async () => {
    const s = storeWith([]);
    const a = ask(s.store, "any");
    const b = ask(s.store, "any");
    await s.store.checkBoxes();
    expect(a.grantedAt).toBeDefined();
    expect(s.store.get(b.id)?.grantedAt).toBeUndefined();
    expect(s.calls).toEqual([]);
    expect(gateView(s.store).boxes).toEqual([]);
  });

  it("two boxes: two browser runs at once, one per box; a third waits for whichever frees first", async () => {
    const s = storeWith([box("b1"), box("b2")]);
    const here = ask(s.store); // this machine's slot
    s.tick(1);
    const a = ask(s.store, "any");
    s.tick(1);
    const b = ask(s.store, "any");
    s.tick(1);
    const c = ask(s.store, "any");
    expect(here.grantedAt).toBeDefined();
    await s.store.checkBoxes();
    s.store.list();
    await s.store.checkBoxes();
    const got = s.store.list();
    const on = (id: string) => got.find((e) => e.id === id);
    expect([on(a.id)?.box, on(b.id)?.box].sort()).toEqual(["b1", "b2"]);
    expect(on(c.id)?.grantedAt).toBeUndefined();
    // b2's run ends: c takes b2.
    const onB2 = [a, b].find((e) => on(e.id)?.box === "b2")!;
    s.store.release(onB2.id);
    await s.store.checkBoxes();
    expect(s.store.get(c.id)?.box).toBe("b2");
    // The slot log names the box.
    const granted = s.store
      .events()
      .filter((e) => e.event === "granted" && e.box);
    expect(granted.map((e) => e.box).sort()).toEqual(["b1", "b2", "b2"]);
  });

  it("a box is checked only when a slot on it is about to be given", async () => {
    const s = storeWith([box("b1")]);
    await s.store.checkBoxes(); // no one waits
    s.store.list();
    expect(s.calls).toEqual([]);
    const a = ask(s.store); // takes this machine; no box wanted
    await s.store.checkBoxes();
    expect(s.calls).toEqual([]);
    ask(s.store, "any");
    await s.store.checkBoxes();
    expect(s.calls).toEqual(["b1"]);
    // The box is full now: no more checks.
    ask(s.store, "any");
    await s.store.checkBoxes();
    await s.store.checkBoxes();
    expect(s.calls).toEqual(["b1"]);
    expect(a.grantedAt).toBeDefined();
  });

  it("a hold file stops new slots on that box within one assignment, and removing it opens them again", async () => {
    const s = storeWith([box("b1", { browser_slots: 2 })]);
    ask(s.store); // this machine
    const a = ask(s.store, "any");
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.box).toBe("b1");
    // The person places the hold file. The next assignment reads it.
    s.answers.b1 = { state: "held", reason: "its hold file is there" };
    const b = ask(s.store, "any");
    await s.store.checkBoxes();
    expect(s.store.get(b.id)?.grantedAt).toBeUndefined();
    // a's slot is untouched: a running slot finishes.
    expect(s.store.get(a.id)?.box).toBe("b1");
    const v = gateView(s.store).boxes.find((x) => x.name === "b1")!;
    expect(v.state).toBe("held");
    expect(v.reason).toMatch(/hold file/);
    // Removed: after the recheck time, the next wanted slot is given.
    s.answers.b1 = { state: "open" };
    s.tick(31_000);
    await s.store.checkBoxes();
    expect(s.store.get(b.id)?.box).toBe("b1");
  });

  it("an unreachable box is skipped with why, and the run goes to another box", async () => {
    const s = storeWith([box("b1"), box("b2")]);
    s.answers.b1 = {
      state: "unreachable",
      reason: "no answer over ssh in 8 s",
    };
    ask(s.store);
    const a = ask(s.store, "any");
    await s.store.checkBoxes();
    await s.store.checkBoxes();
    expect(s.store.get(a.id)?.box).toBe("b2");
    const b1 = gateView(s.store).boxes.find((x) => x.name === "b1")!;
    expect(b1).toMatchObject({
      state: "unreachable",
      reason: "no answer over ssh in 8 s",
    });
  });

  it("a box's time scale stretches its run's expected end", async () => {
    const s = storeWith([box("slow", { time_scale: 2 })]);
    ask(s.store);
    const a = ask(s.store, "any");
    await s.store.checkBoxes();
    const v = gateView(s.store).slots.find((x) => x.id === a.id)!;
    expect(v.box).toBe("slow");
    expect(Date.parse(v.expectedEnd!) - T0).toBe(20 * 60_000);
  });

  it("boxes are Settings: set, listed, removed", () => {
    const s = storeWith([box("b1")]);
    expect(s.store.boxes().map((b) => b.name)).toEqual(["b1"]);
    s.store.setBox(box("b1", { browser_slots: 3 }));
    expect(s.store.boxes()).toHaveLength(1);
    expect(s.store.boxes()[0]!.browser_slots).toBe(3);
    expect(s.store.removeBox("b1")).toBe(true);
    expect(s.store.boxes()).toEqual([]);
    expect(s.store.removeBox("b1")).toBe(false);
  });
});

describe("checkBox", () => {
  it("refuses what could reach ssh as an option, or a malformed address", () => {
    expect(checkBox({ name: "b", ssh: "-oProxyCommand=x" }).ok).toBe(false);
    expect(checkBox({ name: "b", playwright: "http://x:3000" }).ok).toBe(false);
    expect(checkBox({ name: "b", playwright: "ws://u:p@x:3000" }).ok).toBe(
      false,
    );
    expect(checkBox({ name: "b" }).ok).toBe(false);
    expect(
      checkBox({ name: "b", playwright: "ws://x:3000", hold_file: "h" }).ok,
    ).toBe(false);
    expect(
      checkBox({ name: "b", ssh: "ci@x", hold_file: '"; rm -rf ~' }).ok,
    ).toBe(false);
    expect(checkBox({ name: "b", ssh: "ci@x", browser_slots: 0 }).ok).toBe(
      false,
    );
    expect(
      checkBox({
        name: "b",
        ssh: "ci@x",
        ssh_port: 2222,
        playwright: "ws://x:3000",
        browser_slots: 2,
        time_scale: 1.5,
      }),
    ).toMatchObject({ ok: true });
  });

  it("a run on a box is told which box, and its Playwright address", () => {
    expect(
      boxEnv(box("b1", { playwright: "ws://b1.test:3000", time_scale: 2 })),
    ).toEqual({
      DEN_GATE_BOX: "b1",
      DEN_GATE_TIME_SCALE: "2",
      DEN_PW_WS: "ws://b1.test:3000",
      // Issue 1033: the client exposes this machine's loopback to the box.
      DEN_PW_EXPOSE: "<loopback>",
      DEN_GATE_BOX_SSH: "ci@b1.test",
    });
  });
});

describe("gate run and status with boxes", () => {
  function deps(store: GateStore) {
    const out: string[] = [];
    const err: string[] = [];
    const ran: { cmd: string; env?: Record<string, string> }[] = [];
    const d: GateDeps = {
      store,
      env: {},
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => T0,
      sleep: () => Promise.resolve(),
      exec: (cmd, _args, env) => {
        ran.push({ cmd, ...(env ? { env } : {}) });
        return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
      },
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: "/x/repo",
    };
    return { d, out, err, ran };
  }

  it("--box any takes a box when this machine is busy; the run gets DEN_PW_WS", async () => {
    const s = storeWith([box("b1", { playwright: "ws://b1.test:3000" })]);
    ask(s.store); // this machine is busy
    const t = deps(s.store);
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "browser",
          "--box",
          "any",
          "--base-url",
          "http://den.localhost:4100",
          "--",
          "npm",
          "test",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(t.ran[0]!.env).toMatchObject({
      DEN_GATE_BOX: "b1",
      DEN_PW_WS: "ws://b1.test:3000",
    });
    expect(t.err.join("\n")).toMatch(/on box b1/);
  });

  it("--box needs --kind browser", async () => {
    const s = storeWith([box("b1")]);
    const t = deps(s.store);
    expect(
      await cmdGate(["run", "--box", "any", "--", "npm", "test"], t.d),
    ).toBe(2);
  });

  it("status shows each slot's box, and a skipped box with why", async () => {
    const s = storeWith([box("b1"), box("b2")]);
    s.answers.b2 = { state: "unreachable", reason: "no route to host" };
    ask(s.store);
    ask(s.store, "any");
    ask(s.store, "any");
    await s.store.checkBoxes();
    await s.store.checkBoxes();
    const t = deps(s.store);
    expect(await cmdGate(["status"], t.d)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toMatch(/holds browser on box b1/);
    expect(text).toMatch(/box b2: skipped, unreachable: no route to host/);
  });

  it("gate box add, list and remove (a person's)", async () => {
    const s = storeWith([]);
    const t = deps(s.store);
    expect(
      await cmdGate(
        [
          "box",
          "add",
          "b1",
          "--ssh",
          "ci@b1.test",
          "--slots",
          "2",
          "--hold-file",
          "heavy.hold",
          "--time-scale",
          "1.5",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(s.store.boxes()).toEqual([
      {
        name: "b1",
        ssh: "ci@b1.test",
        browser_slots: 2,
        hold_file: "heavy.hold",
        time_scale: 1.5,
      },
    ]);
    expect(await cmdGate(["box", "list"], t.d)).toBe(0);
    expect(t.out.join("\n")).toMatch(/b1 .*2 browser slots/);
    t.d.env = { DEN_AGENT: "agent:x" };
    expect(await cmdGate(["box", "remove", "b1"], t.d)).toBe(2);
    t.d.env = {};
    expect(await cmdGate(["box", "remove", "b1"], t.d)).toBe(0);
    expect(s.store.boxes()).toEqual([]);
  });
});

describe("doctor's box rows", () => {
  it("no boxes: no rows; a skipped box: a row that says why", async () => {
    expect(boxLines(storeWith([]).store).lines).toEqual([]);
    const s = storeWith([box("b1"), box("b2")]);
    s.answers.b2 = { state: "unreachable", reason: "no route to host" };
    ask(s.store);
    ask(s.store, "b2");
    await s.store.checkBoxes();
    const r = boxLines(s.store);
    expect(r.lines.join("\n")).toMatch(/b1.*not checked yet/);
    expect(r.lines.join("\n")).toMatch(/b2.*unreachable: no route to host/);
    expect(r.check.status).toBe("warn");
  });
});
