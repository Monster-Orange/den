/**
 * Issue 212 (Verify 6), the server side: a module's history with its flaky
 * mark, and a security scan's findings against the threshold
 * (VERIFY-SPEC sections 5 and 17; handoff S5, S6).
 *
 *   T11  2 passes after a retry in the last 10 runs show the flaky mark;
 *        1 doesn't; both numbers come from settings
 *   T13  a scan whose findings are all below the threshold passes, and
 *        one with a finding at the threshold fails
 *
 * Plus what they stand on: `verify.run.retries` (a failed module runs
 * again, and every attempt is kept), the SARIF a scan writes to
 * DEN_RESULTS_DIR, and the settings' defaults. Commands are fakes; runs
 * live in a temp state folder. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readVerifyModules } from "../../../src/shared/verify/config.js";
import { moduleChanges } from "../../../src/shared/verify/changes.js";
import { planVerify } from "../../../src/shared/verify/plan.js";
import { runPlan, type RunDeps } from "../../../src/shared/verify/run.js";
import type { RunRecord } from "../../../src/shared/verify/records.js";
import {
  moduleHistory,
  readSarifFindings,
  scanVerdict,
} from "../../../src/shared/verify/history.js";
import {
  DEFAULT_VERIFY_SETTINGS,
  readVerifySettings,
} from "../../../src/shared/verify/settings.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-hist-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("the settings, with permissive defaults", () => {
  it("defaults: no retries, high fails a scan, flaky at 2 in 10, 30 runs of history", () => {
    expect(readVerifySettings(undefined)).toEqual(DEFAULT_VERIFY_SETTINGS);
    expect(DEFAULT_VERIFY_SETTINGS).toEqual({
      retries: 0,
      failOn: "high",
      flakyWindow: 10,
      flakyMinRetries: 2,
      historyLimit: 30,
    });
  });

  it("each one set in the org config's verify: block", () => {
    expect(
      readVerifySettings({
        run: { retries: 2 },
        security: { fail_on: "medium" },
        flaky: { window: 20, min_retries: 3 },
        history: { limit: 50 },
      }),
    ).toEqual({
      retries: 2,
      failOn: "medium",
      flakyWindow: 20,
      flakyMinRetries: 3,
      historyLimit: 50,
    });
  });

  it.each([
    [{ run: { retries: -1 } }, /verify\.run\.retries/],
    [{ security: { fail_on: "severe" } }, /verify\.security\.fail_on/],
    [{ flaky: { window: 0 } }, /verify\.flaky\.window/],
    [{ flaky: { min_retries: 1.5 } }, /verify\.flaky\.min_retries/],
    [{ history: { limit: "lots" } }, /verify\.history\.limit/],
    [{ nope: 1 }, /verify\.nope: unknown key/],
  ])("a wrong value names its key: %j", (raw, re) => {
    expect(() => readVerifySettings(raw)).toThrow(re);
  });
});

const shop = readVerifyModules({
  repo: "shop",
  repoPath: "/repos/shop",
  manifest: {
    name: "shop",
    verify: {
      modules: {
        "api/orders": { kind: "integration", cmd: "make contract" },
        "code/deps": { kind: "security", cmd: "make scan" },
        "code/strict": {
          kind: "security",
          cmd: "make scan",
          fail_on: "medium",
        },
      },
    },
  },
});

const planOf = (names: string[]) =>
  planVerify({
    project: "north",
    env: "local",
    scope: "all",
    chosen: names,
    modules: shop.modules,
    layers: shop.layers,
    changes: moduleChanges(
      shop.modules,
      {},
      {
        head: () => "c0ffee1",
        changedSince: () => [],
      },
    ),
  });

let runN = 0;
function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    stateDir,
    head: () => "c0ffee1",
    runCmd: async () => ({ exitCode: 0 }),
    probe: async () => 200,
    runId: () => `run-${++runN}`,
    ...over,
  };
}

describe("verify.run.retries: a failed module runs again", () => {
  it("a pass on the retry passes, and both attempts are kept", async () => {
    let calls = 0;
    const r = await runPlan(
      planOf(["api/orders"]),
      deps({
        retries: 1,
        runCmd: async () => ({ exitCode: ++calls === 1 ? 1 : 0 }),
      }),
    );
    expect(r.verdict).toBe("passed");
    expect(r.modules[0]).toMatchObject({
      state: "passed",
      attempts: ["failed", "passed"],
    });
  });

  it("with no retries (the default) a failure is final, run once", async () => {
    let calls = 0;
    const r = await runPlan(
      planOf(["api/orders"]),
      deps({
        runCmd: async () => {
          calls++;
          return { exitCode: 1 };
        },
      }),
    );
    expect([r.verdict, calls, r.modules[0].attempts]).toEqual([
      "failed",
      1,
      undefined,
    ]);
  });
});

function rec(
  n: number,
  state: "passed" | "failed",
  attempts?: ("passed" | "failed")[],
  commit = `c${String(n).padStart(6, "0")}`,
): RunRecord {
  return {
    runId: `h-${String(n).padStart(3, "0")}`,
    project: "south",
    env: "local",
    scope: "all",
    verdict: state,
    exitCode: state === "passed" ? 0 : 1,
    startedAt: `2026-11-${String(n).padStart(2, "0")}T10:00:00Z`,
    endedAt: `2026-11-${String(n).padStart(2, "0")}T10:01:00Z`,
    commit,
    modules: [
      {
        id: "shop:api/orders",
        name: "api/orders",
        repo: "shop",
        layer: "api",
        kind: "integration",
        mark: "declared-read-only",
        state,
        ms: 10,
        ...(attempts ? { attempts } : {}),
      },
    ],
  };
}

describe("T11: the flaky mark", () => {
  const settings = { ...DEFAULT_VERIFY_SETTINGS };
  const passRetry = ["failed", "passed"] as ("passed" | "failed")[];

  it("2 passes after a retry in the last 10 runs show the mark", () => {
    const runs = [1, 2, 3, 4, 5].map((n) =>
      rec(n, "passed", n === 2 || n === 4 ? passRetry : undefined),
    );
    const h = moduleHistory(runs, "api/orders", "local", settings);
    expect(h.flaky).toEqual({ flaky: true, retried: 2, window: 10 });
  });

  it("1 doesn't", () => {
    const runs = [1, 2, 3].map((n) =>
      rec(n, "passed", n === 2 ? passRetry : undefined),
    );
    expect(
      moduleHistory(runs, "api/orders", "local", settings).flaky.flaky,
    ).toBe(false);
  });

  it("the window and the count come from settings", () => {
    // Retried passes in runs 1 and 2; then 10 clean runs push them out.
    const runs = Array.from({ length: 12 }, (_, i) =>
      rec(i + 1, "passed", i < 2 ? passRetry : undefined),
    );
    expect(
      moduleHistory(runs, "api/orders", "local", settings).flaky.flaky,
    ).toBe(false);
    expect(
      moduleHistory(runs, "api/orders", "local", {
        ...settings,
        flakyWindow: 12,
      }).flaky.flaky,
    ).toBe(true);
    expect(
      moduleHistory(runs, "api/orders", "local", {
        ...settings,
        flakyWindow: 12,
        flakyMinRetries: 3,
      }).flaky.flaky,
    ).toBe(false);
  });
});

describe("S5: a module's history", () => {
  it("the strip, oldest first, and the first failing range", () => {
    const runs = [
      rec(1, "passed"),
      rec(2, "passed"),
      rec(3, "failed"),
      rec(4, "failed"),
    ];
    const h = moduleHistory(runs, "api/orders", "local", {
      ...DEFAULT_VERIFY_SETTINGS,
      historyLimit: 3,
    });
    expect(h.runs.map((r) => [r.runId, r.state])).toEqual([
      ["h-002", "passed"],
      ["h-003", "failed"],
      ["h-004", "failed"],
    ]);
    expect(h.firstFailing).toEqual({
      lastGood: { runId: "h-002", commit: "c000002" },
      firstBad: { runId: "h-003", commit: "c000003" },
    });
  });

  it("no first failing range while the latest passes; none for another environment", () => {
    const runs = [rec(1, "failed"), rec(2, "passed")];
    expect(
      moduleHistory(runs, "api/orders", "local", DEFAULT_VERIFY_SETTINGS)
        .firstFailing,
    ).toBeNull();
    expect(
      moduleHistory(runs, "api/orders", "staging", DEFAULT_VERIFY_SETTINGS)
        .runs,
    ).toEqual([]);
  });
});

function sarif(results: unknown[], rules: unknown[] = []): string {
  return JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "scanner", rules } }, results }],
  });
}

describe("reading a scan's SARIF", () => {
  it("severity from security-severity (on the result or its rule), else the level", () => {
    const dir = fs.mkdtempSync(path.join(stateDir, "sarif-"));
    fs.writeFileSync(
      path.join(dir, "scan.sarif"),
      sarif(
        [
          {
            ruleId: "CVE-1",
            message: { text: "pkg a 1.0, fixed in 1.1" },
            properties: { "security-severity": "9.8" },
          },
          { ruleId: "R-2", message: { text: "b" } },
          { ruleId: "R-3", level: "warning", message: { text: "c" } },
          { ruleId: "R-4", level: "note", message: { text: "d" } },
          { ruleId: "R-5", level: "none", message: { text: "e" } },
        ],
        [{ id: "R-2", properties: { "security-severity": "7.5" } }],
      ),
    );
    const f = readSarifFindings(dir);
    expect(f?.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 1 });
    expect(f?.findings.map((x) => [x.rule, x.severity])).toEqual([
      ["CVE-1", "critical"],
      ["R-2", "high"],
      ["R-3", "medium"],
      ["R-4", "low"],
    ]);
  });

  it("no SARIF written: null (the exit code decides)", () => {
    const dir = fs.mkdtempSync(path.join(stateDir, "none-"));
    expect(readSarifFindings(dir)).toBeNull();
  });
});

describe("T13: a scan against the threshold", () => {
  const counts = (o: Partial<Record<string, number>>) => ({
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    ...o,
  });

  it("findings below the threshold pass; one at it fails", () => {
    expect(scanVerdict(counts({ medium: 4, low: 9 }), "high").state).toBe(
      "passed",
    );
    expect(scanVerdict(counts({ high: 1 }), "high")).toEqual({
      state: "failed",
      atOrAbove: 1,
    });
    expect(scanVerdict(counts({ critical: 1 }), "high").state).toBe("failed");
  });

  it("in a run: the scan's SARIF decides, not its exit code, at the setting's threshold", async () => {
    const write =
      (results: unknown[], exitCode: number): RunDeps["runCmd"] =>
      async (_m, ctx) => {
        fs.writeFileSync(
          path.join(ctx.resultsDir, "out.sarif"),
          sarif(results),
        );
        return { exitCode };
      };
    const medium = [
      { ruleId: "R-1", level: "warning", message: { text: "x" } },
    ];
    const below = await runPlan(
      planOf(["code/deps"]),
      deps({ runCmd: write(medium, 1) }),
    );
    expect(below.modules[0]).toMatchObject({
      state: "passed",
      findings: { counts: { medium: 1 }, failOn: "high" },
    });
    const high = [{ ruleId: "R-9", level: "error", message: { text: "y" } }];
    const at = await runPlan(
      planOf(["code/deps"]),
      deps({ runCmd: write(high, 0) }),
    );
    expect(at.modules[0]).toMatchObject({
      state: "failed",
      findings: { counts: { high: 1 }, failOn: "high" },
    });
    expect(at.modules[0].message).toMatch(/R-9/);
    // The org's threshold, from settings: medium fails at medium.
    const strict = await runPlan(
      planOf(["code/deps"]),
      deps({ runCmd: write(medium, 0), failOn: "medium" }),
    );
    expect(strict.modules[0].state).toBe("failed");
  });

  it("a module's fail_on may only tighten the org's threshold", async () => {
    const medium = [
      { ruleId: "R-1", level: "warning", message: { text: "x" } },
    ];
    const r = await runPlan(
      planOf(["code/strict"]),
      deps({
        runCmd: async (_m, ctx) => {
          fs.writeFileSync(path.join(ctx.resultsDir, "o.sarif"), sarif(medium));
          return { exitCode: 0 };
        },
      }),
    );
    expect(r.modules[0]).toMatchObject({
      state: "failed",
      findings: { failOn: "medium" },
    });
  });
});
