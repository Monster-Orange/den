#!/usr/bin/env node
/**
 * Save Playwright test result to JSONL
 * Called from test afterEach hook
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "../results");

// Get arguments
const [pillar, environment, testName, status, duration, user, error] =
  process.argv.slice(2);

if (!pillar || !testName || !status) {
  console.error(
    "Usage: node save-test-result.js <pillar> <environment> <testName> <status> <duration> <user> [error]",
  );
  process.exit(1);
}

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// Build result object
const result = {
  timestamp: new Date().toISOString(),
  pillar,
  environment,
  test: testName,
  status,
  duration: parseInt(duration) || 0,
  user: user || "unknown",
};

if (error && error !== "null") {
  result.error = error;
}

// Write to JSONL file
const filename = path.join(RESULTS_DIR, `${pillar}-${environment}.jsonl`);
const line = JSON.stringify(result) + "\n";

try {
  fs.appendFileSync(filename, line, "utf8");
  // Silent success - don't spam test output
} catch (err) {
  console.error(`Failed to write result: ${err.message}`);
}
