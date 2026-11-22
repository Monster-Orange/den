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
      JSON.stringify({ required: true, poster: POSTER, ...(o as object) }),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as { ok: boolean; line: string };
}

// The bed's poster (DEN_BED_POSTER): an app or bot login, never a person's.
const POSTER = "bed-poster[bot]";
const T = "a".repeat(40);
const OTHER = "b".repeat(40);
const green = [{ tree: T, sha: "1".repeat(40), run: 101 }];
const bed = (
  state: string,
  sha = "2".repeat(40),
  creator = POSTER,
  at = "2026-11-22T10:00:00Z",
) => ({
  tree: T,
  sha,
  context: "den/bed",
  state,
  creator,
  at,
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
    expect(r.line).toMatch(/no green pull-request or merge-queue CI run/);
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

describe("release-tree-check: only the bed's own poster counts (DEN_BED_POSTER)", () => {
  it("refuses a success status from another login", () => {
    const r = decide({
      tree: T,
      green,
      statuses: [bed("success", undefined, "someone-else")],
      context: "den/bed",
    });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/bed-poster\[bot\]/);
  });

  it("takes the poster's success, matching its login exactly but in any case", () => {
    const r = decide({
      tree: T,
      green,
      statuses: [bed("success", undefined, "Bed-Poster[BOT]")],
      context: "den/bed",
    });
    expect(r.ok).toBe(true);
    const near = decide({
      tree: T,
      green,
      statuses: [bed("success", undefined, "bed-poster[bot]x")],
      context: "den/bed",
    });
    expect(near.ok).toBe(false);
  });

  it.each([[""], [undefined]])(
    "with DEN_BED_POSTER unset (%p), the poster is github-actions[bot] (the bed's own workflow token)",
    (poster) => {
      const from = (creator: string) =>
        decide({
          tree: T,
          green,
          statuses: [bed("success", undefined, creator)],
          context: "den/bed",
          poster,
        }).ok;
      expect(from("github-actions[bot]")).toBe(true);
      expect(from(POSTER)).toBe(false);
      expect(from("someone-else")).toBe(false);
    },
  );

  it("refuses the poster's failure even when another login posted success after it", () => {
    const r = decide({
      tree: T,
      green,
      statuses: [
        bed("failure", undefined, POSTER, "2026-11-22T10:00:00Z"),
        bed("success", undefined, "someone-else", "2026-11-22T11:00:00Z"),
      ],
      context: "den/bed",
    });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/failure/);
  });

  it("the poster's newest status decides", () => {
    const later = (a: string, b: string) =>
      decide({
        tree: T,
        green,
        statuses: [
          bed(a, undefined, POSTER, "2026-11-22T10:00:00Z"),
          bed(b, "4".repeat(40), POSTER, "2026-11-22T11:00:00Z"),
        ],
        context: "den/bed",
      }).ok;
    expect(later("failure", "success")).toBe(true);
    expect(later("success", "failure")).toBe(false);
  });
});

describe("release-tree-check: the bed's status is required only when DEN_BED_REQUIRED is true", () => {
  it("off: a green pull-request run on the tree alone passes", () => {
    const r = decide({
      tree: T,
      green,
      statuses: [],
      context: "den/bed",
      required: false,
    });
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/run 101/);
  });

  it("off: an untested tree is still refused", () => {
    const r = decide({
      tree: OTHER,
      green,
      statuses: [],
      context: "den/bed",
      required: false,
    });
    expect(r.ok).toBe(false);
  });

  it("on: no status is refused, and another login's is refused", () => {
    expect(
      decide({ tree: T, green, statuses: [], context: "den/bed" }).ok,
    ).toBe(false);
    expect(
      decide({
        tree: T,
        green,
        statuses: [bed("success", undefined, "someone-else")],
        context: "den/bed",
      }).ok,
    ).toBe(false);
  });

  it("a green merge_group run on the tree counts as tested", () => {
    const r = decide({
      tree: T,
      green: [{ tree: T, sha: "5".repeat(40), run: 202, event: "merge_group" }],
      statuses: [],
      context: "den/bed",
      required: false,
    });
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/merge_group run 202/);
  });
});

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
    expect(ci.jobs.checks.if).toBe(
      "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
    );
  });

  it("a merge queue's run (merge_group) runs the pull request's tests", () => {
    expect(Object.keys(ci.on)).toContain("merge_group");
    expect(ci.jobs.pr.if).toBe(
      "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
    );
    // pr-shards follows pr (it needs pr's shard list)
    expect(([] as string[]).concat(ci.jobs["pr-shards"].needs ?? [])).toEqual([
      "pr",
    ]);
    const raw = fs.readFileSync(path.join(DIR, "ci.yml"), "utf8");
    // every base the pr jobs diff against has the queue's base too
    for (const m of raw.matchAll(
      /github\.event\.pull_request\.base\.sha[^}]*/g,
    ))
      if (!/github\.event\.before/.test(m[0]))
        expect(m[0]).toContain("github.event.merge_group.base_sha");
  });
});

describe("release.yml: no test suite, only a tested tree", () => {
  const rel = wf("release.yml");

  it("calls the gates without their tests", () => {
    expect(rel.jobs.gates.with).toEqual({ tests: false });
  });

  it("hands the script the bed's switch and poster from the repository variables", () => {
    const steps = JSON.stringify(rel.jobs.tested.steps);
    expect(steps).toContain("vars.DEN_BED_REQUIRED");
    expect(steps).toContain("vars.DEN_BED_POSTER");
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
