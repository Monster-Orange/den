/**
 * Issue 144 GATE-SLOT: `<cli> gate`. A fake runner, a fake clock and a temp
 * store; the two real-process tests run a node sleeper, never a suite.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cmdGate,
  parseEstimate,
  type GateDeps,
  type GateRun,
} from "../../../src/ui/cli/gate-command.js";
import { GateStore } from "../../../src/shared/gates/store.js";

const tmps: string[] = [];
const kids: ChildProcess[] = [];
const strays: number[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  for (const p of strays.splice(0))
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gatecli-"));
  tmps.push(d);
  return d;
};

/** A fake run: ends with `code` when `end` is called, or when killed. */
function fakeRun(pid = 5151) {
  let end: (c: number) => void = () => {};
  const killed: NodeJS.Signals[] = [];
  const run: GateRun = {
    pid,
    kill: (s) => {
      killed.push(s);
      end(s === "SIGINT" ? 130 : 143);
    },
    done: new Promise<number>((r) => (end = r)),
  };
  return { run, killed, end: (c: number) => end(c) };
}

function deps(over: Partial<GateDeps> = {}) {
  const dir = tmp();
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const exits: number[] = [];
  const beats: (() => void)[] = [];
  let handler: ((s: NodeJS.Signals) => void) | undefined;
  const d: GateDeps = {
    store: new GateStore({ dir, alive: () => true }),
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: (cmd, args) => {
      ran.push([cmd, ...args]);
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: (_ms, fn) => {
      beats.push(fn);
      return () => {
        beats.length = 0;
      };
    },
    onSignal: (h) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    exit: (c) => {
      exits.push(c);
    },
    pid: 4242,
    cwd: "/x/some-repo",
    ...over,
  };
  return {
    d,
    out,
    err,
    ran,
    beats,
    exits,
    signal: (s: NodeJS.Signals) => handler?.(s),
  };
}

const events = (d: GateDeps) => d.store.events().map((e) => e.event);

describe("gate run", () => {
  it("releases on success; the exit code passes through", async () => {
    const t = deps();
    expect(
      await cmdGate(
        ["run", "--kind", "browser", "--estimate", "6m", "--", "npm", "test"],
        t.d,
      ),
    ).toBe(0);
    expect(t.ran).toEqual([["npm", "test"]]);
    expect(t.d.store.list()).toEqual([]);
    expect(events(t.d)).toEqual(["asked", "granted", "released"]);
  });

  it("releases on failure; the failing code passes through", async () => {
    const f = deps({
      exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(3) }),
    });
    expect(await cmdGate(["run", "--", "false"], f.d)).toBe(3);
    expect(f.d.store.list()).toEqual([]);
    expect(events(f.d)).toEqual(["asked", "granted", "released"]);
  });

  it("a command that can't start still gives the slot back", async () => {
    const t = deps({
      exec: () => {
        throw new Error("boom");
      },
    });
    expect(await cmdGate(["run", "--", "x"], t.d)).toBe(1);
    expect(t.d.store.list()).toEqual([]);
  });

  it("records the run's own pid, so the slot outlives a wrapper killed hard", async () => {
    const r = fakeRun(6161);
    const t = deps({ exec: () => r.run });
    const going = cmdGate(["run", "--", "x"], t.d);
    await new Promise((res) => setImmediate(res));
    expect(t.d.store.list()[0]?.runPid).toBe(6161);
    r.end(0);
    expect(await going).toBe(0);
  });

  it("waits while another run holds the machine, saying who and until when, then runs", async () => {
    const t = deps();
    const other = t.d.store.ask({
      kind: "browser",
      who: "Den · other-repo · a person",
      label: "browser suite",
      pid: 777,
      estimateMin: 6,
    });
    let sleeps = 0;
    t.d.sleep = () => {
      if (++sleeps === 2) t.d.store.release(other.id);
      return Promise.resolve();
    };
    expect(await cmdGate(["run", "--kind", "cpu", "--", "jest"], t.d)).toBe(0);
    const said = t.err.join("\n");
    expect(said).toContain(
      "waiting: " +
        other.id +
        '  holds browser  Den · other-repo · a person  "browser suite"  until about ',
    );
    expect(t.ran).toEqual([["jest"]]);
    expect(t.d.store.list()).toEqual([]);
    // The other run was never stopped: it gave its slot back itself.
    expect(t.d.store.events().filter((e) => e.event === "released")).toEqual([
      expect.objectContaining({ id: other.id }),
      expect.anything(),
    ]);
  });

  it("SIGTERM while running passes to the command; its end gives the slot back once", async () => {
    const r = fakeRun();
    const t = deps({ exec: () => r.run });
    const going = cmdGate(["run", "--", "x"], t.d);
    await new Promise((res) => setImmediate(res));
    expect(t.d.store.list()).toHaveLength(1);
    t.signal("SIGTERM");
    expect(await going).toBe(143);
    expect(r.killed).toEqual(["SIGTERM"]);
    expect(t.d.store.list()).toEqual([]);
    expect(events(t.d).filter((e) => e === "released")).toHaveLength(1);
  });

  it("SIGINT while waiting gives the place in the queue back and exits", async () => {
    const t = deps();
    t.d.store.ask({
      kind: "browser",
      who: "w",
      label: "l",
      pid: 7,
      estimateMin: 5,
    });
    t.d.sleep = () => {
      t.signal("SIGINT");
      return Promise.resolve();
    };
    expect(await cmdGate(["run", "--kind", "browser", "--", "x"], t.d)).toBe(
      130,
    );
    expect(t.exits).toEqual([130]);
    expect(t.ran).toEqual([]);
    expect(t.d.store.list().map((e) => e.label)).toEqual(["l"]);
  });

  it("a real run killed with SIGTERM stops its command and gives its slot back", async () => {
    const dir = tmp();
    const store = new GateStore({ dir });
    const k = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "run-child.ts")],
      {
        env: { ...process.env, DEN_GATE_DIR: dir, TSX_DISABLE_CACHE: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    kids.push(k);
    let err = "";
    await new Promise<void>((resolve) =>
      k.stderr.on("data", (d: Buffer) => {
        err += String(d);
        if (/sleeper \d+/.test(err)) resolve();
      }),
    );
    const sleeper = Number(/sleeper (\d+)/.exec(err)?.[1]);
    strays.push(sleeper);
    expect(store.list().map((e) => [e.label, e.runPid])).toEqual([
      ["sleeper", sleeper],
    ]);
    const code = await new Promise<number | null>((resolve) => {
      k.on("exit", (c) => resolve(c));
      k.kill("SIGTERM");
    });
    expect(code).toBe(143);
    // The command got the signal too: no run goes on without its slot.
    expect(alive(sleeper)).toBe(false);
    expect(store.events().map((e) => e.event)).toEqual([
      "asked",
      "granted",
      "released",
    ]);
  }, 30_000);

  it("a real wrapper killed with SIGKILL: the slot stays while its run goes on, then frees at once", async () => {
    const dir = tmp();
    const store = new GateStore({ dir });
    const k = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "run-child.ts")],
      {
        env: { ...process.env, DEN_GATE_DIR: dir, TSX_DISABLE_CACHE: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    kids.push(k);
    let err = "";
    await new Promise<void>((resolve) =>
      k.stderr.on("data", (d: Buffer) => {
        err += String(d);
        if (/sleeper \d+/.test(err)) resolve();
      }),
    );
    const sleeper = Number(/sleeper (\d+)/.exec(err)?.[1]);
    strays.push(sleeper);
    // The wrapper records the run's pid just after it starts it; the run
    // can print first. Kill the wrapper only once the slot names the run,
    // which is the case this test is about.
    for (let i = 0; i < 250 && store.list()[0]?.runPid !== sleeper; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(store.list()[0]?.runPid).toBe(sleeper);
    await new Promise<void>((resolve) => {
      k.on("exit", () => resolve());
      k.kill("SIGKILL");
    });
    expect(store.list().map((e) => e.label)).toEqual(["sleeper"]);
    process.kill(sleeper, "SIGKILL");
    for (let i = 0; i < 100 && alive(sleeper); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(store.list()).toEqual([]);
    expect(store.events().map((e) => e.event)).toEqual([
      "asked",
      "granted",
      "taken-back-gone",
    ]);
  }, 30_000);

  it("past its estimate plus the margin, it says so once, and keeps the slot", async () => {
    let now = Date.now();
    const r = fakeRun();
    const t = deps({ now: () => now, exec: () => r.run });
    t.d.store = new GateStore({
      dir: t.d.store.dir,
      alive: () => true,
      now: () => now,
    });
    const going = cmdGate(
      ["run", "--estimate", "5m", "--label", "e2e", "--", "x"],
      t.d,
    );
    await new Promise((res) => setImmediate(res));
    now += 10 * 60_000;
    t.beats[0]!();
    expect(t.err.join("\n")).not.toContain("past its estimate");
    now += 15 * 60_000;
    t.beats[0]!();
    t.beats[0]!();
    expect(t.d.store.list()).toHaveLength(1);
    expect(r.killed).toEqual([]);
    r.end(0);
    expect(await going).toBe(0);
    expect(t.err.filter((l) => l.includes("past its estimate"))).toEqual([
      "gate: e2e is past its estimate (5 min); it is not stopped, and the slot stays its own until it ends",
    ]);
    expect(t.beats).toEqual([]);
  });

  it("says what is wrong with the asking", async () => {
    const t = deps();
    expect(await cmdGate(["run", "npm"], t.d)).toBe(2);
    expect(await cmdGate(["run", "--kind", "gpu", "--", "x"], t.d)).toBe(2);
    expect(t.err).toEqual([
      "gate: gate run needs -- <command> [args]",
      "gate: --kind is browser or cpu",
    ]);
    expect(parseEstimate("90s")).toBe(1.5);
    expect(parseEstimate("1h")).toBe(60);
    expect(() => parseEstimate("soon")).toThrow("--estimate");
  });
});

describe("gate end and settings: a person's only", () => {
  it("an agent can't end a slot early; a person can, and it is recorded with who", async () => {
    const t = deps();
    const held = t.d.store.ask({
      kind: "browser",
      who: "w",
      label: "l",
      pid: 777,
      estimateMin: 5,
    });
    for (const env of [
      { DEN_ACTOR_TOKEN_FILE: "/nope" },
      { DEN_AGENT: "agent:coder" },
    ]) {
      expect(await cmdGate(["end", held.id], { ...t.d, env })).toBe(2);
      expect(t.err.at(-1)).toBe(
        "gate: gate end: only a person can end a slot early (this is an agent)",
      );
    }
    expect(t.d.store.list()).toHaveLength(1);
    expect(await cmdGate(["end", held.id], t.d)).toBe(0);
    expect(t.d.store.list()).toEqual([]);
    expect(t.d.store.events().at(-1)).toMatchObject({
      event: "ended-early",
      by: "Den · some-repo · a person",
    });
  });

  it("settings: an agent may read, not change", async () => {
    const t = deps();
    const agent = { ...t.d, env: { DEN_ACTOR_TOKEN: "x" } };
    expect(await cmdGate(["settings", "--cpu-slots", "4"], agent)).toBe(2);
    expect(t.d.store.settings().cpuSlots).toBe(2);
    expect(await cmdGate(["settings", "--cpu-slots", "4"], t.d)).toBe(0);
    expect(t.out.at(-1)).toBe(
      "cpu slots 4 · flagged 15 min past its estimate · CI runners renew every 30 s, taken back after 120 s, at most 4 slots and 4 asks each · release priority: 1 per kind at a time, never past a run waiting 60 min, agents and people may ask",
    );
    expect(await cmdGate(["settings"], agent)).toBe(0);
  });
});

describe("gate status", () => {
  it("lists holders then waiters; --json carries overrun", async () => {
    const t = deps();
    expect(await cmdGate(["status"], t.d)).toBe(0);
    expect(t.out).toEqual(["No gate runs hold or wait."]);
    const a = t.d.store.ask({
      kind: "browser",
      who: "A",
      label: "a",
      pid: 1,
      estimateMin: 5,
    });
    const b = t.d.store.ask({
      kind: "cpu",
      who: "B",
      label: "b",
      pid: 2,
      estimateMin: 5,
    });
    t.out.length = 0;
    await cmdGate(["status"], t.d);
    expect(t.out[0]).toMatch(new RegExp(`^${a.id}  holds browser  A`));
    expect(t.out[1]).toMatch(new RegExp(`^${b.id}  waits for cpu  B`));
    t.out.length = 0;
    await cmdGate(["status", "--json"], t.d);
    const j = JSON.parse(t.out[0]!) as {
      slots: { id: string; overrun?: boolean; expectedStart?: string }[];
    };
    expect(j.slots[0]).toMatchObject({
      id: a.id,
      granted: true,
      overrun: false,
    });
    expect(j.slots[1]).toMatchObject({ id: b.id, granted: false });
    expect(typeof j.slots[1]!.expectedStart).toBe("string");
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
