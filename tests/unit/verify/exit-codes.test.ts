/**
 * Issue 207 (VERIFY-SPEC sections 4 and 5): one exit-code table for every
 * kind, the CLI and MCP. 0 passed, 1 failed (error and blocked too), 3
 * nothing ran, 4 cancelled. Nothing ran and cancelled are never a pass.
 *
 * T5: an all-skipped run of any kind exits 3 and is never a success.
 * T6: a cancelled run says "Cancelled", never a pass, and exits 4.
 * T12: each of the seven old kinds still runs, warns with its new
 *      `<layer>/<name>` form, and maps its own codes to the table.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";

import * as outcome from "../../../src/shared/run-outcome.js";
import { getRunDonePayload } from "../../../src/ui/server/perf-report.js";
import { TestRunner } from "../../../src/ui/cli/test-runner.js";
import { callTool } from "../../../src/ui/mcp/tools.js";
import type { Pillar } from "../../../src/shared/types/index.js";

const SEVEN: Pillar[] = [
  "smoke",
  "synthetic",
  "integration",
  "performance",
  "journeys",
  "security",
  "suites",
];

const quiet = () => {
  const out: string[] = [];
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
  return out;
};

/** A TestRunner whose kind's own process ended with `exitCode`. */
function runnerEnding(exitCode: number): TestRunner {
  const runner = new TestRunner();
  jest
    .spyOn(
      runner as unknown as { executeTestCommand: () => Promise<unknown> },
      "executeTestCommand",
    )
    .mockResolvedValue({ success: exitCode === 0, exitCode });
  return runner;
}

/** MCP run_tests over a stream that ended with these events. */
async function mcpRun(pillar: string, events: object[], exitCode: number) {
  const api = {
    baseUrl: "http://den.test",
    get: async () => ({ ok: true, units: [], refused: [] }),
    stream: async () => ({
      events,
      lines: [],
      ended: "done" as const,
      exitCode,
    }),
  };
  return callTool("run_tests", { pillar, env: "local" }, {
    api,
    cfg: {
      actions: ["run_tests"],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: false,
    },
    cli: "acme",
  } as never);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the one table", () => {
  it("0 passed, 1 failed, 3 nothing ran, 4 cancelled", () => {
    const o = outcome as unknown as Record<string, unknown>;
    expect(o.VERDICT_EXIT).toEqual({
      passed: 0,
      failed: 1,
      "nothing ran": 3,
      cancelled: 4,
    });
  });
});

describe("T5: an all-skipped run exits 3 and is never a success", () => {
  // The kinds whose own process says "nothing ran" with 3 today.
  for (const kind of ["suites", "journeys", "security"] as Pillar[]) {
    it(`${kind}: nothingRan() is true, the done event says so`, () => {
      expect(outcome.nothingRan(kind, 3)).toBe(true);
      const d = getRunDonePayload({ pillar: kind, exitCode: 3, duration: 1 });
      expect(d).toMatchObject({ nothingRan: true, exitCode: 3 });
      expect(d.exitCode).not.toBe(0);
    });
  }

  it("journeys in the CLI: exits 3, prints nothing ran, never success", async () => {
    const out = quiet();
    const r = await runnerEnding(3).runTests({
      pillar: "journeys",
      environment: "local",
    });
    expect(r).toMatchObject({ success: false, nothingRan: true, exitCode: 3 });
    const text = out.join("\n");
    expect(text).toMatch(/Nothing ran/);
    expect(text).not.toMatch(/completed successfully|✅/);
  });

  it("security over MCP: the verdict is nothing ran, an error", async () => {
    const r = await mcpRun(
      "security",
      [{ type: "done", exitCode: 3, nothingRan: true }],
      3,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"outcome": "nothing ran"/);
    expect(r.text).toMatch(/"exitCode": 3/);
  });
});

describe("T6: a cancelled run says Cancelled, never a pass, and exits 4", () => {
  it("a run stopped by a signal is cancelled in the done event", () => {
    for (const exitCode of [130, 143]) {
      const d = getRunDonePayload({
        pillar: "smoke",
        exitCode,
        duration: 1,
      }) as Record<string, unknown>;
      expect(d).toMatchObject({ exitCode: 4, cancelled: true });
      expect(d).not.toHaveProperty("nothingRan");
    }
  });

  it("the CLI prints Cancelled and exits 4, never success", async () => {
    const out = quiet();
    const r = await runnerEnding(130).runTests({
      pillar: "synthetic",
      environment: "local",
    });
    expect(r).toMatchObject({ success: false, exitCode: 4 });
    expect((r as unknown as { cancelled?: boolean }).cancelled).toBe(true);
    const text = out.join("\n");
    expect(text).toMatch(/Cancelled/);
    expect(text).not.toMatch(/completed successfully|✅|Tests failed/);
  });

  it("MCP says cancelled, an error, exit code 4", async () => {
    const r = await mcpRun(
      "smoke",
      [{ type: "done", exitCode: 4, cancelled: true }],
      4,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"outcome": "cancelled"/);
    expect(r.text).toMatch(/"exitCode": 4/);
    expect(r.text).not.toMatch(/"outcome": "passed"/);
  });
});

describe("T12: the seven old kinds keep working and map to the table", () => {
  // [kind, its own process code, the table's code]
  const MAP: [Pillar, number, number][] = [
    ["smoke", 0, 0],
    ["smoke", 1, 1],
    ["synthetic", 1, 1],
    ["integration", 0, 0],
    ["integration", 1, 1],
    ["performance", 0, 0],
    ["performance", 99, 1], // k6: a threshold failed
    ["performance", 105, 4], // k6: stopped from outside
    ["journeys", 0, 0],
    ["journeys", 1, 1], // infrastructure: error counts as failed
    ["journeys", 2, 1], // a journey failed
    ["journeys", 3, 3], // no specs
    ["security", 0, 0],
    ["security", 1, 1],
    ["security", 2, 1], // a High finding
    ["security", 3, 3], // nothing scanned
    ["suites", 0, 0],
    ["suites", 1, 1],
    ["suites", 3, 3],
  ];
  for (const [kind, raw, want] of MAP) {
    it(`${kind} exit ${raw} → ${want}`, () => {
      const d = getRunDonePayload({
        pillar: kind,
        exitCode: raw,
        duration: 1,
      });
      expect(d.exitCode).toBe(want);
    });
  }

  for (const kind of SEVEN) {
    it(`${kind} still runs, warns with its new form, and maps its exit`, async () => {
      const out = quiet();
      const r = await runnerEnding(2).runTests({
        pillar: kind,
        environment: "local",
      });
      expect(r.exitCode).toBe(1);
      expect(r.success).toBe(false);
      const text = out.join("\n");
      expect(text).toMatch(new RegExp(`test kind "${kind}" is retiring`));
      expect(text).toMatch(
        kind === "suites"
          ? /new form is a repo check/
          : /new form is <layer>\//,
      );
    });
  }
});
