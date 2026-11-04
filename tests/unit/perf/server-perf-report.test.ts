import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { getRunDonePayload } from "../../../src/ui/server/perf-report.js";
import { PERF_CURRENT_REPORT_FILE } from "../../../src/shared/perf/report-paths.js";

const tmpDirs: string[] = [];

function createTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-perf-server-"));
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

describe("getRunDonePayload", () => {
  it("includes perf report metadata when the current report exists", () => {
    const rootDir = createTempRoot();
    const reportPath = path.join(rootDir, PERF_CURRENT_REPORT_FILE);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ pillar: "performance", environment: "staging" }),
      "utf-8",
    );

    expect(
      getRunDonePayload({
        pillar: "performance",
        exitCode: 99,
        duration: 45_000,
        rootDir,
      }),
    ).toEqual({
      type: "done",
      exitCode: 99,
      duration: 45_000,
      perfReport: {
        available: true,
        url: "/api/perf-report/current",
      },
    });
  });

  it("omits perf report metadata for non-performance runs", () => {
    expect(
      getRunDonePayload({
        pillar: "smoke",
        exitCode: 0,
        duration: 1_000,
      }),
    ).toEqual({
      type: "done",
      exitCode: 0,
      duration: 1_000,
    });
  });

  it("omits perf report metadata when a performance run has no report yet", () => {
    const rootDir = createTempRoot();

    expect(
      getRunDonePayload({
        pillar: "performance",
        exitCode: 1,
        duration: 2_000,
        rootDir,
      }),
    ).toEqual({
      type: "done",
      exitCode: 1,
      duration: 2_000,
    });
  });
});
