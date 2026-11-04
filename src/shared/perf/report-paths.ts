import * as path from "path";

export const PERF_REPORT_ROOT = ".perf-report";
export const PERF_CURRENT_REPORT_DIR = path.join(PERF_REPORT_ROOT, "current");
export const PERF_CURRENT_REPORT_FILE = path.join(
  PERF_CURRENT_REPORT_DIR,
  "report.json",
);

export function getPerfSummaryArtifactName(moduleName: string): string {
  return `${moduleName.replace(/\//g, "-")}.summary.json`;
}

export function getPerfSummaryArtifactPath(moduleName: string): string {
  return path.join(
    PERF_CURRENT_REPORT_DIR,
    getPerfSummaryArtifactName(moduleName),
  );
}
