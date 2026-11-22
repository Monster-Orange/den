#!/usr/bin/env node
/**
 * Issue 844: how long a pull request waited for its first red. The pr job
 * runs the directly affected tests first; when that step fails, this
 * writes one line to the run summary: the time from the run's start to now.
 *
 *   node scripts/ci-first-red.mjs <run-start ISO time> <what failed>
 *     Prints the line (the step appends it to $GITHUB_STEP_SUMMARY).
 *
 * An empty or unreadable start says the time isn't known: never a guess.
 */
import { pathToFileURL } from "node:url";

/** The summary line for a red `what`, `nowMs` after a run started at `startIso`. */
export function firstRedLine(startIso, nowMs, what) {
  const start = Date.parse(startIso || "");
  if (!Number.isFinite(start) || nowMs < start)
    return `**First red:** the run's start time isn't known (${what}).`;
  const s = Math.round((nowMs - start) / 1000);
  const min = Math.floor(s / 60);
  return `**First red:** ${min} min ${s % 60} s after the run started (${what}).`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    firstRedLine(
      process.argv[2] ?? "",
      Date.now(),
      process.argv[3] || "a step",
    ),
  );
