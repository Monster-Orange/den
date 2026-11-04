import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import { TestRunner } from "../../../src/ui/cli/test-runner.js";
import * as path from "path";
import { getDistRoot } from "../../../src/shared/paths.js";
import { getPerfSummaryArtifactPath } from "../../../src/shared/perf/report-paths.js";
import { enginePath as ENG, tsxBin } from "../../../src/shared/engine.js";

describe("TestRunner performance execution", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds setup-env + perf harness steps for repo-owned performance modules (staging)", () => {
    const runner = new TestRunner();
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "staging",
      modules: ["sample-service/search"],
    });

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      command: tsxBin(),
      args: [
        ENG("src/pillars/smoke/setup-env.ts"),
        "--env",
        "staging",
        "--repo",
        "sample-service",
      ],
      label: "Resolve deployed branch (staging)",
    });
    expect(steps[1]).toMatchObject({
      command: tsxBin(),
      args: [
        ENG("src/pillars/perf/run.ts"),
        "--env",
        "staging",
        "--repo",
        "sample-service",
        "--module",
        "search",
      ],
      label: "Run k6 sample-service (search)",
    });
    expect(steps[1].args).not.toContain("--base-url");
  });

  it("runs repo-owned performance modules via setup-env then perf harness", async () => {
    const runner = new TestRunner();
    const checkK6Installed = jest
      .spyOn(runner as never, "checkK6Installed")
      .mockResolvedValue(true);
    const spawnProcess = jest
      .spyOn(runner as never, "spawnProcess")
      .mockResolvedValue({ success: true, exitCode: 0 });

    const result = await runner.runTests({
      pillar: "performance",
      environment: "staging",
      modules: ["sample-service/search"],
    });

    expect(result.success).toBe(true);
    expect(checkK6Installed).toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenNthCalledWith(
      1,
      tsxBin(),
      [
        ENG("src/pillars/smoke/setup-env.ts"),
        "--env",
        "staging",
        "--repo",
        "sample-service",
      ],
      expect.objectContaining({
        E2E_ENVIRONMENT: "staging",
      }),
    );
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      tsxBin(),
      [
        ENG("src/pillars/perf/run.ts"),
        "--env",
        "staging",
        "--repo",
        "sample-service",
        "--module",
        "search",
      ],
      expect.objectContaining({
        E2E_ENVIRONMENT: "staging",
      }),
    );
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("still builds the perf report after a k6 failure (local internal modules)", async () => {
    const runner = new TestRunner();
    jest.spyOn(runner as never, "checkK6Installed").mockResolvedValue(true);
    const spawnProcess = jest
      .spyOn(runner as never, "spawnProcess")
      .mockResolvedValueOnce({ success: false, exitCode: 99 })
      .mockResolvedValueOnce({ success: true, exitCode: 0 });

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runner.runTests({
        pillar: "performance",
        environment: "local",
        modules: ["api-health"],
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(99);
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(spawnProcess).toHaveBeenNthCalledWith(
        1,
        "k6",
        [
          "run",
          "--summary-export",
          path.resolve(getDistRoot(), getPerfSummaryArtifactPath("api-health")),
          path.resolve(getDistRoot(), "tests/pillars/perf/api-health/test.js"),
        ],
        expect.objectContaining({
          E2E_ENVIRONMENT: "local",
        }),
      );
      expect(spawnProcess).toHaveBeenNthCalledWith(
        2,
        tsxBin(),
        [ENG("src/pillars/perf/build-report.ts")],
        expect.objectContaining({
          PERF_ENVIRONMENT: "local",
          PERF_MODULES: "api-health",
        }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  // The runner is now a thin transport: it injects whatever env the caller
  // resolved (via resolveFieldEnv) into THAT module's k6 process, scoped by
  // moduleEnv[moduleName]. The smoke→SMOKE=1 / target-default-3k semantics now live
  // in the pure resolver (see optional-fields.test.ts); these tests assert the
  // routing + behaviour-preserving end-to-end mapping for one module.

  it("routes a module's resolved optional-field env ONLY into its own k6 step", () => {
    const runner = new TestRunner();
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "staging",
      modules: ["api-load", "api-health"],
      moduleEnv: {
        "api-load": { LOAD_SMOKE: "1" },
      },
    });
    const apiLoadStep = steps.find(
      (s) =>
        s.command === "k6" &&
        s.args.some((a) => a.includes("api-load/test.js")),
    );
    const apiHealthStep = steps.find(
      (s) =>
        s.command === "k6" &&
        s.args.some((a) => a.includes("api-health/test.js")),
    );
    expect(apiLoadStep?.env?.LOAD_SMOKE).toBe("1");
    // The env must NOT leak into a sibling module's k6 process.
    expect(apiHealthStep?.env?.LOAD_SMOKE).toBeUndefined();
    // Label summarizes the set field keys generically.
    expect(apiLoadStep?.label).toContain("LOAD_SMOKE");
  });

  it("behaviour-preserving: smoke on → LOAD_SMOKE=1, no target", () => {
    const runner = new TestRunner();
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "staging",
      modules: ["api-load"],
      // What the server would resolve for { smoke: true } from the manifest.
      moduleEnv: { "api-load": { LOAD_SMOKE: "1" } },
    });
    const k6Step = steps.find((s) => s.command === "k6");
    expect(k6Step?.env?.LOAD_SMOKE).toBe("1");
    expect(k6Step?.env?.LOAD_TARGET).toBeUndefined();
  });

  it("behaviour-preserving: smoke off + target=10k → LOAD_TARGET=10k, no SMOKE", () => {
    const runner = new TestRunner();
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "staging",
      modules: ["api-load"],
      moduleEnv: { "api-load": { LOAD_TARGET: "10k" } },
    });
    const k6Step = steps.find((s) => s.command === "k6");
    expect(k6Step?.env?.LOAD_TARGET).toBe("10k");
    expect(k6Step?.env?.LOAD_SMOKE).toBeUndefined();
    expect(k6Step?.label).toContain("LOAD_TARGET");
  });

  it("no moduleEnv → no optional-field env vars on the k6 step", () => {
    const runner = new TestRunner();
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "staging",
      modules: ["api-load"],
    });
    const k6Step = steps.find((s) => s.command === "k6");
    expect(k6Step?.env?.LOAD_SMOKE).toBeUndefined();
    expect(k6Step?.env?.LOAD_TARGET).toBeUndefined();
  });
});
