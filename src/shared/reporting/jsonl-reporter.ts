/**
 * JSONL Reporter for Playwright
 * Writes test results to JSONL format for historical tracking
 */

import type {
  Reporter,
  TestCase,
  TestResult as PlaywrightTestResult,
  FullConfig,
  Suite,
} from "@playwright/test/reporter";
import { resultWriter } from "../results/result-writer.js";
import type { Pillar, Environment } from "../types/index.js";
import * as os from "os";
import * as path from "path";

export default class JSONLReporter implements Reporter {
  onBegin(_config: FullConfig, _suite: Suite) {
    console.log("[JSONL Reporter] Initialized");
  }

  async onTestEnd(test: TestCase, result: PlaywrightTestResult) {
    console.log("[JSONL Reporter] onTestEnd called");
    try {
      // Detect pillar from test file path
      const pillar = this.detectPillar(test.location.file);
      console.log(`[JSONL Reporter] Pillar detected: ${pillar}`);

      // Get environment from env var or default to local
      const environment = (process.env.TEST_ENV || "local") as Environment;

      // Get test title path (e.g., "Smoke Tests - App Health › web app is accessible")
      const testTitle = test.titlePath().slice(1).join(" › ");

      // Get relative test file path for better readability
      const testFile = this.getRelativeTestPath(test.location.file, pillar);

      // Determine status
      let status: "passed" | "failed" | "skipped";
      if (result.status === "passed") {
        status = "passed";
      } else if (result.status === "skipped") {
        status = "skipped";
      } else {
        status = "failed";
      }

      // Get screenshot and trace paths if they exist
      const screenshot = result.attachments.find(
        (a) => a.name === "screenshot" || a.contentType?.startsWith("image/"),
      )?.path;

      const trace = result.attachments.find(
        (a) => a.name === "trace" || a.contentType?.includes("zip"),
      )?.path;

      // Write result to JSONL
      await resultWriter.writeResult({
        timestamp: new Date().toISOString(),
        pillar,
        environment,
        test: `${testFile} › ${testTitle}`,
        status,
        duration: result.duration,
        user: process.env.USER || os.userInfo().username || "unknown",
        error: result.error?.message,
        screenshot,
        trace,
        metadata: {
          browser: test.parent.project()?.name,
          retries: result.retry,
          workerIndex: result.workerIndex,
        },
      });
    } catch (error) {
      // Don't let reporter errors break tests
      console.warn(
        `[JSONL Reporter] Failed to write result: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Detect pillar from test file path
   */
  private detectPillar(filePath: string): Pillar {
    if (
      filePath.includes("/.synth-run/") ||
      filePath.includes("/pillars/browser/")
    ) {
      return "synthetic";
    } else if (
      filePath.includes("/pillars/api/") ||
      filePath.includes("/integration/")
    ) {
      return "integration";
    } else if (
      filePath.includes("/pillars/perf/") ||
      filePath.includes("/performance/")
    ) {
      return "performance";
    } else if (
      filePath.includes("/pillars/smoke/") ||
      filePath.includes("/.smoke-run/")
    ) {
      return "smoke";
    } else if (filePath.includes("/pillars/journeys/")) {
      // Journeys aren't Playwright-run (they have their own JSONL writer in
      // src/pillars/journeys/report/); branch kept for union completeness.
      return "journeys";
    }

    // Default to synthetic
    return "synthetic";
  }

  /**
   * Get relative test path for display
   */
  private getRelativeTestPath(filePath: string, pillar: Pillar): string {
    // Extract path relative to pillar directory
    const parts = filePath.split(`/${pillar}/tests/`);
    if (parts.length > 1) {
      return parts[1].replace(/\.spec\.ts$/, "");
    }

    // Fallback to just filename
    return path.basename(filePath, ".spec.ts");
  }
}
