/**
 * Issue 1129: agents/restarts-waiting.json, how many agents the server's
 * restart queue holds (restart-queue-service.ts writes it). Doctor reads
 * it; a new server clears what an earlier one left.
 */
import * as fs from "fs";
import * as path from "path";

/** What doctor reads: how many wait, and since when. */
export interface RestartsWaiting {
  waiting: number;
  ids: string[];
  at: string;
}

export function restartsWaitingFile(stateDir: string): string {
  return path.join(stateDir, "agents", "restarts-waiting.json");
}

export function readRestartsWaiting(stateDir: string): RestartsWaiting | null {
  try {
    const o = JSON.parse(
      fs.readFileSync(restartsWaitingFile(stateDir), "utf8"),
    ) as Partial<RestartsWaiting>;
    return typeof o.waiting === "number" &&
      Array.isArray(o.ids) &&
      typeof o.at === "string"
      ? { waiting: o.waiting, ids: o.ids.map(String), at: o.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * A new server holds no queue: what an earlier one left waiting is gone,
 * so its file (and doctor's line) goes too.
 */
export function clearRestartsWaiting(stateDir: string): void {
  try {
    fs.rmSync(restartsWaitingFile(stateDir), { force: true });
  } catch {
    /* doctor's line is best effort */
  }
}
