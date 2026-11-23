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
 *   3. A lock left by a process that is gone is taken back at once; a
 *      live holder's only once it is 60 s old (a stalled writer keeps it).
 *   4. A change saved later merges onto the file as it is then, so the
 *      other process's change made meanwhile stays.
 *   5. A change still waiting when the process ends (process.exit, as the
 *      CLI and the server's SIGTERM and restart end) is saved at exit.
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

/** Another process runs `body` with NotificationStore imported. */
function child(body: string): ChildProcess {
  const src = path.join(ROOT, "src/shared/notifications.ts");
  const code =
    `const { NotificationStore } = await import(${JSON.stringify(src)});` +
    body;
  const k = spawn(
    process.execPath,
    [
      "--import",
      path.join(ROOT, "node_modules/tsx/dist/loader.mjs"),
      "--input-type=module",
      "-e",
      code,
    ],
    { stdio: ["ignore", "pipe", "ignore"], cwd: ROOT },
  );
  kids.push(k);
  return k;
}
const exited = (k: ChildProcess) =>
  new Promise<number | null>((r) =>
    k.exitCode !== null ? r(k.exitCode) : k.on("exit", (c) => r(c)),
  );

/** Another process adds `n` entries, one store per add (as the CLI does). */
function adder(stateDir: string, n: number): Promise<number | null> {
  return exited(
    child(
      `for (let i = 0; i < ${n}; i++) new NotificationStore(${JSON.stringify(stateDir)}).add(` +
        `{ kind: "waiting", subject: "agent:a" + i, scope: "workspace/north", text: "t" + i });`,
    ),
  );
}

const lockOf = (d: string) => path.join(d, "notifications.json.lock");
const fileOf = (d: string) => path.join(d, "notifications.json");
/** The lock, as a holder that is this test's own (live) process. */
function takeLock(d: string, ageMs = 0) {
  fs.mkdirSync(lockOf(d), { recursive: true });
  fs.writeFileSync(path.join(lockOf(d), "pid"), String(process.pid));
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(lockOf(d), t, t);
  }
}
const onDisk = (d: string) =>
  fs.existsSync(fileOf(d))
    ? (
        JSON.parse(fs.readFileSync(fileOf(d), "utf-8")) as {
          items: { subject: string }[];
        }
      ).items.map((x) => x.subject)
    : [];

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

  it("a live holder's lock: kept at 20 s old, taken back at 70 s", async () => {
    const d = dir();
    const add = (subject: string) =>
      new NotificationStore(d).add({
        kind: "waiting",
        subject,
        scope: "workspace/north",
        text: "t",
      });
    takeLock(d, 20_000);
    add("agent:young");
    expect(onDisk(d)).toEqual([]);
    takeLock(d, 70_000);
    add("agent:old");
    await notificationsSaved(d);
    expect(onDisk(d).sort()).toEqual(["agent:old", "agent:young"]);
    expect(fs.existsSync(lockOf(d))).toBe(false);
  });
});

describe("a change saved later (issue 1348)", () => {
  it("merges onto the file as it is then: the holder's own write stays", async () => {
    const d = dir();
    takeLock(d);
    new NotificationStore(d).add({
      kind: "waiting",
      subject: "agent:mine",
      scope: "workspace/north",
      text: "waits for the lock",
    });
    // The holder writes its own entry, then lets go.
    fs.writeFileSync(
      fileOf(d),
      JSON.stringify({
        items: [
          {
            id: "other-1",
            kind: "waiting",
            subject: "agent:other",
            scope: "workspace/north",
            text: "the other process's",
            at: new Date(Date.now() - 1000).toISOString(),
            read: false,
          },
        ],
        mutes: [],
      }),
    );
    fs.rmSync(lockOf(d), { recursive: true, force: true });
    await notificationsSaved(d);
    expect(onDisk(d).sort()).toEqual(["agent:mine", "agent:other"]);
  });
});

describe("a change still waiting when the process ends (issue 1348)", () => {
  const ADD = (d: string) =>
    `new NotificationStore(${JSON.stringify(d)}).add({ kind: "waiting", subject: "agent:late", scope: "workspace/north", text: "t" });`;

  it("process.exit (the CLI's end): saved at exit once the lock frees", async () => {
    const d = dir();
    takeLock(d);
    const k = child(ADD(d) + "process.exit(0);");
    setTimeout(
      () => fs.rmSync(lockOf(d), { recursive: true, force: true }),
      300,
    );
    expect(await exited(k)).toBe(0);
    expect(onDisk(d)).toEqual(["agent:late"]);
  }, 30_000);

  it("SIGTERM (the server's stop and restart end in process.exit): saved", async () => {
    const d = dir();
    takeLock(d);
    const k = child(
      `process.on("SIGTERM", () => process.exit(0));` +
        ADD(d) +
        `console.log("ready"); setInterval(() => {}, 1000);`,
    );
    await new Promise<void>((r) => k.stdout!.once("data", () => r()));
    k.kill("SIGTERM");
    setTimeout(
      () => fs.rmSync(lockOf(d), { recursive: true, force: true }),
      300,
    );
    expect(await exited(k)).toBe(0);
    expect(onDisk(d)).toEqual(["agent:late"]);
  }, 30_000);
});
