/**
 * Issue 212: the Verify page's history (S5) and security findings (S6)
 * views, pure HTML from the routes' JSON, in en's words.
 *
 *   S5  the answer ("since when?"), a strip of runs oldest first, each a
 *       button with a symbol (✓ ✕ ↻), the first failing range with its
 *       commits and Open the first failing run; flaky: the mark and every
 *       attempt
 *   S6  the answer and the threshold, counts by severity, findings under
 *       their severity with the version that fixes them; below the
 *       threshold never fails, and says so; "Open report (SARIF)"
 */
import { describe, expect, it } from "@jest/globals";
import {
  boardView,
  findingsView,
  historyView,
} from "../../../src/ui/server/public/verify-page.js";
import { installEnShell } from "./helpers/en-catalog.js";

installEnShell();

const run = (i: number, state: string, over: Record<string, unknown> = {}) => ({
  runId: `r${i}`,
  endedAt: `2026-11-1${i}T10:05:00Z`,
  commit: `c${i}aaaa`,
  state,
  ms: 100,
  ...over,
});

const failing = {
  ok: true,
  project: "north",
  module: "shop:api/orders",
  name: "api/orders",
  kind: "integration",
  env: "staging",
  runs: [
    run(1, "passed"),
    run(2, "passed"),
    run(3, "passed"),
    run(4, "failed", { message: "POST /orders returned 500" }),
  ],
  flaky: { mark: false, count: 0, window: 10, min: 2 },
  streak: { state: "failed", runs: 1, passedBefore: 3 },
  range: {
    lastPassed: { runId: "r3", commit: "a1b2c3d" },
    firstFailed: { runId: "r4", commit: "e4f5a6b" },
  },
  commits: [
    { commit: "b7c8d9e", subject: "orders: add discount codes" },
    { commit: "e4f5a6b", subject: "api: update database driver" },
  ],
};

