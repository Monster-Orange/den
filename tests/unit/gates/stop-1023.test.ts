/**
 * Issue 1023: a stopped `gate run` frees its slot at once. A real gate run
 * (run-child.ts) around a node sleeper; the slot must be gone within 2 s
 * of a signal to the command, or to gate run itself.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { GATE_RUN_SIGNALS } from "../../../src/ui/cli/gate-command.js";

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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A real gate run holding a browser slot; resolves once its run is up. */
async function holding() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1023-"));
  tmps.push(dir);
  // Seen with a live pid check, as another waiter on the machine would.
  const store = new GateStore({ platform: "linux", dir });
  const k = spawn(
    process.execPath,
    ["--import", "tsx", path.join(__dirname, "run-child.ts")],
    {
      env: {
        ...process.env,
        DEN_GATE_DIR: dir,
        TSX_DISABLE_CACHE: "1",
        DEN_PW_WS: "ws://192.0.2.1:9",
      },
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
  for (let i = 0; i < 250 && store.list()[0]?.runPid !== sleeper; i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(store.list()[0]?.runPid).toBe(sleeper);
  return { store, k, sleeper };
}

/** Milliseconds until the queue is empty (or -1 after `ms`). */
async function freedWithin(store: GateStore, ms: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (store.list().length === 0) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 25));
  }
  return -1;
}

describe("issue 1023: a stopped gate run frees its slot at once", () => {
  for (const sig of [
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
    "SIGQUIT",
    "SIGKILL",
  ] as const)
    it(`${sig} to the command frees the slot within 2 s`, async () => {
      const { store, k, sleeper } = await holding();
      const gone = new Promise<number | null>((r) => k.on("exit", r));
      process.kill(sleeper, sig);
      const t = await freedWithin(store, 2_000);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(await gone).not.toBe(0);
      expect(store.events().map((e) => e.event)).toEqual([
        "asked",
        "granted",
        "released",
      ]);
    }, 30_000);

  // Every signal gate run passes on (gate-command.ts, which run-child.ts runs).
  it("passes on SIGINT, SIGTERM, SIGHUP and SIGQUIT", () => {
    expect([...GATE_RUN_SIGNALS].sort()).toEqual([
      "SIGHUP",
      "SIGINT",
      "SIGQUIT",
      "SIGTERM",
    ]);
  });

  for (const sig of GATE_RUN_SIGNALS)
    it(`${sig} to gate run passes to the command and frees the slot within 2 s`, async () => {
      const { store, k, sleeper } = await holding();
      k.kill(sig);
      const t = await freedWithin(store, 2_000);
      expect(t).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < 100 && alive(sleeper); i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(alive(sleeper)).toBe(false);
    }, 30_000);
});
