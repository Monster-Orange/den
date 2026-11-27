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

const SPEND_FILE = "judge-spend.json";
const SPEND_KEEP_MS = 2 * 86_400_000;

function readSpend(stateDir: string): { at: number; tokens: number }[] {
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(path.join(coachDir(stateDir), SPEND_FILE), "utf-8"),
    );
    return Array.isArray(v)
      ? v.filter(
          (x): x is { at: number; tokens: number } =>
            !!x &&
            Number.isFinite((x as { at?: unknown }).at) &&
            Number.isFinite((x as { tokens?: unknown }).tokens),
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Slice T-d: record a run's judging spend, kept apart from the runs (which
 * keep_runs prunes) and trimmed to the last two days.
 */
export function recordJudgeSpend(
  stateDir: string,
  at: number,
  tokens: number,
): void {
  const list = readSpend(stateDir).filter((x) => x.at >= at - SPEND_KEEP_MS);
  list.push({ at, tokens: Math.max(0, tokens) });
  writePrivate(
    path.join(coachDir(stateDir), SPEND_FILE),
    JSON.stringify(list) + "\n",
  );
}

/** Tokens judging spent at or after `since` (ms since the epoch). */
export function judgeSpentSince(stateDir: string, since: number): number {
  return readSpend(stateDir)
    .filter((x) => x.at >= since)
    .reduce((n, x) => n + x.tokens, 0);
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
