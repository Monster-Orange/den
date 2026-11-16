/**
 * Issue 212: Verify's settings in the org config (`verify:`), each with a
 * permissive default (VERIFY-SPEC section 6, settings table):
 *
 *   verify:
 *     run: { retries: 0 }               a pass after a retry is flaky
 *     flaky: { window: 10, min_retries: 2 }
 *     history: { limit: 30 }
 *     security: { fail_on: high }       a module's fail_on may tighten it
 *
 * A bad value throws: a typo must not quietly change what passes.
 */
import { SEVERITIES, type Severity } from "./findings.js";

export interface VerifySettings {
  /** How many times a failed command module runs again. */
  retries: number;
  /** The flaky mark: passed after a retry in `flakyMinRetries` of the last `flakyWindow` runs. */
  flakyWindow: number;
  flakyMinRetries: number;
  /** How many runs a module's history shows. */
  historyLimit: number;
  /** A finding at or above this fails a scan. */
  failOn: Severity;
}

export const VERIFY_SETTINGS_DEFAULTS: Readonly<VerifySettings> = {
  retries: 0,
  flakyWindow: 10,
  flakyMinRetries: 2,
  historyLimit: 30,
  failOn: "high",
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

function whole(
  v: unknown,
  name: string,
  min: number,
  fallback: number,
): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min)
    throw new Error(
      `verify.${name}: a whole number, ${min} or more (got ${JSON.stringify(v)})`,
    );
  return v;
}

/** `verify:` from the org config, with the defaults filled in. */
export function readVerifySettings(raw: unknown): VerifySettings {
  const v = obj(raw);
  const run = obj(v.run);
  const flaky = obj(v.flaky);
  const history = obj(v.history);
  const security = obj(v.security);
  const d = VERIFY_SETTINGS_DEFAULTS;
  const failOn = security.fail_on ?? d.failOn;
  if (!(SEVERITIES as readonly unknown[]).includes(failOn))
    throw new Error(
      `verify.security.fail_on: one of ${SEVERITIES.join(", ")} (got ${JSON.stringify(failOn)})`,
    );
  return {
    retries: whole(run.retries, "run.retries", 0, d.retries),
    flakyWindow: whole(flaky.window, "flaky.window", 1, d.flakyWindow),
    flakyMinRetries: whole(
      flaky.min_retries,
      "flaky.min_retries",
      1,
      d.flakyMinRetries,
    ),
    historyLimit: whole(history.limit, "history.limit", 1, d.historyLimit),
    failOn: failOn as Severity,
  };
}
