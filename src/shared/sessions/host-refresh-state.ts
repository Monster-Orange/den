/**
 * Issue 731: what Den's own terminal host refresh (host-refresh.ts, run at
 * the web server's start, or on the held write host_restart) is
 * doing, for doctor to read: waiting for agents mid-turn (since when, for
 * at most how long), or how it ended. One small file in the state dir,
 * written by the server that runs the refresh:
 *
 *   <state>/host-refresh.json   { state, startedAt, waitSeconds, pid, … }
 *
 * A "waiting" written by a server that is gone is no refresh at all (it
 * died mid-wait): read as null, so doctor offers the held write.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";

export type HostRefreshPhase =
  | "waiting"
  | "restarted"
  | "failed"
  | "kept"
  | "current"
  | "none";

export interface HostRefreshState {
  state: HostRefreshPhase;
  /** When the refresh began (ISO UTC). */
  startedAt: string;
  /** sessions.host_restart_wait_seconds it waits at most. */
  waitSeconds: number;
  /** The web server's pid that runs it. */
  pid: number;
  /** When it ended (ISO UTC); absent while waiting. */
  endedAt?: string;
  /** Why it failed, or why the host needed the restart. */
  why?: string;
  /** What started it: the web server's start, or the held write. */
  by?: "start" | "held";
  /**
   * Issue 732: while waiting, the agents whose turn has ended but a
   * background job they started still runs (the restart would end it),
   * each with how long it has run: doctor says so, never "mid-turn".
   */
  jobs?: { agent: string; minutes: number }[];
}

export const hostRefreshFile = (stateDir: string): string =>
  path.join(stateDir, "host-refresh.json");

/** Writes the state (atomic, 0600). Best effort: never throws. */
export function writeHostRefreshState(
  stateDir: string,
  s: HostRefreshState,
): void {
  const file = hostRefreshFile(stateDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(s) + "\n", { mode: 0o600 });
  } catch {
    /* doctor then offers the held write: never worse than before */
  }
}

const PHASES: readonly string[] = [
  "waiting",
  "restarted",
  "failed",
  "kept",
  "current",
  "none",
];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The last refresh's state, or null when none is known (no file, a bad
 * one, or a wait whose server is gone).
 */
export function readHostRefreshState(
  stateDir: string,
  alive: (pid: number) => boolean = pidAlive,
): HostRefreshState | null {
  let v: Partial<HostRefreshState>;
  try {
    v = JSON.parse(fs.readFileSync(hostRefreshFile(stateDir), "utf8"));
  } catch {
    return null;
  }
  if (
    !v ||
    typeof v.state !== "string" ||
    !PHASES.includes(v.state) ||
    typeof v.startedAt !== "string" ||
    Number.isNaN(Date.parse(v.startedAt)) ||
    typeof v.waitSeconds !== "number" ||
    typeof v.pid !== "number"
  )
    return null;
  if (v.state === "waiting" && !alive(v.pid)) return null;
  const out = { ...v } as HostRefreshState;
  delete out.jobs;
  // Issue 732: only well-formed entries.
  const jobs = Array.isArray(v.jobs)
    ? v.jobs.filter(
        (j): j is { agent: string; minutes: number } =>
          !!j &&
          typeof j.agent === "string" &&
          j.agent.length > 0 &&
          j.agent.length <= 64 &&
          typeof j.minutes === "number" &&
          Number.isFinite(j.minutes) &&
          j.minutes >= 0,
      )
    : [];
  return jobs.length
    ? {
        ...out,
        jobs: jobs.map((j) => ({ agent: j.agent, minutes: j.minutes })),
      }
    : out;
}

/**
 * Issue 731: the held write that restarts the terminal host the supported
 * way (the refresh's wait for idle agents, restart, resume and audit), on
 * the person's one Allow. Doctor's fix after a failed or unknown refresh.
 */
export const HOST_RESTART_ACTION = "host_restart";
export const HOST_RESTART_TITLE =
  "Restart the terminal host when agents are idle";
