/**
 * Journeys JSONL result rows — collect → finalize (plan: jrn-reporting
 * packet; critique carry-over R3-1).
 *
 * The split is load-bearing for the entrypoint's ordering contract
 * (runJourney → verify → report → teardown in finally):
 * - `collectJourneyReport()` runs right after verification and normalizes
 *   everything known at that point (verdict, usage, snapshots, friction);
 * - teardown runs;
 * - `finalizeJourneyReport()` runs in the same finally, folding the
 *   TeardownReport (deletion failures + unmanaged-mutation warnings) into
 *   the JSONL row, the JUnit case, and the rendered markdown report — so
 *   teardown outcomes are part of every persisted output.
 *
 * Verdict discipline: the row's status comes EXCLUSIVELY from the
 * deterministic verifier's Verdict. Friction points ride along as metadata
 * and can never flip it (pinned by test).
 */

import { mkdir, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { resultWriter } from "../../../shared/results/result-writer.js";
import type { TestResult } from "../../../shared/types/index.js";
import type { JourneyEvent } from "../observability/events.js";
import type { FailureKind, RunOutcome } from "../runner.js";
import type { JourneySpec } from "../spec/schema.js";
import type { TeardownReport } from "../teardown.js";
import type { SnapshotIndexEntry } from "../tools/snapshot-store.js";
import type { AssertionResult } from "../verify/assertions.js";
import type { Verdict } from "../verify/verdict.js";
import type { FrictionPoint } from "./friction.js";
import { renderJourneyReportMarkdown } from "./render.js";
import type { JourneysJUnitCase } from "./junit.js";

/** Spec fields the report consumes (full JourneySpec accepted). */
export type ReportableSpec = Pick<JourneySpec, "name" | "surface" | "budgets">;

export interface CollectJourneyReportInput {
  spec: ReportableSpec;
  env: string;
  outcome: RunOutcome;
  verdict: Verdict;
  frictionPoints: readonly FrictionPoint[];
  /** Defaults to the current OS user. */
  user?: string;
  /** Defaults to now (injectable for deterministic tests). */
  timestamp?: string;
}

/** Budget consumption snapshot for the JSONL row. */
export interface BudgetConsumption {
  tokensUsed?: number;
  maxTotalTokens: number;
  timeoutS: number;
  maxTurns: number;
}

/** Everything known after verification, before teardown. */
export interface CollectedJourneyReport {
  journeyName: string;
  surface: JourneySpec["surface"];
  environment: string;
  timestamp: string;
  user: string;
  runId: string;
  status: "passed" | "failed";
  failureKind?: FailureKind;
  durationMs: number;
  usageTotalTokens?: number;
  budgetConsumption: BudgetConsumption;
  transcriptPath: string;
  reportDir: string;
  snapshotsDir: string;
  snapshotCount: number;
  snapshotIndex: readonly SnapshotIndexEntry[];
  frictionPoints: readonly FrictionPoint[];
  assertionResults: readonly AssertionResult[];
  /** Structured harness timeline (tool calls, bindings, denials, error). */
  events: readonly JourneyEvent[];
  /** Basename of the events.jsonl sidecar (for the report header). */
  eventsFile: string;
  /** SDK terminal error detail on an agent_error run (previously dropped). */
  agentError?: string;
}

/**
 * Normalize one verified journey into report data. Pure — writes nothing.
 * Called BEFORE teardown so the collected data is safe even if teardown
 * itself fails catastrophically.
 */
export function collectJourneyReport(
  input: CollectJourneyReportInput,
): CollectedJourneyReport {
  const reportDir = path.dirname(input.outcome.transcriptPath);
  const collected: CollectedJourneyReport = {
    journeyName: input.spec.name,
    surface: input.spec.surface,
    environment: input.env,
    timestamp: input.timestamp ?? new Date().toISOString(),
    user: input.user ?? process.env.USER ?? os.userInfo().username,
    runId: input.outcome.runId,
    status: input.verdict.passed ? "passed" : "failed",
    durationMs: input.outcome.durationMs,
    budgetConsumption: {
      tokensUsed: input.outcome.usage?.totalTokens,
      maxTotalTokens: input.spec.budgets.max_total_tokens,
      timeoutS: input.spec.budgets.timeout_s,
      maxTurns: input.spec.budgets.max_turns,
    },
    transcriptPath: input.outcome.transcriptPath,
    reportDir,
    snapshotsDir: path.join(reportDir, "snapshots"),
    snapshotCount: input.outcome.snapshotIndex.length,
    snapshotIndex: input.outcome.snapshotIndex,
    frictionPoints: input.frictionPoints,
    assertionResults: input.verdict.results,
    events: input.outcome.events,
    eventsFile: path.basename(input.outcome.eventsPath),
  };
  if (input.outcome.usage !== undefined) {
    collected.usageTotalTokens = input.outcome.usage.totalTokens;
  }
  if (input.verdict.failure_kind !== undefined) {
    collected.failureKind = input.verdict.failure_kind;
  }
  if (input.outcome.error !== undefined) {
    collected.agentError = input.outcome.error;
  }
  return collected;
}

/** Teardown block embedded in the JSONL row metadata. */
export interface TeardownRowMetadata {
  attempted: number;
  failed: number;
  failures: Array<{
    resourceType: string;
    id: string;
    cleanup: { method: string; path: string };
    status?: number;
    error?: string;
  }>;
  unmanaged_mutation_warnings: Array<{
    method: string;
    path: string;
    status: number;
    source: string;
  }>;
  /** Browser interception-processing failures (finding 7 — never silent). */
  interception_errors: string[];
}

export interface FinalizedJourneyReport {
  row: TestResult;
  junitCase: JourneysJUnitCase;
  reportPath: string;
}

/** Injectable output sinks (real writers by default). */
export interface FinalizeJourneyReportDeps {
  writeResult: (row: TestResult) => Promise<void>;
  writeFile: (filePath: string, contents: string) => Promise<void>;
}

async function defaultWriteFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

function toTeardownMetadata(
  teardown: TeardownReport | undefined,
): TeardownRowMetadata {
  return {
    attempted: teardown?.results.length ?? 0,
    failed: teardown?.failures.length ?? 0,
    failures: (teardown?.failures ?? []).map((failure) => ({
      resourceType: failure.entry.resourceType,
      id: failure.entry.id,
      cleanup: failure.entry.cleanup,
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      ...(failure.error !== undefined ? { error: failure.error } : {}),
    })),
    unmanaged_mutation_warnings: (teardown?.unmanagedWarnings ?? []).map(
      (warning) => ({
        method: warning.method,
        path: warning.path,
        status: warning.status,
        source: warning.source,
      }),
    ),
    interception_errors: [...(teardown?.interceptionErrors ?? [])],
  };
}

function failedAssertionMessages(
  results: readonly AssertionResult[],
): string[] {
  return results
    .filter((result) => !result.passed)
    .map(
      (result) =>
        result.message ??
        `assertion ${result.assertion.kind} failed ` +
          `(expected ${JSON.stringify(result.expected)}, ` +
          `actual ${JSON.stringify(result.actual)})`,
    );
}

/** Snapshot-capture failures (finding 9) — missing required evidence. */
function snapshotCaptureErrorStrings(
  snapshotIndex: CollectedJourneyReport["snapshotIndex"],
): string[] {
  return snapshotIndex
    .filter((entry) => entry.captureError !== undefined)
    .map(
      (entry) =>
        `snapshot capture failed for ${entry.action} (seq ${entry.seq}): ` +
        `${entry.captureError}`,
    );
}

function teardownWarningStrings(metadata: TeardownRowMetadata): string[] {
  return [
    ...metadata.failures.map(
      (failure) =>
        `teardown failed for ${failure.resourceType} ${failure.id}: ` +
        `${failure.cleanup.method} ${failure.cleanup.path}` +
        (failure.status !== undefined ? ` (${failure.status})` : "") +
        (failure.error !== undefined ? ` — ${failure.error}` : ""),
    ),
    ...metadata.unmanaged_mutation_warnings.map(
      (warning) =>
        `unmanaged mutation: ${warning.method} ${warning.path} ` +
        `(${warning.status})`,
    ),
    ...metadata.interception_errors.map(
      (message) => `browser interception error: ${message}`,
    ),
  ];
}

/**
 * Finalize one journey's persisted outputs AFTER teardown: the JSONL row
 * (via the shared resultWriter → results/journeys-<env>-<date>.jsonl), the
 * JUnit case (aggregated across journeys by the entrypoint), and the
 * rendered markdown report with the snapshot gallery. Teardown warnings —
 * deletion failures and unmanaged mutations — are folded into all three.
 */
export async function finalizeJourneyReport(
  collected: CollectedJourneyReport,
  teardown: TeardownReport | undefined,
  deps: Partial<FinalizeJourneyReportDeps> = {},
): Promise<FinalizedJourneyReport> {
  const writeResult =
    deps.writeResult ?? ((row: TestResult) => resultWriter.writeResult(row));
  const writeReportFile = deps.writeFile ?? defaultWriteFile;

  const teardownMetadata = toTeardownMetadata(teardown);
  const failureMessages = failedAssertionMessages(collected.assertionResults);
  const snapshotWarnings = snapshotCaptureErrorStrings(collected.snapshotIndex);

  const errorParts: string[] = [];
  if (collected.failureKind !== undefined) {
    errorParts.push(`failure_kind=${collected.failureKind}`);
  }
  errorParts.push(...failureMessages);

  const row: TestResult = {
    timestamp: collected.timestamp,
    pillar: "journeys",
    environment: collected.environment,
    test: collected.journeyName,
    status: collected.status,
    duration: collected.durationMs,
    user: collected.user,
    ...(collected.status === "failed" && errorParts.length > 0
      ? { error: errorParts.join("; ") }
      : {}),
    metadata: {
      surface: collected.surface,
      runId: collected.runId,
      ...(collected.failureKind !== undefined
        ? { failure_kind: collected.failureKind }
        : {}),
      usage_total_tokens: collected.usageTotalTokens,
      budget_consumption: collected.budgetConsumption,
      transcript_path: collected.transcriptPath,
      snapshot_count: collected.snapshotCount,
      snapshots_dir: collected.snapshotsDir,
      friction_points: collected.frictionPoints,
      teardown: teardownMetadata,
      snapshot_capture_errors: snapshotWarnings,
    },
  };

  const junitCase: JourneysJUnitCase = {
    name: collected.journeyName,
    environment: collected.environment,
    durationMs: collected.durationMs,
    passed: collected.status === "passed",
    ...(collected.failureKind !== undefined
      ? { failureKind: collected.failureKind }
      : {}),
    failureDetails: failureMessages,
    teardownWarnings: [
      ...snapshotWarnings,
      ...teardownWarningStrings(teardownMetadata),
    ],
  };

  const reportPath = path.join(collected.reportDir, "report.md");
  await writeResult(row);
  await writeReportFile(
    reportPath,
    renderJourneyReportMarkdown(collected, teardown),
  );

  return { row, junitCase, reportPath };
}
