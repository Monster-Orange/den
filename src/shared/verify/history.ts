/**
 * Issue 212: one module's history on one environment (S5): its last runs
 * oldest first, the flaky mark, and the first failing range.
 *
 *   flaky   passed after a retry in `flakyMinRetries` or more of its last
 *           `flakyWindow` runs (T11; both are settings)
 *   range   when it fails now: the last run it passed and the first run
 *           of the failing streak, with their commits ("since when?")
 *
 * Only ended runs that gave it a result count (cancelled is never one).
 */
import type { Findings } from "./findings.js";
import { hasEnded, type ModuleRecord, type RunRecord } from "./records.js";
import type { ModuleRun } from "./run.js";
import type { VerifySettings } from "./settings.js";

type ResultOnly = "passed" | "failed" | "error" | "blocked";

export interface HistoryRun {
  runId: string;
  endedAt: string;
  commit: string | null;
  state: ResultOnly;
  /** Passed after a retry. */
  flaky?: true;
  attempts?: ModuleRun["attempts"];
  message?: string;
  ms: number;
  findings?: Findings;
}

export interface ModuleHistory {
  module: string;
  env: string;
  /** Oldest first, at most settings.historyLimit. */
  runs: HistoryRun[];
  flaky: { mark: boolean; count: number; window: number; min: number };
  /** The state now, how many runs in a row, and the passes before it. */
  streak?: { state: ResultOnly; runs: number; passedBefore: number };
  /** When it fails now: where it last passed and where it first failed. */
  range?: {
    lastPassed?: { runId: string; commit: string | null };
    firstFailed: { runId: string; commit: string | null };
  };
}

const RESULT = new Set(["passed", "failed", "error", "blocked"]);

/** `runs`: the project's run records, newest first (listRunRecords). */
export function moduleHistory(
  runs: readonly RunRecord[],
  moduleId: string,
  env: string,
  s: VerifySettings,
): ModuleHistory {
  const newest: HistoryRun[] = [];
  for (const r of runs) {
    if (!hasEnded(r) || r.env !== env) continue;
    const m: ModuleRecord | undefined = r.modules.find(
      (x) => x.id === moduleId,
    );
    if (!m || !RESULT.has(m.state)) continue;
    newest.push({
      runId: r.runId,
      endedAt: r.endedAt,
      commit: r.commit ?? null,
      state: m.state as ResultOnly,
      ms: m.ms,
      ...(m.flaky ? { flaky: true as const } : {}),
      ...(m.attempts?.length ? { attempts: m.attempts } : {}),
      ...(m.message ? { message: m.message } : {}),
      ...(m.findings ? { findings: m.findings } : {}),
    });
  }
  const count = newest.slice(0, s.flakyWindow).filter((x) => x.flaky).length;
  const out: ModuleHistory = {
    module: moduleId,
    env,
    runs: newest.slice(0, s.historyLimit).reverse(),
    flaky: {
      mark: count >= s.flakyMinRetries,
      count,
      window: s.flakyWindow,
      min: s.flakyMinRetries,
    },
  };
  if (!newest.length) return out;
  const now = newest[0].state;
  let n = 0;
  while (n < newest.length && newest[n].state === now) n++;
  let passed = 0;
  while (n + passed < newest.length && newest[n + passed].state === "passed")
    passed++;
  out.streak = {
    state: now,
    runs: n,
    passedBefore: now === "passed" ? 0 : passed,
  };
  if (now !== "passed") {
    const first = newest[n - 1];
    const before = newest[n];
    out.range = {
      ...(before && before.state === "passed"
        ? { lastPassed: { runId: before.runId, commit: before.commit } }
        : {}),
      firstFailed: { runId: first.runId, commit: first.commit },
    };
  }
  return out;
}
