/**
 * Global Teardown for Staged Synthetic Tests
 * Logs screenshot count retained in test-results/.
 */

import { type FullConfig } from "@playwright/test";
import * as path from "path";
import * as fs from "fs/promises";
import { getDistRoot } from "../../shared/paths.js";

async function globalTeardown(_config: FullConfig) {
  console.log("\n📸 Ensuring screenshots are retained...");

  // read-only screenshot count; anchored so it matches the config outputDir
  const testResultsDir = path.join(getDistRoot(), "test-results");

  try {
    const exists = await fs
      .access(testResultsDir)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      const entries = await fs.readdir(testResultsDir, { withFileTypes: true });
      let screenshotCount = 0;

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const testDir = path.join(testResultsDir, entry.name);
          const files = await fs.readdir(testDir);
          screenshotCount += files.filter((f) => f.endsWith(".png")).length;
        }
      }

      console.log(
        `✓ ${screenshotCount} screenshots retained in test-results/\n`,
      );
    } else {
      console.log("⚠️  No test-results directory found\n");
    }
  } catch (error) {
    console.warn(
      `Warning: Could not check screenshots: ${(error as Error).message}\n`,
    );
  }
}

export default globalTeardown;
