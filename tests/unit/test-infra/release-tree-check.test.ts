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

const SCRIPTS = path.join(process.cwd(), "scripts");
/** One export of an .mjs script, called in a child Node (Jest here runs CommonJS). */
function call(file: string, fn: string, ...args: unknown[]): unknown {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify("file://" + path.join(SCRIPTS, file))});` +
        `console.log(JSON.stringify(m[${JSON.stringify(fn)}](...JSON.parse(process.argv[1]))));`,
      JSON.stringify(args),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}
/** The script's rule. */
function decide(o: unknown): { ok: boolean; line: string } {
  return call("release-tree-check.mjs", "decide", {
    required: true,
    poster: POSTER,
    ...(o as object),
  }) as { ok: boolean; line: string };
}

// The bed's poster (DEN_BED_POSTER): an app or bot login, never a person's.
const POSTER = "bed-poster[bot]";
const T = "a".repeat(40);
const OTHER = "b".repeat(40);
// A green run as its `tested` artifact recorded it: the tree CI checked out
// (on a pull request, the merge of head and base), the selection, the attempt.
const green = [
  {
    tree: T,
    sha: "1".repeat(40),
    run: 101,
    attempt: 1,
    selection: "all",
    event: "pull_request",
  },
];
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
      green: [
        {
          tree: T,
          sha: "5".repeat(40),
          run: 202,
          attempt: 1,
          selection: "all",
          event: "merge_group",
        },
      ],
      statuses: [],
      context: "den/bed",
      required: false,
    });
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/merge_group run 202/);
  });
});

describe("release-tree-check: the tree CI tested, with the whole suite (its `tested` artifact)", () => {
  it("a PR run whose base moved on doesn't count for the head's tree", () => {
    // CI tested the merge of head and the newer base (MERGE), not the head (T).
    const MERGE = "c".repeat(40);
    const r = decide({
      tree: T,
      green: [{ ...green[0], tree: MERGE, headTree: T }],
      statuses: [],
      context: "den/bed",
      required: false,
    });
    expect(r.ok).toBe(false);
  });

  it("an affected-only run is refused: tested means the full suite", () => {
    const r = decide({
      tree: T,
      green: [{ ...green[0], selection: "affected" }],
      statuses: [],
      context: "den/bed",
      required: false,
    });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/full suite/);
  });

  it("the accepted line names the run's attempt, so a re-run to green shows", () => {
    const r = decide({
      tree: T,
      green: [{ ...green[0], attempt: 3 }],
      statuses: [],
      context: "den/bed",
      required: false,
    });
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/run 101 attempt 3/);
  });

  it("the no-match line says only the newest 100 runs per event are searched", () => {
    const r = decide({
      tree: OTHER,
      green,
      statuses: [],
      context: "den/bed",
      required: false,
    });
    expect(r.line).toMatch(/newest 100 runs per event/);
  });

  describe("candidates: the runs whose artifact may count", () => {
    const REPO = "owner-x/repo-x";
    const BLOB = "d".repeat(40);
    const run = (id: number, o: Record<string, unknown> = {}) => ({
      id,
      path: ".github/workflows/ci.yml",
      head_sha: String(id).repeat(40).slice(0, 40),
      head_commit: { tree_id: T },
      head_repository: { full_name: REPO },
      run_attempt: 1,
      ci_blob: BLOB,
      ...o,
    });
    const pick = (runs: unknown[]) =>
      (
        call("release-tree-check.mjs", "candidates", runs, T, {
          repo: REPO,
          ciBlob: BLOB,
        }) as { id: number }[]
      ).map((r) => r.id);

    it("ci.yml's own runs whose head has the tree", () => {
      expect(
        pick([
          run(1),
          run(2, { path: ".github/workflows/other.yml" }),
          run(3, { head_commit: { tree_id: OTHER } }),
        ]),
      ).toEqual([1]);
    });

    it("a fork's run is refused: its artifact came from outside", () => {
      expect(
        pick([run(4, { head_repository: { full_name: "fork-y/repo-x" } })]),
      ).toEqual([]);
    });

    it("a run whose head has another ci.yml is refused: that workflow wrote its artifact", () => {
      expect(pick([run(5, { ci_blob: "e".repeat(40) })])).toEqual([]);
      expect(pick([run(6, { ci_blob: null })])).toEqual([]);
    });
  });

  it("a run's entry comes from its artifact; no artifact, no entry", () => {
    const r = { id: 7, head_sha: "7".repeat(40), run_attempt: 2 };
    expect(
      call("release-tree-check.mjs", "entryOf", r, {
        tree: T,
        selection: "all",
        attempt: 2,
        event: "merge_group",
      }),
    ).toEqual({
      tree: T,
      sha: "7".repeat(40),
      run: 7,
      attempt: 2,
      selection: "all",
      event: "merge_group",
    });
    expect(call("release-tree-check.mjs", "entryOf", r, null)).toBeNull();
    expect(
      call("release-tree-check.mjs", "entryOf", r, { selection: "all" }),
    ).toBeNull();
  });
});

describe("ci-force-all: some changes always run the whole suite", () => {
  const force = (o: object) => call("ci-force-all.mjs", "forceAll", o);
  it("a pull request that changes package.json's version (a release or dev-tag commit)", () => {
    expect(
      force({
        event: "pull_request",
        baseVersion: "0.4.83",
        headVersion: "0.4.84-dev.1",
      }),
    ).toBe(true);
    expect(
      force({
        event: "pull_request",
        baseVersion: "0.4.83",
        headVersion: "0.4.83",
      }),
    ).toBe(false);
  });
  it("every merge-queue run", () => {
    expect(
      force({
        event: "merge_group",
        baseVersion: "1.0.0",
        headVersion: "1.0.0",
      }),
    ).toBe(true);
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

  it("the pr job records what it tested in an artifact named tested", () => {
    const steps = (ci.jobs.pr.steps ?? []) as {
      name?: string;
      uses?: string;
      if?: string;
      run?: string;
      with?: Record<string, unknown>;
    }[];
    const rec = steps.find((st) => (st.run ?? "").includes("tested.json"));
    expect(rec?.run).toContain("git rev-parse 'HEAD^{tree}'");
    expect(rec?.run).toContain("github.run_attempt");
    const up = steps.find(
      (st) =>
        (st.uses ?? "").startsWith("actions/upload-artifact@") &&
        st.with?.name === "tested",
    );
    expect(up).toBeDefined();
    expect(up?.with?.path).toBe("tested.json");
  });

  it("both selections force the whole suite through ci-force-all", () => {
    for (const job of ["pr", "pr-shards"]) {
      const runs = JSON.stringify(ci.jobs[job].steps);
      expect([job, runs.includes("scripts/ci-force-all.mjs")]).toEqual([
        job,
        true,
      ]);
    }
  });

  it("a merge queue's run (merge_group) runs the pull request's tests", () => {
    expect(Object.keys(ci.on)).toContain("merge_group");
    expect(ci.jobs.pr.if).toBe(
      "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
    );
    // pr-shards follows pr (it needs pr's shard list), and the fast
    // static checks (issue 843)
    expect(([] as string[]).concat(ci.jobs["pr-shards"].needs ?? [])).toEqual([
      "fast",
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
    // Issue 922: and the promoted commit to build (ref, dev-tag, dev-commit).
    expect(rel.jobs.gates.with).toMatchObject({ tests: false });
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
