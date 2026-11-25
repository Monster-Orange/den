/**
 * Review M1 (0.4.46): one change to an agent at a time. Start, stop,
 * resume and relaunch of one agent queue behind each other, so two
 * overlapping starts can't both pass the "is running" check on a stale
 * record. Re-entrant along one call chain (a restart stops, then resumes,
 * under the one lock).
 *
 * Issue 218: across processes too. The CLI and the web server are
 * separate processes, so each change also holds a lock file in the
 * agent's state folder (`agents/<id>.lock`, made with O_EXCL, holding the
 * holder's pid and when it took it). Another process waits for it, polling,
 * up to `waitMs` (the setting agents.lock_wait_minutes). A lock whose pid
 * no longer runs (a crash) is taken over. Released when the change ends,
 * and on the process's exit.
 */
import { AsyncLocalStorage } from "async_hooks";
import * as fs from "fs";
import * as path from "path";
import { agentsDir } from "./records.js";
import { LOCK_WAIT_MINUTES_DEFAULT } from "./limit-defaults.js";

/** agents.lock_wait_minutes when unset: a stop and resume never take this long. */
export { LOCK_WAIT_MINUTES_DEFAULT };
/** How often a process waiting for another's lock checks it again. */
export const LOCK_POLL_MS = 100;

export interface AgentLockOptions {
  /** How long to wait for another process's lock (default: the setting's default). */
  waitMs?: number;
  /** How often to look again while waiting. */
  pollMs?: number;
}

/** Another process held agent `id`'s lock for all of the wait. */
export class AgentLockBusy extends Error {
  constructor(
    readonly id: string,
    readonly holder: { pid?: number; at?: string } | null,
    readonly waitedMs: number,
  ) {
    const who = holder?.pid
      ? ` (process ${holder.pid}${holder.at ? `, since ${holder.at}` : ""})`
      : "";
    super(
      `agent ${id} is busy with another change${who}; waited ${Math.round(waitedMs / 1000)} s; nothing changed`,
    );
    this.name = "AgentLockBusy";
  }
}

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new Map<string, Promise<void>>();
/** Lock files this process holds now: removed on its exit. */
const mine = new Set<string>();
let exitHook = false;

export function agentLockFile(stateDir: string, id: string): string {
  return path.join(agentsDir(stateDir), `${id}.lock`);
}

export async function withAgentLock<T>(
  stateDir: string,
  id: string,
  fn: () => Promise<T>,
  opts: AgentLockOptions = {},
): Promise<T> {
  const key = `${stateDir}\0${id}`;
  const outer = held.getStore();
  if (outer?.has(key)) return fn();
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const tail = before.then(() => done);
  tails.set(key, tail);
  await before;
  try {
    const file = agentLockFile(stateDir, id);
    await acquire(file, id, opts);
    try {
      return await held.run(new Set([...(outer ?? []), key]), fn);
    } finally {
      releaseFile(file);
    }
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

async function acquire(
  file: string,
  id: string,
  opts: AgentLockOptions,
): Promise<void> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MINUTES_DEFAULT * 60_000;
  const pollMs = Math.max(1, opts.pollMs ?? LOCK_POLL_MS);
  const start = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    if (tryCreate(file)) return;
    if (takeOverStale(file, waitMs)) continue;
    const left = start + waitMs - Date.now();
    if (left <= 0) throw new AgentLockBusy(id, holderOf(file), waitMs);
    await sleep(Math.min(pollMs, left));
  }
}

const holderLine = () =>
  JSON.stringify({ pid: process.pid, at: new Date().toISOString() });

/** The lock file made with O_EXCL: true when this process now holds it. */
function tryCreate(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if (errCode(e) === "EEXIST") return false;
    throw e;
  }
  try {
    fs.writeSync(fd, holderLine());
  } finally {
    fs.closeSync(fd);
  }
  mine.add(file);
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const f of [...mine]) releaseFile(f);
    });
  }
  return true;
}

function readLock(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

function parseHolder(raw: string): { pid?: number; at?: string } | null {
  try {
    const v = JSON.parse(raw) as { pid?: unknown; at?: unknown };
    const pid =
      typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0
        ? v.pid
        : undefined;
    return { pid, at: typeof v.at === "string" ? v.at : undefined };
  } catch {
    return null;
  }
}

function holderOf(file: string): { pid?: number; at?: string } | null {
  const raw = readLock(file);
  return raw === null ? null : parseHolder(raw);
}

/** Whether process `pid` runs (EPERM: it runs as someone else). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) !== "ESRCH";
  }
}

/**
 * Whether the lock in `file` is stale: its pid no longer runs, or it is
 * this process's own and not one it holds (left behind). A lock that
 * can't be read (a holder that died between making it and writing it)
 * counts as stale once it is older than the wait.
 */
function stale(file: string, raw: string, waitMs: number): boolean {
  const h = parseHolder(raw);
  if (h?.pid) {
    if (h.pid === process.pid) return !mine.has(file);
    return !alive(h.pid);
  }
  try {
    return Date.now() - fs.statSync(file).mtimeMs > waitMs;
  } catch {
    return false;
  }
}

/**
 * A stale lock removed, so the next try can take it: true when the lock
 * is gone (removed here, or by its holder). One process at a time takes
 * over (a `.takeover` file made with O_EXCL), and only the lock it judged
 * stale: one that changed meanwhile is left alone.
 */
function takeOverStale(file: string, waitMs: number): boolean {
  const raw = readLock(file);
  if (raw === null) return true;
  if (!stale(file, raw, waitMs)) return false;
  const guard = `${file}.takeover`;
  let fd: number;
  try {
    fd = fs.openSync(guard, "wx", 0o600);
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
    // A taker that died mid-takeover leaves its guard: removed, tried next poll.
    const g = readLock(guard);
    if (g !== null && stale(guard, g, waitMs)) unlinkIfSame(guard, g);
    return false;
  }
  try {
    try {
      fs.writeSync(fd, holderLine());
    } finally {
      fs.closeSync(fd);
    }
    unlinkIfSame(file, raw);
    return true;
  } finally {
    unlinkIfSame(guard, null);
  }
}

/** Removes `file` when it still reads `raw` (null: whatever it reads). */
function unlinkIfSame(file: string, raw: string | null): void {
  try {
    if (raw !== null && readLock(file) !== raw) return;
    fs.unlinkSync(file);
  } catch (e) {
    if (errCode(e) !== "ENOENT") throw e;
  }
}

/** This process's lock on `file` removed (never another's). */
function releaseFile(file: string): void {
  if (!mine.delete(file)) return;
  try {
    const h = holderOf(file);
    if (h?.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* gone already, or unreadable: nothing of ours to remove */
  }
}
