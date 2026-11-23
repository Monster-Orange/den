/**
 * Issue 212 (Verify 6), the page: S5 a module's history and S6 a scan's
 * findings (public/verify-page.js), pure HTML from the routes' JSON, in
 * en's words. Matches the approved mock, direction C frames 5 and 6.
 *
 *   S5  since when it fails, a strip of runs oldest first with symbols as
 *       well as colour (✓ ✕ ↻), each opening its run's report; the first
 *       failing range with the commits in between; the flaky mark with
 *       "See the attempts"; an imported run is named by its tag
 *   S6  one answer sentence, the threshold, counts at each severity,
 *       findings under their severity with the version that fixes them,
 *       "Open report (SARIF)" as the only place SARIF shows, and a line
 *       saying findings below the threshold never fail the check
 *   The ways in: why (S4) and All checks link to a module's history; a
 *   history whose run kept findings links to them
 */
import { describe, expect, it } from "@jest/globals";
import {
  allChecks,
  findingsView,
  historyView,
  whyView,
} from "../../../src/ui/server/public/verify-page.js";
import { installEnShell } from "./helpers/en-catalog.js";

installEnShell();

const run = (
  n: number,
  state: string,
  extra: Record<string, unknown> = {},
) => ({
  runId: `r-${n}`,
  commit: `c${n}${n}${n}${n}${n}${n}${n}`,
  state,
  endedAt: `2026-11-${String(10 + n).padStart(2, "0")}T10:00:00Z`,
  ...extra,
});

const failing = {
  ok: true,
  project: "north",
  module: "shop:api/orders",
  name: "api/orders",
  env: "staging",
  runs: [
    run(1, "passed"),
    run(2, "passed"),
    run(3, "passed"),
    run(4, "failed"),
    run(5, "failed"),
  ],
  firstFailing: {
    lastGood: { runId: "r-3", commit: "c333333" },
    firstBad: { runId: "r-4", commit: "c444444" },
  },
  commits: [
    { commit: "b7c8d9e", subject: "orders: add discount codes" },
    { commit: "c444444", subject: "api: update database driver" },
  ],
  flaky: { flaky: false, retried: 0, window: 10, minRetries: 2 },
};

const flaky = {
  ok: true,
  project: "north",
  module: "shop:web/checkout",
  name: "web/checkout",
  env: "local",
  runs: [
    run(1, "passed"),
    run(2, "passed", { attempts: ["failed", "passed"], retried: true }),
    run(3, "passed"),
    run(4, "passed", { attempts: ["failed", "passed"], retried: true }),
  ],
  firstFailing: null,
  commits: [],
  flaky: { flaky: true, retried: 2, window: 10, minRetries: 2 },
};

describe("S5: a module's history", () => {
  it("since when it fails, the strip oldest first, and the first failing range with its commits", () => {
    const html = historyView(failing);
    expect(html).toContain("History: api/orders on Staging");
    expect(html).toContain(
      "api/orders passed 3 runs in a row, then failed. It first failed at c444444, within 2 commits after c333333.",
    );
    const marks = [
      ...html.matchAll(/data-vf-run="(r-\d)"[^>]*>.*?aria-hidden="true">(.)</g),
    ];
    expect(marks.map((m) => [m[1], m[2]])).toEqual([
      ["r-1", "✓"],
      ["r-2", "✓"],
      ["r-3", "✓"],
      ["r-4", "✕"],
      ["r-5", "✕"],
    ]);
    expect(html).toContain("Last 5 runs on Staging, oldest first.");
    expect(html).toContain("First failing range");
    expect(html).toContain("<code>c333333</code> … <code>c444444</code>");
    expect(html).toContain("orders: add discount codes");
    expect(html).toContain("Open the first failing run");
    // Each run opens its own report, in a new tab.
    expect(html).toMatch(
      /href="\/api\/verify\/runs\/r-4\/report\?project=north&amp;module=shop%3Aapi%2Forders"[^>]*target="_blank"/,
    );
  });

  it("flaky: the mark, its sentence from settings, ↻ in the strip, and See the attempts", () => {
    const html = historyView(flaky);
    expect(html).toContain("Flaky: web/checkout on Local");
    expect(html).toContain(
      "2 of the last 10 runs passed only after a retry. Every attempt is kept.",
    );
    expect(html.match(/aria-hidden="true">↻</g)).toHaveLength(2 + 1);
    expect(html).toContain("See the attempts");
    expect(html).toContain("Attempt 1: failed");
    expect(html).toContain("Attempt 2: passed");
    expect(html).not.toContain("First failing range");
  });

  it("an imported run is named by its tag; no runs yet says so", () => {
    const html = historyView({
      ...failing,
      runs: [
        run(1, "passed", { tag: "v0.4.85-dev.3", runId: "v0.4.85-dev.3" }),
      ],
      firstFailing: null,
    });
    expect(html).toContain("v0.4.85-dev.3");
    expect(historyView({ ...failing, runs: [], firstFailing: null })).toContain(
      "No runs here yet.",
    );
  });

  it("a run whose scan kept findings links to them", () => {
    const html = historyView({
      ...failing,
      runs: [...failing.runs.slice(0, 4), run(5, "failed", { findings: true })],
    });
    expect(html).toContain(
      'href="?findings=r-5&amp;module=shop%3Aapi%2Forders"',
    );
  });
});