describe("issue 212: S5 history", () => {
  it("says since when, with the range, its commits and the first failing run", () => {
    const html = historyView(failing);
    expect(html).toMatch(
      /<h2 tabindex="-1">History: api\/orders on Staging<\/h2>/,
    );
    expect(html).toContain(
      "api/orders passed 3 runs in a row, then failed. It first failed at e4f5a6b.",
    );
    expect(html).toContain("That is within 2 commits after a1b2c3d.");
    expect(html).toContain("<code>a1b2c3d</code> … <code>e4f5a6b</code>");
    expect(html).toContain("orders: add discount codes");
    expect(html).toContain('href="?run=r4"');
    expect(html).toContain("Open the first failing run");
  });

  it("the strip: oldest first, each run a button with a symbol and a name", () => {
    const html = historyView(failing);
    expect(html).toContain(
      'aria-label="Last 4 runs on Staging, oldest first."',
    );
    const order = [...html.matchAll(/data-vf-run="(r\d)"/g)].map((m) => m[1]);
    expect(order).toEqual(["r1", "r2", "r3", "r4"]);
    expect(html).toMatch(/data-vf-run="r4"[^>]*aria-label="failed at c4aaaa/);
    expect(html).toMatch(
      /data-vf-run="r4"[^>]*>[^<]*<span aria-hidden="true">✕/,
    );
    expect(html).toContain("↻ passed after a retry");
  });

  it("T11 on the page: the flaky mark and every attempt, only when marked", () => {
    const flaky = {
      ...failing,
      runs: [
        run(1, "passed", {
          flaky: true,
          attempts: [
            {
              state: "failed",
              message: "timed out waiting for the pay button",
              ms: 10,
            },
            { state: "passed", ms: 10 },
          ],
        }),
        run(2, "passed", { flaky: true }),
        run(3, "passed"),
      ],
      flaky: { mark: true, count: 2, window: 10, min: 2 },
      streak: { state: "passed", runs: 3, passedBefore: 0 },
      range: undefined,
      commits: undefined,
    };
    const html = historyView(flaky);
    expect(html).toContain("flaky");
    expect(html).toContain(
      "2 of the last 10 runs passed only after a retry. Every attempt is kept.",
    );
    expect(html).toContain("See the attempts");
    expect(html).toContain("Attempt 1: failed");
    expect(html).toContain("timed out waiting for the pay button");
    expect(html).toMatch(
      /data-vf-run="r1"[^>]*>[^<]*<span aria-hidden="true">↻/,
    );
    expect(html).toContain("api/orders has passed the last 3 runs here.");
    const once = historyView({
      ...flaky,
      flaky: { ...flaky.flaky, mark: false, count: 1 },
    });
    expect(once).not.toContain("See the attempts");
  });

  it("no runs yet says so", () => {
    expect(
      historyView({
        ...failing,
        runs: [],
        streak: undefined,
        range: undefined,
      }),
    ).toContain("No runs here yet.");
  });
});

const scan = (findings: unknown, state = "passed") => ({
  ok: true,
  runId: "r-scan",
  project: "north",
  env: "local",
  verdict: state,
  commit: "e4f5a6b",
  endedAt: "2026-11-15T10:00:00Z",
  modules: [
    {
      id: "shop:code/deps",
      name: "code/deps",
      kind: "security",
      state,
      ms: 10,
      findings,
    },
  ],
});
const below = {
  counts: { critical: 0, high: 0, medium: 2, low: 5 },
  failOn: "high",
  report: "deps.sarif",
  list: [
    {
      severity: "medium",
      message: "x",
      package: "yaml-lite",
      version: "0.9.3",
      fixedIn: "0.9.5",
    },
    { severity: "medium", message: "image-resize can be tricked" },
  ],
};

describe("issue 212: S6 security findings", () => {
  it("T13 on the page: below the threshold passes, and says it doesn't fail", () => {
    const html = findingsView(scan(below), "shop:code/deps");
    expect(html).toMatch(
      /<h2 tabindex="-1">Security findings: code\/deps<\/h2>/,
    );
    expect(html).toContain("Nothing at high or worse, so this scan passes.");
    expect(html).toContain("Fails at high or worse");
    expect(html).toContain("Scanned commit e4f5a6b.");
    expect(html).toContain("2 medium findings");
    expect(html).toContain("They do not fail the check.");
    expect(html).toContain("<code>yaml-lite 0.9.3</code>");
    expect(html).toContain("Fixed in <code>0.9.5</code>");
    expect(html).toContain("image-resize can be tricked");
    expect(html).toContain(
      'href="/api/verify/runs/r-scan/report?project=north&amp;module=shop%3Acode%2Fdeps&amp;kind=sarif"',
    );
    expect(html).toContain("Open report (SARIF)");
    expect(html).not.toMatch(/vf-badge vf-bad/);
  });

  it("at the threshold fails, says how many, and never says they don't count", () => {
    const at = {
      ...below,
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      list: [{ severity: "high", message: "pkg has a hole", package: "pkg" }],
    };
    const html = findingsView(scan(at, "failed"), "shop:code/deps");
    expect(html).toContain("1 findings at high or worse, so this scan fails.");
    expect(html).toMatch(/vf-badge vf-bad/);
    expect(html).not.toContain("They do not fail the check.");
  });

  it("a run that kept no findings says so", () => {
    expect(findingsView(scan(undefined), "shop:code/deps")).toContain(
      "This run kept no findings for code/deps.",
    );
  });
});

describe("issue 212: the board's panel leads to both", () => {
  it("History for each check, Findings for a scan with a run", () => {
    const ov = {
      ok: true,
      project: "north",
      modules: 2,
      envOrder: ["local"],
      activity: [],
      envs: [
        {
          env: "local",
          answer: "ready",
          counts: {},
          failures: [],
          blocked: [],
        },
      ],
      checks: [
        {
          id: "shop:code/deps",
          module: "code/deps",
          layer: "code",
          kind: "security",
          mark: "reads-code-only",
          dependsOn: [],
          states: { local: "passed" },
          recent: { local: ["passed"] },
          from: { local: { commit: "e4f5a6b", runId: "r-scan" } },
        },
      ],
    };
    const html = boardView(ov, { open: { env: "local", layer: "code" } });
    expect(html).toContain('href="?history=shop%3Acode%2Fdeps&amp;env=local"');
    expect(html).toContain(
      'href="?findings=r-scan&amp;module=shop%3Acode%2Fdeps"',
    );
  });
});
