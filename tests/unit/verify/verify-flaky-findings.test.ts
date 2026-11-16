/**
 * Issue 212: history with the flaky mark (S5, T11), and security findings
 * with the threshold (S6, T13). VERIFY-SPEC section 5 and the settings
 * table (section 6):
 *
 *   verify.run.retries (0)        a module that passes after a retry is
 *                                 "passed, marked flaky"; every attempt kept
 *   verify.flaky.window (10),     the flaky mark: passed after a retry in
 *   verify.flaky.min_retries (2)  min_retries or more of the last window runs
 *   verify.history.limit (30)     how many runs the history shows
 *   verify.security.fail_on (high) a finding at or above it fails the scan;
 *                                 a module's fail_on may tighten it
 *
 * Findings come from SARIF a scan writes to DEN_RESULTS_DIR. Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readVerifyModules } from "../../../src/shared/verify/config.js";
import { readFindings } from "../../../src/shared/verify/findings.js";
import { moduleHistory } from "../../../src/shared/verify/history.js";
import { planVerify } from "../../../src/shared/verify/plan.js";
import type {
  EndedRunRecord,
  ModuleRecord,
} from "../../../src/shared/verify/records.js";
import { runPlan, type RunDeps } from "../../../src/shared/verify/run.js";
import {
  readVerifySettings,
  VERIFY_SETTINGS_DEFAULTS,
} from "../../../src/shared/verify/settings.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-212-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("issue 212: the settings, with permissive defaults", () => {
  it("defaults when unset", () => {
    expect(readVerifySettings(undefined)).toEqual({
      retries: 0,
      flakyWindow: 10,
      flakyMinRetries: 2,
      historyLimit: 30,
      failOn: "high",
    });
    expect(VERIFY_SETTINGS_DEFAULTS.failOn).toBe("high");
  });

  it("reads each one from verify:", () => {
    expect(
      readVerifySettings({
        run: { retries: 2 },
        flaky: { window: 20, min_retries: 3 },
        history: { limit: 50 },
        security: { fail_on: "medium" },
      }),
    ).toEqual({
      retries: 2,
      flakyWindow: 20,
      flakyMinRetries: 3,
      historyLimit: 50,
      failOn: "medium",
    });
  });

  it("refuses a value that would quietly change what passes", () => {
    expect(() => readVerifySettings({ run: { retries: -1 } })).toThrow(
      /verify\.run\.retries/,
    );
    expect(() => readVerifySettings({ flaky: { window: 0 } })).toThrow(
      /verify\.flaky\.window/,
    );
    expect(() =>
      readVerifySettings({ security: { fail_on: "severe" } }),
    ).toThrow(/verify\.security\.fail_on/);
  });
});

/** A SARIF log with one result per severity given (CVSS-style scores). */
function sarif(sevs: string[]) {
  const score: Record<string, string> = {
    critical: "9.8",
    high: "7.5",
    medium: "5.3",
    low: "2.1",
  };
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "audit",
            rules: sevs.map((s, i) => ({
              id: `R${i}`,
              properties: { "security-severity": score[s] },
            })),
          },
        },
        results: sevs.map((s, i) => ({
          ruleId: `R${i}`,
          ruleIndex: i,
          level: "warning",
          message: { text: `pkg-${i} has a ${s} hole` },
          properties: {
            package: `pkg-${i}`,
            version: "1.0.0",
            fixedIn: "1.0.1",
          },
        })),
      },
    ],
  };
}

describe("issue 212: findings from SARIF", () => {
  it("counts by severity, from security-severity or else the level", () => {
    const dir = fs.mkdtempSync(path.join(stateDir, "sarif-"));
    fs.writeFileSync(
      path.join(dir, "deps.sarif"),
      JSON.stringify(sarif(["medium", "medium", "low"])),
    );
    const plain = sarif([]);
    plain.runs[0].results = [
      { ruleId: "X", level: "error", message: { text: "no score" } },
    ] as never;
    fs.writeFileSync(path.join(dir, "more.sarif.json"), JSON.stringify(plain));
    const f = readFindings(dir)!;
    expect(f.counts).toEqual({ critical: 0, high: 1, medium: 2, low: 1 });
    expect(f.list[0]).toMatchObject({
      severity: "high",
      message: "no score",
    });
    expect(f.list.find((x) => x.package === "pkg-0")).toMatchObject({
      severity: "medium",
      version: "1.0.0",
      fixedIn: "1.0.1",
    });
    expect(f.report).toBe("deps.sarif");
  });

  it("no SARIF written: none", () => {
    expect(
      readFindings(fs.mkdtempSync(path.join(stateDir, "none-"))),
    ).toBeNull();
  });
});

