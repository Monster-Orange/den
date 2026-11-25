/**
 * Issue 1395: the gate's settings.json has one writer, GateStore's
 * writeSettings, and it writes under the gate-slot lock the grant
 * decision holds, so a change never lands in the middle of a decision.
 * The file is replaced whole (written aside, then renamed): a reader
 * never sees half of it. A temp gates folder; invented names only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateLockBusy, GateStore } from "../../../src/shared/gates/store.js";

let dir = "";
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1395-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const settingsFile = () => path.join(dir, "settings.json");

describe("issue 1395: one writer for the gate's settings, under its lock", () => {
  it("while another process holds the gate-slot lock, a write waits; past the wait it is refused and nothing is written", () => {
    const store = new GateStore({ dir, lockWaitMs: 0 });
    store.writeSettings({ cpu_slots: 2 }, "a person");
    const before = fs.readFileSync(settingsFile(), "utf-8");
    // A live holder: this process's own pid, so it is never taken back.
    const lock = path.join(dir, "lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    try {
      expect(() => store.writeSettings({ cpu_slots: 3 }, "a person")).toThrow(
        GateLockBusy,
      );
      expect(fs.readFileSync(settingsFile(), "utf-8")).toBe(before);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    store.writeSettings({ cpu_slots: 3 }, "a person");
    expect(store.settings().cpuSlots).toBe(3);
    // The lock is given back after the write.
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a reader in another process never sees half a file while it is rewritten", async () => {
    const store = new GateStore({ dir, lockWaitMs: 5_000 });
    store.writeSettings({ cpu_slots: 1 }, "a person");
    // A long value makes a torn write likely if the file were written in place.
    const long = "x".repeat(200_000);
    const reader = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");const f=${JSON.stringify(settingsFile())};let bad=0,n=0;const end=Date.now()+1500;while(Date.now()<end){try{JSON.parse(fs.readFileSync(f,"utf-8"));n++}catch(e){if(e.code!=="ENOENT")bad++}}process.stdout.write(JSON.stringify({bad,n}))`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    reader.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const done = new Promise<void>((r) => reader.on("close", () => r()));
    const end = Date.now() + 1200;
    let i = 0;
    while (Date.now() < end) {
      store.writeSettings(
        { cpu_slots: (i++ % 4) + 1, class_order: i % 2 ? long : null },
        "a person",
      );
      await new Promise((r) => setImmediate(r));
    }
    await done;
    const r = JSON.parse(out) as { bad: number; n: number };
    expect(r.n).toBeGreaterThan(0);
    expect(r.bad).toBe(0);
  }, 20_000);
});
