import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  loadCurrentPerfRunReport,
  writeCurrentPerfRunReport,
} from "../../../src/shared/perf/report-store.js";
import {
  PERF_CURRENT_REPORT_FILE,
  getPerfSummaryArtifactPath,
} from "../../../src/shared/perf/report-paths.js";

const tmpDirs: string[] = [];

function createTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-perf-report-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("perf report store", () => {
  it("writes and reloads the current normalized perf report", () => {
    const rootDir = createTempRoot();

    const localSummaryPath = path.join(
      rootDir,
      getPerfSummaryArtifactPath("api-health"),
    );
    const repoSummaryPath = path.join(
      rootDir,
      getPerfSummaryArtifactPath("sample-service/search"),
    );

    fs.mkdirSync(path.dirname(localSummaryPath), { recursive: true });
    fs.writeFileSync(
      localSummaryPath,
      JSON.stringify({
        metrics: {
          http_req_failed: {
            values: { rate: 0 },
            thresholds: { "rate<0.01": true },
          },
        },
        root_group: { checks: [] },
        options: { scenarios: {} },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      repoSummaryPath,
      JSON.stringify({
        metrics: {
          http_req_failed: {
            values: { rate: 0.1 },
            thresholds: { "rate<0.01": false },
          },
        },
        root_group: { checks: [] },
        options: { scenarios: {} },
      }),
      "utf-8",
    );

    const report = writeCurrentPerfRunReport({
      rootDir,
      environment: "staging",
      modules: ["api-health", "sample-service/search"],
      finishedAt: "2026-03-19T12:01:00.000Z",
    });

    expect(report.status).toBe("failed");
    expect(report.modules).toHaveLength(2);
    expect(fs.existsSync(path.join(rootDir, PERF_CURRENT_REPORT_FILE))).toBe(
      true,
    );

    const loaded = loadCurrentPerfRunReport(rootDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.environment).toBe("staging");
    expect(loaded?.rawArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: getPerfSummaryArtifactPath("api-health"),
        }),
        expect.objectContaining({
          path: getPerfSummaryArtifactPath("sample-service/search"),
        }),
      ]),
    );
  });

  it("returns null when no normalized perf report exists yet", () => {
    const rootDir = createTempRoot();

    expect(loadCurrentPerfRunReport(rootDir)).toBeNull();
  });

  it("throws when a referenced summary artifact is missing", () => {
    const rootDir = createTempRoot();

    expect(() =>
      writeCurrentPerfRunReport({
        rootDir,
        environment: "local",
        modules: ["missing-module"],
      }),
    ).toThrow('Missing k6 summary artifact for module "missing-module"');
  });
});
