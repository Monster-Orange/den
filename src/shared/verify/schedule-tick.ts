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
  commandLimit,
  scheduleState,
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
  | "commands-off"
  | "command-unclear";

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
  const lim = commandLimit(s, settings);
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
