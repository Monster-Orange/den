/**
 * Journeys JUnit XML emitter (plan: jrn-reporting packet).
 *
 * Journeys are not Playwright-run, so no reporter emits JUnit for them —
 * this is a small hand-rolled writer producing one <testcase> per journey
 * under a single "journeys" <testsuite>. Failure detail (failure kind +
 * assertion diagnostics) goes into <failure>; teardown warnings are
 * NON-GATING and surface in <system-out>.
 */

import { mkdir, writeFile } from "fs/promises";
import * as path from "path";

/** Conventional output path (repo-relative), mirroring the smoke/api junit files under reports/. */
export const JUNIT_OUTPUT_PATH = "reports/junit-journeys-results.xml";

/** One journey's JUnit row, produced by finalizeJourneyReport. */
export interface JourneysJUnitCase {
  name: string;
  environment: string;
  durationMs: number;
  passed: boolean;
  /** RunOutcome failure kind, when the run itself failed. */
  failureKind?: string;
  /** Structured assertion diagnostics for the <failure> body. */
  failureDetails: string[];
  /** Teardown failures + unmanaged-mutation warnings (non-gating). */
  teardownWarnings: string[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderTestCase(testCase: JourneysJUnitCase): string {
  const timeS = testCase.durationMs / 1000;
  const lines: string[] = [
    `    <testcase name="${escapeXml(testCase.name)}" ` +
      `classname="journeys.${escapeXml(testCase.environment)}" ` +
      `time="${timeS}">`,
  ];

  if (!testCase.passed) {
    const message =
      testCase.failureKind !== undefined
        ? `failure_kind=${testCase.failureKind}`
        : "journey assertions failed";
    const body = [message, ...testCase.failureDetails]
      .map(escapeXml)
      .join("\n");
    lines.push(
      `      <failure message="${escapeXml(message)}">${body}</failure>`,
    );
  }

  if (testCase.teardownWarnings.length > 0) {
    lines.push(
      `      <system-out>${testCase.teardownWarnings
        .map(escapeXml)
        .join("\n")}</system-out>`,
    );
  }

  lines.push("    </testcase>");
  return lines.join("\n");
}

/** Render the full JUnit document for one run's journeys. */
export function renderJourneysJUnitXml(
  cases: readonly JourneysJUnitCase[],
): string {
  const failures = cases.filter((testCase) => !testCase.passed).length;
  const totalTimeS =
    cases.reduce((sum, testCase) => sum + testCase.durationMs, 0) / 1000;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${cases.length}" failures="${failures}" time="${totalTimeS}">`,
    `  <testsuite name="journeys" tests="${cases.length}" ` +
      `failures="${failures}" time="${totalTimeS}">`,
    ...cases.map(renderTestCase),
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

/**
 * Write the JUnit document to disk (default: reports/junit-journeys-
 * results.xml). Returns the resolved file path.
 */
export async function writeJourneysJUnitXml(
  cases: readonly JourneysJUnitCase[],
  filePath: string = JUNIT_OUTPUT_PATH,
): Promise<string> {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, renderJourneysJUnitXml(cases));
  return resolved;
}
