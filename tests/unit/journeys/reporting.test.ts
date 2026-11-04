/**
 * Unit tests for the journeys report modules
 * (src/pillars/journeys/report/{results,junit,render}.ts) and the
 * 'journeys' Pillar union widening (src/shared/types).
 *
 * Contract under test (plan: jrn-reporting packet, Approach §Reporting;
 * critique carry-over R3-1):
 * - collect → finalize split: report data is COLLECTED first, teardown runs,
 *   then outputs are FINALIZED so teardown warnings (incl. unmanaged
 *   mutations) appear in the JSONL/JUnit row;
 * - JSONL row shape: pillar, environment, journey name, surface, verdict,
 *   failure_kind, duration, usage tokens, budget consumption, transcript
 *   path, snapshot count + snapshots dir, friction_points[], teardown
 *   warnings;
 * - JUnit XML: one testcase per journey with failure detail (hand-rolled —
 *   journeys are not Playwright-run);
 * - rendered per-run markdown report embeds the snapshot gallery (relative
 *   image links) alongside the friction section;
 * - friction NEVER flips a passing verdict (by construction + test).
 */

import { describe, expect, it, jest } from "@jest/globals";
import * as path from "path";

import type { RunOutcome } from "../../../src/pillars/journeys/runner.js";
import type { TeardownReport } from "../../../src/pillars/journeys/teardown.js";
import { RunLedger } from "../../../src/pillars/journeys/tools/ledger.js";
import { testLedgerRegistry } from "./fixtures/test-app.js";
import type { SnapshotIndexEntry } from "../../../src/pillars/journeys/tools/snapshot-store.js";
import type { Verdict } from "../../../src/pillars/journeys/verify/verdict.js";
import type { FrictionPoint } from "../../../src/pillars/journeys/report/friction.js";
import {
  collectJourneyReport,
  finalizeJourneyReport,
  type CollectJourneyReportInput,
  type CollectedJourneyReport,
} from "../../../src/pillars/journeys/report/results.js";
import {
  JUNIT_OUTPUT_PATH,
  renderJourneysJUnitXml,
  type JourneysJUnitCase,
} from "../../../src/pillars/journeys/report/junit.js";
import { renderJourneyReportMarkdown } from "../../../src/pillars/journeys/report/render.js";
import type { Pillar, TestResult } from "../../../src/shared/types/index.js";

const REPORT_DIR = "/tmp/reports/journeys/jrn-user-first-item-ts-ab12";

function snapshotEntry(
  seq: number,
  action: string,
  filePath: string | null,
): SnapshotIndexEntry {
  return {
    seq,
    action,
    url: "http://localhost:3000/app",
    path: filePath,
    ts: `2026-07-15T10:00:0${seq}.000Z`,
    ...(filePath === null ? { suppressed: true, masked: true } : {}),
  };
}

function makeOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  const ledger = new RunLedger(testLedgerRegistry());
  return {
    runId: "jrn-user-first-item-ts-ab12",
    transcriptPath: path.join(REPORT_DIR, "transcript.jsonl"),
    eventsPath: path.join(REPORT_DIR, "events.jsonl"),
    events: [],
    snapshotIndex: [
      snapshotEntry(
        1,
        "navigate",
        path.join(REPORT_DIR, "snapshots/001-navigate.png"),
      ),
      snapshotEntry(2, "type", null),
      snapshotEntry(
        3,
        "click",
        path.join(REPORT_DIR, "snapshots/003-click.png"),
      ),
    ],
    ledger,
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 1650,
    },
    durationMs: 42_000,
    ...overrides,
  };
}

const PASSING_VERDICT: Verdict = { passed: true, results: [] };

function makeInput(
  overrides: Partial<CollectJourneyReportInput> = {},
): CollectJourneyReportInput {
  return {
    spec: {
      name: "user-first-item",
      surface: "browser",
      budgets: { max_turns: 20, timeout_s: 300, max_total_tokens: 100_000 },
    },
    env: "local",
    outcome: makeOutcome(),
    verdict: PASSING_VERDICT,
    frictionPoints: [],
    user: "test-user",
    timestamp: "2026-07-15T10:05:00.000Z",
    ...overrides,
  };
}

function makeTeardown(overrides: Partial<TeardownReport> = {}): TeardownReport {
  return {
    results: [],
    failures: [],
    unmanagedWarnings: [],
    interceptionErrors: [],
    ...overrides,
  };
}

