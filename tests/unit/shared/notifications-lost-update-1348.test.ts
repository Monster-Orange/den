/**
 * Issue 1348: the notification store reads the whole file, changes it and
 * writes it back. Other processes write the same file (the CLI, agents'
 * hooks). One adding an entry between another's read and write lost it.
 *
 *   1. Two processes: one adds entries while the other marks all read and
 *      clears in a loop. Every added entry is there at the end.
 *   2. A lock another live process holds: the change is seen at once in
 *      this process, never waited for on the thread, and saved once the
 *      lock is free.
 *   3. A lock left by a process that is gone is taken back.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  NotificationStore,
  notificationsSaved,
} from "../../../src/shared/notifications.js";

const tmps: string[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const ROOT = path.resolve(__dirname, "../../..");
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1348-"));
  tmps.push(d);
  return d;
};

/** Another process adds `n` entries, one store per add (as the CLI does). */
function adder(stateDir: string, n: number): Promise<number | null> {
  const src = path.join(ROOT, "src/shared/notifications.ts");
  const code =
    `const { NotificationStore } = await import(${JSON.stringify(src)});` +
    `for (let i = 0; i < ${n}; i++) new NotificationStore(${JSON.stringify(stateDir)}).add(` +
    `{ kind: "waiting", subject: "agent:a" + i, scope: "workspace/north", text: "t" + i });`;
  const k = spawn(
    process.execPath,
    [
      "--import",
      path.join(ROOT, "node_modules/tsx/dist/loader.mjs"),
      "--input-type=module",
      "-e",
      code,
    ],
    { stdio: "ignore", cwd: ROOT },
  );
  kids.push(k);
  return new Promise((r) => k.on("exit", (c) => r(c)));
}

/** Another process takes the store's lock and keeps it for `ms`. */
async function holdLock(stateDir: string, ms: number): Promise<void> {
  const lock = path.join(stateDir, "notifications.json.lock");
  const k = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");fs.mkdirSync(${JSON.stringify(lock)});` +
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

const subjects = (s: NotificationStore) =>
  new Set(s.list().map((n) => n.subject));

describe("two writers (issue 1348)", () => {
  it("one adds while the other marks all read and clears: no entry is lost", async () => {
    const d = dir();
    const N = 150;
    const store = new NotificationStore(d);
    let running = true;
    const done = adder(d, N).finally(() => (running = false));
    // The other writer, as the server's Mark all read and Clear read do.
    let passes = 0;
    while (running) {
      const ids = store.list().map((n) => n.id);
      store.markReadMany(ids);
      store.markRead({ all: true });
      passes++;
      await new Promise((r) => setImmediate(r));
    }
    expect(await done).toBe(0);
    await notificationsSaved(d);
    expect(passes).toBeGreaterThan(0);
    const got = subjects(new NotificationStore(d));
    const lost = Array.from({ length: N }, (_, i) => `agent:a${i}`).filter(
      (s) => !got.has(s),
    );
    expect(lost).toEqual([]);
  }, 60_000);
});

describe("a busy lock (issue 1348)", () => {
  it("never waits on the thread; seen at once here, saved once it's free", async () => {
    const d = dir();
    await holdLock(d, 3_000);
    const t0 = performance.now();
    const n = new NotificationStore(d).add({
      kind: "waiting",
      subject: "agent:busy",
      scope: "workspace/north",
      text: "while held",
    });
    // A wait would take the lock's 3 s; a busy runner takes far less than 1 s.
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(n?.subject).toBe("agent:busy");
    // This process sees it at once, through any store.
    expect(subjects(new NotificationStore(d)).has("agent:busy")).toBe(true);
    // Not on disk while the lock is held.
    expect(fs.existsSync(path.join(d, "notifications.json"))).toBe(false);
    await notificationsSaved(d);
    const disk = JSON.parse(
      fs.readFileSync(path.join(d, "notifications.json"), "utf-8"),
    ) as { items: { subject: string }[] };
    expect(disk.items.map((x) => x.subject)).toEqual(["agent:busy"]);
  }, 30_000);

  it("a lock left by a process that is gone is taken back", () => {
    const d = dir();
    const lock = path.join(d, "notifications.json.lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "pid"), "2147483646");
    new NotificationStore(d).add({
      kind: "waiting",
      subject: "agent:after",
      scope: "workspace/north",
      text: "t",
    });
    expect(fs.existsSync(path.join(d, "notifications.json"))).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
