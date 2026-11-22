/**
 * Issue 52: where the Coach keeps its runs, in the state dir (0600, on this
 * machine only): `coach/latest.json`, and each run under `coach/runs/`,
 * the newest `agents.coach.keep_runs` of them.
 */
import * as fs from "fs";
import * as path from "path";
import { writePrivate } from "../agents/records.js";
import type { CoachReport } from "./breakdown.js";

export function coachDir(stateDir: string): string {
  return path.join(stateDir, "coach");
}

export function coachRunsDir(stateDir: string): string {
  return path.join(coachDir(stateDir), "runs");
}

const RUN_RE = /^\d{8}T\d{9}Z\.json$/;

/** A run's file name: its time, sortable, with no colons. */
function runName(ranAt: string): string {
  return `${ranAt.replace(/[-:.]/g, "")}.json`;
}

/** Save `report` as the latest and as a run; keep the newest `keepRuns`. */
export function writeCoachReport(
  stateDir: string,
  report: CoachReport,
  keepRuns: number,
): void {
  const text = JSON.stringify(report, null, 2) + "\n";
  writePrivate(path.join(coachRunsDir(stateDir), runName(report.ranAt)), text);
  writePrivate(path.join(coachDir(stateDir), "latest.json"), text);
  const runs = fs
    .readdirSync(coachRunsDir(stateDir))
    .filter((n) => RUN_RE.test(n))
    .sort();
  for (const n of runs.slice(0, Math.max(0, runs.length - keepRuns)))
    fs.rmSync(path.join(coachRunsDir(stateDir), n), { force: true });
}

/** The latest run, or null when there is none (or it can't be read). */
export function readCoachReport(stateDir: string): CoachReport | null {
  try {
    const r = JSON.parse(
      fs.readFileSync(path.join(coachDir(stateDir), "latest.json"), "utf-8"),
    ) as CoachReport;
    return r && r.version === 1 ? r : null;
  } catch {
    return null;
  }
}