describe("Pillar union — 'journeys'", () => {
  it("'journeys' is assignable to Pillar and TestResult.pillar", () => {
    const pillar: Pillar = "journeys";
    const result: TestResult = {
      timestamp: "2026-07-15T10:05:00.000Z",
      pillar: "journeys",
      environment: "local",
      test: "user-first-item",
      status: "passed",
      duration: 1,
      user: "u",
    };
    expect(pillar).toBe("journeys");
    expect(result.pillar).toBe("journeys");
  });

  // NOTE: scanModules('journeys') behavior is covered with mocked discovery
  // in tests/unit/perf/module-scanner.test.ts — the compile-stub-era "empty
  // list" pin that lived here depended on the developer machine having no
  // journeys-declaring repos registered.
});

describe("collectJourneyReport", () => {
  it("collects the full row data from spec + outcome + verdict + friction", () => {
    const friction: FrictionPoint[] = [
      {
        step: 2,
        surface: "browser",
        severity: "high",
        category: "tool_error",
        evidence: { transcriptRef: "transcript.jsonl:2" },
        description: "browser_click failed",
      },
    ];

    const collected = collectJourneyReport(
      makeInput({ frictionPoints: friction }),
    );

    expect(collected.journeyName).toBe("user-first-item");
    expect(collected.surface).toBe("browser");
    expect(collected.environment).toBe("local");
    expect(collected.status).toBe("passed");
    expect(collected.failureKind).toBeUndefined();
    expect(collected.durationMs).toBe(42_000);
    expect(collected.usageTotalTokens).toBe(1650);
    expect(collected.budgetConsumption).toEqual({
      tokensUsed: 1650,
      maxTotalTokens: 100_000,
      timeoutS: 300,
      maxTurns: 20,
    });
    expect(collected.transcriptPath).toBe(
      path.join(REPORT_DIR, "transcript.jsonl"),
    );
    expect(collected.reportDir).toBe(REPORT_DIR);
    expect(collected.snapshotsDir).toBe(path.join(REPORT_DIR, "snapshots"));
    expect(collected.snapshotCount).toBe(3);
    expect(collected.frictionPoints).toEqual(friction);
  });

  it("maps a failed verdict with failure_kind onto the collected data", () => {
    const collected = collectJourneyReport(
      makeInput({
        outcome: makeOutcome({ failure_kind: "budget_exceeded" }),
        verdict: {
          passed: false,
          failure_kind: "budget_exceeded",
          results: [],
        },
      }),
    );

    expect(collected.status).toBe("failed");
    expect(collected.failureKind).toBe("budget_exceeded");
  });

  it("collects assertion diagnostics from the verdict for failure detail", () => {
    const verdict: Verdict = {
      passed: false,
      results: [
        {
          assertion: {
            kind: "http_status",
            request: { method: "GET", path: "/api/v1/items/{item_id}" },
            equals: 200,
          },
          passed: false,
          expected: 200,
          actual: 404,
          message: "expected HTTP 200, got 404",
        },
      ],
    };

    const collected = collectJourneyReport(makeInput({ verdict }));

    expect(collected.status).toBe("failed");
    expect(collected.assertionResults).toHaveLength(1);
    expect(collected.assertionResults[0].passed).toBe(false);
  });

  it("friction never flips a passing verdict — status comes from the verdict alone", () => {
    const friction: FrictionPoint[] = [
      {
        step: 1,
        surface: "api",
        severity: "high",
        category: "http_error",
        evidence: { transcriptRef: "transcript.jsonl:1" },
        description: "HTTP 500 from tool call",
      },
    ];

    const collected = collectJourneyReport(
      makeInput({ frictionPoints: friction, verdict: PASSING_VERDICT }),
    );

    expect(collected.status).toBe("passed");
    expect(collected.frictionPoints).toHaveLength(1);
  });
});

