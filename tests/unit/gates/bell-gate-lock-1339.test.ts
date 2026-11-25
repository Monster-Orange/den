/**
 * Issue 1339 (part B): the bell's refresh, GET /api/notifications, read
 * the gate slots (issue 993's overrun line) through GateStore.list(). That
 * takes the machine-wide gate-slot lock, the one every gate run
 * takes, with a synchronous wait of up to 10 s on the server's one thread.
 * While another process held it, the whole server stood still: the bell,
 * and every other page.
 *
 *   1. GateStore.peekAll() reads the slots without the lock, at once, while
 *      another live process holds it, and changes nothing.
 *   2. It shows what list() shows: a held slot; not one whose run is gone
 *      or whose lease lapsed.
 *   3. bellGateOverruns (what the server's bell calls) answers at once
 *      with the lock held, with the overrun line.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { bellGateOverruns } from "../../../src/ui/server/gate-overrun-bell.js";

const tmps: string[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-23T16:00:00Z");
const MIN = 60_000;

function setup(alive: (pid: number) => boolean = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1339g-"));
  tmps.push(dir);
  let now = T0;
  const store = new GateStore({
    platform: "linux",
    dir,
    now: () => now,
    alive,
  });
  return {
    dir,
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const run = (s: GateStore, pid = 1) =>
  s.ask({
    kind: "browser",
    who: "den · north · agent:coder",
    label: "e2e suite",
    pid,
    estimateMin: 10,
    agent: true,
    actor: "agent:coder",
  });

/** Another process takes the gate-slot lock, as a gate run does, and keeps it. */
async function holdLock(dir: string): Promise<void> {
  const lock = path.join(dir, "lock");
  const k = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");fs.mkdirSync(${JSON.stringify(lock)});` +
        `fs.writeFileSync(${JSON.stringify(path.join(lock, "pid"))},String(process.pid));` +
        `setInterval(()=>{},1000);`,
    ],
    { stdio: "ignore" },
  );
  kids.push(k);
  const t0 = Date.now();
  while (!fs.existsSync(path.join(lock, "pid"))) {
    if (Date.now() - t0 > 5_000) throw new Error("the holder never took it");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const listing = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((n) => !n.startsWith("lock"))
    .sort();

describe("GateStore.peekAll (issue 1339)", () => {
  it("answers at once while another process holds the lock, and writes nothing", async () => {
    const t = setup();
    const e = run(t.store);
    await holdLock(t.dir);
    const before = listing(t.dir);
    const t0 = performance.now();
    const got = t.store.peekAll();
    expect(performance.now() - t0).toBeLessThan(1_000); // list() would wait 10 s
    expect(got.map((x) => x.id)).toEqual([e.id]);
    expect(listing(t.dir)).toEqual(before);
  });

  it("shows what list() shows: what list() keeps (a gone waiter its while), and not a gone holder", () => {
    let dead = 0;
    const t = setup((pid) => pid !== dead);
    const keep = run(t.store, 11);
    const goes = run(t.store, 12);
    expect(
      t.store
        .peekAll()
        .map((x) => x.id)
        .sort(),
    ).toEqual([keep.id, goes.id].sort());
    // The waiter's run is gone: it keeps its place a while, as list() does.
    dead = 12;
    expect(
      t.store
        .peekAll()
        .map((x) => x.id)
        .sort(),
    ).toEqual([keep.id, goes.id].sort());
    // The holder's run is gone: not there (list() takes it back).
    dead = 11;
    expect(t.store.peekAll().map((x) => x.id)).not.toContain(keep.id);
    expect(t.store.peekAll().map((x) => x.id)).toEqual(
      t.store.list().map((x) => x.id),
    );
  });
});

describe("the bell's overrun line (issue 1339 with 993)", () => {
  it("answers at once with the lock held, with the line", async () => {
    const t = setup();
    const e = run(t.store);
    t.advance(21 * MIN);
    await holdLock(t.dir);
    const t0 = performance.now();
    const got = bellGateOverruns(t.store, T0 + 21 * MIN);
    expect(performance.now() - t0).toBeLessThan(1_000); // list() would wait 10 s
    expect(got).toMatchObject([{ kind: "gate_overrun", id: e.id }]);
  });
});
