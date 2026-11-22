/**
 * Issue 996: one change runs its tests once, on its pull request.
 *
 * - ci.yml runs no test suite on a push to main. Main's tree is a pull
 *   request's tested tree. Its fast checks (lint, types, the org-name gate)
 *   still run there, as a tripwire. The full suite can still be run by hand
 *   (workflow_dispatch).
 * - release.yml runs no test suite either. It publishes only a tree that was
 *   tested: the release commit must be the newest dev tag of its version
 *   with the release's versions applied (scripts/release-dry-run.mjs
 *   apply), and that tag's tree must have a green pull-request ci.yml run
 *   and a successful bed status (den/bed, posted from the bed's verdict).
 *   scripts/release-tree-check.mjs decides; it is tested here with no network.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const SCRIPT = path.join(process.cwd(), "scripts", "release-tree-check.mjs");
/** The script's rule, in a child Node (an .mjs script; Jest here runs CommonJS). */
function decide(o: unknown): { ok: boolean; line: string } {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { decide } = await import(${JSON.stringify("file://" + SCRIPT)});` +
        "console.log(JSON.stringify(decide(JSON.parse(process.argv[1]))));",
      JSON.stringify(o),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as { ok: boolean; line: string };
}

const T = "a".repeat(40);
const OTHER = "b".repeat(40);
const green = [{ tree: T, sha: "1".repeat(40), run: 101 }];
const bed = (state: string, sha = "2".repeat(40)) => ({
  tree: T,
  sha,
  context: "den/bed",
  state,
});

describe("release-tree-check: only a tested tree publishes", () => {
  it("refuses a tree no green pull-request run has", () => {
    const r = decide({
      tree: OTHER,
      green,
      statuses: [{ ...bed("success"), tree: OTHER }],
      context: "den/bed",
    });
    expect(r.ok).toBe(false);
    expect(r.line).toContain(OTHER);
    expect(r.line).toMatch(/no green pull-request CI run/);
  });

  it("refuses a tree with green PR CI but no bed status", () => {
    const r = decide({ tree: T, green, statuses: [], context: "den/bed" });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/run 101/);
    expect(r.line).toMatch(/no den\/bed status/);
  });

  it("refuses a failed bed status", () => {
    const r = decide({
      tree: T,
      green,
      statuses: [bed("failure")],
      context: "den/bed",
    });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/den\/bed .*failure/);
  });

  it("ignores another context's success", () => {
    const r = decide({
      tree: T,
      green,
      statuses: [{ ...bed("success"), context: "other" }],
      context: "den/bed",
    });
    expect(r.ok).toBe(false);
  });

  it("passes when both are there for the same tree, on different commits", () => {
    const r = decide({
      tree: T,
      green,
      statuses: [bed("success", "3".repeat(40))],
      context: "den/bed",
    });
    expect(r).toEqual({ ok: true, line: expect.stringMatching(/run 101/) });
  });

  it("takes the context it is given (the repository variable)", () => {
    const r = decide({
      tree: T,
      green,
      statuses: [{ ...bed("success"), context: "lab/bed" }],
      context: "lab/bed",
    });
    expect(r.ok).toBe(true);
  });
});

const DIR = path.join(process.cwd(), ".github", "workflows");
type Job = {
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  steps?: { run?: string }[];
};
const wf = (f: string) =>
  yaml.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as {
    on: Record<string, unknown>;
    jobs: Record<string, Job>;
  };

describe("ci.yml: tests run on the pull request, not again on main", () => {
  const ci = wf("ci.yml");

  it("the test suites never run on a push", () => {
    for (const name of ["tests", "dist-smoke", "den-ui-nav"]) {
      const cond = ci.jobs[name].if ?? "";
      expect([name, cond.includes("'push'")]).toEqual([name, false]);
      expect([
        name,
        cond.includes("github.event_name == 'workflow_dispatch'"),
      ]).toEqual([name, true]);
    }
  });

  it("the fast checks still run on a push to main", () => {
    expect(ci.on.push).toEqual({ branches: ["main"] });
    expect(ci.jobs.checks.if).toBe("github.event_name != 'pull_request'");
  });
});

describe("release.yml: no test suite, only a tested tree", () => {
  const rel = wf("release.yml");

  it("calls the gates without their tests", () => {
    expect(rel.jobs.gates.with).toEqual({ tests: false });
  });

  it("a job checks the tree before the gates, the tag and the publish", () => {
    const t = rel.jobs.tested;
    expect(t).toBeDefined();
    expect(([] as string[]).concat(t.needs ?? [])).toEqual(["check"]);
    expect(t.permissions).toMatchObject({ actions: "read", statuses: "read" });
    expect(JSON.stringify(t.steps)).toContain("scripts/release-tree-check.mjs");
    expect(([] as string[]).concat(rel.jobs.gates.needs ?? [])).toEqual([
      "check",
      "tested",
    ]);
  });

  it("the dry run on dev tags keeps its tests", () => {
    const dry = wf("release-dry-run.yml");
    expect(dry.jobs.gates.with?.tests).toBeUndefined();
    const gates = wf("release-gates.yml");
    expect(gates.jobs.tests.if).toBe("inputs.tests");
  });
});
