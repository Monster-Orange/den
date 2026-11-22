/**
 * Testing policy 1 (Vision 11-22): GitHub's Team plan runs 60 jobs at once
 * across the org, and Den's pull requests filled all of them.
 *
 * - A draft pull request runs static checks and unit tests only: no browser
 *   specs (DEN_TEST_BROWSER=skip), no Playwright install, no den-ui-nav. A
 *   run that must be the whole suite (the merge queue, a version change)
 *   still runs everything, draft or not.
 * - Marking a draft ready for review starts a full run (ready_for_review).
 * - One pull request's shards take at most 4 runners at once. A run that
 *   must be the whole suite is not capped: release runs never wait on it.
 * - A run without the browser specs never counts as the whole suite for
 *   the release (tested.json's selection stays "affected").
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  env?: Record<string, string>;
  strategy?: { "max-parallel"?: string | number };
  outputs?: Record<string, string>;
  steps: Step[];
};
const ci = yaml.parse(
  fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf-8"),
) as { on: { pull_request?: { types?: string[] } }; jobs: Record<string, Job> };

/** jest.config.js's ignore patterns under an env (an ES module: a child Node). */
function ignoreWith(env: Record<string, string>): string[] {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify((await import('./jest.config.js')).default.testPathIgnorePatterns ?? []));",
    ],
    { cwd: ROOT, encoding: "utf-8", env: { ...process.env, DEN_TEST_DOCKER: "", DEN_TEST_QUARANTINE: "", ...env } },
  );
  return JSON.parse(out) as string[];
}
const ignored = (patterns: string[], file: string) =>
  patterns.some((p) => new RegExp(p).test(`/repo/${file}`));

describe("draft pull requests and shard fan-out (testing policy 1)", () => {
  it("DEN_TEST_BROWSER=skip leaves out the browser specs, and only them", () => {
    const p = ignoreWith({ DEN_TEST_BROWSER: "skip" });
    expect(ignored(p, "tests/unit/den-ui/nav-inventory.browser.test.ts")).toBe(true);
    expect(ignored(p, "tests/unit/scripts/no-close-keywords.test.ts")).toBe(false);
    expect(ignored(ignoreWith({}), "tests/unit/den-ui/nav-inventory.browser.test.ts")).toBe(false);
  });

  it("refuses any other DEN_TEST_BROWSER value", () => {
    expect(() => ignoreWith({ DEN_TEST_BROWSER: "off" })).toThrow();
  });

  it("marking a draft ready for review starts a run", () => {
    expect(ci.on.pull_request?.types).toEqual(
      expect.arrayContaining(["opened", "synchronize", "reopened", "ready_for_review"]),
    );
  });

  it("the pr job picks browser=skip for a draft unless the run must be the whole suite", () => {
    const select = ci.jobs.pr.steps.find((s) => s.id === "select")!;
    expect(select.env?.DRAFT).toBe(
      "${{ github.event.pull_request.draft && !contains(github.event.pull_request.labels.*.name, 'ci:full') }}",
    );
    expect(select.run).toMatch(/DRAFT" = true/);
    expect(select.run).toMatch(/DEN_TEST_BROWSER=skip" >> "\$GITHUB_ENV"/);
    expect(ci.jobs.pr.outputs?.browser).toBe("${{ steps.select.outputs.browser }}");
    expect(ci.jobs.pr.outputs?.force_all).toBe("${{ steps.select.outputs.force_all }}");
  });

  it("a draft with the ci:full label runs the browser specs (PR 994, the queue's own run)", () => {
    const select = ci.jobs.pr.steps.find((s) => s.id === "select")!;
    expect(select.env?.DRAFT).toContain("!contains(github.event.pull_request.labels.*.name, 'ci:full')");
  });

  it("tested.json records whether the browser specs ran", () => {
    const what = ci.jobs.pr.steps.find((s) => s.name === "What this run tests")!;
    expect(what.run).toMatch(/"browser":"%s"/);
    expect(what.run).toMatch(/\$\{DEN_TEST_BROWSER:-run\}/);
  });

  it("pr-shards skips the browser specs and Playwright when pr says so", () => {
    const j = ci.jobs["pr-shards"];
    expect(j.env?.DEN_TEST_BROWSER).toBe("${{ needs.pr.outputs.browser }}");
    const pw = j.steps.filter((s) => (s.run ?? "").includes("ci-pw-install.sh") || s.id === "pw");
    expect(pw.length).toBeGreaterThan(0);
    for (const s of pw) expect(s.if).toMatch(/env\.DEN_TEST_BROWSER != 'skip'/);
  });

  it("the pr job skips Playwright when the browser specs are skipped", () => {
    const pw = ci.jobs.pr.steps.filter((s) => (s.run ?? "").includes("ci-pw-install.sh"));
    expect(pw.length).toBeGreaterThan(0);
    for (const s of pw) expect(s.if).toMatch(/env\.DEN_TEST_BROWSER != 'skip'/);
  });

  it("caps one pull request at 4 shard runners, but never a whole-suite run", () => {
    expect(ci.jobs["pr-shards"].strategy?.["max-parallel"]).toBe(
      "${{ needs.pr.outputs.force_all == 'yes' && 32 || 4 }}",
    );
  });

  it("a run without the browser specs never counts as the whole suite", () => {
    const what = ci.jobs.pr.steps.find((s) => s.name === "What this run tests")!;
    expect(what.run).toMatch(/DEN_TEST_BROWSER:-}" = skip.*sel=affected/s);
  });
});
