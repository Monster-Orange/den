/**
 * `gate run` starts its command through a shim that waits for
 * a line on fd 3, sent once the command's group is recorded. Then it
 * becomes the command (the same pid, group and start time). If gate run
 * is gone before it sends the line, the command never runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Writable } from "stream";
import {
  cmdGate,
  GATE_HOLD_NEVER_STARTED,
  GATE_HOLD_SHIM,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";
import { GateStore } from "../../../src/shared/gates/store.js";

const posix = process.platform !== "win32";

function held(cmd: string, args: string[]) {
  const k = spawn(
    "/bin/sh",
    ["-c", GATE_HOLD_SHIM, "den-gate-hold", cmd, ...args],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  let out = "";
  k.stdout!.on("data", (d: Buffer) => (out += String(d)));
  const done = new Promise<number | null>((r) => k.on("exit", (c) => r(c)));
  return { k, go: k.stdio[3] as Writable, done, out: () => out };
}

(posix ? describe : describe.skip)("the gate run hold (issue 1575)", () => {
  it("nothing runs until the line comes; then the command runs as the same process, its arguments intact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hold-"));
    const mark = path.join(dir, "ran");
    try {
      const h = held("/bin/sh", [
        "-c",
        'echo "$$|$1|$2"; : > "$3"',
        "x",
        "a b",
        "$HOME",
        mark,
      ]);
      await new Promise((r) => setTimeout(r, 500));
      expect(fs.existsSync(mark)).toBe(false);
      expect(h.k.exitCode).toBeNull();
      h.go.end("go\n");
      expect(await h.done).toBe(0);
      expect(fs.existsSync(mark)).toBe(true);
      // exec kept the pid the group was recorded under
      expect(h.out().trim()).toBe(`${h.k.pid}|a b|$HOME`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gate run gone before the line (the pipe closes): the command never runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hold-"));
    const mark = path.join(dir, "ran");
    try {
      const h = held("/bin/sh", ["-c", ': > "$1"', "x", mark]);
      h.go.end();
      expect(await h.done).toBe(GATE_HOLD_NEVER_STARTED);
      expect(fs.existsSync(mark)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a command that isn't there fails as a shell says, 127", async () => {
    const h = held("/no/such/den-command", []);
    h.go.end("go\n");
    expect(await h.done).toBe(127);
  });
});

const stores: string[] = [];
afterEach(() => {
  for (const d of stores.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function recording(env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hold-deps-"));
  stores.push(dir);
  const store = new GateStore({ platform: "linux", dir, alive: () => true });
  const seen: string[] = [];
  const recordPid = store.setRunPid.bind(store);
  store.setRunPid = ((...a: Parameters<GateStore["setRunPid"]>) => {
    seen.push("recorded");
    return recordPid(...a);
  }) as GateStore["setRunPid"];
  const asked: ({ held?: boolean } | undefined)[] = [];
  const d: GateDeps = {
    store,
    env,
    out: () => {},
    err: () => {},
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: (_cmd, _args, _env, opts) => {
      asked.push(opts);
      seen.push("exec");
      return {
        pid: 7101,
        group: 7101,
        kill: () => {},
        done: Promise.resolve(0),
        ...(opts?.held ? { start: () => void seen.push("start") } : {}),
      };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    descends: () => true,
  };
  return { d, store, seen, asked };
}

describe("which runs are held (issue 1575)", () => {
  it.each([
    [["run", "--kind", "cpu", "--", "make", "test"]],
    [
      [
        "run",
        "--kind",
        "browser",
        "--browser-endpoint",
        "ws://127.0.0.1:9/pw",
        "--",
        "npx",
        "x",
      ],
    ],
  ])(
    "a run whose group is recorded asks for the hold, and starts after the record: %j",
    async (argv) => {
      const t = recording();
      expect(await cmdGate(argv, t.d)).toBe(0);
      expect(t.asked).toEqual([{ held: true }]);
      expect(t.seen).toEqual(["exec", "recorded", "start"]);
    },
  );

  it("a run inside a held slot records no group, so it isn't held", async () => {
    const outer = recording();
    const e = outer.store.ask({
      kind: "cpu",
      who: "outer",
      label: "outer",
      pid: 3000,
      estimateMin: 10,
      agent: false,
      project: "some-repo",
    });
    outer.store.setRunPid(e.id, 3001);
    const t = recording({ DEN_GATE_SLOT: e.id });
    t.d.store = outer.store;
    expect(
      await cmdGate(["run", "--kind", "cpu", "--", "make", "test"], t.d),
    ).toBe(0);
    expect(t.asked).toEqual([undefined]);
    expect(t.seen).toEqual(["exec"]);
  });
});
