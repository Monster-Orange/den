import { loadCurrentPerfRunReport } from "../../shared/perf/report-store.js";
import type { Pillar } from "../../shared/types/index.js";
import {
  VERDICT_EXIT,
  verdictOf,
  type Verdict,
} from "../../shared/run-outcome.js";

interface RunDonePayloadInput {
  pillar: Pillar;
  /** The kind's own process exit code; mapped to the one table. */
  exitCode: number;
  duration: number;
  rootDir?: string;
  /** The signal that ended the run's process, when one did. */
  signal?: NodeJS.Signals | null;
}

export function getRunDonePayload(input: RunDonePayloadInput): {
  type: "done";
  /** The one table (issue 207): 0 passed, 1 failed, 3 nothing ran, 4 cancelled. */
  exitCode: number;
  verdict: Verdict;
  duration: number;
  /** Nothing ran, for any kind: not a pass (0.4.45, issue 207). */
  nothingRan?: true;
  /** A person or an agent stopped the run: not a pass (issue 207). */
  cancelled?: true;
  perfReport?: {
    available: boolean;
    url: string;
  };
} {
  const verdict = verdictOf(input.pillar, input.exitCode, {
    signal: input.signal,
  });
  const base = {
    type: "done" as const,
    exitCode: VERDICT_EXIT[verdict],
    verdict,
    duration: input.duration,
    ...(verdict === "nothing ran" ? { nothingRan: true as const } : {}),
    ...(verdict === "cancelled" ? { cancelled: true as const } : {}),
  };

  if (input.pillar !== "performance") {
    return base;
  }

  const report = loadCurrentPerfRunReport(input.rootDir);
  if (!report) {
    return base;
  }

  return {
    ...base,
    perfReport: {
      available: true,
      url: "/api/perf-report/current",
    },
  };
}
