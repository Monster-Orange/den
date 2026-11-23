/**
 * Issue 1132, clauses 1 and 2: a gate run's worker tree is stopped when
 * the run is gone. A real `gate run` (reap-child.ts) around a node command
 * that starts three node workers (sleepers, never a suite).
 *
 *   - the command exits, its workers left behind: they are stopped when
 *     the slot ends (TERM; KILL after gates.reap_grace_seconds)
 *   - the run's folder is deleted while it holds the slot: its tree is
 *     stopped and the slot ends with that reason
 *   - gate run itself killed hard: the next pass of the queue (any store)
 *     stops the group it left, and the slot log says what, never how
 *   - a process outside the run's group, the same command line, is never
 *     touched
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const tmp = (name: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `den-gate1132-${name}-`));
  tmps.push(d);
  return d;
};

/** Waits until `ok` or `ms` pass; the milliseconds taken, or -1. */
async function within(ms: number, ok: () => boolean): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (ok()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
  }
  return ok() ? Date.now() - t0 : -1;
}

/** A real gate run around the workers; resolves once they are up. */
async function start(o: {
  mode: "exit" | "stay";
  stubborn?: boolean;
  cwd?: string;
  grace?: number;
}) {
  const dir = tmp("q");
  const store = new GateStore({ platform: "linux", dir });
  store.writeSettings({ reap_grace_seconds: o.grace ?? 1 }, "test");
  const k = spawn(
    process.execPath,
    [
      "--import",
      // By its full path: the run may start in a folder outside the repo.
      pathToFileURL(
        path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
      ).href,
      path.join(__dirname, "reap-child.ts"),
    ],
    {
      cwd: o.cwd ?? process.cwd(),
      env: {
        ...process.env,
        DEN_GATE_DIR: dir,
        TSX_DISABLE_CACHE: "1",
        DEN_GATE_LOAD5: "0",
        REAP_MODE: o.mode,
        REAP_STUBBORN: o.stubborn ? "1" : "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  kids.push(k);
  let err = "";
  const up = await new Promise<RegExpExecArray | null>((resolve) => {
    const t = setTimeout(() => resolve(null), 20_000);
    k.stderr.on("data", (d: Buffer) => {
      err += String(d);
      const m = /workers (\d+) ([\d,]+)/.exec(err);
      if (m) {
        clearTimeout(t);
        resolve(m);
      }
    });
  });
  if (!up) throw new Error(`the workers never started: ${err.slice(-400)}`);
  const command = Number(up[1]);
  const workers = up[2]!.split(",").map(Number);
  strays.push(command, ...workers);
  return { dir, store, k, command, workers, err: () => err };
}

const leftoverRows = (store: GateStore) =>
  store.events().filter((e) => e.event === "stopped-leftovers");

describe("a run's worker tree", () => {
  it("the command exits and leaves its workers: they are stopped when the slot ends", async () => {
    const r = await start({ mode: "exit" });
    expect(r.workers.every(alive)).toBe(true);
    expect(await within(8_000, () => r.k.exitCode !== null)).not.toBe(-1);
    expect(await within(3_000, () => !r.workers.some(alive))).not.toBe(-1);
    expect(r.store.list()).toEqual([]);
    const rows = leftoverRows(r.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      count: 3,
      cmd: "node",
      label: "reaper",
      reason: "ended",
    });
    // What, never how: no arguments or environment in the row.
    expect(JSON.stringify(rows[0])).not.toMatch(/spawn|setInterval|REAP_/);
  });

  it("workers that ignore TERM are killed after the grace period", async () => {
    const r = await start({ mode: "exit", stubborn: true, grace: 1 });
    // gate run stays until its tree is gone: TERM, the grace, then KILL.
    expect(await within(10_000, () => r.k.exitCode !== null)).not.toBe(-1);
    expect(await within(2_000, () => !r.workers.some(alive))).not.toBe(-1);
    const rows = leftoverRows(r.store);
    expect(rows.map((x) => x.signal)).toEqual(["TERM", "KILL"]);
    expect(rows[1]).toMatchObject({ count: 3, label: "reaper" });
    // KILL came no sooner than the grace after TERM.
    expect(
      Date.parse(rows[1]!.at) - Date.parse(rows[0]!.at),
    ).toBeGreaterThanOrEqual(1_000);
  });

  it("the run's folder is deleted while it holds the slot: its tree is stopped and the slot ends with that reason", async () => {
    const work = tmp("work");
    const r = await start({ mode: "stay", cwd: work });
    expect(r.store.list()[0]?.grantedAt).toBeTruthy();
    fs.rmSync(work, { recursive: true, force: true });
    expect(
      await within(8_000, () => ![r.command, ...r.workers].some(alive)),
    ).not.toBe(-1);
    expect(await within(3_000, () => r.store.list().length === 0)).not.toBe(-1);
    const end = r.store
      .events()
      .find((e) => e.event === "released" || e.event === "taken-back-gone");
    expect(end).toMatchObject({ reason: "folder-gone" });
  });

  it("gate run and its command killed hard: the next pass of the queue stops the workers they left", async () => {
    const r = await start({ mode: "stay" });
    // As in the incident: the run's processes gone, its workers not. (A
    // wrapper killed while its command lives keeps the slot: that rule
    // is unchanged.)
    r.k.kill("SIGKILL");
    process.kill(r.command, "SIGKILL");
    expect(
      await within(
        3_000,
        () => r.k.exitCode !== null || r.k.signalCode !== null,
      ),
    ).not.toBe(-1);
    expect(await within(3_000, () => !alive(r.command))).not.toBe(-1);
    // Left behind, until the queue looks.
    expect(r.workers.every(alive)).toBe(true);
    // Any store on the machine: the next pass takes the slot back and
    // stops what it left (and KILLs it after the grace, on a later pass).
    const look = new GateStore({ platform: "linux", dir: r.dir });
    expect(
      await within(6_000, () => {
        look.list();
        return !r.workers.some(alive);
      }),
    ).not.toBe(-1);
    const rows = leftoverRows(look);
    expect(rows[0]).toMatchObject({
      count: 3,
      cmd: "node",
      label: "reaper",
      reason: "gone",
    });
  });

  it("a process outside the run's group, with the same command line, is never stopped", async () => {
    const same = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000);"],
      {
        stdio: "ignore",
      },
    );
    kids.push(same);
    const r = await start({ mode: "exit" });
    expect(await within(8_000, () => !r.workers.some(alive))).not.toBe(-1);
    // Well past the grace: the outsider is still up.
    await new Promise((res) => setTimeout(res, 1_500));
    new GateStore({ platform: "linux", dir: r.dir }).list();
    expect(alive(same.pid!)).toBe(true);
  });
});
