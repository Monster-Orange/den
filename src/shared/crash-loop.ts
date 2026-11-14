/**
 * The web app's crash-loop guard (den#85). A service manager (launchd's
 * KeepAlive, systemd's Restart) brings a crashed web app straight back. When
 * the crash happens on every start (a heap that fills within seconds), that
 * loop runs until someone notices, and each start redoes the work that
 * crashed it.
 *
 * Each start is recorded in `<state>/web-boots.json` (0600, the newest 50);
 * a stop with exit code 0 marks its start clean. A start that finds at
 * least `restarts` earlier starts within `minutes` that never stopped
 * cleanly waits before it serves: 30 s, doubling with each further one, at
 * most `max_wait_seconds`. The bell says so. An update or a restart Den
 * asked for stops cleanly, so it never counts.
 *
 * Settings (user.yml): web.crash_loop_restarts (5), web.crash_loop_minutes
 * (10), web.crash_loop_max_wait_seconds (300).
 */
import fs from "node:fs";
import path from "node:path";

export const BOOTS_FILE = "web-boots.json";
const KEEP = 50;
const BASE_WAIT_S = 30;

export interface CrashLoopSettings {
  restarts: number;
  minutes: number;
  maxWaitSeconds: number;
}

export const CRASH_LOOP_DEFAULTS: CrashLoopSettings = {
  restarts: 5,
  minutes: 10,
  maxWaitSeconds: 300,
};

interface Boot {
  at: string;
  pid: number;
  clean?: boolean;
}

/** One web.<key> number from user.yml's `web`: `dflt` when unset or bad. */
function num(
  web: Record<string, unknown> | undefined,
  key: string,
  dflt: number,
  min: number,
): number {
  const v = web?.[key];
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : dflt;
}

/** The guard's settings from user.yml's `web` mapping (defaults without). */
export function crashLoopSettings(web: unknown): CrashLoopSettings {
  const w =
    web && typeof web === "object" && !Array.isArray(web)
      ? (web as Record<string, unknown>)
      : undefined;
  return {
    restarts: num(w, "crash_loop_restarts", CRASH_LOOP_DEFAULTS.restarts, 1),
    minutes: num(w, "crash_loop_minutes", CRASH_LOOP_DEFAULTS.minutes, 1),
    maxWaitSeconds: num(
      w,
      "crash_loop_max_wait_seconds",
      CRASH_LOOP_DEFAULTS.maxWaitSeconds,
      0,
    ),
  };
}

function readBoots(file: string): Boot[] {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return Array.isArray(v)
      ? (v as Boot[]).filter(
          (b) => b && typeof b.at === "string" && typeof b.pid === "number",
        )
      : [];
  } catch {
    return [];
  }
}

function writeBoots(file: string, boots: Boot[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(boots.slice(-KEEP))}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    // A state dir that can't be written never stops the web app.
  }
}

export interface BootCheck {
  /** Starts within the window that never stopped cleanly. */
  crashes: number;
  /** How long this start waits before it serves (0: none). */
  waitMs: number;
}

/**
 * Record this start (`pid` at `now`) and say whether it is in a crash
 * loop, and so how long it waits.
 */
export function recordBoot(
  stateDir: string,
  s: CrashLoopSettings,
  now: number = Date.now(),
  pid: number = process.pid,
): BootCheck {
  const file = path.join(stateDir, BOOTS_FILE);
  const boots = readBoots(file);
  const since = now - s.minutes * 60_000;
  const crashes = boots.filter(
    (b) => !b.clean && b.pid !== pid && Date.parse(b.at) >= since,
  ).length;
  boots.push({ at: new Date(now).toISOString(), pid });
  writeBoots(file, boots);
  if (crashes < s.restarts) return { crashes, waitMs: 0 };
  const extra = crashes - s.restarts;
  const waitS = Math.min(s.maxWaitSeconds, BASE_WAIT_S * 2 ** extra);
  return { crashes, waitMs: Math.max(0, waitS) * 1000 };
}

/** Mark `pid`'s start as stopped cleanly. */
export function markCleanStop(
  stateDir: string,
  pid: number = process.pid,
): void {
  const file = path.join(stateDir, BOOTS_FILE);
  const boots = readBoots(file);
  const mine = [...boots].reverse().find((b) => b.pid === pid && !b.clean);
  if (!mine) return;
  mine.clean = true;
  writeBoots(file, boots);
}

/**
 * Whether this process was started by a service manager: launchd (its
 * parent is pid 1) or systemd (INVOCATION_ID). DEN_CRASH_LOOP_GUARD=1 or 0
 * says so outright.
 */
export function runByServiceManager(
  env: NodeJS.ProcessEnv = process.env,
  ppid: number = process.ppid,
): boolean {
  if (env.DEN_CRASH_LOOP_GUARD === "1") return true;
  if (env.DEN_CRASH_LOOP_GUARD === "0") return false;
  return ppid === 1 || Boolean(env.INVOCATION_ID);
}
