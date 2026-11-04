/**
 * Unit tests for the journeys CLI entrypoint
 * (src/pillars/journeys/run.ts) — plan: jrn-pilot-journeys packet.
 *
 * Contract under test (Approach §Verdict discipline / §Explicit environment
 * targeting; todo jrn-pilot-journeys/implement-run-entrypoint):
 * - --env is REQUIRED, exactly one, and must be a known environment name;
 * - discovery is manifest-driven via discoverJourneySpecs(); specs whose
 *   environments allowlist excludes the target env are SKIPPED with a
 *   logged reason; zero runnable specs is a loud distinct exit code (3);
 * - per journey the STRICT order is runJourney → verify → collect report →
 *   teardown (in finally, AFTER the verification probes) → finalize report
 *   (teardown warnings folded in) — reporting is guaranteed in finally on
 *   every outcome;
 * - exit codes: 0 all passed / 1 infra error / 2 any journey failed /
 *   3 no specs discovered;
 * - an in-process transcript secret scan compares secrets FROM MEMORY
 *   (never argv) against the persisted transcript artifacts and fails the
 *   journey as infra_error on a hit.
 *
 * All collaborators are injected fakes — no live SDK, stack, or fs calls.
 */

import { describe, expect, it, jest } from "@jest/globals";
import type { DiscoveredJourneySpec } from "../../../src/pillars/journeys/discover.js";
import type { RunOutcome } from "../../../src/pillars/journeys/runner.js";
import {
  EXIT_ALL_PASSED,
  EXIT_INFRA_ERROR,
  EXIT_JOURNEY_FAILED,
  EXIT_NO_SPECS,
  parseCliArgs,
  runJourneysCli,
  transcriptContainsSecret,
  type EntrypointDeps,
} from "../../../src/pillars/journeys/run.js";
import type { JourneySpec } from "../../../src/pillars/journeys/spec/schema.js";
import type { TeardownReport } from "../../../src/pillars/journeys/teardown.js";
import { RunLedger } from "../../../src/pillars/journeys/tools/ledger.js";
import { testLedgerRegistry } from "./fixtures/test-app.js";
import type { Verdict } from "../../../src/pillars/journeys/verify/verdict.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<JourneySpec> = {}): JourneySpec {
  return {
    name: "user-first-item",
    persona: { role: "user", brief: "Create an item and ask a question." },
    surface: "api",
    environments: ["local"],
    budgets: { max_turns: 10, timeout_s: 120, max_total_tokens: 50_000 },
    success: {
      assertions: [
        {
          kind: "http_status",
          request: { method: "GET", path: "/api/v1/items/{item_id}" },
          equals: 200,
        },
      ],
    },
    ...overrides,
  } as JourneySpec;
}

function makeDiscovered(
  spec: JourneySpec,
  specPath = `/repos/web-app/tests/journeys/${spec.name}.journey.yml`,
): DiscoveredJourneySpec {
  return {
    repoName: "web-app",
    repoPath: "/repos/web-app",
    specPath,
    spec,
  };
}

function makeOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "jrn-user-first-item-2026-07-15T00-00-00-000Z-ab12",
    transcriptPath: "/reports/journeys/run-1/transcript.jsonl",
    snapshotIndex: [],
    ledger: new RunLedger(testLedgerRegistry()),
    durationMs: 1234,
    ...overrides,
  };
}

const passedVerdict: Verdict = { passed: true, results: [] };
const failedVerdict: Verdict = { passed: false, results: [] };

const emptyTeardown: TeardownReport = {
  results: [],
  failures: [],
  unmanagedWarnings: [],
  interceptionErrors: [],
};

interface FakeDepsOptions {
  specs?: DiscoveredJourneySpec[];
  outcome?: RunOutcome | (() => RunOutcome);
  verdict?: Verdict;
  transcriptContents?: Record<string, string>;
}

