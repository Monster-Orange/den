#!/usr/bin/env node
/**
 * Issue 1127: the scheduled filed-text scan's command line. The scan
 * itself is scripts/filed-text-scan.js (its header says how it works).
 */
import { main } from "./filed-text-scan.js";

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  // gh's first line only: never item text.
  console.error(`filed-text scan: ${String(e?.message ?? e).split("\n")[0]}`);
  process.exitCode = 1;
}
