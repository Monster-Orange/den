#!/usr/bin/env node
/**
 * Org-name gate: Den is public, so no org's names, hosts or accounts may land
 * in it. The patterns are NOT in this repo (listing them would publish them):
 * they come from DEN_ORG_NAMES (one regex per line; a CI secret) or the file
 * named by DEN_ORG_NAMES_FILE. With neither set the gate fails, so a missing
 * secret can never pass silently.
 *
 *   DEN_ORG_NAMES_FILE=../notes/org-names.txt node scripts/org-name-gate.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { orgHits, orgPatterns } from "./org-names.js";

const patterns = orgPatterns();
if (patterns.length === 0) {
  console.error(
    "org-name gate: no patterns (set DEN_ORG_NAMES or DEN_ORG_NAMES_FILE)",
  );
  process.exit(2);
}

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf-8" })
  .split("\0")
  .filter(Boolean);
let hits = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  const lines = [file, ...text.split("\n")];
  lines.forEach((line, i) => {
    for (const { index } of orgHits(line, patterns)) {
      hits++;
      // Name the file, line and pattern index, never the matched text: CI
      // logs are public too.
      console.log(
        `${file}:${i === 0 ? "(path)" : i} matches pattern #${index}`,
      );
    }
  });
}
if (hits) {
  console.error(`org-name gate: ${hits} hit(s)`);
  process.exit(1);
}
console.log(`org-name gate: ${files.length} files clean`);