function makeDeps(options: FakeDepsOptions = {}): {
  deps: EntrypointDeps;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const specs = options.specs ?? [makeDiscovered(makeSpec())];
  const verdict = options.verdict ?? passedVerdict;

  const deps: EntrypointDeps = {
    discoverSpecs: jest.fn(() => specs),
    loadEnvironment: jest.fn(async () => ({
      name: "local",
      baseUrls: {
        web: "http://localhost:3000",
        api: "http://localhost:8000",
        services: {},
      },
    })) as EntrypointDeps["loadEnvironment"],
    captureSecrets: jest.fn(async () => ({
      cursorApiKey: "cursor-key-value",
    })) as EntrypointDeps["captureSecrets"],
    deriveApiToken: jest.fn(async () => ({
      apiToken: "jwt-token-value",
      headers: { "X-Org-ID": "org-value" },
    })) as EntrypointDeps["deriveApiToken"],
    runJourney: jest.fn(async (_spec, _env, runnerDeps) => {
      // Mirror the real runner: capture secrets AND derive the session
      // token through the caller-supplied deps so the entrypoint can hold
      // them for verify/teardown/scan.
      await runnerDeps.captureSecrets?.("user", "local");
      await runnerDeps.deriveApiToken?.(
        "/tmp/playwright/.auth/user-local.json",
        "local",
      );
      return typeof options.outcome === "function"
        ? options.outcome()
        : (options.outcome ?? makeOutcome());
    }) as unknown as EntrypointDeps["runJourney"],
    buildProbeClient: jest.fn(() =>
      jest.fn(async () => ({ status: 200, body: {} })),
    ) as unknown as EntrypointDeps["buildProbeClient"],
    verifyJourney: jest.fn(
      async () => verdict,
    ) as unknown as EntrypointDeps["verifyJourney"],
    teardownLedger: jest.fn(
      async () => emptyTeardown,
    ) as unknown as EntrypointDeps["teardownLedger"],
    collectReport: jest.fn((input) => ({
      journeyName: input.spec.name,
      surface: input.spec.surface,
      environment: input.env,
      timestamp: "2026-07-15T00:00:00.000Z",
      user: "test",
      runId: input.outcome.runId,
      status: input.verdict.passed ? ("passed" as const) : ("failed" as const),
      ...(input.verdict.failure_kind !== undefined
        ? { failureKind: input.verdict.failure_kind }
        : {}),
      durationMs: input.outcome.durationMs,
      budgetConsumption: {
        maxTotalTokens: input.spec.budgets.max_total_tokens,
        timeoutS: input.spec.budgets.timeout_s,
        maxTurns: input.spec.budgets.max_turns,
      },
      transcriptPath: input.outcome.transcriptPath,
      reportDir: "/reports/journeys/run-1",
      snapshotsDir: "/reports/journeys/run-1/snapshots",
      snapshotCount: input.outcome.snapshotIndex.length,
      snapshotIndex: input.outcome.snapshotIndex,
      frictionPoints: input.frictionPoints,
      assertionResults: input.verdict.results,
    })) as unknown as EntrypointDeps["collectReport"],
    finalizeReport: jest.fn(async (collected) => ({
      row: {
        timestamp: collected.timestamp,
        pillar: "journeys" as const,
        environment: collected.environment,
        test: collected.journeyName,
        status: collected.status,
        duration: collected.durationMs,
        user: collected.user,
      },
      junitCase: {
        name: collected.journeyName,
        environment: collected.environment,
        durationMs: collected.durationMs,
        passed: collected.status === "passed",
        failureDetails: [],
        teardownWarnings: [],
      },
      reportPath: "/reports/journeys/run-1/report.md",
    })) as unknown as EntrypointDeps["finalizeReport"],
    writeJUnit: jest.fn(
      async () => "/reports/junit-journeys-results.xml",
    ) as unknown as EntrypointDeps["writeJUnit"],
    extractFriction: jest.fn(
      () => [],
    ) as unknown as EntrypointDeps["extractFriction"],
    readFileIfExists: jest.fn(
      (filePath: string) => options.transcriptContents?.[filePath],
    ),
    log: (message: string) => logs.push(message),
    logError: (message: string) => errors.push(message),
  };

  return { deps, logs, errors };
}