describe("finalizeJourneyReport", () => {
  it("writes the JSONL row via the result writer with the journeys pillar", async () => {
    const writeResult = jest.fn<(row: TestResult) => Promise<void>>(
      async () => undefined,
    );
    const writeFile = jest.fn<
      (filePath: string, contents: string) => Promise<void>
    >(async () => undefined);

    const collected = collectJourneyReport(makeInput());
    const finalized = await finalizeJourneyReport(collected, makeTeardown(), {
      writeResult,
      writeFile,
    });

    expect(writeResult).toHaveBeenCalledTimes(1);
    const row = writeResult.mock.calls[0][0];
    expect(row.pillar).toBe("journeys");
    expect(row.environment).toBe("local");
    expect(row.test).toBe("user-first-item");
    expect(row.status).toBe("passed");
    expect(row.duration).toBe(42_000);
    expect(row.user).toBe("test-user");
    expect(finalized.row).toEqual(row);
  });

  it("row metadata carries surface, usage, budgets, snapshots, friction, teardown", async () => {
    const writeResult = jest.fn<(row: TestResult) => Promise<void>>(
      async () => undefined,
    );
    const writeFile = jest.fn<
      (filePath: string, contents: string) => Promise<void>
    >(async () => undefined);

    const friction: FrictionPoint[] = [
      {
        step: 2,
        surface: "browser",
        severity: "low",
        category: "tool_retry",
        evidence: { transcriptRef: "transcript.jsonl:2" },
        description: "browser_click retried",
      },
    ];
    const teardown = makeTeardown({
      unmanagedWarnings: [
        {
          method: "POST",
          path: "/api/v1/widgets",
          status: 201,
          source: "browser",
        },
      ],
    });

    const collected = collectJourneyReport(
      makeInput({ frictionPoints: friction }),
    );
    await finalizeJourneyReport(collected, teardown, {
      writeResult,
      writeFile,
    });

    const metadata = writeResult.mock.calls[0][0].metadata as Record<
      string,
      unknown
    >;
    expect(metadata.surface).toBe("browser");
    expect(metadata.runId).toBe("jrn-user-first-item-ts-ab12");
    expect(metadata.usage_total_tokens).toBe(1650);
    expect(metadata.budget_consumption).toEqual({
      tokensUsed: 1650,
      maxTotalTokens: 100_000,
      timeoutS: 300,
      maxTurns: 20,
    });
    expect(metadata.transcript_path).toBe(
      path.join(REPORT_DIR, "transcript.jsonl"),
    );
    expect(metadata.snapshot_count).toBe(3);
    expect(metadata.snapshots_dir).toBe(path.join(REPORT_DIR, "snapshots"));
    expect(metadata.friction_points).toEqual(friction);
    expect(metadata.teardown).toEqual({
      attempted: 0,
      failed: 0,
      failures: [],
      unmanaged_mutation_warnings: [
        {
          method: "POST",
          path: "/api/v1/widgets",
          status: 201,
          source: "browser",
        },
      ],
      interception_errors: [],
    });
  });

  it("snapshot capture failures surface in the row metadata and JUnit warnings (review finding 9)", async () => {
    const writeResult = jest.fn<(row: TestResult) => Promise<void>>(
      async () => undefined,
    );
    const writeFile = jest.fn<
      (filePath: string, contents: string) => Promise<void>
    >(async () => undefined);

    const collected = collectJourneyReport(makeInput({}));
    const withFailedCapture = {
      ...collected,
      snapshotIndex: [
        ...collected.snapshotIndex,
        {
          seq: 99,
          action: "click",
          url: "http://x/",
          path: null,
          ts: "2026-07-15T00:00:00.000Z",
          captureError: "disk full",
        },
      ],
    };

    const finalized = await finalizeJourneyReport(
      withFailedCapture,
      makeTeardown({}),
      { writeResult, writeFile },
    );

    const metadata = writeResult.mock.calls[0][0].metadata as {
      snapshot_capture_errors: string[];
    };
    expect(metadata.snapshot_capture_errors).toEqual([
      expect.stringContaining("disk full"),
    ]);
    expect(finalized.junitCase.teardownWarnings).toEqual([
      expect.stringContaining("snapshot capture failed for click"),
    ]);
  });

  it("interception errors surface in the row metadata and JUnit warnings (review finding 7)", async () => {
    const writeResult = jest.fn<(row: TestResult) => Promise<void>>(
      async () => undefined,
    );
    const writeFile = jest.fn<
      (filePath: string, contents: string) => Promise<void>
    >(async () => undefined);
    const teardown = makeTeardown({
      interceptionErrors: ["response handler exploded"],
    });

    const collected = collectJourneyReport(makeInput({}));
    const finalized = await finalizeJourneyReport(collected, teardown, {
      writeResult,
      writeFile,
    });

    const metadata = writeResult.mock.calls[0][0].metadata as {
      teardown: { interception_errors: string[] };
    };
    expect(metadata.teardown.interception_errors).toEqual([
      "response handler exploded",
    ]);
    expect(finalized.junitCase.teardownWarnings).toEqual([
      expect.stringContaining("response handler exploded"),
    ]);
  });

  it("teardown deletion failures appear in the row and the JUnit case (R3-1)", async () => {
    const writeResult = jest.fn<(row: TestResult) => Promise<void>>(
      async () => undefined,
    );
    const writeFile = jest.fn<
      (filePath: string, contents: string) => Promise<void>
    >(async () => undefined);

    const ledger = new RunLedger(testLedgerRegistry());
    ledger.record(
      {
        method: "POST",
        pathOrUrl: "/api/v1/items",
        status: 201,
        body: { id: "item-1" },
      },
      "http-tool",
    );
    const entry = ledger.entries[0];
    const teardown = makeTeardown({
      results: [{ entry, ok: false, status: 500 }],
      failures: [{ entry, ok: false, status: 500 }],
    });

    const collected = collectJourneyReport(makeInput());
    const finalized = await finalizeJourneyReport(collected, teardown, {
      writeResult,
      writeFile,
    });

    const metadata = writeResult.mock.calls[0][0].metadata as Record<
      string,
      unknown
    >;
    const teardownMeta = metadata.teardown as {
      attempted: number;
      failed: number;
      failures: unknown[];
    };
    expect(teardownMeta.attempted).toBe(1);
    expect(teardownMeta.failed).toBe(1);
    expect(teardownMeta.failures).toHaveLength(1);
    expect(
      finalized.junitCase.teardownWarnings.some((w) => w.includes("item")),
    ).toBe(true);
  });

  it("works without a teardown report (undefined) — outputs still finalize", async () => {
    const writeResult = jest.fn<(row: TestResult) => Promise<void>>(
      async () => undefined,
    );
    const writeFile = jest.fn<
      (filePath: string, contents: string) => Promise<void>
    >(async () => undefined);

    const collected = collectJourneyReport(makeInput());
    const finalized = await finalizeJourneyReport(collected, undefined, {
      writeResult,
      writeFile,
    });

    expect(writeResult).toHaveBeenCalledTimes(1);
    expect(finalized.row.status).toBe("passed");
  });

  it("writes the rendered markdown report into the run's report dir", async () => {
    const writeResult = jest.fn<(row: TestResult) => Promise<void>>(
      async () => undefined,
    );
    const writeFile = jest.fn<
      (filePath: string, contents: string) => Promise<void>
    >(async () => undefined);

    const collected = collectJourneyReport(makeInput());
    const finalized = await finalizeJourneyReport(collected, makeTeardown(), {
      writeResult,
      writeFile,
    });

    expect(finalized.reportPath).toBe(path.join(REPORT_DIR, "report.md"));
    expect(writeFile).toHaveBeenCalledWith(
      path.join(REPORT_DIR, "report.md"),
      expect.stringContaining("user-first-item"),
    );
  });

  it("failed verdicts produce a failed row and a failing JUnit case", async () => {
    const writeResult = jest.fn<(row: TestResult) => Promise<void>>(
      async () => undefined,
    );
    const writeFile = jest.fn<
      (filePath: string, contents: string) => Promise<void>
    >(async () => undefined);

    const collected = collectJourneyReport(
      makeInput({
        outcome: makeOutcome({ failure_kind: "agent_error" }),
        verdict: { passed: false, failure_kind: "agent_error", results: [] },
      }),
    );
    const finalized = await finalizeJourneyReport(collected, makeTeardown(), {
      writeResult,
      writeFile,
    });

    expect(finalized.row.status).toBe("failed");
    expect(finalized.row.error).toContain("agent_error");
    expect(finalized.junitCase.passed).toBe(false);
    expect(finalized.junitCase.failureKind).toBe("agent_error");
  });
});

