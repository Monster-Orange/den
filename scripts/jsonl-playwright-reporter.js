/**
 * Custom Playwright Reporter for JSONL
 * Writes test results to JSONL files for historical tracking
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const writerScript = path.join(__dirname, "write-result.js");

class JSONLReporter {
  onBegin(config, suite) {
    console.log("[JSONL] Reporter initialized");
  }

  async onTestEnd(test, result) {
    try {
      // Detect pillar from file path
      const filePath = test.location.file;
      let pillar = "synthetic";
      if (filePath.includes("/integration/")) pillar = "integration";
      else if (filePath.includes("/performance/")) pillar = "performance";

      // Get environment
      const environment = process.env.TEST_ENV || "local";

      // Build test name
      const testTitle = test.titlePath().slice(1).join(" › ");
      const fileName = path.basename(filePath, path.extname(filePath));
      const testName = `${fileName} › ${testTitle}`;

      // Determine status
      let status = "passed";
      if (result.status === "failed") status = "failed";
      else if (result.status === "skipped") status = "skipped";
      else if (result.status === "timedOut") status = "failed";

      // Build result object
      const resultData = {
        timestamp: new Date().toISOString(),
        pillar,
        environment,
        test: testName,
        status,
        duration: result.duration,
        user: process.env.USER || os.userInfo().username || "unknown",
        error: result.error?.message || null,
        retries: result.retry || 0,
      };

      // Write to JSONL asynchronously
      const child = spawn("node", [writerScript, JSON.stringify(resultData)], {
        stdio: "inherit",
      });

      // Don't wait for completion to avoid slowing down tests
    } catch (error) {
      console.warn(`[JSONL] Failed to write result: ${error.message}`);
    }
  }

  onEnd(result) {
    console.log(`[JSONL] Results written to results/ directory`);
  }
}

export default JSONLReporter;
