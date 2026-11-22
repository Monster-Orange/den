/**
 * Issue 928: a run inside a held slot asked for another slot of the same
 * kind and waited behind its own slot. Now `gate run` hands its command
 * DEN_GATE_SLOT (the slot's id), DEN_GATE_SLOT_KIND and DEN_GATE_SLOT_BOX
 * ("local" or the test box). A nested `gate run` of that kind and place,
 * from a process under that slot's run, runs inside the held slot: no
 * second entry, no wait. Anything else asks as before; a process that
 * only names the id (not under that run) gets no way past the line.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { GateStore } from "../../../src/shared/gates/store.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function deps(store: GateStore, over: Partial<GateDeps> = {}) {
  const ran: { cmd: string[]; env?: Record<string, string> }[] = [];
  const err: string[] = [];
  const d: GateDeps = {
    store,
    env: {},
    out: () => {},
    err: (l) => err.push(l),
    now: Date.now,
    // A run that would wait forever fails the test instead of hanging it.
    sleep: (() => {
      let n = 0;
      return () =>
        ++n > 50
          ? Promise.reject(new Error("still waiting after 50 looks"))
          : Promise.resolve();
    })(),
    exec: (cmd, args, env) => {
      ran.push({ cmd: [cmd, ...args], ...(env ? { env } : {}) });
      return { pid: 7001, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    ...over,
  };
  return { d, ran, err };
}

function store(): GateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate928-"));
  tmps.push(dir);
  return new GateStore({ platform: "linux", dir, alive: () => true });
}

/** An outer run that holds `kind` here (pid 3000, its command 3001). */
function held(s: GateStore, kind: "browser" | "cpu") {
  const e = s.ask({
    kind,
    who: "outer",
    label: "outer",
    pid: 3000,
    estimateMin: 10,
    agent: false,
    project: "some-repo",
  });
  expect(e.grantedAt).toBeDefined();
  s.setRunPid(e.id, 3001);
  return e;
}

const asks = (s: GateStore) =>
  s.events().filter((e) => e.event === "asked").length;

describe("issue 928: gate run hands its command the slot", () => {
  it("DEN_GATE_SLOT, its kind and its place reach the command", async () => {
    const s = store();
    const { d, ran } = deps(s);
    expect(
      await cmdGate(["run", "--kind", "cpu", "--", "make", "test"], d),
    ).toBe(0);
    const env = ran[0]!.env!;
    expect(env.DEN_GATE_SLOT).toMatch(/^cpu-/);
    expect(env.DEN_GATE_SLOT_KIND).toBe("cpu");
    expect(env.DEN_GATE_SLOT_BOX).toBe("local");
  });
});

describe("issue 928: a nested run of the held kind", () => {
  it("runs inside the held slot at once: one entry, no wait", async () => {
    const s = store();
    const outer = held(s, "browser");
    const before = asks(s);
    let slept = 0;
    const { d, ran, err } = deps(s, {
      env: { DEN_GATE_SLOT: outer.id },
      descends: (pid, root) => pid === 4242 && root === 3001,
      sleep: () =>
        ++slept > 50
          ? Promise.reject(new Error("still waiting after 50 looks"))
          : Promise.resolve(),
    });
    expect(
      await cmdGate(
        ["run", "--kind", "browser", "--", "npx", "playwright", "test"],
        d,
      ),
    ).toBe(0);
    expect(ran.map((r) => r.cmd)).toEqual([["npx", "playwright", "test"]]);
    expect(slept).toBe(0);
    expect(asks(s)).toBe(before);
    expect(s.list().map((e) => e.id)).toEqual([outer.id]);
    expect(err.join("\n")).toMatch(new RegExp(`inside ${outer.id}`));
    // The outer run still holds its slot: a nested run never gives it back.
    expect(s.get(outer.id)?.grantedAt).toBeDefined();
  });

  it("a nested run of the other kind asks as before", async () => {
    const s = store();
    const outer = held(s, "browser");
    const before = asks(s);
    const { d } = deps(s, {
      env: { DEN_GATE_SLOT: outer.id },
      descends: () => true,
    });
    expect(await cmdGate(["run", "--kind", "cpu", "--", "make"], d)).toBe(0);
    expect(asks(s)).toBe(before + 1);
  });

  it("naming the id from outside that run gets no way past the line", async () => {
    const s = store();
    const outer = held(s, "cpu");
    // One cpu slot: the outer run holds it.
    s.writeSettings({ cpu_slots: 1 });
    const before = asks(s);
    let n = 0;
    const { d } = deps(s, {
      env: { DEN_GATE_SLOT: outer.id },
      descends: () => false,
      sleep: () => {
        // The outer run ends while this one waits.
        if (++n === 2) s.release(outer.id);
        return Promise.resolve();
      },
    });
    expect(await cmdGate(["run", "--kind", "cpu", "--", "make"], d)).toBe(0);
    expect(asks(s)).toBe(before + 1);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("a slot id that no longer holds asks as before", async () => {
    const s = store();
    const { d } = deps(s, {
      env: { DEN_GATE_SLOT: "cpu-gone" },
      descends: () => true,
    });
    expect(await cmdGate(["run", "--kind", "cpu", "--", "make"], d)).toBe(0);
    expect(asks(s)).toBe(1);
  });
});
