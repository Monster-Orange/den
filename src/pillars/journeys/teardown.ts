/**
 * Journeys teardown executor — pure library over the run ledger (plan:
 * jrn-runner packet, Approach §Isolation and teardown for Phase-1 pilots).
 *
 * INVOKED ONLY BY THE CALLER (the pilot entrypoint, jrn-pilot-journeys),
 * strictly after runJourney → verify → report, in a finally block. Never
 * called from inside runJourney.
 *
 * Deletes recognized ledger resources — from BOTH feeds (http-tool and
 * browser network interception) — in REVERSE creation order, executing
 * each entry's explicit cleanup descriptor through the caller-supplied
 * allowlisted+authenticated HTTP client. Deletion failures and
 * unmanaged-mutation warnings surface in the TeardownReport; nothing is
 * swallowed, and unmanaged mutations are reported, never guessed-deleted.
 *
 * Run identity note: the runner injects the runId (`jrn-<journey>-<ts>-
 * <rand4>`) into the persona brief as a required display-name prefix —
 * best-effort labeling for humans; the ledger stays the teardown source
 * of truth.
 */

import type {
  CleanupRequest,
  LedgerEntry,
  RunLedger,
  UnmanagedMutationWarning,
} from "./tools/ledger.js";

/**
 * Caller-supplied HTTP client executing one cleanup request. The pilot
 * entrypoint wires this to the allowlisted+JWT client so teardown carries
 * the same auth and reach constraints as the journey itself.
 */
export type TeardownHttpClient = (
  request: CleanupRequest,
) => Promise<{ status: number }>;

/** Outcome of one attempted deletion. */
export interface TeardownResultItem {
  entry: LedgerEntry;
  ok: boolean;
  /** HTTP status when the request completed. */
  status?: number;
  /** Error message when the client threw (transport failure etc.). */
  error?: string;
}

export interface TeardownReport {
  /** Every attempted deletion, in execution (reverse-creation) order. */
  results: TeardownResultItem[];
  /** Subset of results that did not succeed — never swallowed. */
  failures: TeardownResultItem[];
  /** Unmanaged mutations observed during the run (reported, not deleted). */
  unmanagedWarnings: readonly UnmanagedMutationWarning[];
  /**
   * Browser interception-processing failures — a creation MAY have gone
   * unrecorded, so these surface as report warnings (finding 7).
   */
  interceptionErrors: readonly string[];
}

/**
 * Delete every recognized ledger resource in reverse creation order via
 * its explicit cleanup descriptor. A failed deletion (non-2xx or thrown
 * client error) is recorded and execution continues with the remaining
 * entries — partial teardown is better than none, and the report carries
 * the full picture.
 */
export async function teardownLedger(
  ledger: RunLedger,
  httpClient: TeardownHttpClient,
): Promise<TeardownReport> {
  const results: TeardownResultItem[] = [];

  for (const entry of [...ledger.entries].reverse()) {
    try {
      const response = await httpClient(entry.cleanup);
      results.push({
        entry,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
      });
    } catch (error) {
      results.push({
        entry,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    results,
    failures: results.filter((result) => !result.ok),
    unmanagedWarnings: ledger.warnings,
    interceptionErrors: ledger.interceptionErrors,
  };
}
