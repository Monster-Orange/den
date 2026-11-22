/**
 * Issue 1023, on Linux: a command stopped with SIGQUIT dumps core before
 * it exits, and a crash handler may take seconds to read the dump. It can
 * run no more once the dump starts, so gate run gives its slot back then,
 * not at the command's exit.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cmdGate,
  coreDumping,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";
import { GateStore } from "../../../src/shared/gates/store.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function store(): GateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1023d-"));
  tmps.push(dir);
  return new GateStore({ platform: "linux", dir, alive: () => true });
}

/** A gate run whose command is dumping core when `dump` says so. */
function run(s: GateStore, withDumping: boolean) {
  let end: (code: number) => void = () => {};
  const done = new Promise<number>((r) => (end = r));
  let dump = false;
  const looks: (() => void)[] = [];
  const d: GateDeps = {
    store: s,
    env: {},
    out: () => {},
    err: () => {},
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: () => ({
      pid: 7001,
      kill: () => {},
      done,
      ...(withDumping ? { dumping: () => dump } : {}),
    }),
    every: (_ms, fn) => {
      looks.push(fn);
      return () => {
        const i = looks.indexOf(fn);
        if (i >= 0) looks.splice(i, 1);
      };
    },
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
  };
  const code = cmdGate(["run", "--kind", "cpu", "--", "node", "x.js"], d);
  return {
    code,
    end,
    startDump: () => (dump = true),
    look: () => looks.slice().forEach((f) => f()),
  };
}

describe("issue 1023: a command dumping core gives its slot back", () => {
  it("the slot is free once the dump starts, before the command exits", async () => {
    const s = store();
    const r = run(s, true);
    for (let i = 0; i < 50 && s.list()[0]?.runPid !== 7001; i++)
      await Promise.resolve();
    expect(s.list()[0]?.runPid).toBe(7001);
    r.look();
    expect(s.list()).toHaveLength(1); // still running: kept
    r.startDump();
    r.look();
    expect(s.list()).toHaveLength(0);
    r.end(131);
    expect(await r.code).toBe(131);
    expect(s.events().map((e) => e.event)).toEqual([
      "asked",
      "granted",
      "released",
    ]);
  });

  it("a command with no way to tell keeps its slot to its exit", async () => {
    const s = store();
    const r = run(s, false);
    for (let i = 0; i < 50 && s.list()[0]?.runPid !== 7001; i++)
      await Promise.resolve();
    r.look();
    expect(s.list()).toHaveLength(1);
    r.end(0);
    expect(await r.code).toBe(0);
    expect(s.list()).toHaveLength(0);
  });

  it("reads CoreDumping from /proc/<pid>/status", () => {
    const status = (v: string) => () => `Name:\tnode\nCoreDumping:\t${v}\n`;
    expect(coreDumping(1, status("1") as never)).toBe(true);
    expect(coreDumping(1, status("0") as never)).toBe(false);
    expect(
      coreDumping(1, (() => {
        throw new Error("ENOENT");
      }) as never),
    ).toBe(false);
  });
});
