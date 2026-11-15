/**
 * 0.4.49 GATE-SLOT (den#144): `<cli> gate`. Fake runner, fake clock, a
 * temp store: nothing here runs a suite.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cmdGate,
  parseEstimate,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";
import { GateStore } from "../../../src/shared/gates/store.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function deps(over: Partial<GateDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gatecli-"));
  tmps.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const beats: (() => void)[] = [];
  let release: ((s: NodeJS.Signals) => void) | undefined;
  const d: GateDeps = {
    store: new GateStore({ dir, alive: () => true }),
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: (cmd, args) => {
      ran.push([cmd, ...args]);
      return Promise.resolve(0);
    },
    every: (_ms, fn) => {
      beats.push(fn);
      return () => {
        beats.length = 0;
      };
    },
    onSignal: (r) => {
      release = r;
      return () => {
        release = undefined;
      };
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
    signal: (s: NodeJS.Signals) => release?.(s),
  };
}

const events = (d: GateDeps) => d.store.events().map((e) => e.event);

describe("gate run", () => {
  it("runs the command in a slot and gives it back; the exit code passes through", async () => {
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

    const f = deps({ exec: () => Promise.resolve(3) });
    expect(await cmdGate(["run", "--", "false"], f.d)).toBe(3);
    expect(f.d.store.list()).toEqual([]);
  });

  it("a command that throws still gives the slot back", async () => {
    const t = deps({ exec: () => Promise.reject(new Error("boom")) });
    expect(await cmdGate(["run", "--", "x"], t.d)).toBe(1);
    expect(t.d.store.list()).toEqual([]);
  });

  it("waits while another run holds the machine, saying who, then runs", async () => {
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
    expect(t.err.join("\n")).toContain(
      "waiting: " +
        other.id +
        '  holds browser  Den · other-repo · a person  "browser suite"',
    );
    expect(t.ran).toEqual([["jest"]]);
    expect(t.d.store.list()).toEqual([]);
  });

  it("SIGINT or SIGTERM gives the slot back once", async () => {
    const t = deps();
    t.d.exec = () => {
      t.signal("SIGTERM");
      return Promise.resolve(143);
    };
    expect(await cmdGate(["run", "--", "x"], t.d)).toBe(143);
    expect(t.d.store.list()).toEqual([]);
    expect(events(t.d).filter((e) => e === "released")).toHaveLength(1);
  });

  it("a real run killed with SIGTERM stops its command and gives its slot back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gatecli-"));
    tmps.push(dir);
    const store = new GateStore({ dir });
    const k = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "run-child.ts")],
      {
        env: { ...process.env, DEN_GATE_DIR: dir, TSX_DISABLE_CACHE: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let err = "";
    await new Promise<void>((resolve) =>
      k.stderr.on("data", (d: Buffer) => {
        err += String(d);
        if (/sleeper \d+/.test(err)) resolve();
      }),
    );
    expect(store.list().map((e) => e.label)).toEqual(["sleeper"]);
    const code = await new Promise<number | null>((resolve) => {
      k.on("exit", (c) => resolve(c));
      k.kill("SIGTERM");
    });
    expect(code).toBe(143);
    // The command got the signal too: no run goes on without its slot.
    const sleeper = Number(/sleeper (\d+)/.exec(err)?.[1]);
    await new Promise((r) => setTimeout(r, 300));
    let left = true;
    try {
      process.kill(sleeper, "SIGKILL");
    } catch {
      left = false;
    }
    expect(left).toBe(false);
    expect(store.events().map((e) => e.event)).toEqual([
      "asked",
      "granted",
      "released",
    ]);
  }, 30_000);

  it("past its estimate plus the margin, it says so once, and keeps the slot", async () => {
    let now = Date.now();
    const t = deps({ now: () => now });
    t.d.store = new GateStore({
      dir: t.d.store.dir,
      alive: () => true,
      now: () => now,
    });
    t.d.exec = async () => {
      now += 10 * 60_000;
      t.beats[0]!();
      expect(t.err.join("\n")).not.toContain("past its estimate");
      now += 15 * 60_000;
      t.beats[0]!();
      t.beats[0]!();
      expect(t.d.store.list()).toHaveLength(1);
      return 0;
    };
    expect(
      await cmdGate(
        ["run", "--estimate", "5m", "--label", "e2e", "--", "x"],
        t.d,
      ),
    ).toBe(0);
    expect(t.err.filter((l) => l.includes("past its estimate"))).toEqual([
      "gate: e2e is past its estimate (5 min); the slot stays its own until it ends",
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
    const agent = { ...t.d, env: { DEN_ACTOR_TOKEN_FILE: "/nope" } };
    expect(await cmdGate(["end", held.id], agent)).toBe(2);
    expect(t.err.at(-1)).toBe(
      "gate: gate end: only a person can end a slot early (this is an agent)",
    );
    expect(t.d.store.list()).toHaveLength(1);
    expect(await cmdGate(["end", held.id], t.d)).toBe(0);
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
      "cpu slots 4 · lease 30 min · flagged 15 min past its estimate",
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
