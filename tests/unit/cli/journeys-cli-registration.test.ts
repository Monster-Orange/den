/**
 * Journeys pillar registration in the interactive CLI (plan:
 * jrn-cli-registration packet).
 *
 * Covers the two src/ui/cli surfaces that gained journeys behavior:
 * - CLIPrompts.promptForPillar offers the journeys pillar choice;
 * - ResultsViewer renders a journeys-specific results view over the JSONL
 *   rows (verdict, failure_kind, friction count, snapshots dir) and
 *   includes journeys in the summary sweep.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import inquirer from "inquirer";
import { CLIPrompts } from "../../../src/ui/cli/prompts.js";
import { ResultsViewer } from "../../../src/ui/cli/results-viewer.js";
import { resultReader } from "../../../src/shared/results/result-reader.js";
import type {
  TestResult,
  TestSummary,
} from "../../../src/shared/types/index.js";

// The global inquirer stub (tests/__mocks__/inquirer.cjs) returns {} from
// prompt; tests below swap in a capturing fake and restore it afterwards.
const inquirerModule = inquirer as unknown as {
  prompt: (questions: unknown) => Promise<unknown>;
};
const originalPrompt = inquirerModule.prompt;

afterEach(() => {
  inquirerModule.prompt = originalPrompt;
  jest.restoreAllMocks();
});

describe("CLIPrompts.promptForPillar", () => {
  it("offers journeys as a pillar choice", async () => {
    let capturedQuestions: unknown;
    inquirerModule.prompt = async (questions: unknown) => {
      capturedQuestions = questions;
      return { pillar: "journeys" };
    };

    const pillar = await new CLIPrompts().promptForPillar();

    expect(pillar).toBe("journeys");
    const [question] = capturedQuestions as Array<{
      choices: Array<{ name: string; value: string }>;
    }>;
    const journeysChoice = question.choices.find(
      (choice) => choice.value === "journeys",
    );
    expect(journeysChoice).toBeDefined();
    expect(journeysChoice?.name).toContain("Journeys");
  });
});

describe("ResultsViewer journeys view", () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  const emptySummary: TestSummary = {
    pillar: "journeys",
    environment: "local",
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0,
    passRate: 0,
  };

  const failedRow: TestResult = {
    timestamp: new Date().toISOString(),
    pillar: "journeys",
    environment: "local",
    test: "user-first-item",
    status: "failed",
    duration: 61234,
    user: "tester",
    error: "failure_kind=budget_exceeded",
    metadata: {
      surface: "browser",
      runId: "jrn-user-first-item-run",
      failure_kind: "budget_exceeded",
      snapshot_count: 12,
      snapshots_dir: "reports/journeys/jrn-user-first-item-run/snapshots",
      friction_points: [{ category: "retry" }, { category: "latency" }],
    },
  };

  const passedRow: TestResult = {
    timestamp: new Date().toISOString(),
    pillar: "journeys",
    environment: "local",
    test: "connection-create-and-browse",
    status: "passed",
    duration: 32000,
    user: "tester",
    metadata: {
      surface: "browser",
      runId: "jrn-connection-run",
      snapshot_count: 7,
      snapshots_dir: "reports/journeys/jrn-connection-run/snapshots",
      friction_points: [],
    },
  };

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  const loggedOutput = (): string =>
    logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

  it("renders verdict, failure kind, friction count, and snapshots dir per row", async () => {
    jest.spyOn(resultReader, "query").mockResolvedValue([failedRow, passedRow]);
    jest.spyOn(resultReader, "getSummary").mockResolvedValue({
      ...emptySummary,
      total: 2,
      passed: 1,
      failed: 1,
      passRate: 50,
    });

    await new ResultsViewer().displayDetailed("journeys", "local", 7);

    const output = loggedOutput();
    expect(output).toContain("user-first-item");
    expect(output).toContain("budget_exceeded");
    expect(output).toContain(
      "reports/journeys/jrn-user-first-item-run/snapshots",
    );
    // Friction column: 2 friction points on the failed row.
    expect(output).toMatch(/Friction/);
    expect(output).toContain("connection-create-and-browse");
  });

  it("says so when no journeys results exist", async () => {
    jest.spyOn(resultReader, "query").mockResolvedValue([]);

    await new ResultsViewer().displayDetailed("journeys", "local", 7);

    expect(loggedOutput()).toContain("No results found");
  });

  it("includes journeys in the summary sweep", async () => {
    const getSummarySpy = jest
      .spyOn(resultReader, "getSummary")
      .mockResolvedValue(emptySummary);

    await new ResultsViewer().displaySummary(7);

    const sweptPillars = getSummarySpy.mock.calls.map(([pillar]) => pillar);
    expect(sweptPillars).toContain("journeys");
  });

  it("tolerates rows without metadata (older den versions)", async () => {
    const bareRow: TestResult = {
      timestamp: new Date().toISOString(),
      pillar: "journeys",
      environment: "local",
      test: "legacy-journey",
      status: "skipped",
      duration: 500,
      user: "tester",
    };
    jest.spyOn(resultReader, "query").mockResolvedValue([bareRow]);
    jest.spyOn(resultReader, "getSummary").mockResolvedValue(emptySummary);

    await new ResultsViewer().displayDetailed("journeys", "local", 7);

    const output = loggedOutput();
    expect(output).toContain("legacy-journey");
    expect(output).toContain("Skipped");
  });

  it("caps the journeys table at 20 rows and reports the remainder", async () => {
    const manyRows = Array.from({ length: 23 }, (_, i) => ({
      ...passedRow,
      test: `journey-${i}`,
    }));
    jest.spyOn(resultReader, "query").mockResolvedValue(manyRows);
    jest.spyOn(resultReader, "getSummary").mockResolvedValue({
      ...emptySummary,
      total: 23,
      passed: 23,
      passRate: 100,
    });

    await new ResultsViewer().displayDetailed("journeys", "local", 7);

    expect(loggedOutput()).toContain("... and 3 more results");
  });
});

describe("ResultsViewer existing views (regression around the journeys split)", () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  const loggedOutput = (): string =>
    logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

  it("renders non-journeys detailed results with statuses and summary", async () => {
    const rows: TestResult[] = [
      {
        timestamp: new Date(Date.now() - 30_000).toISOString(),
        pillar: "integration",
        environment: "local",
        test: "a-very-long-test-name-that-needs-truncation-to-fit-the-table",
        status: "passed",
        duration: 450,
        user: "someone-with-a-long-username",
      },
      {
        timestamp: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        pillar: "integration",
        environment: "local",
        test: "failing-test",
        status: "failed",
        duration: 61_000,
        user: "tester",
      },
      {
        timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        pillar: "integration",
        environment: "local",
        test: "skipped-test",
        status: "skipped",
        duration: 1_500,
        user: "tester",
      },
      {
        timestamp: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        pillar: "integration",
        environment: "local",
        test: "old-test",
        status: "passed",
        duration: 12_000,
        user: "tester",
      },
    ];
    jest.spyOn(resultReader, "query").mockResolvedValue(rows);
    jest.spyOn(resultReader, "getSummary").mockResolvedValue({
      pillar: "integration",
      environment: "local",
      total: 4,
      passed: 2,
      failed: 1,
      skipped: 1,
      duration: 74_950,
      passRate: 50,
    });

    await new ResultsViewer().displayDetailed("integration", "local", 30);

    const output = loggedOutput();
    expect(output).toContain("failing-test");
    expect(output).toContain("Skipped");
    expect(output).toContain("Pass Rate");
  });

  it("renders per-environment summary tables with mixed pass rates", async () => {
    jest
      .spyOn(resultReader, "getSummary")
      .mockImplementation(async (pillar, environment) => ({
        pillar,
        environment,
        total: environment === "local" ? 10 : 0,
        passed: 8,
        failed: 1,
        skipped: 1,
        duration: 1000,
        passRate: environment === "local" ? 80 : 0,
      }));

    await new ResultsViewer().displaySummary(7);

    const output = loggedOutput();
    expect(output).toContain("Journeys");
    expect(output).toContain("Pass Rate");
  });

  it("lists flaky tests with their flake rates", async () => {
    jest.spyOn(resultReader, "getFlakyTests").mockResolvedValue([
      { test: "wobbly-test", runs: 10, failures: 6, flakyRate: 60 },
      { test: "mildly-flaky", runs: 10, failures: 3, flakyRate: 30 },
      { test: "rarely-flaky", runs: 10, failures: 1, flakyRate: 10 },
    ]);

    await new ResultsViewer().displayFlakyTests("integration", 30);

    const output = loggedOutput();
    expect(output).toContain("wobbly-test");
    expect(output).toContain("60.0%");
  });

  it("celebrates when no flaky tests exist", async () => {
    jest.spyOn(resultReader, "getFlakyTests").mockResolvedValue([]);

    await new ResultsViewer().displayFlakyTests("integration", 30);

    expect(loggedOutput()).toContain("No flaky tests found");
  });
});
