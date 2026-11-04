import * as fs from "fs";
import * as path from "path";
import type { PerfRunReport } from "./report-types.js";
import { getDistRoot } from "../paths.js";
import { buildPerfRunReport, type K6Summary } from "./report-normalizer.js";
import {
  PERF_CURRENT_REPORT_DIR,
  PERF_CURRENT_REPORT_FILE,
  getPerfSummaryArtifactPath,
} from "./report-paths.js";

interface WriteCurrentPerfRunReportInput {
  rootDir?: string;
  environment: string;
  modules: string[];
  startedAt?: string;
  finishedAt?: string;
}

export function writeCurrentPerfRunReport(
  input: WriteCurrentPerfRunReportInput,
): PerfRunReport {
  // Default anchored to the den root, NOT process.cwd(): this WRITES
  // .perf-report/, and perf children spawned by the CLI inherit an arbitrary
  // user cwd (bin/den never cds).
  const rootDir = input.rootDir ?? getDistRoot();
  const report = buildPerfRunReport({
    environment: input.environment,
    modules: input.modules.map((moduleName) => ({
      module: moduleName,
      summary: readSummaryArtifact(rootDir, moduleName),
      artifactPath: getPerfSummaryArtifactPath(moduleName),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    })),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });

  fs.mkdirSync(path.join(rootDir, PERF_CURRENT_REPORT_DIR), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(rootDir, PERF_CURRENT_REPORT_FILE),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  return report;
}

export function loadCurrentPerfRunReport(
  rootDir = getDistRoot(),
): PerfRunReport | null {
  const reportPath = path.join(rootDir, PERF_CURRENT_REPORT_FILE);
  if (!fs.existsSync(reportPath)) {
    return null;
  }

  // A truncated/corrupt report.json must not crash the request handler — treat
  // an unparseable report as "no report yet".
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf-8")) as PerfRunReport;
  } catch {
    return null;
  }
}

/**
 * Remove the previous run's normalized report + raw summary artifacts at the
 * START of a run.
 *
 * `.perf-report/current/` is reused across runs, so without this the prior
 * run's `report.json` (and per-module `*.summary.json`) linger. If the report
 * is read before the current run regenerates it — or a threshold-breaching run
 * never regenerates it — `loadCurrentPerfRunReport` silently serves STALE prior
 * results (the back-to-back staleness bug). Clearing here makes such a read
 * return `null` ("no report yet", loud) instead of stale data.
 */
export function resetCurrentPerfRunReport(rootDir = getDistRoot()): void {
  try {
    fs.rmSync(path.join(rootDir, PERF_CURRENT_REPORT_FILE), { force: true });
  } catch {
    /* nothing to remove */
  }
  try {
    const dir = path.join(rootDir, PERF_CURRENT_REPORT_DIR);
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith(".summary.json")) {
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    }
  } catch {
    /* dir may not exist yet */
  }
}

function readSummaryArtifact(rootDir: string, moduleName: string): K6Summary {
  const artifactPath = path.join(
    rootDir,
    getPerfSummaryArtifactPath(moduleName),
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing k6 summary artifact for module "${moduleName}"`);
  }

  // JSON boundary: k6 wrote this artifact, so the shape is trusted here and
  // every field access in the normalizer is already optional/defensive.
  return JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as K6Summary;
}