function callOrder(fn: unknown): number {
  const mock = fn as jest.Mock;
  expect(mock.mock.invocationCallOrder.length).toBeGreaterThan(0);
  return mock.mock.invocationCallOrder[0];
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

describe("parseCliArgs", () => {
  it("parses a single required --env", () => {
    expect(parseCliArgs(["--env=staging"])).toEqual({ env: "staging" });
  });

  it("parses an optional --journey filter", () => {
    expect(parseCliArgs(["--env=local", "--journey=user-first-item"])).toEqual({
      env: "local",
      journey: "user-first-item",
    });
  });

  it("rejects a missing --env", () => {
    expect(() => parseCliArgs([])).toThrow(/--env/);
  });

  it("rejects multiple --env flags (exactly one environment per invocation)", () => {
    expect(() => parseCliArgs(["--env=local", "--env=staging"])).toThrow(
      /exactly one/i,
    );
  });

  it("rejects an unknown environment name", () => {
    expect(() => parseCliArgs(["--env=den-prime"])).toThrow(
      /unknown environment/i,
    );
  });

  it("rejects unrecognized arguments loudly", () => {
    expect(() => parseCliArgs(["--env=local", "--frobnicate"])).toThrow(
      /--frobnicate/,
    );
  });
});

// ── Env handling / discovery / skip reasons ─────────────────────────────────

describe("runJourneysCli — env handling and discovery", () => {
  it("exits 1 with a usage error when --env is missing (never runs anything)", async () => {
    const { deps, errors } = makeDeps();
    const exitCode = await runJourneysCli([], deps);
    expect(exitCode).toBe(EXIT_INFRA_ERROR);
    expect(errors.join("\n")).toMatch(/--env/);
    expect(deps.runJourney).not.toHaveBeenCalled();
  });

  it("exits 3 (loud, distinct) when discovery finds zero specs", async () => {
    const { deps, errors } = makeDeps({ specs: [] });
    const exitCode = await runJourneysCli(["--env=local"], deps);
    expect(exitCode).toBe(EXIT_NO_SPECS);
    expect(errors.join("\n")).toMatch(/no journey specs/i);
  });

  it("exits 3 when --journey matches no discovered spec", async () => {
    const { deps, errors } = makeDeps();
    const exitCode = await runJourneysCli(
      ["--env=local", "--journey=does-not-exist"],
      deps,
    );
    expect(exitCode).toBe(EXIT_NO_SPECS);
    expect(errors.join("\n")).toMatch(/does-not-exist/);
    expect(deps.runJourney).not.toHaveBeenCalled();
  });

  it("skips specs whose environments allowlist excludes the target env, with a logged reason", async () => {
    const runnable = makeSpec({ name: "runs-on-local" });
    const skipped = makeSpec({
      name: "staging-only",
      environments: ["staging"],
    });
    const { deps, logs } = makeDeps({
      specs: [makeDiscovered(runnable), makeDiscovered(skipped)],
    });

    const exitCode = await runJourneysCli(["--env=local"], deps);

    expect(exitCode).toBe(EXIT_ALL_PASSED);
    expect(deps.runJourney).toHaveBeenCalledTimes(1);
    const skipLine = logs.find((line) => line.includes("staging-only"));
    expect(skipLine).toMatch(/skip/i);
    expect(skipLine).toMatch(/staging/);
  });

  it("exits 3 when every discovered spec is skipped for the target env (never silent green)", async () => {
    const { deps, errors } = makeDeps({
      specs: [makeDiscovered(makeSpec({ environments: ["staging"] }))],
    });
    const exitCode = await runJourneysCli(["--env=local"], deps);
    expect(exitCode).toBe(EXIT_NO_SPECS);
    expect(errors.join("\n")).toMatch(/0 of 1/);
  });

  it("exits 1 when discovery itself throws (invalid spec / missing testDir)", async () => {
    const { deps, errors } = makeDeps();
    (deps.discoverSpecs as jest.Mock).mockImplementation(() => {
      throw new Error("Journeys testDir missing");
    });
    const exitCode = await runJourneysCli(["--env=local"], deps);
    expect(exitCode).toBe(EXIT_INFRA_ERROR);
    expect(errors.join("\n")).toMatch(/testDir missing/);
  });

  it("--journey runs only the named journey", async () => {
    const a = makeSpec({ name: "journey-a" });
    const b = makeSpec({ name: "journey-b" });
    const { deps } = makeDeps({
      specs: [makeDiscovered(a), makeDiscovered(b)],
    });

    await runJourneysCli(["--env=local", "--journey=journey-b"], deps);

    expect(deps.runJourney).toHaveBeenCalledTimes(1);
    expect((deps.runJourney as jest.Mock).mock.calls[0][0]).toMatchObject({
      name: "journey-b",
    });
  });

  it("--journey=<repo>/<name> selects the exact repo's spec when names collide (review finding 10)", async () => {
    const spec = makeSpec({ name: "shared-name" });
    const fromWebApp = makeDiscovered(spec);
    const fromOtherRepo: DiscoveredJourneySpec = {
      repoName: "other-repo",
      repoPath: "/repos/other-repo",
      specPath: "/repos/other-repo/tests/journeys/shared-name.journey.yml",
      spec: makeSpec({ name: "shared-name" }),
    };
    const { deps } = makeDeps({ specs: [fromWebApp, fromOtherRepo] });

    const exitCode = await runJourneysCli(
      ["--env=local", "--journey=other-repo/shared-name"],
      deps,
    );

    expect(exitCode).toBe(EXIT_ALL_PASSED);
    expect(deps.runJourney).toHaveBeenCalledTimes(1);
    expect((deps.runJourney as jest.Mock).mock.calls[0][0]).toBe(
      fromOtherRepo.spec,
    );
  });

  it("refuses a bare --journey name duplicated across repos with a loud error", async () => {
    const fromWebApp = makeDiscovered(makeSpec({ name: "shared-name" }));
    const fromOtherRepo: DiscoveredJourneySpec = {
      repoName: "other-repo",
      repoPath: "/repos/other-repo",
      specPath: "/repos/other-repo/tests/journeys/shared-name.journey.yml",
      spec: makeSpec({ name: "shared-name" }),
    };
    const { deps, errors } = makeDeps({
      specs: [fromWebApp, fromOtherRepo],
    });

    const exitCode = await runJourneysCli(
      ["--env=local", "--journey=shared-name"],
      deps,
    );

    expect(exitCode).toBe(EXIT_INFRA_ERROR);
    expect(errors.join("\n")).toMatch(/ambiguous/i);
    expect(errors.join("\n")).toMatch(/<repo>\/<name>/);
    expect(deps.runJourney).not.toHaveBeenCalled();
  });

  it("exits 3 when the repo-qualified --journey matches nothing", async () => {
    const { deps, errors } = makeDeps();

    const exitCode = await runJourneysCli(
      ["--env=local", "--journey=wrong-repo/user-first-item"],
      deps,
    );

    expect(exitCode).toBe(EXIT_NO_SPECS);
    expect(errors.join("\n")).toMatch(/wrong-repo/);
    expect(deps.runJourney).not.toHaveBeenCalled();
  });
});

// ── Ordering ─────────────────────────────────────────────────────────────────

describe("runJourneysCli — strict per-journey ordering", () => {
  it("runs runJourney → verify → collect → teardown → finalize on the happy path", async () => {
    const { deps } = makeDeps();

    const exitCode = await runJourneysCli(["--env=local"], deps);

    expect(exitCode).toBe(EXIT_ALL_PASSED);
    const order = [
      callOrder(deps.runJourney),
      callOrder(deps.verifyJourney),
      callOrder(deps.collectReport),
      callOrder(deps.teardownLedger),
      callOrder(deps.finalizeReport),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("teardown runs AFTER verification probes even when the journey fails its verdict", async () => {
    const { deps } = makeDeps({ verdict: failedVerdict });

    const exitCode = await runJourneysCli(["--env=local"], deps);

    expect(exitCode).toBe(EXIT_JOURNEY_FAILED);
    expect(callOrder(deps.verifyJourney)).toBeLessThan(
      callOrder(deps.teardownLedger),
    );
    expect(callOrder(deps.teardownLedger)).toBeLessThan(
      callOrder(deps.finalizeReport),
    );
  });

  it("still tears down and finalizes a report when verification throws (reporting in finally)", async () => {
    const { deps, errors } = makeDeps();
    (deps.verifyJourney as jest.Mock).mockImplementation(async () => {
      throw new Error("probe transport exploded");
    });

    const exitCode = await runJourneysCli(["--env=local"], deps);

    expect(exitCode).toBe(EXIT_INFRA_ERROR);
    expect(deps.teardownLedger).toHaveBeenCalledTimes(1);
    expect(deps.finalizeReport).toHaveBeenCalledTimes(1);
    // The fallback report can never pass.
    const collected = (deps.collectReport as jest.Mock).mock.calls[0][0] as {
      verdict: Verdict;
    };
    expect(collected.verdict.passed).toBe(false);
    expect(errors.join("\n")).toMatch(/probe transport exploded/);
  });

  it("finalize folds the teardown report in (finalize receives teardown's result)", async () => {
    const teardownReport: TeardownReport = {
      results: [],
      failures: [],
      unmanagedWarnings: [
        {
          method: "POST",
          path: "/api/v1/widgets",
          status: 201,
          source: "http-tool",
        } as TeardownReport["unmanagedWarnings"][number],
      ],
      interceptionErrors: [],
    };
    const { deps } = makeDeps();
    (deps.teardownLedger as jest.Mock).mockImplementation(
      async () => teardownReport,
    );

    await runJourneysCli(["--env=local"], deps);

    expect((deps.finalizeReport as jest.Mock).mock.calls[0][1]).toBe(
      teardownReport,
    );
  });

  it("a teardown failure is logged, folded as undefined, and does not mask the verdict", async () => {
    const { deps, errors } = makeDeps();
    (deps.teardownLedger as jest.Mock).mockImplementation(async () => {
      throw new Error("cleanup transport down");
    });

    const exitCode = await runJourneysCli(["--env=local"], deps);

    // Verdict passed; teardown crash surfaces loudly but reporting persists.
    expect(deps.finalizeReport).toHaveBeenCalledTimes(1);
    expect(errors.join("\n")).toMatch(/cleanup transport down/);
    expect(exitCode).toBe(EXIT_INFRA_ERROR);
  });

  it("skips teardown and reporting when runJourney throws before producing an outcome, and continues with remaining journeys", async () => {
    const a = makeSpec({ name: "journey-a" });
    const b = makeSpec({ name: "journey-b" });
    const { deps, errors } = makeDeps({
      specs: [makeDiscovered(a), makeDiscovered(b)],
    });
    (deps.runJourney as jest.Mock)
      .mockImplementationOnce(async () => {
        throw new Error("agent bootstrap blew up");
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        // Mirror the real runner: journey-b provisions its secrets AND
        // derives its session token (teardown needs the derived token).
        const runnerDeps = args[2] as {
          captureSecrets?: (role: string, env: string) => Promise<unknown>;
          deriveApiToken?: (
            authFilePath: string,
            env: string,
          ) => Promise<unknown>;
        };
        await runnerDeps.captureSecrets?.("user", "local");
        await runnerDeps.deriveApiToken?.(
          "/tmp/playwright/.auth/user-local.json",
          "local",
        );
        return makeOutcome();
      });

    const exitCode = await runJourneysCli(["--env=local"], deps);

    expect(exitCode).toBe(EXIT_INFRA_ERROR);
    expect(deps.runJourney).toHaveBeenCalledTimes(2);
    // No ledger exists for journey-a; only journey-b tears down + reports.
    expect(deps.teardownLedger).toHaveBeenCalledTimes(1);
    expect(deps.finalizeReport).toHaveBeenCalledTimes(1);
    expect(errors.join("\n")).toMatch(/agent bootstrap blew up/);
  });

  it("runs journeys sequentially (the second starts after the first fully finishes)", async () => {
    const a = makeSpec({ name: "journey-a" });
    const b = makeSpec({ name: "journey-b" });
    const { deps } = makeDeps({
      specs: [makeDiscovered(a), makeDiscovered(b)],
    });

    await runJourneysCli(["--env=local"], deps);

    const finalizeOrders = (deps.finalizeReport as jest.Mock).mock
      .invocationCallOrder;
    const runOrders = (deps.runJourney as jest.Mock).mock.invocationCallOrder;
    expect(finalizeOrders[0]).toBeLessThan(runOrders[1]);
  });

  it("writes the aggregated JUnit file exactly once with a case per executed journey", async () => {
    const a = makeSpec({ name: "journey-a" });
    const b = makeSpec({ name: "journey-b" });
    const { deps } = makeDeps({
      specs: [makeDiscovered(a), makeDiscovered(b)],
    });

    await runJourneysCli(["--env=local"], deps);

    expect(deps.writeJUnit).toHaveBeenCalledTimes(1);
    const cases = (deps.writeJUnit as jest.Mock).mock.calls[0][0] as Array<{
      name: string;
    }>;
    expect(cases.map((c) => c.name)).toEqual(["journey-a", "journey-b"]);
  });
});

// ── Exit codes ───────────────────────────────────────────────────────────────

describe("runJourneysCli — exit codes", () => {
  it("exits 0 when every journey passes", async () => {
    const { deps } = makeDeps();
    expect(await runJourneysCli(["--env=local"], deps)).toBe(EXIT_ALL_PASSED);
  });

  it("exits 2 when any journey fails its verdict", async () => {
    const { deps } = makeDeps({ verdict: failedVerdict });
    expect(await runJourneysCli(["--env=local"], deps)).toBe(
      EXIT_JOURNEY_FAILED,
    );
  });

  it("exits 1 when a journey's outcome carries failure_kind=infra_error", async () => {
    const { deps } = makeDeps({
      outcome: makeOutcome({ failure_kind: "infra_error" }),
      verdict: {
        passed: false,
        failure_kind: "infra_error",
        results: [],
      },
    });
    expect(await runJourneysCli(["--env=local"], deps)).toBe(EXIT_INFRA_ERROR);
  });

  it("infra errors dominate journey failures (1 beats 2)", async () => {
    const a = makeSpec({ name: "journey-a" });
    const b = makeSpec({ name: "journey-b" });
    const { deps } = makeDeps({
      specs: [makeDiscovered(a), makeDiscovered(b)],
      verdict: failedVerdict,
    });
    (deps.runJourney as jest.Mock).mockImplementationOnce(async () => {
      throw new Error("infra blew up");
    });

    expect(await runJourneysCli(["--env=local"], deps)).toBe(EXIT_INFRA_ERROR);
  });

  it("budget failure kinds count as journey failures (exit 2), not infra", async () => {
    const { deps } = makeDeps({
      outcome: makeOutcome({ failure_kind: "budget_exceeded" }),
      verdict: {
        passed: false,
        failure_kind: "budget_exceeded",
        results: [],
      },
    });
    expect(await runJourneysCli(["--env=local"], deps)).toBe(
      EXIT_JOURNEY_FAILED,
    );
  });
});

// ── Secret scan ──────────────────────────────────────────────────────────────

describe("transcriptContainsSecret", () => {
  it("detects a live secret value in transcript contents", () => {
    expect(
      transcriptContainsSecret('{"text":"leaked jwt-token-value here"}', [
        "cursor-key-value",
        "jwt-token-value",
      ]),
    ).toBe(true);
  });

  it("passes clean contents and ignores empty secret values", () => {
    expect(
      transcriptContainsSecret('{"text":"all clean"}', [
        "",
        "cursor-key-value",
      ]),
    ).toBe(false);
  });
});

describe("runJourneysCli — in-process transcript secret scan", () => {
  it("scans the persisted transcript with secrets held in memory and fails the journey as infra on a hit", async () => {
    const outcome = makeOutcome();
    const { deps, errors } = makeDeps({
      outcome,
      transcriptContents: {
        [outcome.transcriptPath]: '{"text":"oops jwt-token-value"}',
      },
    });

    const exitCode = await runJourneysCli(["--env=local"], deps);

    expect(exitCode).toBe(EXIT_INFRA_ERROR);
    expect(errors.join("\n")).toMatch(/secret/i);
    // The persisted report can never claim a pass after a leak.
    const collected = (deps.collectReport as jest.Mock).mock.calls[0][0] as {
      verdict: Verdict;
    };
    expect(collected.verdict.passed).toBe(false);
    expect(collected.verdict.failure_kind).toBe("infra_error");
  });

  it("reads BOTH transcript.jsonl and the rendered transcript.md", async () => {
    const outcome = makeOutcome();
    const { deps } = makeDeps({ outcome });

    await runJourneysCli(["--env=local"], deps);

    const readPaths = (deps.readFileIfExists as jest.Mock).mock.calls.map(
      (call) => call[0],
    );
    expect(readPaths).toContain(outcome.transcriptPath);
    expect(
      readPaths.some(
        (p) => typeof p === "string" && p.endsWith("transcript.md"),
      ),
    ).toBe(true);
  });

  it("a clean transcript keeps the journey passing", async () => {
    const outcome = makeOutcome();
    const { deps } = makeDeps({
      outcome,
      transcriptContents: {
        [outcome.transcriptPath]: '{"text":"perfectly clean"}',
      },
    });
    expect(await runJourneysCli(["--env=local"], deps)).toBe(EXIT_ALL_PASSED);
  });
});

// ── Secret plumbing ──────────────────────────────────────────────────────────

describe("runJourneysCli — captured secrets feed verify/teardown", () => {
  it("builds the probe client with a tokenProvider + headersProvider from the session token", async () => {
    const { deps } = makeDeps();

    await runJourneysCli(["--env=local"], deps);

    const options = (deps.buildProbeClient as jest.Mock).mock.calls[0][0] as {
      allowedBaseUrls: string[];
      tokenProvider: () => Promise<string>;
      headersProvider: () => Promise<Record<string, string>>;
    };
    expect(options.allowedBaseUrls).toContain("http://localhost:8000");
    // The probe token + headers are the browser-session-derived values,
    // not a captureSecrets-minted JWT.
    await expect(options.tokenProvider()).resolves.toBe("jwt-token-value");
    await expect(options.headersProvider()).resolves.toEqual({
      "X-Org-ID": "org-value",
    });
  });
});