describe("renderJourneysJUnitXml", () => {
  const passingCase: JourneysJUnitCase = {
    name: "user-first-item",
    environment: "local",
    durationMs: 42_000,
    passed: true,
    failureDetails: [],
    teardownWarnings: [],
  };

  it("emits one testcase per journey under a journeys testsuite", () => {
    const failingCase: JourneysJUnitCase = {
      name: "folder-create-and-browse",
      environment: "local",
      durationMs: 65_500,
      passed: false,
      failureKind: "agent_error",
      failureDetails: ["expected HTTP 200, got 404"],
      teardownWarnings: [],
    };

    const xml = renderJourneysJUnitXml([passingCase, failingCase]);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('name="journeys"');
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<testcase name="user-first-item"');
    expect(xml).toContain('<testcase name="folder-create-and-browse"');
    // Duration in seconds, JUnit convention.
    expect(xml).toContain('time="42"');
    expect(xml).toContain('time="65.5"');
    // Failure detail present for the failing case only.
    expect(xml.match(/<failure/g)).toHaveLength(1);
    expect(xml).toContain("agent_error");
    expect(xml).toContain("expected HTTP 200, got 404");
  });

  it("escapes XML-special characters in names and failure details", () => {
    const nasty: JourneysJUnitCase = {
      name: 'journey <with> "quotes" & ampersands',
      environment: "local",
      durationMs: 1000,
      passed: false,
      failureDetails: ['diag <tag> & "quoted"'],
      teardownWarnings: [],
    };

    const xml = renderJourneysJUnitXml([nasty]);

    expect(xml).toContain(
      "journey &lt;with&gt; &quot;quotes&quot; &amp; ampersands",
    );
    expect(xml).toContain("diag &lt;tag&gt; &amp; &quot;quoted&quot;");
    expect(xml).not.toContain("<with>");
  });

  it("surfaces teardown warnings in system-out without failing the case", () => {
    const withWarnings: JourneysJUnitCase = {
      ...passingCase,
      teardownWarnings: ["unmanaged mutation: POST /api/v1/widgets (201)"],
    };

    const xml = renderJourneysJUnitXml([withWarnings]);

    expect(xml).toContain("<system-out>");
    expect(xml).toContain("unmanaged mutation: POST /api/v1/widgets (201)");
    expect(xml).toContain('failures="0"');
  });

  it("exports the conventional output path", () => {
    expect(JUNIT_OUTPUT_PATH).toBe("reports/junit-journeys-results.xml");
  });
});

