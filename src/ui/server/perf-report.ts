import { loadCurrentPerfRunReport } from "../../shared/perf/report-store.js";
import type { Pillar } from "../../shared/types/index.js";

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
  perfReport?: {
    available: boolean;
    url: string;
  };
} {
  const base = {
    type: "done" as const,
    exitCode: input.exitCode,
    duration: input.duration,
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
