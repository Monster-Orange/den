/**
 * Every gate slot end ends its run's whole process group: TERM, then KILL
 * after cancel_grace_seconds. A child that outlived its parent (adopted by
 * PID 1, still in the group) is reached. If `gate run` itself dies, the
 * store's sweep does the same for the group recorded in the slot. What
 * outlives it (still in the group after KILL, or escaped from it while a
 * group member's child) is listed as survivors: slot log, gate status,
 * the holder's bell; never signalled. Temp stores only; the real process
 * tests signal only the groups their own `gate run` made.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GateStore,
  groupSurvey,
  type ProcRow,
} from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { ringIdleGates } from "../../../src/ui/server/gate-idle-bell.js";

const tmps: string[] = [];
const kids: ChildProcess[] = [];
/** Only processes these tests started. */
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gategroup-"));
  tmps.push(d);
  return d;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.parse("2026-11-19T10:00:00Z");

describe("group survey", () => {
  const row = (
    pid: number,
    ppid: number,
    pgid: number,
    age: number,
    comm = "node",
  ): ProcRow => ({ pid, ppid, pgid, ageSec: age, comm });

  it("lists the group and the processes that left it under a member", () => {
    const rows = [
      row(500, 77, 500, 10),
      row(501, 500, 500, 9, "pg_ctl"),
      row(600, 501, 600, 8, "postgres"), // setsid under 501
      row(601, 600, 600, 8, "postgres"),
      row(700, 1, 700, 5000, "launchd-child"), // unrelated
    ];
    const s = groupSurvey(rows, 500, 30);
    expect(s).not.toBeNull();
    expect(s!.members.map((r) => r.pid).sort()).toEqual([500, 501]);
    expect(s!.escaped.map((r) => r.pid).sort()).toEqual([600, 601]);
  });

  it("a group with a member older than the run is someone else's: null", () => {
    expect(groupSurvey([row(500, 1, 500, 9000)], 500, 30)).toBeNull();
  });
});

/** A store on a fake clock, a fake process table, and recorded signals. */
function rig() {
  let now = T0;
  const up = new Set<number>();
  const sent: [number, string][] = [];
  let table: ProcRow[] = [];
  let ignoresTerm = false;
  const store = new GateStore({
    dir: tmp(),
    now: () => now,
    alive: (p) => (p < 0 ? table.some((r) => r.pgid === -p) : up.has(p)),
    kill: (p, s) => {
      sent.push([p, s]);
      if (p < 0 && (s === "SIGKILL" || !ignoresTerm))
        table = table.filter((r) => r.pgid !== -p);
    },
    procs: () => table,
  });
  return {
    store,
    sent,
    up,
    at: (sec: number) => (now = T0 + sec * 1000),
    set: (t: ProcRow[], ignore = false) => {
      table = t;
      ignoresTerm = ignore;
    },
  };
}