describe("renderJourneyReportMarkdown", () => {
  function collectedWithFriction(): CollectedJourneyReport {
    return collectJourneyReport(
      makeInput({
        frictionPoints: [
          {
            step: 3,
            surface: "browser",
            severity: "high",
            category: "tool_error",
            evidence: {
              transcriptRef: "transcript.jsonl:3",
              snapshotPath: path.join(REPORT_DIR, "snapshots/003-click.png"),
            },
            description: "browser_click failed: element not found",
          },
        ],
      }),
    );
  }

  it("embeds the snapshot gallery with RELATIVE image links", () => {
    const markdown = renderJourneyReportMarkdown(
      collectedWithFriction(),
      makeTeardown(),
    );

    expect(markdown).toContain("![001-navigate](snapshots/001-navigate.png)");
    expect(markdown).toContain("![003-click](snapshots/003-click.png)");
    // Absolute paths never leak into the rendered gallery links.
    expect(markdown).not.toContain(`](${REPORT_DIR}`);
  });

  it("marks suppressed snapshots instead of rendering a broken image", () => {
    const markdown = renderJourneyReportMarkdown(
      collectedWithFriction(),
      makeTeardown(),
    );

    expect(markdown).toMatch(/suppressed/i);
    expect(markdown).not.toContain("![002-type](null)");
  });

  it("renders the friction section with evidence references", () => {
    const markdown = renderJourneyReportMarkdown(
      collectedWithFriction(),
      makeTeardown(),
    );

    expect(markdown).toMatch(/## Friction/i);
    expect(markdown).toContain("browser_click failed: element not found");
    expect(markdown).toContain("transcript.jsonl:3");
  });

  it("renders verdict, failure kind, and teardown warnings", () => {
    const collected = collectJourneyReport(
      makeInput({
        outcome: makeOutcome({ failure_kind: "budget_exceeded" }),
        verdict: {
          passed: false,
          failure_kind: "budget_exceeded",
          results: [],
        },
      }),
    );
    const teardown = makeTeardown({
      unmanagedWarnings: [
        {
          method: "POST",
          path: "/api/v1/widgets",
          status: 201,
          source: "browser",
        },
      ],
    });

    const markdown = renderJourneyReportMarkdown(collected, teardown);

    expect(markdown).toMatch(/failed/i);
    expect(markdown).toContain("budget_exceeded");
    expect(markdown).toContain("/api/v1/widgets");
  });
});
