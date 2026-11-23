/**
 * Issue 752: an orphaned `gate run` gives its place back, and an agent can
 * release its own shell-made entries.
 *
 * 1. gate run follows its parent: once the parent is gone, a waiter leaves
 *    the queue and a holder stops its command (whose end frees the slot).
 * 2. gate_slot_release takes any entry whose recorded agent is the caller,
 *    not only the slots this MCP process asked for; another agent's entry
 *    is still refused.
 * 3. a waiter whose process is gone holds no place (swept on the next pass).
 *
 * A temp store; the one real-process test runs a node sleeper, never a suite.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cmdGate,
  type GateDeps,
  type GateRun,
  ORPHAN_KILL_GRACE_MS,
} from "../../../src/ui/cli/gate-command.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate752-"));
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

function deps(over: Partial<GateDeps> = {}) {
  const beats: (() => void)[] = [];
  const d: GateDeps = {
    store: new GateStore({ dir: tmp(), alive: () => true }),
    env: {},
    out: () => {},
    err: () => {},
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: () => ({ pid: 5151, kill: () => {}, done: Promise.resolve(0) }),
    every: (_ms, fn) => {
      beats.push(fn);
      return () => {
        beats.length = 0;
      };
    },
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    ...over,
  };
  return { d, beats };
}

describe("issue 752 review: a detached run, and a holder that ignores TERM", () => {
  // Five looks while waiting; the queue as it stood at the fifth, and what
  // gate run returned (it ends itself with an error after that).
  const waitOnce = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const t = deps({ parentAlive: () => false, env });
    t.d.store.ask({
      kind: "browser",
      who: "w",
      label: "holder",
      pid: 7,
      estimateMin: 5,
    });
    let ticks = 0;
    let labels: string[] = [];
    t.d.sleep = () => {
      if (++ticks < 5) return Promise.resolve();
      labels = t.d.store.list().map((e) => e.label);
      return Promise.reject(new Error("still waiting"));
    };
    const r = await cmdGate(
      [
        "run",
        "--kind",
        "browser",
        "--browser-endpoint",
        "self",
        ...args,
        "--",
        "x",
      ],
      t.d,
    );
    return { r, ticks, labels };
  };

  it("--detached: a run whose parent is gone keeps its place (nohup, setsid, a wrapper that leaves)", async () => {
    const w = await waitOnce(["--detached", "--label", "mine"]);
    // Still in line at the fifth look: it never left.
    expect(w.ticks).toBe(5);
    expect(w.labels).toEqual(["holder", "mine"]);
  });

  it("DEN_GATE_DETACHED=1 does the same; any other value still follows the parent", async () => {
    expect(
      (await waitOnce(["--label", "mine"], { DEN_GATE_DETACHED: "1" })).labels,
    ).toEqual(["holder", "mine"]);
    const followed = await waitOnce(["--label", "mine"], {
      DEN_GATE_DETACHED: "no",
    });
    // It left at the first look (129, SIGHUP's code), never reaching five.
    expect(followed.r).toBe(129);
    expect(followed.ticks).toBe(1);
  });

  it("an orphaned holder whose command ignores TERM gets KILL after the grace", async () => {
    const t = deps({ parentAlive: () => false });
    let clock = 1_000_000;
    t.d.now = () => clock;
    let end: (c: number) => void = () => {};
    const killed: NodeJS.Signals[] = [];
    t.d.exec = () => ({
      pid: 5151,
      // It traps TERM: only KILL ends it.
      kill: (s) => {
        killed.push(s);
        if (s === "SIGKILL") end(137);
      },
      done: new Promise<number>((r) => (end = r)),
    });
    const going = cmdGate(
      ["run", "--kind", "browser", "--browser-endpoint", "self", "--", "x"],
      t.d,
    );
    for (let i = 0; i < 50 && t.beats.length === 0; i++)
      await new Promise((r) => setImmediate(r));
    const beat = () => {
      for (const b of [...t.beats]) b();
    };
    beat();
    expect(killed).toEqual(["SIGTERM"]);
    clock += ORPHAN_KILL_GRACE_MS - 1;
    beat();
    expect(killed).toEqual(["SIGTERM"]);
    clock += 2;
    beat();
    expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await going).toBe(137);
  });
});

describe("gate run follows its parent (issue 752)", () => {
  it("a waiter whose parent is gone leaves the queue and exits", async () => {
    let parent = true;
    const t = deps({ parentAlive: () => parent });
    t.d.store.ask({
      kind: "browser",
      who: "w",
      label: "holder",
      pid: 7,
      estimateMin: 5,
    });
    let ticks = 0;
    t.d.sleep = () => {
      if (++ticks === 2) parent = false;
      // A waiter that never looks would spin here forever.
      if (ticks > 50) return Promise.reject(new Error("still waiting"));
      return Promise.resolve();
    };
    const ran: string[] = [];
    t.d.exec = (cmd) => {
      ran.push(cmd);
      return { pid: 1, kill: () => {}, done: Promise.resolve(0) };
    };
    expect(
      await cmdGate(
        ["run", "--kind", "browser", "--browser-endpoint", "self", "--", "x"],
        t.d,
      ),
    ).toBe(129);
    expect(ran).toEqual([]);
    expect(t.d.store.list().map((e) => e.label)).toEqual(["holder"]);
  });

  it("a holder whose parent is gone stops its command, and the slot is freed", async () => {
    let parent = true;
    const t = deps({ parentAlive: () => parent });
    let end: (c: number) => void = () => {};
    const killed: NodeJS.Signals[] = [];
    const run: GateRun = {
      pid: 5151,
      kill: (s) => {
        killed.push(s);
        end(143);
      },
      done: new Promise<number>((r) => (end = r)),
    };
    t.d.exec = () => run;
    const going = cmdGate(
      ["run", "--kind", "browser", "--browser-endpoint", "self", "--", "x"],
      t.d,
    );
    for (let i = 0; i < 50 && t.beats.length === 0; i++)
      await new Promise((r) => setImmediate(r));
    for (const b of [...t.beats]) b();
    expect(killed).toEqual([]);
    parent = false;
    for (const b of [...t.beats]) b();
    expect(await going).toBe(143);
    expect(killed).toEqual(["SIGTERM"]);
    expect(t.d.store.list()).toEqual([]);
  });

  it("kill the parent of a real waiting gate run: its entry is gone within the check interval", async () => {
    const dir = tmp();
    const store = new GateStore({ dir });
    // This test process holds the machine, so the child waits.
    store.ask({
      kind: "browser",
      who: "test",
      label: "holder",
      pid: process.pid,
      estimateMin: 5,
    });
    const child = path.join(__dirname, "run-child.ts");
    const sh = spawn(
      "sh",
      [
        "-c",
        `"${process.execPath}" --import tsx "${child}" & echo "waiter $!"; wait`,
      ],
      {
        env: {
          ...process.env,
          DEN_GATE_DIR: dir,
          TSX_DISABLE_CACHE: "1",
          // A browser ask names where its browser runs (required on
          // macOS); only its form is checked, never connected to.
          DEN_PW_WS: "ws://127.0.0.1:9/orphan-752",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    kids.push(sh);
    let out = "";
    await new Promise<void>((resolve) =>
      sh.stdout!.on("data", (d: Buffer) => {
        out += String(d);
        if (/waiter \d+/.test(out)) resolve();
      }),
    );
    const waiter = Number(/waiter (\d+)/.exec(out)?.[1]);
    strays.push(waiter);
    for (let i = 0; i < 500 && store.list().length < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(store.list().map((e) => e.label)).toEqual(["holder", "sleeper"]);
    await new Promise<void>((resolve) => {
      sh.on("exit", () => resolve());
      sh.kill("SIGKILL");
    });
    // The check runs every 2 s while waiting; allow a few.
    for (let i = 0; i < 400 && store.list().length > 1; i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(store.list().map((e) => e.label)).toEqual(["holder"]);
    for (let i = 0; i < 200 && alive(waiter); i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(alive(waiter)).toBe(false);
  }, 40_000);
});

describe("a dead waiter holds no place (issue 752)", () => {
  it("is swept on the next pass", () => {
    const pids = new Set([100, 200]);
    const s = new GateStore({ dir: tmp(), alive: (p) => pids.has(p) });
    const holder = s.ask({
      kind: "browser",
      who: "h",
      label: "h",
      pid: 100,
      estimateMin: 5,
    });
    s.ask({ kind: "browser", who: "w", label: "w", pid: 200, estimateMin: 5 });
    pids.delete(200);
    expect(s.list().map((e) => e.id)).toEqual([holder.id]);
  });
});

describe("gate_slot_release: an agent's own entries (issue 752)", () => {
  const api = {
    baseUrl: "http://localhost:47003",
    async get(p: string) {
      if (p === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      throw new Error(`no API call expected: ${p}`);
    },
  } as unknown as DenApi;
  const ctx = (store: GateStore, actor = "agent:coder"): ToolContext => ({
    api,
    cfg: {
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    } as unknown as ToolContext["cfg"],
    cli: "acme",
    scope: { workspace: "north", actor },
    gates: store,
  });
  // What `gate run` writes from the agent's shell (DEN_AGENT set).
  const shellAsk = (store: GateStore, actor: string) =>
    store.ask({
      kind: "browser",
      who: `Den · north · ${actor}`,
      label: "e2e",
      pid: 31337,
      estimateMin: 30,
      agent: true,
      actor,
    });

  it("releases a shell-made entry of its own", async () => {
    const store = new GateStore({ dir: tmp(), alive: () => true });
    const held = shellAsk(store, "agent:coder");
    const waiting = shellAsk(store, "agent:coder");
    const r = await callTool(
      "gate_slot_release",
      { id: waiting.id },
      ctx(store),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text)).toEqual({ released: true });
    const r2 = await callTool("gate_slot_release", { id: held.id }, ctx(store));
    expect(JSON.parse(r2.text)).toEqual({ released: true });
    expect(store.list()).toEqual([]);
  });

  it("still refuses another agent's entry", async () => {
    const store = new GateStore({ dir: tmp(), alive: () => true });
    const other = shellAsk(store, "agent:reviewer");
    const r = await callTool("gate_slot_release", { id: other.id }, ctx(store));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("that slot isn't yours");
    expect(store.list().map((e) => e.id)).toEqual([other.id]);
  });
});
