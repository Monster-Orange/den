/**
 * The shared GitHub watcher's one status line, for doctor and
 * `<cli> github status`: GitHub calls left this hour and the reset time,
 * the active watches (issue 1166: the queued ones, the oldest's age and the
 * cap now) and the current interval; when paused, why and until when. Read from the server's <state>/github/watch-status.json
 * (watcher.ts writes it each round).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { WatchStatus } from "./watcher.js";

export const watchStatusFile = (stateDir: string) =>
  path.join(stateDir, "github", "watch-status.json");

/** The server's last status, or null when it hasn't written one. */
export function readWatchStatus(stateDir: string): WatchStatus | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(watchStatusFile(stateDir), "utf-8"),
    ) as unknown;
    return v && typeof v === "object" ? (v as WatchStatus) : null;
  } catch {
    return null;
  }
}

const WHY: Record<string, string> = {
  budget: "GitHub's API budget is under Den's floor (github.api_budget_floor)",
  retry: "GitHub asked Den to wait (Retry-After)",
  secondary: "GitHub's secondary rate limit",
};

/** The line; ok false while paused. Null with no status yet. */
export function githubWatchLine(
  s: WatchStatus | null,
): { ok: boolean; text: string } | null {
  if (!s) return null;
  const calls =
    s.remaining === null
      ? "GitHub calls left: not known yet"
      : `${s.remaining}${s.limit ? ` of ${s.limit}` : ""} GitHub calls left${s.resetAt ? ` (reset ${s.resetAt})` : ""}`;
  // Issue 1166: the queued ones, the oldest open one's age and the cap.
  const age =
    s.oldestAt && Number.isFinite(Date.parse(s.oldestAt))
      ? Math.max(
          0,
          Math.floor((Date.parse(s.at) - Date.parse(s.oldestAt)) / 60_000),
        )
      : null;
  const rest =
    `${s.active} ${s.active === 1 ? "watch" : "watches"}` +
    (s.queued ? `, ${s.queued} queued` : "") +
    (age !== null ? `, oldest ${age} min` : "") +
    (s.cap ? ` (at most ${s.cap} at once now)` : "") +
    `, every ${s.intervalSeconds} s`;
  if (s.pausedUntil)
    return {
      ok: false,
      text: `paused until ${s.pausedUntil}: ${WHY[s.pausedWhy ?? ""] ?? "paused"}; ${calls}; ${rest}`,
    };
  return { ok: true, text: `${calls}; ${rest}` };
}
