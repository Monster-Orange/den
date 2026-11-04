/**
 * Journeys verdict composition (plan: jrn-verifier packet, Approach
 * §Verdict discipline and packet ordering).
 *
 * The deterministic assertions are the SOLE pass/fail authority — agent
 * completion status alone never passes a journey. Composition rule: a
 * journey passes only when ALL assertions pass AND the RunOutcome carries
 * no failure_kind. Any failure_kind (budget_exceeded, budget_unverifiable,
 * infra_error, agent_error) can NEVER compose to pass, even with every
 * assertion green. The advisory rubric is NOT part of the verdict.
 */

import type { FailureKind } from "../runner.js";
import type { JourneyAssertion } from "../spec/schema.js";
import type { RunLedger } from "../tools/ledger.js";
import {
  runAssertions,
  type AssertionResult,
  type VerifierProbeClient,
} from "./assertions.js";

/** Structural subset of RunOutcome the verdict composer consumes. */
export interface VerifiableOutcome {
  failure_kind?: FailureKind;
}

/** The journey's final deterministic verdict. */
export interface Verdict {
  passed: boolean;
  /** Propagated from the RunOutcome when the run itself failed. */
  failure_kind?: FailureKind;
  /** Every assertion's structured result, for reporting. */
  results: AssertionResult[];
}

/**
 * Compose the verdict: pass only if ALL assertions passed and the run
 * carried no failure_kind. Pure and synchronous — probes have already run.
 */
export function composeVerdict(
  outcome: VerifiableOutcome,
  results: AssertionResult[],
): Verdict {
  const verdict: Verdict = {
    passed:
      outcome.failure_kind === undefined &&
      results.every((result) => result.passed),
    results,
  };
  if (outcome.failure_kind !== undefined) {
    verdict.failure_kind = outcome.failure_kind;
  }
  return verdict;
}

/**
 * Verify one finished journey: execute its assertions as API probes
 * against the run's ledger (placeholder binding from either feed), then
 * compose the verdict. Called by the entrypoint strictly AFTER runJourney
 * and BEFORE any teardown — probes must observe the created state. Even
 * when the run carried a failure_kind the probes still execute (their
 * results are diagnostics for the report), but the verdict can never pass.
 */
export async function verifyJourney(
  assertions: readonly JourneyAssertion[],
  outcome: VerifiableOutcome & { ledger: RunLedger },
  client: VerifierProbeClient,
): Promise<Verdict> {
  const results = await runAssertions(assertions, outcome.ledger, client);
  return composeVerdict(outcome, results);
}
