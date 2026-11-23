/**
 * Issue 52 (TUNE): the Coach's settings, `agents.coach` in the org config.
 *
 *   enabled      true | false; default false (the Coach is off until a
 *                person turns it on)
 *   window_days  a whole number of days, 1–90; default 7 (the window each
 *                run reads)
 *   keep_runs    how many past runs are kept, 1–10000; default 100
 *   findings     the counted findings' thresholds (FINDING_DEFAULTS), each
 *                a number, 0 or more; a partial map keeps the rest
 *
 * Config-driven, with permissive defaults. A counted run (this phase) uses
 * no model, so there is no model or budget setting yet.
 */

/** When a counted finding shows (TUNE-3): permissive, so few show. */
export interface FindingThresholds {
  /** Subagent calls on Opus, in percent, at or above which it shows. */
  subagent_opus_pct: number;
  /** ...when it made at least this many subagent calls in the window. */
  min_subagent_calls: number;
  polls_per_day: number;
  denials_per_day: number;
  /** A window's transcripts at or over this many MB. */
  transcript_mb: number;
  /** T-c: asks passing R12, in percent, below which it shows... */
  ask_r12_pass_pct: number;
  /** ...and the waits for an answer: with at least this many asks. */
  min_asks: number;
  /** The median wait for a person's answer, in minutes, at or over which it shows. */
  ask_wait_min: number;
  /** The same text sent again to the same agent, this many times or more. */
  sends_repeated: number;
  /** Sends no reply followed, in percent, at or above which it shows... */
  sends_no_reply_pct: number;
  /** ...when it sent at least this many. */
  min_sends: number;
  /** R12: a sentence in an ask of more words than this is long. */
  sentence_words: number;
}

export const FINDING_DEFAULTS: Readonly<FindingThresholds> = Object.freeze({
  subagent_opus_pct: 50,
  min_subagent_calls: 20,
  polls_per_day: 20,
  denials_per_day: 5,
  transcript_mb: 1024,
  ask_r12_pass_pct: 80,
  min_asks: 3,
  ask_wait_min: 240,
  sends_repeated: 3,
  sends_no_reply_pct: 50,
  min_sends: 5,
  sentence_words: 25,
});

export interface CoachSettings {
  enabled: boolean;
  window_days: number;
  keep_runs: number;
  findings: FindingThresholds;
}

export const COACH_DEFAULTS: Readonly<CoachSettings> = Object.freeze({
  enabled: false,
  window_days: 7,
  keep_runs: 100,
  findings: FINDING_DEFAULTS,
});

const KEYS = new Set(Object.keys(COACH_DEFAULTS));
const FINDING_KEYS = Object.keys(
  FINDING_DEFAULTS,
) as (keyof FindingThresholds)[];

function checkFindings(raw: unknown): FindingThresholds {
  const out = { ...FINDING_DEFAULTS };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      `agents.coach.findings: a map of thresholds (${FINDING_KEYS.join(", ")}) (got ${JSON.stringify(raw)})`,
    );
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(FINDING_KEYS as string[]).includes(k))
      throw new Error(
        `agents.coach.findings.${k}: not a threshold (${FINDING_KEYS.join(", ")})`,
      );
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new Error(
        `agents.coach.findings.${k}: a number, 0 or more (got ${JSON.stringify(v)})`,
      );
    out[k as keyof FindingThresholds] = v;
  }
  return out;
}

function wholeIn(key: string, v: unknown, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    throw new Error(
      `agents.coach.${key}: a whole number from ${lo} to ${hi} (got ${JSON.stringify(v)})`,
    );
  return v;
}

/** `agents.coach` as written, with its defaults; throws on a bad value. */
export function checkCoachConfig(raw: unknown): CoachSettings {
  if (raw === undefined || raw === null)
    return { ...COACH_DEFAULTS, findings: { ...FINDING_DEFAULTS } };
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      `agents.coach: a map of settings (enabled, window_days, keep_runs, findings) (got ${JSON.stringify(raw)})`,
    );
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (!KEYS.has(k))
      throw new Error(
        `agents.coach.${k}: not a Coach setting (enabled, window_days, keep_runs, findings)`,
      );
  const out = { ...COACH_DEFAULTS, findings: checkFindings(r.findings) };
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