// The findings route's answer (GET /api/verify/runs/:id/modules/:m/findings).
const scan = (counts: Record<string, number>, failOn = "high") => ({
  ok: true,
  project: "north",
  runId: "r-9",
  module: "code/deps",
  moduleId: "shop:code/deps",
  state: "passed",
  commit: "e4f5a6b",
  failOn,
  counts,
  findings: [
    {
      rule: "CVE-1",
      severity: "medium",
      message: "loops",
      package: "yaml-lite",
      version: "0.9.3",
      fixedIn: "0.9.5",
    },
    {
      rule: "CVE-2",
      severity: "medium",
      message: "big image",
      package: "image-resize",
      version: "2.1.0",
      fixedIn: "2.2.1",
    },
    { rule: "R-3", severity: "low", message: "a note" },
  ],
  sarif: true,
});

describe("S6: a scan's findings against the threshold", () => {
  it("below the threshold: safe to ship, the threshold line, counts, and the fixing versions", () => {
    const html = findingsView(
      scan({ critical: 0, high: 0, medium: 2, low: 5 }),
    );
    expect(html).toContain("Security findings: code/deps");
    expect(html).toContain(
      "code/deps is safe to ship: no findings at high or worse. The limit is high.",
    );
    expect(html).toContain("Fails at high or worse");
    expect(html).toContain("2 medium findings. They do not fail the check.");
    expect(html).toContain(
      "<code>yaml-lite 0.9.3</code> · Fixed in <code>0.9.5</code>",
    );
    expect(html).toContain("5 low findings");
    expect(html).toContain("Scanned commit e4f5a6b.");
    // The threshold sits between high and medium, as the mock shows.
    expect(html.indexOf("Fails at high or worse")).toBeGreaterThan(
      html.indexOf(">high<"),
    );
    expect(html.indexOf("Fails at high or worse")).toBeLessThan(
      html.indexOf(">medium<"),
    );
    // "SARIF" shows once: the report link.
    expect(html.match(/SARIF/g)).toHaveLength(1);
    expect(html).toContain("Open report (SARIF)");
    expect(html).toContain(
      'href="/api/verify/runs/r-9/report?project=north&amp;module=shop%3Acode%2Fdeps&amp;kind=sarif"',
    );
  });

  it("at the threshold: not safe, and it names how many", () => {
    const html = findingsView({
      ...scan({ critical: 0, high: 1, medium: 0, low: 0 }),
    });
    expect(html).toContain(
      "code/deps is not safe to ship: 1 finding at high or worse.",
    );
  });

  it("a threshold from settings moves the line", () => {
    const html = findingsView(
      scan({ critical: 0, high: 0, medium: 2, low: 0 }, "medium"),
    );
    expect(html).toContain("Fails at medium or worse");
    expect(html).toContain("not safe to ship: 2 findings at medium or worse.");
  });
});

const ov = {
  ok: true,
  project: "north",
  modules: 2,
  envOrder: ["local", "staging"],
  envs: [
    {
      env: "staging",
      answer: "failed",
      counts: {
        passed: 1,
        failed: 1,
        error: 0,
        blocked: 0,
        notrun: 0,
        total: 2,
      },
      failures: [
        {
          module: "api/orders",
          state: "failed",
          message: "500",
          runId: "r-5",
          report: true,
        },
      ],
      blocked: [],
    },
  ],
  checks: [
    {
      module: "api/orders",
      layer: "api",
      kind: "integration",
      dependsOn: [],
      states: { local: "passed", staging: "failed" },
    },
  ],
  activity: [],
};

describe("the ways into a module's history", () => {
  it("why (S4) offers History beside each failure's report", () => {
    expect(whyView(ov, "staging")).toContain(
      'href="?history=api%2Forders&amp;env=staging"',
    );
  });

  it("All checks: each environment's state opens that module's history there", () => {
    const html = allChecks(ov, true);
    expect(html).toContain('href="?history=api%2Forders&amp;env=local"');
    expect(html).toContain('href="?history=api%2Forders&amp;env=staging"');
  });
});
