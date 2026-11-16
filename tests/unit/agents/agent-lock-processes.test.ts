/**
 * Issue 218: one change per agent across processes, not only within one.
 * The CLI and the web server are separate processes; each change to one
 * agent takes a lock file in the agent's state folder, so a second process
 * waits for the first. A lock left by a process that died is taken over.
 *
 * Real child processes (node with tsx) on a temp state folder. Invented
 * names only; nothing real runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LOCK_WAIT_MINUTES_DEFAULT,
  withAgentLock,
} from "../../../src/shared/agents/agent-lock.js";
import {
  AGENTS_RESERVED_KEYS,
  readAgentsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";

const ROOT = path.resolve(__dirname, "../../..");
const LOCK_TS = path.join(ROOT, "src/shared/agents/agent-lock.ts");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");

const tmps: string[] = [];
const kids: { kill(): void }[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lock-"));
  tmps.push(d);
  return d;
}

/** A tiny script: take the lock on agent a1, note enter and exit times. */
function script(dir: string): string {
  const f = path.join(dir, "contend.mts");
  fs.writeFileSync(
    f,
    `import * as fs from "fs";
import { withAgentLock } from ${JSON.stringify(LOCK_TS)};
const [stateDir, out, tag] = process.argv.slice(2);
await withAgentLock(stateDir, "a1", async () => {
  fs.appendFileSync(out, JSON.stringify({ tag, at: "enter", t: Date.now() }) + "\\n");
  await new Promise((r) => setTimeout(r, 400));
  fs.appendFileSync(out, JSON.stringify({ tag, at: "exit", t: Date.now() }) + "\\n");
}, { pollMs: 20 });
`,
  );
  return f;
}

function run(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(TSX, [file, ...args], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    });
    kids.push(p);
    p.on("error", reject);
    p.on("exit", (code) => resolve(code ?? -1));
  });
}

/** A pid that no process has any more. */
function deadPid(): number {
  const r = spawnSync(process.execPath, [
    "-e",
    "process.stdout.write(String(process.pid))",
  ]);
  return Number(String(r.stdout));
}

describe("the agent lock across processes (issue 218)", () => {
  it("two processes changing one agent never overlap", async () => {
    const dir = tmp();
    const stateDir = path.join(dir, "state");
    fs.mkdirSync(stateDir);
    const out = path.join(dir, "times.jsonl");
    const f = script(dir);
    const codes = await Promise.all([
      run(f, [stateDir, out, "one"]),
      run(f, [stateDir, out, "two"]),
      run(f, [stateDir, out, "three"]),
    ]);
    expect(codes).toEqual([0, 0, 0]);
    const rows = fs
      .readFileSync(out, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { tag: string; at: string; t: number });
    expect(rows).toHaveLength(6);
    // In time order, each enter is followed by its own exit.
    rows.sort((a, b) => a.t - b.t);
    for (let i = 0; i < rows.length; i += 2) {
      expect(rows[i].at).toBe("enter");
      expect(rows[i + 1]).toMatchObject({ tag: rows[i].tag, at: "exit" });
    }
    // Released: no lock file left behind.
    expect(fs.existsSync(path.join(stateDir, "agents", "a1.lock"))).toBe(false);
  }, 30_000);

  it("a lock left by a process that died is taken over", async () => {
    const stateDir = tmp();
    const lock = path.join(stateDir, "agents", "a1.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const dead = deadPid();
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: dead, at: new Date().toISOString() }),
    );
    let inside: unknown;
    await withAgentLock(
      stateDir,
      "a1",
      async () => {
        inside = JSON.parse(fs.readFileSync(lock, "utf-8"));
      },
      { waitMs: 5_000, pollMs: 20 },
    );
    expect(inside).toMatchObject({ pid: process.pid });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a lock a live process holds is waited for, up to the wait", async () => {
    const stateDir = tmp();
    const lock = path.join(stateDir, "agents", "a1.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    kids.push(live);
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: live.pid, at: new Date().toISOString() }),
    );
    let ran = false;
    const err = await withAgentLock(
      stateDir,
      "a1",
      async () => {
        ran = true;
      },
      { waitMs: 300, pollMs: 20 },
    ).catch((e: unknown) => e);
    expect(ran).toBe(false);
    expect(String((err as Error)?.message)).toMatch(
      /agent a1 is busy with another change/,
    );
    // Someone else's lock: left as it was.
    expect(JSON.parse(fs.readFileSync(lock, "utf-8"))).toMatchObject({
      pid: live.pid,
    });
  });
});

describe("agents.lock_wait_minutes (issue 218)", () => {
  const wait = (v: unknown) =>
    readAgentsConfig({
      agents: { lock_wait_minutes: v },
    } as unknown as DenConfig).lockWaitMs;

  it("unset: the default (permissive); set: in ms; it is no agent id", () => {
    expect(readAgentsConfig({} as DenConfig).lockWaitMs).toBeUndefined();
    expect(LOCK_WAIT_MINUTES_DEFAULT).toBeGreaterThanOrEqual(10);
    expect(wait(45)).toBe(45 * 60_000);
    expect(wait(0.5)).toBe(30_000);
    expect(AGENTS_RESERVED_KEYS).toContain("lock_wait_minutes");
  });

  it("a bad value fails naming the key", () => {
    for (const bad of [0, -1, "8", true, Number.NaN])
      expect(() => wait(bad)).toThrow(/agents\.lock_wait_minutes: /);
  });
});
