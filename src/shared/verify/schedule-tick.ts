/**
 * Issue 214: what the schedule loop does with a schedule now, and what it
 * remembers. A run is due at the cron's next time after the last one Den
 * handled; it starts in its window, under its standing Allow, or is skipped
 * and named. Catching up after Den was down runs once, never once per
 * missed time.
 *
 * State lives in <state>/verify/<project>/schedule-runs.json (0600).
 */
import * as fs from "fs";
import * as path from "path";
import { inWindow, nextRun, parseWindow, windowEnd } from "./cron.js";
import {
  scheduleLimit,
  scheduleState,
  type ScheduleLimitReason,
  type Schedule,
  type ScheduleAllow,
  type ScheduleSettings,
} from "./schedules.js";

export type SkipReason =
  | "needs-allow"
  | "plan-changed"
  | "expired"
  | "window"
  | "busy"
  | ScheduleLimitReason;

export interface ScheduleRunState {
  /** The last due time Den handled (or first saw the schedule at). */
  lastDue?: string;
  last?: { runId: string; verdict: string; at: string };
  /** Newest last; at most 10. */
  skipped?: { due: string; reason: SkipReason }[];
  /** The Allow expiry the bell last warned about. */
  warned?: string;
}

export type Decision =
  | { action: "baseline" }
  | { action: "wait" }
  | { action: "run"; due: string }
  | { action: "skip"; due: string; reason: SkipReason };

export function decide(
  s: Schedule,
  allow: ScheduleAllow | undefined,
  r: ScheduleRunState,
  now: Date,
  settings: ScheduleSettings,
): Decision {
  if (!r.lastDue) return { action: "baseline" };
  const due = nextRun(s.cron, new Date(r.lastDue));
  if (!due || due > now) return { action: "wait" };
  const w = parseWindow(s.window);
  const end = windowEnd(w, due);
  const iso = due.toISOString();
  if (end && now >= end) return { action: "skip", due: iso, reason: "window" };
  if (!inWindow(w, now)) return { action: "wait" };
  const lim = scheduleLimit(s, settings);
  if (lim) return { action: "skip", due: iso, reason: lim.reason };
  const st = scheduleState(s, allow, now, settings);
  if (st === "needs-allow" || st === "plan-changed" || st === "expired")
    return { action: "skip", due: iso, reason: st };
  return { action: "run", due: iso };
}

const fileOf = (stateDir: string, project: string) =>
  path.join(stateDir, "verify", project, "schedule-runs.json");

export function readScheduleRuns(
  stateDir: string,
  project: string,
): Record<string, ScheduleRunState> {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(stateDir, project), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Merges a change into a schedule's state; a skip joins the list. */
export function noteScheduleRun(
  stateDir: string,
  project: string,
  id: string,
  change: {
    lastDue?: string;
    last?: ScheduleRunState["last"];
    skip?: { due: string; reason: SkipReason };
    warned?: string;
  },
): ScheduleRunState {
  const all = readScheduleRuns(stateDir, project);
  const cur = all[id] ?? {};
  const next: ScheduleRunState = {
    ...cur,
    ...(change.lastDue ? { lastDue: change.lastDue } : {}),
    ...(change.last ? { last: change.last } : {}),
    ...(change.warned ? { warned: change.warned } : {}),
  };
  if (change.skip)
    next.skipped = [...(cur.skipped ?? []), change.skip].slice(-10);
  all[id] = next;
  const file = fileOf(stateDir, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

/** Issue 964: the lock that keeps two servers on one state folder from both running. */
export const scheduleLockOf = (stateDir: string) =>
  path.join(stateDir, "verify", "schedules.lock");

/** A lock older than this is taken over, whatever its process (a run that hung). */
const LOCK_STALE_MS = 6 * 3_600_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the scheduled-run lock, or returns null when another run holds it
 * (in this process or another one). The lock names its process; one
 * whose process is gone, or that is older than 6 hours, is taken over.
 * Call the returned function to let it go.
 */
export function takeScheduleLock(
  stateDir: string,
  now = Date.now(),
): (() => void) | null {
  const file = scheduleLockOf(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = `${process.pid} ${now} ${Math.random().toString(36).slice(2)}\n`;
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, mine, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(file, "utf-8") === mine) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let held = "";
    try {
      held = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // let go between the two calls: try again
    }
    const [pid, at] = held.split(" ").map(Number);
    const stale =
      !Number.isFinite(pid) ||
      !Number.isFinite(at) ||
      now - at > LOCK_STALE_MS ||
      !alive(pid);
    if (!stale) return null;
    try {
      if (fs.readFileSync(file, "utf-8") === held) fs.unlinkSync(file);
    } catch {
      /* someone else took it over */
    }
  }
  return null;
}