describe("the sweep: gate run died, its group did not", () => {
  const start = (r: ReturnType<typeof rig>) => {
    r.store.writeSettings({ cancel_grace_seconds: 10 });
    r.up.add(77);
    const e = r.store.ask({
      kind: "cpu",
      who: "w",
      label: "db tests",
      pid: 77,
      estimateMin: 10,
      agent: true,
      actor: "agent:coder",
    });
    expect(r.store.setRunPid(e.id, 500, true)?.pgid).toBe(500);
    r.up.delete(77); // gate run is SIGKILLed
    return e;
  };

  it("TERM to the recorded group; freed once it is gone", () => {
    const r = rig();
    r.set([{ pid: 501, ppid: 1, pgid: 500, ageSec: 5, comm: "db-wrapper" }]);
    const e = start(r);
    r.at(1);
    r.store.list();
    expect(r.sent).toEqual([[-500, "SIGTERM"]]);
    r.at(2);
    expect(r.store.list()).toEqual([]);
    const ev = r.store.events().map((x) => x.event);
    expect(ev).toContain("taken-back-gone");
    expect(r.store.events().find((x) => x.event === "survivors")).toBeUndefined();
    expect(e.id).toBeTruthy();
  });

  it("a group that ignores TERM gets KILL after the grace; the slot holds until then", () => {
    const r = rig();
    r.set(
      [{ pid: 501, ppid: 1, pgid: 500, ageSec: 5, comm: "db-wrapper" }],
      true,
    );
    const e = start(r);
    r.at(1);
    r.store.list();
    r.at(5);
    expect(r.store.list().map((x) => x.id)).toEqual([e.id]);
    r.at(12);
    r.store.list();
    expect(r.sent).toEqual([
      [-500, "SIGTERM"],
      [-500, "SIGKILL"],
    ]);
    r.at(13);
    expect(r.store.list()).toEqual([]);
  });

  it("never signals a group that isn't the run's (a member older than the run)", () => {
    const r = rig();
    r.set([{ pid: 500, ppid: 1, pgid: 500, ageSec: 99_999, comm: "other" }]);
    start(r);
    r.at(1);
    expect(r.store.list()).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("an escaped process is listed as a survivor, never signalled", () => {
    const r = rig();
    r.set([
      { pid: 501, ppid: 1, pgid: 500, ageSec: 5, comm: "db-wrapper" },
      { pid: 600, ppid: 501, pgid: 600, ageSec: 4, comm: "postgres" },
    ]);
    start(r);
    r.up.add(600);
    r.at(1);
    r.store.list();
    r.at(2);
    r.store.list();
    expect(r.sent.every(([p]) => p === -500)).toBe(true);
    const sv = r.store.events().find((x) => x.event === "survivors");
    expect(sv?.survivors).toEqual([{ pid: 600, comm: "postgres" }]);
    expect(sv?.actor).toBe("agent:coder");
  });
});

describe("survivors are shown", () => {
  const ended = () => {
    const store = new GateStore({
      dir: tmp(),
      alive: () => true,
      now: () => T0,
    });
    const e = store.ask({
      kind: "cpu",
      who: "w",
      label: "db tests",
      pid: 1,
      estimateMin: 10,
      agent: true,
      actor: "agent:coder",
    });
    store.release(e.id, [{ pid: 4242, comm: "postgres" }]);
    return { store, e };
  };

  it("in gate status, text and --json, while they live", async () => {
    const { store, e } = ended();
    const out: string[] = [];
    const d = {
      store,
      env: {},
      out: (l: string) => out.push(l),
      err: () => {},
      now: () => T0,
      sleep: () => Promise.resolve(),
      exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 1,
      cwd: "/x/r",
    } as GateDeps;
    expect(await cmdGate(["status"], d)).toBe(0);
    expect(out.join("\n")).toMatch(/survivors?.*4242 \(postgres\)/i);
    expect(gateView(store, T0).survivors).toEqual([
      expect.objectContaining({
        id: e.id,
        label: "db tests",
        pids: [{ pid: 4242, comm: "postgres" }],
      }),
    ]);
  });

  it("in the agent holder's bell, under Needs you, once", () => {
    const { store, e } = ended();
    const added: Record<string, unknown>[] = [];
    const d = {
      store,
      bell: {
        add: (n: Record<string, unknown>) => {
          added.push(n);
          return null;
        },
      },
      records: () => [{ id: "coder", workspace: "north" }],
      rung: new Set<string>(),
      now: () => T0,
      since: T0 - 60_000,
    };
    ringIdleGates(d as never);
    ringIdleGates(d as never);
    expect(added).toEqual([
      expect.objectContaining({
        kind: "decision",
        scope: "workspace/north",
        subject: `gate:${e.id}:survivors`,
        msg: {
          key: "bell.m.gateSurvivors",
          vars: { label: "db tests", pids: "4242 (postgres)" },
        },
      }),
    ]);
  });
});

/** Real `gate run`s, each around a node script; only their own groups. */
describe("real runs", () => {
  async function startRun(dir: string, script: string, need: RegExp[]) {
    const k = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "cancel-child.ts")],
      {
        env: {
          ...process.env,
          DEN_GATE_DIR: dir,
          DEN_AGENT: "agent:coder",
          GATE_CHILD_SCRIPT: script,
          TSX_DISABLE_CACHE: "1",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    kids.push(k);
    let err = "";
    const exited = new Promise<number | null>((r) =>
      k.on("exit", (c) => r(c)),
    );
    await new Promise<void>((resolve) =>
      k.stderr!.on("data", (d: Buffer) => {
        err += String(d);
        if (need.every((n) => n.test(err))) resolve();
      }),
    );
    const num = (re: RegExp) => Number(re.exec(err)?.[1]);
    return { k, exited, err: () => err, num };
  }

  /** The parent starts a child that holds a lock file, then exits 0. */
  const orphan = (lock: string, ignoreTerm: boolean, escape = false) =>
    [
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      `const kid = spawn(process.execPath, ['-e', ${JSON.stringify(
        [
          "const fs = require('fs');",
          `fs.writeFileSync(${JSON.stringify(lock)}, String(process.pid));`,
          ignoreTerm
            ? "process.on('SIGTERM', () => {});"
            : `process.on('SIGTERM', () => { try { fs.unlinkSync(${JSON.stringify(lock)}); } catch {} process.exit(0); });`,
          escape
            ? "const { spawn } = require('child_process'); const e = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); console.error('esc ' + e.pid);"
            : "",
          "console.error('kid ' + process.pid);",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      )}], { stdio: ['ignore', 'ignore', 'inherit'] });`,
      `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(lock)})) { clearInterval(t); setTimeout(() => process.exit(0), ${escape ? 300 : 50}); } }, 20);`,
    ].join("\n");

  it("the parent exits 0, its child holds a lock: after the slot ends the child is gone and the lock freed", async () => {
    const dir = tmp();
    const lock = path.join(dir, "db.lock");
    new GateStore({ dir }).writeSettings({ cancel_grace_seconds: 1 });
    const run = await startRun(dir, orphan(lock, false), [/kid \d+/]);
    const kid = run.num(/kid (\d+)/);
    strays.push(kid);
    expect(await run.exited).toBe(0);
    expect(alive(kid)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    const store = new GateStore({ dir });
    expect(store.list()).toEqual([]);
    expect(store.events().find((x) => x.event === "survivors")).toBeUndefined();
  }, 30_000);

  it("a child that ignores TERM is killed after the grace", async () => {
    const dir = tmp();
    const lock = path.join(dir, "db.lock");
    new GateStore({ dir }).writeSettings({ cancel_grace_seconds: 1 });
    const run = await startRun(dir, orphan(lock, true), [/kid \d+/]);
    const kid = run.num(/kid (\d+)/);
    strays.push(kid);
    const t0 = Date.now();
    expect(await run.exited).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(alive(kid)).toBe(false);
  }, 30_000);

  it("a child that escapes the group (setsid) is listed as a survivor, not signalled", async () => {
    const dir = tmp();
    const lock = path.join(dir, "db.lock");
    new GateStore({ dir }).writeSettings({ cancel_grace_seconds: 1 });
    const run = await startRun(dir, orphan(lock, false, true), [
      /kid \d+/,
      /esc \d+/,
    ]);
    const kid = run.num(/kid (\d+)/);
    const esc = run.num(/esc (\d+)/);
    strays.push(kid, esc);
    expect(await run.exited).toBe(0);
    expect(alive(kid)).toBe(false);
    expect(alive(esc)).toBe(true);
    const sv = new GateStore({ dir })
      .events()
      .find((x) => x.event === "survivors");
    expect(sv?.survivors).toEqual([
      expect.objectContaining({ pid: esc, comm: expect.stringMatching(/node/) }),
    ]);
  }, 30_000);

  it("gate run itself killed: the sweep ends the recorded group", async () => {
    const dir = tmp();
    const lock = path.join(dir, "db.lock");
    new GateStore({ dir }).writeSettings({ cancel_grace_seconds: 1 });
    const script = orphan(lock, false).replace(
      /setTimeout\(\(\) => process\.exit\(0\), \d+\)/,
      "0",
    );
    const run = await startRun(dir, script, [/kid \d+/]);
    const kid = run.num(/kid (\d+)/);
    strays.push(kid);
    const store = new GateStore({ dir });
    expect(store.list()[0]?.pgid).toBeDefined();
    run.k.kill("SIGKILL");
    await run.exited;
    const until = Date.now() + 10_000;
    while (store.list().length && Date.now() < until) await wait(200);
    expect(store.list()).toEqual([]);
    expect(alive(kid)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    expect(store.events().map((x) => x.event)).toContain("taken-back-gone");
  }, 30_000);
});
