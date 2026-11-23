/**
 * Issue 1199: a test box is never left "not checked yet". Every box that
 * is on and inside its window is checked when the gate starts (the boxes
 * with no state yet), and a box is checked at once when it is added or
 * changed (gate box add, Settings, the held write). A box turned off or
 * outside its window is never contacted. No ssh: the check is a stub.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readBoxStates,
  type BoxProbe,
} from "../../../src/shared/gates/boxes.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import {
  setTestBox,
  startGateBoxChecks,
} from "../../../src/ui/server/gate-routes.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

// 12:00 UTC.
const T0 = Date.parse("2026-11-22T12:00:00Z");

function world(answer: "open" | "unreachable" = "open") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1199-"));
  tmps.push(dir);
  const probed: string[] = [];
  const probe: BoxProbe = (b) => {
    probed.push(b.name);
    return Promise.resolve(
      answer === "open"
        ? { state: "open" }
        : { state: "unreachable", reason: "connection refused" },
    );
  };
  const store = new GateStore({
    platform: "linux",
    dir,
    alive: () => true,
    now: () => T0,
    probe,
  });
  const box = (name: string, more: Record<string, unknown> = {}) =>
    store.setBox({
      name,
      ssh: `ci@${name}.test`,
      playwright: `ws://${name}.test:3000`,
      playwright_version: "1.48.0",
      ...more,
    });
  return { dir, store, probed, box };
}

describe("issue 1199: boxes are checked when the gate starts", () => {
  it("every box with no state yet is checked, and none shows 'not checked yet'", async () => {
    const w = world();
    w.box("m1");
    w.box("mini");
    expect(readBoxStates(w.dir)).toEqual({});
    await startGateBoxChecks(w.store);
    expect(w.probed.sort()).toEqual(["m1", "mini"]);
    const st = readBoxStates(w.dir);
    expect(st.m1?.state).toBe("open");
    expect(st.mini?.state).toBe("open");
  });

  it("an unreachable box records why", async () => {
    const w = world("unreachable");
    w.box("m1");
    await startGateBoxChecks(w.store);
    expect(readBoxStates(w.dir).m1).toMatchObject({
      state: "unreachable",
      reason: "connection refused",
    });
  });

  it("a box turned off, or outside its window, is never contacted", async () => {
    const w = world();
    w.box("off", { enabled: false });
    // 12:00 UTC is outside 01:00-02:00 in any time zone within ±10 h.
    w.box("shut", { window: "01:00-02:00" });
    w.box("on");
    await startGateBoxChecks(w.store);
    expect(w.probed).toEqual(["on"]);
  });

  it("a box that already has a state isn't checked again at start-up", async () => {
    const w = world();
    w.box("m1");
    await startGateBoxChecks(w.store);
    await startGateBoxChecks(w.store);
    expect(w.probed).toEqual(["m1"]);
  });
});

describe("issue 1199: a box is checked when it is added or changed", () => {
  function deps(store: GateStore) {
    const out: string[] = [];
    const d: GateDeps = {
      store,
      env: {},
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      now: () => T0,
      sleep: () => Promise.resolve(),
      exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: "/x/repo",
    };
    return { d, out };
  }

  it("gate box add checks it and says what it found", async () => {
    const w = world("unreachable");
    const t = deps(w.store);
    expect(
      await cmdGate(
        [
          "box",
          "add",
          "m1",
          "--ssh",
          "ci@m1.test",
          "--playwright",
          "ws://m1.test:3000",
          "--playwright-version",
          "1.48.0",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(w.probed).toEqual(["m1"]);
    expect(readBoxStates(w.dir).m1?.state).toBe("unreachable");
    expect(t.out.join("\n")).toMatch(/m1: unreachable \(connection refused\)/);
  });

  it("a changed box is checked again at once, even with a fresh state", async () => {
    const w = world();
    w.box("m1");
    await startGateBoxChecks(w.store);
    const t = deps(w.store);
    await cmdGate(
      [
        "box",
        "add",
        "m1",
        "--ssh",
        "ci@m1.test",
        "--playwright",
        "ws://m1.test:3001",
        "--playwright-version",
        "1.48.0",
      ],
      t.d,
    );
    expect(w.probed).toEqual(["m1", "m1"]);
  });

  it("gate box add --off records it and contacts nothing", async () => {
    const w = world();
    const t = deps(w.store);
    await cmdGate(["box", "add", "m1", "--ssh", "ci@m1.test", "--off"], t.d);
    expect(w.probed).toEqual([]);
  });

  it("Settings and the held write (setTestBox) check the box they set", async () => {
    const w = world();
    const audit: string[] = [];
    await setTestBox(
      w.store,
      {
        name: "m1",
        ssh: "ci@m1.test",
        playwright: "ws://m1.test:3000",
        playwright_version: "1.48.0",
        browser_slots: 1,
      } as never,
      (x) => audit.push(x),
    );
    expect(w.probed).toEqual(["m1"]);
    expect(readBoxStates(w.dir).m1?.state).toBe("open");
  });
});
