/**
 * Issue 1129: whether each agent was working (mid-turn) or idle, kept on
 * disk so a resume after Den or the machine restarts can start the
 * working ones first. Attention notes a change (a tool ran or a prompt
 * came: working; its turn ended or it waits for its person: idle); the
 * file is written only when an agent's state changes, never per tool.
 *
 *   <state>/agents/activity.json   { "<id>": { "working": bool, "at": iso } }
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";

export interface Activity {
  working: boolean;
  at: string;
}

export function activityFile(stateDir: string): string {
  return path.join(stateDir, "agents", "activity.json");
}

/** Each agent's last known state; {} when none or unreadable. */
export function readActivity(stateDir: string): Record<string, Activity> {
  try {
    const o = JSON.parse(fs.readFileSync(activityFile(stateDir), "utf8"));
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Record<string, Activity> = {};
    for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
      const a = v as Partial<Activity> | null;
      if (a && typeof a.working === "boolean" && typeof a.at === "string")
        out[id] = { working: a.working, at: a.at };
    }
    return out;
  } catch {
    return {};
  }
}

/** Note agent `id` working or idle; writes only on a change. */
export function noteActivity(
  stateDir: string,
  id: string,
  working: boolean,
  now: Date = new Date(),
): boolean {
  const all = readActivity(stateDir);
  if (all[id]?.working === working) return false;
  all[id] = { working, at: now.toISOString() };
  fs.mkdirSync(path.dirname(activityFile(stateDir)), { recursive: true });
  writeFileAtomic(activityFile(stateDir), JSON.stringify(all, null, 2) + "\n");
  return true;
}

/** Forget agents no longer here (`keep`: the ids that remain). */
export function pruneActivity(stateDir: string, keep: ReadonlySet<string>) {
  const all = readActivity(stateDir);
  const left = Object.fromEntries(
    Object.entries(all).filter(([id]) => keep.has(id)),
  );
  if (Object.keys(left).length === Object.keys(all).length) return;
  writeFileAtomic(activityFile(stateDir), JSON.stringify(left, null, 2) + "\n");
}
