/**
 * Bell v6 (0.4.45): a person's bell, in their user config, served by
 * /api/settings as `bell_kinds` ({switch: true|false}, every switch) and
 * `bell_fold_days` (3, 7, 14 or 30). Never sent to Hub. It hides and
 * folds; the activity trail still records every event.
 */
import {
  BELL_FOLD_DAYS,
  BELL_SWITCHES,
  bellPrefs,
} from "../../shared/notifications.js";
import type { UserConfig } from "../../shared/den-config.js";

/** Every switch, on or off, as the page shows them. */
export function bellKinds(user: UserConfig): Record<string, boolean> {
  const off = new Set(bellPrefs(user).off);
  return Object.fromEntries(BELL_SWITCHES.map((s) => [s, !off.has(s)]));
}

export const bellFoldDays = (user: UserConfig) => bellPrefs(user).foldDays;

type Notes = Record<string, unknown>;
const notesOf = (user: UserConfig): Notes =>
  ({ ...((user as { notifications?: Notes }).notifications ?? {}) }) as Notes;
const setNotes = (user: UserConfig, n: Notes) => {
  const u = user as { notifications?: Notes };
  if (Object.keys(n).length) u.notifications = n;
  else delete u.notifications;
};

/**
 * A POSTed `bell_kinds`: some switches, each true or false (null clears
 * one back to its default). Anything else: the error to answer with.
 */
export function patchBellKinds(
  user: UserConfig,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  const known = BELL_SWITCHES as readonly string[];
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    !Object.entries(v).every(
      ([k, x]) => known.includes(k) && (typeof x === "boolean" || x === null),
    )
  )
    return {
      ok: false,
      error: `bell_kinds must map ${BELL_SWITCHES.join(", ")} to true, false or null`,
    };
  const n = notesOf(user);
  const kinds = { ...((n.kinds as Notes | undefined) ?? {}) };
  for (const [k, x] of Object.entries(v))
    if (x === null) delete kinds[k];
    else kinds[k] = x;
  if (Object.keys(kinds).length) n.kinds = kinds;
  else delete n.kinds;
  setNotes(user, n);
  return { ok: true };
}

/** A POSTed `bell_fold_days`: 3, 7, 14 or 30, or null (the default, 7). */
export function patchBellFoldDays(
  user: UserConfig,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (v !== null && !(BELL_FOLD_DAYS as readonly unknown[]).includes(v))
    return {
      ok: false,
      error: `bell_fold_days must be one of ${BELL_FOLD_DAYS.join(", ")}, or null`,
    };
  const n = notesOf(user);
  if (v === null) delete n.fold_days;
  else n.fold_days = v;
  setNotes(user, n);
  return { ok: true };
}
