/**
 * Issue 52 (TUNE): the Coach's settings, `agents.coach` in the org config.
 *
 *   enabled      true | false; default false (the Coach is off until a
 *                person turns it on)
 *   window_days  a whole number of days, 1–90; default 7 (the window each
 *                run reads)
 *   keep_runs    how many past runs are kept, 1–10000; default 100
 *
 * Config-driven, with permissive defaults. A counted run (this phase) uses
 * no model, so there is no model or budget setting yet.
 */

export interface CoachSettings {
  enabled: boolean;
  window_days: number;
  keep_runs: number;
}

export const COACH_DEFAULTS: Readonly<CoachSettings> = Object.freeze({
  enabled: false,
  window_days: 7,
  keep_runs: 100,
});

const KEYS = new Set(Object.keys(COACH_DEFAULTS));

function wholeIn(key: string, v: unknown, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    throw new Error(
      `agents.coach.${key}: a whole number from ${lo} to ${hi} (got ${JSON.stringify(v)})`,
    );
  return v;
}

/** `agents.coach` as written, with its defaults; throws on a bad value. */
export function checkCoachConfig(raw: unknown): CoachSettings {
  if (raw === undefined || raw === null) return { ...COACH_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      `agents.coach: a map of settings (enabled, window_days, keep_runs) (got ${JSON.stringify(raw)})`,
    );
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (!KEYS.has(k))
      throw new Error(
        `agents.coach.${k}: not a Coach setting (enabled, window_days, keep_runs)`,
      );
  const out = { ...COACH_DEFAULTS };
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== "boolean")
      throw new Error(
        `agents.coach.enabled: true or false (got ${JSON.stringify(r.enabled)})`,
      );
    out.enabled = r.enabled;
  }
  if (r.window_days !== undefined)
    out.window_days = wholeIn("window_days", r.window_days, 1, 90);
  if (r.keep_runs !== undefined)
    out.keep_runs = wholeIn("keep_runs", r.keep_runs, 1, 10_000);
  return out;
}
