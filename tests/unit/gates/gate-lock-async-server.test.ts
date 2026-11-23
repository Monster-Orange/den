/**
 * Issue 1339 (follow-up): the server never waits on the gate-slot lock on
 * its one thread. Every gate run on the machine takes that lock; the
 * GateStore waited for it synchronously (up to 10 s), so while a gate run
 * held it, the whole server stood still.
 *
 *   1. A store with lockWaitMs 0 (the server's) says GateLockBusy at once
 *      when another live process holds the lock; a lock whose holder is
 *      gone is still taken back at once.
 *   2. gateLocked(fn) waits by timer: other work runs meanwhile, and fn
 *      runs once the lock is free. Past its wait it says GateLockBusy.
 *   3. GET /api/gate-slots (the gate chip) on the server's store: while
 *      the lock is held, the server's other timers keep running, and the
 *      answer comes once it is free.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  GateLockBusy,
  GateStore,
  gateLocked,
} from "../../../src/shared/gates/store.js";
import { handleGateRoutes } from "../../../src/ui/server/gate-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";

const tmps: string[] = [];
const kids: ChildProcess[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function serverStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gatelock-"));
  tmps.push(dir);
  return {
    dir,
    store: new GateStore({ platform: "linux", dir, lockWaitMs: 0 }),
  };
}

/** Another process takes the gate-slot lock, as a gate run does, for `ms`. */
async function holdLock(dir: string, ms: number): Promise<void> {
  const lock = path.join(dir, "lock");
  const k = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");fs.mkdirSync(${JSON.stringify(lock)},{recursive:false});` +
        `fs.writeFileSync(${JSON.stringify(path.join(lock, "pid"))},String(process.pid));` +
        `setTimeout(()=>{fs.rmSync(${JSON.stringify(lock)},{recursive:true,force:true});setInterval(()=>{},1000)},${ms});`,
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

/** How many times a 10 ms timer fired while `p` ran. */
async function ticksDuring<T>(p: () => Promise<T>) {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10);
  try {
    const t0 = Date.now();
    const value = await p();
    return { value, ticks, ms: Date.now() - t0 };
  } finally {
    clearInterval(iv);
  }
}

describe("the server's store: busy at once, never a spin (issue 1339)", () => {
  it("lockWaitMs 0: GateLockBusy at once while another live process holds it", async () => {
    const { dir, store } = serverStore();
    await holdLock(dir, 5_000);
    const t0 = performance.now();
    expect(() => store.list()).toThrow(GateLockBusy);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("a lock left by a process that is gone is taken back at once", () => {
    const { dir, store } = serverStore();
    fs.mkdirSync(path.join(dir, "lock"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lock", "pid"), "2147483646");
    expect(store.list()).toEqual([]);
  });
});

describe("gateLocked (issue 1339)", () => {
  it("waits by timer: other work runs, and fn runs once the lock is free", async () => {
    const { dir, store } = serverStore();
    await holdLock(dir, 400);
    const r = await ticksDuring(() => gateLocked(() => store.list()));
    expect(r.value).toEqual([]);
    expect(r.ms).toBeGreaterThanOrEqual(250);
    // A 10 ms timer fired through the wait: the thread was free.
    expect(r.ticks).toBeGreaterThanOrEqual(10);
  });

  it("past its wait: GateLockBusy", async () => {
    const { dir, store } = serverStore();
    await holdLock(dir, 5_000);
    await expect(
      gateLocked(() => store.list(), { waitMs: 150 }),
    ).rejects.toBeInstanceOf(GateLockBusy);
  });

  it("other errors are not waited on", async () => {
    let n = 0;
    await expect(
      gateLocked(() => {
        n++;
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(n).toBe(1);
  });
});

describe("GET /api/gate-slots on the server's store (issue 1339)", () => {
  it("while a gate run holds the lock, the server keeps running; the answer comes once it's free", async () => {
    const { dir, store } = serverStore();
    const server = http.createServer((req, res) => {
      setPrincipal(req, { kind: "person", actor: "person:pat" } as never);
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleGateRoutes(req, res, p, {
        store: () => store,
        title: "Acme",
        audit: (() => ({}) as never) as never,
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await holdLock(dir, 400);
    const r = await ticksDuring(async () => {
      const res = await fetch(`${base}/api/gate-slots`);
      return { status: res.status, body: (await res.json()) as unknown };
    });
    expect(r.value.status).toBe(200);
    expect(r.value.body).toMatchObject({ slots: [] });
    expect(r.ms).toBeGreaterThanOrEqual(250);
    expect(r.ticks).toBeGreaterThanOrEqual(10);
  });
});
