/**
 * D34: a person clears an agent's finished helpers. Den keeps one mark per
 * agent, when it was cleared, in agent-files/<id>/helpers-cleared.json, so
 * it survives restarts, relaunches and rotations. Claude Code's own
 * subagent files are never touched: a cleared helper is only hidden.
 *
 * Hidden: a helper that is done, failed or stopped and ended at or before
 * the mark. Running and idle ones always show, and one that ends after
 * the mark shows as usual.
 */
import * as fs from "fs";
import * as path from "path";
import type { Helper } from "./helpers.js";
import { writePrivate } from "./records.js";

export const HELPERS_CLEARED_FILE = "helpers-cleared.json";

const clearedFile = (filesDir: string) =>
  path.join(filesDir, HELPERS_CLEARED_FILE);

/** The mark (epoch ms), or undefined when never cleared or unreadable. */
export function readClearedAt(filesDir: string): number | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(clearedFile(filesDir), "utf-8")) as {
      clearedAt?: unknown;
    } | null;
    const at = v?.clearedAt;
    return typeof at === "number" && Number.isFinite(at) && at > 0
      ? at
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeClearedAt(filesDir: string, at: number): void {
  writePrivate(
    clearedFile(filesDir),
    JSON.stringify({ clearedAt: at }, null, 2) + "\n",
  );
}

const ENDED = new Set(["done", "failed", "stopped"]);

/** When a finished helper ended, as near as its files tell. */
export function endedAt(h: Helper): number | undefined {
  if (h.lastActivityAt !== undefined) return h.lastActivityAt;
  if (h.startedAt !== undefined && h.durationMs !== undefined)
    return h.startedAt + h.durationMs;
  return h.startedAt;
}

/** Done, failed or stopped: what "Clear done" hides. */
export const isEnded = (h: Helper): boolean => ENDED.has(h.status);

/** Whether `h` is hidden by a mark at `at`. */
export function isCleared(h: Helper, at: number | undefined): boolean {
  if (at === undefined || !isEnded(h)) return false;
  return (endedAt(h) ?? 0) <= at;
}

/** `hs` split by the mark, each in its order. */
export function splitCleared(
  hs: readonly Helper[],
  at: number | undefined,
): { shown: Helper[]; cleared: Helper[] } {
  const shown: Helper[] = [];
  const cleared: Helper[] = [];
  for (const h of hs) (isCleared(h, at) ? cleared : shown).push(h);
  return { shown, cleared };
}