const shop = readVerifyModules({
  repo: "shop",
  repoPath: "/repos/shop",
  manifest: {
    name: "shop",
    verify: {
      modules: {
        "code/deps": { kind: "security", cmd: "make audit" },
        "code/strict": {
          kind: "security",
          cmd: "make audit",
          fail_on: "medium",
        },
        "api/orders": { kind: "integration", cmd: "make contract" },
      },
    },
  },
});

const planOf = (names: string[]) =>
  planVerify({
    project: "north",
    env: "local",
    scope: "all",
    modules: shop.modules.filter((m) => names.includes(m.name)),
    layers: shop.layers,
    changes: {},
  });

let n = 0;
function deps(over: Partial<RunDeps>): RunDeps {
  n++;
  return {
    stateDir,
    head: () => "c0ffee1",
    runCmd: async () => ({ exitCode: 0 }),
    probe: async () => 200,
    runId: () => `run-${n}`,
    now: () => new Date("2026-11-15T12:00:00Z"),
    ...over,
  };
}

/** A scan that writes these findings and exits 1 when it found any. */
const scan =
  (sevs: string[]): RunDeps["runCmd"] =>
  async (_m, ctx) => {
    fs.writeFileSync(
      path.join(ctx.resultsDir, "out.sarif"),
      JSON.stringify(sarif(sevs)),
    );
    return { exitCode: sevs.length ? 1 : 0 };
  };

describe("T13: a scan fails at its threshold, never below it", () => {
  it("below the threshold passes, though the scanner exited 1", async () => {
    const r = await runPlan(
      planOf(["code/deps"]),
      deps({ runCmd: scan(["medium", "medium", "low"]) }),
    );
    expect(r.modules[0].state).toBe("passed");
    expect(r.modules[0].findings).toMatchObject({
      counts: { critical: 0, high: 0, medium: 2, low: 1 },
      failOn: "high",
    });
    expect(r.verdict).toBe("passed");
  });

  it("at the threshold fails, naming the first finding at or above it", async () => {
    const r = await runPlan(
      planOf(["code/deps"]),
      deps({ runCmd: scan(["low", "high"]) }),
    );
    expect(r.modules[0].state).toBe("failed");
    expect(r.modules[0].message).toBe("pkg-1 has a high hole");
    expect(r.exitCode).toBe(1);
  });

  it("the threshold comes from settings, and a module's fail_on tightens it", async () => {
    const loose = await runPlan(
      planOf(["code/deps"]),
      deps({ runCmd: scan(["high"]), failOn: "critical" }),
    );
    expect(loose.modules[0].state).toBe("passed");
    const strict = await runPlan(
      planOf(["code/strict"]),
      deps({ runCmd: scan(["medium"]), failOn: "critical" }),
    );
    expect(strict.modules[0].state).toBe("failed");
    expect(strict.modules[0].findings?.failOn).toBe("medium");
  });
});

describe("retries: passed after a retry is passed, marked flaky", () => {
  const flaky = (): RunDeps["runCmd"] => {
    let tries = 0;
    return async () => ({
      exitCode: ++tries === 1 ? 1 : 0,
      lines: [tries === 1 ? "timed out waiting for the pay button" : "ok"],
    });
  };

  it("with verify.run.retries 1: passed, flaky, both attempts kept", async () => {
    const r = await runPlan(
      planOf(["api/orders"]),
      deps({ runCmd: flaky(), retries: 1 }),
    );
    expect(r.modules[0]).toMatchObject({ state: "passed", flaky: true });
    expect(r.modules[0].attempts?.map((a) => a.state)).toEqual([
      "failed",
      "passed",
    ]);
    expect(r.modules[0].attempts?.[0].message).toBe(
      "timed out waiting for the pay button",
    );
  });

  it("with none (the default): the first failure stands", async () => {
    const r = await runPlan(planOf(["api/orders"]), deps({ runCmd: flaky() }));
    expect(r.modules[0].state).toBe("failed");
    expect(r.modules[0].flaky).toBeUndefined();
    expect(r.modules[0].attempts).toBeUndefined();
  });
});

