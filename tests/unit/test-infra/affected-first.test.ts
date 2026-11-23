/**
 * Issue 844: on a pull request, the directly affected tests run first, as
 * one step in the pr job, and the full shards (pr-shards) start only when
 * it passes. Directly affected: a changed test file, the tests the map
 * names for a changed file (tests/affected-map.json), and the test named
 * like a changed source file that jest also relates to it. Not the
 * importers further away, the smoke set or "everything": those wait for
 * the rest of the subset or the shards. The merge queue and a version
 * change (a release candidate) still run every test across the shards
 * (issue 996). A red in that first step says, in the run summary, how long
 * after the run started it came.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.resolve(__dirname, "../../..");
const AFFECTED = path.join(ROOT, "scripts", "affected-tests.mjs");
const FIRST_RED = path.join(ROOT, "scripts", "ci-first-red.mjs");

/** Calls `fn` of an ES module in a child Node (jest can't load .mjs). */
function call<T>(script: string, fn: string, ...args: unknown[]): T {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(script)});
       const r = typeof m[${JSON.stringify(fn)}] === "function"
         ? await m[${JSON.stringify(fn)}](...JSON.parse(process.argv[1]))
         : { missing: true };
       console.log(JSON.stringify(r ?? null));`,
      JSON.stringify(args),
    ],
    { encoding: "utf-8" },
  );
  return JSON.parse(out.trim().split("\n").pop()!) as T;
}

type Step = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = {
  needs?: string[] | string;
  if?: string;
  outputs?: Record<string, string>;
  steps: Step[];
};
const WF = yaml.parse(
  fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf-8"),
) as { jobs: Record<string, Job> };

const map = {
  everything: ["src/guard.ts"],
  smoke: ["tests/smoke.test.ts"],
  rules: [
    {
      when: ["src/public/a-page.js"],
      run: ["tests/a-*.browser.test.ts"],
      why: "page a",
    },
  ],
};
const tests = [
  "tests/smoke.test.ts",
  "tests/a-one.browser.test.ts",
  "tests/unit/lib/widget.test.ts",
  "tests/unit/far/uses-widget.test.ts",
  "tests/unit/edited.test.ts",
  "tests/unit/fast.test.ts",
];

describe("issue 844 clause 1: the directly affected tests", () => {
  const direct = (
    changed: string[],
    related: string[],
    ranFirst: string[] = [],
  ) =>
    call<string[] | { missing: true }>(AFFECTED, "directTests", {
      changed,
      allTests: tests,
      related,
      map,
      ranFirst,
    });

  it("a changed test, the map's tests for a changed page, the test named like a changed source", () => {
    expect(
      direct(
        [
          "tests/unit/edited.test.ts",
          "src/public/a-page.js",
          "src/lib/widget.ts",
        ],
        ["tests/unit/lib/widget.test.ts", "tests/unit/far/uses-widget.test.ts"],
      ),
    ).toEqual([
      "tests/unit/edited.test.ts",
      "tests/a-one.browser.test.ts",
      "tests/unit/lib/widget.test.ts",
    ]);
  });

  it("not the importers further away, the smoke set, or a same-named test jest doesn't relate", () => {
    const d = direct(
      ["src/lib/widget.ts"],
      ["tests/unit/far/uses-widget.test.ts"],
    );
    expect(d).toEqual([]);
  });

  it("a shared file (everything) still has its direct tests, and fast's files are left out", () => {
    expect(
      direct(
        [
          "src/guard.ts",
          "tests/unit/edited.test.ts",
          "tests/unit/fast.test.ts",
        ],
        [],
        ["tests/unit/fast.test.ts"],
      ),
    ).toEqual(["tests/unit/edited.test.ts"]);
  });

  it("a rule that fans out to many tests (a docs page read by dozens) is not direct", () => {
    const many = Array.from(
      { length: 11 },
      (_, i) => `tests/docs-${i}.test.ts`,
    );
    const wide = {
      ...map,
      rules: [
        ...map.rules,
        {
          when: ["CONTRIBUTING.md"],
          run: ["tests/docs-*.test.ts"],
          why: "docs",
        },
      ],
    };
    const d = call<string[]>(AFFECTED, "directTests", {
      changed: ["CONTRIBUTING.md", "src/public/a-page.js"],
      allTests: [...tests, ...many],
      related: [],
      map: wide,
    });
    expect(d).toEqual(["tests/a-one.browser.test.ts"]);
  });

  it("the fan-out cap is DEN_DIRECT_FANOUT_MAX (default 10); a bad value is refused, naming it", () => {
    expect(call<number>(AFFECTED, "directFanoutMax", {})).toBe(10);
    expect(
      call<number>(AFFECTED, "directFanoutMax", {
        DEN_DIRECT_FANOUT_MAX: "25",
      }),
    ).toBe(25);
    for (const bad of ["0", "-3", "ten", "2.5"]) {
      const r = call<unknown>(AFFECTED, "directFanoutMaxOrError", {
        DEN_DIRECT_FANOUT_MAX: bad,
      });
      expect(String(r)).toContain("DEN_DIRECT_FANOUT_MAX");
    }
    // Raised, the docs rule's 11 tests are direct.
    const many = Array.from(
      { length: 11 },
      (_, i) => `tests/docs-${i}.test.ts`,
    );
    const d = call<string[]>(AFFECTED, "directTests", {
      changed: ["CONTRIBUTING.md"],
      allTests: [...tests, ...many],
      related: [],
      map: {
        ...map,
        rules: [
          {
            when: ["CONTRIBUTING.md"],
            run: ["tests/docs-*.test.ts"],
            why: "docs",
          },
        ],
      },
      fanoutMax: 11,
    });
    expect(d).toHaveLength(11);
  });

  it("the pr job runs them first, in one step, before the rest of the subset", () => {
    const steps = WF.jobs.pr.steps;
    const select = steps.find((s) => s.id === "select");
    expect(select?.run).toMatch(/--direct direct\.txt/);
    const first = steps.findIndex((s) => s.id === "direct");
    expect(first).toBeGreaterThan(-1);
    expect(steps[first].run).toMatch(/direct\.txt/);
    // It runs whether the rest goes to shards or stays here.
    expect(steps[first].if ?? "").not.toMatch(/shards == '\[\]'/);
    const rest = steps.findIndex(
      (s, i) =>
        i > first &&
        (s.run ?? "").includes("affected.txt") &&
        s.env?.DEN_TEST_DOCKER === "skip",
    );
    expect(rest).toBeGreaterThan(first);
    // The rest leaves out what ran first.
    expect(steps[rest].run).toMatch(/direct\.txt/);
  });
});

describe("issue 844 clause 2: the full shards wait for it", () => {
  it("pr-shards needs pr and runs only on its success", () => {
    const j = WF.jobs["pr-shards"];
    expect(j.needs).toEqual(expect.arrayContaining(["pr"]));
    // No always()/!cancelled(): a red pr job skips the shards.
    expect(j.if ?? "").not.toMatch(/always\(\)|cancelled\(\)|failure\(\)/);
  });

  it("a subset's shards leave out what pr ran first; the whole suite keeps every file", () => {
    const pick = WF.jobs["pr-shards"].steps.find((s) =>
      (s.run ?? "").includes("shard-plan.cjs --files"),
    );
    expect(pick?.run).toMatch(/--direct direct\.txt/);
    expect(pick?.run).toMatch(/grep -vxF -f direct\.txt/);
    // Only for a subset: ALL is listed after the exclusion.
    const run = pick?.run ?? "";
    expect(run.indexOf("grep -vxF -f direct.txt")).toBeLessThan(
      run.indexOf("npx jest --listTests"),
    );
  });
});

describe("issue 844 clause 3: the merge queue and a release candidate run every shard", () => {
  it("the merge queue and a version change still select ALL in pr and pr-shards", () => {
    for (const job of ["pr", "pr-shards"]) {
      const run = WF.jobs[job].steps.map((s) => s.run ?? "").join("\n");
      expect(run).toMatch(/ci-force-all\.mjs/);
      expect(run).toMatch(/echo ALL > affected\.txt/);
    }
  });
});

describe("issue 844 clause 4: time to first red in the run summary", () => {
  it("says how many minutes and seconds after the run started the first red came", () => {
    expect(
      call<string | { missing: true }>(
        FIRST_RED,
        "firstRedLine",
        "2026-11-22T10:00:00Z",
        Date.parse("2026-11-22T10:03:07Z"),
        "the directly affected tests",
      ),
    ).toBe(
      "**First red:** 3 min 7 s after the run started (the directly affected tests).",
    );
  });

  it("an unknown start says so, never a made-up time", () => {
    expect(call<string>(FIRST_RED, "firstRedLine", "", Date.now(), "x")).toBe(
      "**First red:** the run's start time isn't known (x).",
    );
  });

  it("the pr job writes it to the summary when the first step fails", () => {
    const steps = WF.jobs.pr.steps;
    const s = steps.find((x) => (x.run ?? "").includes("ci-first-red.mjs"));
    expect(s?.if).toMatch(/failure\(\)/);
    expect(s?.if).toMatch(/steps\.direct\.outcome == 'failure'/);
    // To the summary, and to the log (the summary isn't in the API).
    expect(s?.run).toMatch(/\| tee -a "\$GITHUB_STEP_SUMMARY"/);
  });
});
