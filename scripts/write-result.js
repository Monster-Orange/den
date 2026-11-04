#!/usr/bin/env node
/**
 * Simple JSONL result writer
 * Usage: node scripts/write-result.js <jsonData>
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "../results");

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// Get result data from command line or stdin
const resultData = process.argv[2] ? JSON.parse(process.argv[2]) : null;

if (!resultData) {
  console.error(
    'Usage: node scripts/write-result.js \'{"timestamp":"...","pillar":"..."}\'',
  );
  process.exit(1);
}

// Determine filename based on pillar and environment
const pillar = resultData.pillar || "synthetic";
const environment = resultData.environment || "local";
const filename = path.join(RESULTS_DIR, `${pillar}-${environment}.jsonl`);

// Append result to JSONL file
const line = JSON.stringify(resultData) + "\n";
fs.appendFileSync(filename, line, "utf8");

console.log(`✓ Result written to ${filename}`);
