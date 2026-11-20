/**
 * Issue 701: doctor's rows for the Hub comments this install holds: per
 * agent, how many, the oldest's age and why (the reason Hub was told), and
 * typed ones with no answer yet. ⚠ once one has waited past
 * hub.delivery_held_bell_minutes. Read from Den's held file only (no
 * server, no Hub, no token).
 */
import * as fs from "fs";
import * as path from "path";
import type { OnboardCheck } from "./doctor-onboard.js";

/** The `held` block of hub/deliveries-seen.json, as Den writes it. */
export interface HeldFile {
  queue?: Record<string, unknown[]>;
  active?: Record<string, { ids?: unknown[]; typedAt?: unknown }>;
}

/** The held block, or null (none, or unreadable). */
export function readHeldFile(stateDir: string): HeldFile | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(stateDir, "hub", "deliveries-seen.json"),
        "utf-8",
      ),
    ) as { held?: unknown };
    const h = raw?.held;
    return h && typeof h === "object" ? (h as HeldFile) : null;
  } catch {
    return null;
  }
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

export function heldLines(
  title: string,
  held: HeldFile | null,
  o: { now: number; bellMinutes: number },
): { lines: string[]; check: OnboardCheck } {
  const rows: string[] = [];
  let late = false;
  for (const [agent, list] of Object.entries(held?.queue ?? {})) {
    if (!Array.isArray(list) || !list.length) continue;
    const times = list
      .map((r) =>
        Date.parse(String((r as { created_at?: unknown }).created_at)),
      )
      .filter((t) => Number.isFinite(t));
    const oldest = times.length ? Math.min(...times) : o.now;
    const age = minutes(o.now - oldest);
    if (age >= o.bellMinutes) late = true;
    const why = list
      .map((r) => (r as { held_reason?: unknown }).held_reason)
      .find((x): x is string => typeof x === "string" && !!x);
    rows.push(
      `${agent}: ${list.length} held, oldest ${age} min${why ? `: ${why}` : ""}`,
    );
  }
  for (const [agent, a] of Object.entries(held?.active ?? {})) {
    const n = Array.isArray(a?.ids) ? a.ids.length : 0;
    if (!n || typeof a.typedAt !== "number") continue;
    rows.push(
      `${agent}: ${n} typed ${minutes(o.now - a.typedAt)} min ago, no answer yet`,
    );
  }
  const detail = rows.length ? rows.join("; ") : "no Hub comments held";
  const mark = late ? "⚠" : "✓";
  return {
    lines: [
      "",
      `${title} doctor: Hub comments held`,
      "",
      ...(rows.length
        ? rows.map((r) => `  ${mark}  ${r}`)
        : [`  ✓  no Hub comments held`]),
    ],
    check: {
      id: "hub_held_comments",
      status: late ? "warn" : "ok",
      detail,
    },
  };
}
