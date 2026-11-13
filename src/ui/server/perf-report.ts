import { loadCurrentPerfRunReport } from "../../shared/perf/report-store.js";
import type { Pillar } from "../../shared/types/index.js";
import { nothingRan } from "../../shared/run-outcome.js";

interface RunDonePayloadInput {
  pillar: Pillar;
  exitCode: number;
  duration: number;
  rootDir?: string;
}

export function getRunDonePayload(input: RunDonePayloadInput): {
  type: "done";
  exitCode: number;
  duration: number;
  /** Every suite was skipped: not a pass (0.4.45). */
  nothingRan?: true;
  perfReport?: {
    available: boolean;
    url: string;
  };
} {
  const base = {
    type: "done" as const,
    exitCode: input.exitCode,
    duration: input.duration,
    ...(nothingRan(input.pillar, input.exitCode)
      ? { nothingRan: true as const }
      : {}),
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