/** Ended runs of api/orders on local, oldest first in `states`. */
function runs(states: string[]): EndedRunRecord[] {
  return states
    .map((s, i): EndedRunRecord => {
      const mod: ModuleRecord = {
        id: "shop:api/orders",
        name: "api/orders",
        repo: "shop",
        layer: "api",
        kind: "integration",
        mark: "declared-read-only",
        state: s === "r" ? "passed" : s === "f" ? "failed" : "passed",
        ms: 100,
        ...(s === "r" ? { flaky: true } : {}),
      };
      return {
        runId: `h${i}`,
        project: "north",
        env: "local",
        scope: "all",
        verdict: mod.state === "passed" ? "passed" : "failed",
        exitCode: mod.state === "passed" ? 0 : 1,
        startedAt: `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
        endedAt: `2026-11-${String(i + 1).padStart(2, "0")}T10:05:00Z`,
        commit: `c${i}`,
        modules: [mod],
      };
    })
    .reverse(); // newest first, as listRunRecords gives them
}

describe("T11: the flaky mark", () => {
  const s = VERIFY_SETTINGS_DEFAULTS;
  it("2 passes after a retry in the last 10 runs show the mark", () => {
    const h = moduleHistory(
      runs([..."ppprppprpp"]),
      "shop:api/orders",
      "local",
      s,
    );
    expect(h.flaky).toEqual({ mark: true, count: 2, window: 10, min: 2 });
    expect(h.runs.map((r) => r.state)).toEqual(
      [..."ppppppppppp"].slice(0, 10).map(() => "passed"),
    );
    expect(h.runs.filter((r) => r.flaky)).toHaveLength(2);
  });

  it("1 doesn't", () => {
    const h = moduleHistory(
      runs([..."ppprpppppp"]),
      "shop:api/orders",
      "local",
      s,
    );
    expect(h.flaky.mark).toBe(false);
    expect(h.flaky.count).toBe(1);
  });

  it("the numbers come from settings", () => {
    const one = { ...s, flakyMinRetries: 1 };
    expect(
      moduleHistory(runs([..."ppprpppppp"]), "shop:api/orders", "local", one)
        .flaky.mark,
    ).toBe(true);
    // A window of 5 leaves out the older retry.
    const w5 = { ...s, flakyWindow: 5 };
    expect(
      moduleHistory(runs([..."prprpppppp"]), "shop:api/orders", "local", w5)
        .flaky,
    ).toMatchObject({ mark: false, count: 0, window: 5 });
  });
});

describe("issue 212: S5 history", () => {
  it("oldest first, at most verify.history.limit runs, and the first failing range", () => {
    const h = moduleHistory(
      runs([..."ppppppppff"]),
      "shop:api/orders",
      "local",
      { ...VERIFY_SETTINGS_DEFAULTS, historyLimit: 6 },
    );
    expect(h.runs.map((r) => r.runId)).toEqual([
      "h4",
      "h5",
      "h6",
      "h7",
      "h8",
      "h9",
    ]);
    expect(h.range).toEqual({
      lastPassed: { runId: "h7", commit: "c7" },
      firstFailed: { runId: "h8", commit: "c8" },
    });
    expect(h.streak).toEqual({ state: "failed", runs: 2, passedBefore: 8 });
  });

  it("passing now: no failing range; never run: no runs", () => {
    expect(
      moduleHistory(
        runs([..."fpp"]),
        "shop:api/orders",
        "local",
        VERIFY_SETTINGS_DEFAULTS,
      ).range,
    ).toBeUndefined();
    expect(
      moduleHistory([], "shop:api/orders", "local", VERIFY_SETTINGS_DEFAULTS)
        .runs,
    ).toEqual([]);
  });
});
