/**
 * Issue 1334: how many phones or browsers have push alerts on, for
 * doctor's push row. The file is the server's (ui/server/web-push.ts
 * writes it); the CLI only counts entries, never reads their keys.
 */
import fs from "node:fs";
import path from "node:path";

export const PUSH_SUBSCRIPTIONS_FILE = "push-subscriptions.json";

/** Entries with an endpoint; 0 with no file; undefined when unreadable. */
export function pushSubscriptionCount(stateDir: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(
      path.join(stateDir, PUSH_SUBSCRIPTIONS_FILE),
      "utf-8",
    );
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : undefined;
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return undefined;
    return v.filter(
      (x) => !!x && typeof (x as { endpoint?: unknown }).endpoint === "string",
    ).length;
  } catch {
    return undefined;
  }
}
