/**
 * Issue 212: the org config's `verify:` settings this slice reads
 * (VERIFY-SPEC section 6), each with a permissive default:
 *
 *   verify:
 *     run: { retries: 0 }          # a failed module runs again this often
 *     security: { fail_on: high }  # a finding at or above fails a scan
 *     flaky: { window: 10, min_retries: 2 }
 *                                  # flaky: passed after a retry in at
 *                                  # least min_retries of the last window runs
 *     history: { limit: 30 }       # runs a module's history shows
 *
 * A wrong value throws, naming its key.
 */
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface VerifySettings {
  retries: number;
  failOn: Severity;
  flakyWindow: number;
  flakyMinRetries: number;
  historyLimit: number;
}

export const DEFAULT_VERIFY_SETTINGS: Readonly<VerifySettings> = {
  retries: 0,
  failOn: "high",
  flakyWindow: 10,
  flakyMinRetries: 2,
  historyLimit: 30,
};

const SHAPE: Record<string, readonly string[]> = {
  run: ["retries"],
  security: ["fail_on"],
  flaky: ["window", "min_retries"],
  history: ["limit"],
};

const isMap = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function whole(
  v: unknown,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new Error(
      `verify.${key}: must be a whole number, ${min} to ${max} (got ${JSON.stringify(v)})`,
    );
  return v;
}

/** The org config's `verify:` block, with the defaults applied. */
export function readVerifySettings(raw: unknown): VerifySettings {
  const out: VerifySettings = { ...DEFAULT_VERIFY_SETTINGS };
  if (raw === undefined || raw === null) return out;
  if (!isMap(raw))
    throw new Error(`verify: must be a mapping (got ${JSON.stringify(raw)})`);
  for (const [k, v] of Object.entries(raw)) {
    const keys = SHAPE[k];
    if (!keys)
      throw new Error(
        `verify.${k}: unknown key (verify takes ${Object.keys(SHAPE).join(", ")})`,
      );
    if (!isMap(v))
      throw new Error(
        `verify.${k}: must be a mapping (got ${JSON.stringify(v)})`,
      );
    for (const sub of Object.keys(v))
      if (!keys.includes(sub))
        throw new Error(
          `verify.${k}.${sub}: unknown key (verify.${k} takes ${keys.join(", ")})`,
        );
  }
  const r = raw as Record<string, Record<string, unknown> | undefined>;
  out.retries = whole(r.run?.retries, "run.retries", 0, 10) ?? out.retries;
  const failOn = r.security?.fail_on;
  if (failOn !== undefined) {
    if (!SEVERITIES.includes(failOn as Severity))
      throw new Error(
        `verify.security.fail_on: one of ${SEVERITIES.join(", ")} (got ${JSON.stringify(failOn)})`,
      );
    out.failOn = failOn as Severity;
  }
  out.flakyWindow =
    whole(r.flaky?.window, "flaky.window", 1, 1000) ?? out.flakyWindow;
  out.flakyMinRetries =
    whole(r.flaky?.min_retries, "flaky.min_retries", 1, 1000) ??
    out.flakyMinRetries;
  out.historyLimit =
    whole(r.history?.limit, "history.limit", 1, 1000) ?? out.historyLimit;
  return out;
}

/** The stricter of two thresholds (the lower severity fails more). */
export function stricter(a: Severity, b: Severity | undefined): Severity {
  if (!b) return a;
  return SEVERITIES.indexOf(b) > SEVERITIES.indexOf(a) ? b : a;
}
