/**
 * Issue 487: doctor's GitHub budget lines, from the snapshot Den's server
 * writes (github-budget.json): what is left of the account's hourly
 * budget, when it resets, the reserve (✗ below it), and who spent it in
 * the last hour. Reads a file only: doctor never calls GitHub.
 */
import * as fs from "fs";
import { resetClock, type BudgetSnapshot } from "./budget.js";

export function readBudgetSnapshot(file: string): BudgetSnapshot | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf-8")) as BudgetSnapshot;
    return typeof s?.remaining === "number" &&
      typeof s.limit === "number" &&
      typeof s.reset === "number" &&
      typeof s.reserve === "number"
      ? s
      : null;
  } catch {
    return null;
  }
}

/** The lines, plain (doctor colours them); `top` spenders at most. */
export function githubBudgetLines(
  file: string,
  now: number = Date.now(),
  top = 5,
): string[] {
  const s = readBudgetSnapshot(file);
  if (!s)
    return [
      "  ℹ GitHub budget: not read yet (the Den server reads it when an agent waits for CI)",
    ];
  const resetPassed = s.reset * 1000 <= now;
  const below = !resetPassed && s.remaining < s.reserve;
  const when = resetPassed
    ? "reset since it was read"
    : `resets at ${resetClock(s.reset)}`;
  const lines = [
    `  ${below ? "✗" : "✓"} GitHub budget: ${s.remaining} of ${s.limit} requests left, ${when}; reserve ${s.reserve}${below ? " (below it: agents' calls through Den wait for the reset)" : ""}`,
  ];
  const spend = Object.entries(s.spend ?? {})
    .filter(([, n]) => typeof n === "number" && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
  if (spend.length)
    lines.push(
      `  ℹ spent through Den in the last hour: ${spend.map(([a, n]) => `${a} ${Math.round(n * 10) / 10}`).join(", ")}`,
    );
  return lines;
}

/** Whether the snapshot is below the reserve now (doctor's problem flag). */
export function budgetBelowReserve(file: string, now = Date.now()): boolean {
  const s = readBudgetSnapshot(file);
  return !!s && s.reset * 1000 > now && s.remaining < s.reserve;
}
