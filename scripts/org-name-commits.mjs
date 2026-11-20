#!/usr/bin/env node
/**
 * Org-name check for commit messages. Den is public and history is forever,
 * so a message must not name an org any more than a file may. Same patterns
 * and same matching as the file gate (scripts/org-names.js: DEN_ORG_NAMES or
 * DEN_ORG_NAMES_FILE).
 *
 *   node scripts/org-name-commits.mjs <base>..<head>   CI: every commit in the range
 *   node scripts/org-name-commits.mjs --message <file> commit-msg hook: one message
 *
 * Range mode fails (2) with no patterns, like the file gate, so a missing
 * secret never passes silently. Message mode passes quietly with none, so a
 * machine without the names file can still commit; a per-user names file
 * that is there but broken (a dangling link, no patterns) fails it, so a
 * hook never checks 0 patterns without saying so. Only new ranges are
 * checked: nothing already on main is rewritten.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { orgHitsWide, orgPatternsOrExit } from "./org-names.js";

const [mode, arg] = process.argv.slice(2);
// A per-user names file that is there but broken fails both modes (issue 528).
const patterns = orgPatternsOrExit("org-name check");

if (mode === "--message") {
  if (patterns.length === 0) process.exit(0);
  // Lines git adds itself (comments) are not part of the message.
  const text = readFileSync(arg, "utf-8")
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n");
  const hits = orgHitsWide(text, patterns);
  if (hits.length) {
    console.error(
      `org-name check: this commit message matches pattern ${hits
        .map((h) => `#${h.index}`)
        .join(", #")}. Reword it; no org's names in this public repo.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const range = mode;
if (!range || !range.includes("..")) {
  console.error(
    "usage: org-name-commits.mjs <base>..<head> | --message <file>",
  );
  process.exit(2);
}
if (patterns.length === 0) {
  console.error(
    "org-name commits: no patterns (set DEN_ORG_NAMES or DEN_ORG_NAMES_FILE)",
  );
  process.exit(2);
}
const [base] = range.split("..");
if (/^0+$/.test(base)) {
  // A push with no earlier tip (a new branch): no range to check.
  console.log("org-name commits: no base, nothing to check");
  process.exit(0);
}

const shas = execFileSync("git", ["rev-list", range], { encoding: "utf-8" })
  .split("\n")
  .filter(Boolean);
let bad = 0;
for (const sha of shas) {
  const msg = execFileSync("git", ["show", "-s", "--format=%B", sha], {
    encoding: "utf-8",
  });
  const hits = orgHitsWide(msg, patterns);
  if (!hits.length) continue;
  bad++;
  const subject = msg.split("\n")[0];
  // The subject is shown unless it is what matched: CI logs are public too.
  const shown = orgHitsWide(subject, patterns).length
    ? "(subject withheld)"
    : subject;
  console.log(
    `${sha.slice(0, 8)} ${shown} matches pattern ${hits
      .map((h) => `#${h.index}`)
      .join(", #")}`,
  );
}
if (bad) {
  console.error(`org-name commits: ${bad} commit message(s) with a hit`);
  process.exit(1);
}
console.log(`org-name commits: ${shas.length} message(s) clean`);
