/**
 * Issue 845, clause 1: shards are planned from measured test times kept in
 * the repo (tests/shard-times.json), refreshed from the full-suite runs of
 * what lands on main (the staging pull request from next/queue), and each
 * shard's p90 is within 20% of the others.
 *
 * scripts/shard-times-refresh.mjs: each file's time is its median over the
 * last runs; files that no longer exist drop out; CI's absolute paths become
 * repo paths. Each shard's p90 comes from the runs' job times; --check fails
 * when the slowest shard's p90 is more than 20% over the fastest's. A
 * weekly workflow runs it and reports the table.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "shard-times-refresh.mjs");

/** Calls `fn` of the ES module in a child Node (jest can't load .mjs). */
function call<T>(fn: string, ...args: unknown[]): T {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(SCRIPT)});
       const r = typeof m[${JSON.stringify(fn)}] === "function"
         ? await m[${JSON.stringify(fn)}](...JSON.parse(process.argv[1]))
         : { missing: ${JSON.stringify(fn)} };
       console.log(JSON.stringify(r ?? null));`,
      JSON.stringify(args),
    ],
    { encoding: "utf-8" },
  );
  return JSON.parse(out.trim().split("\n").pop()!) as T;
}

/** A jest --json result with one file's start and end. */
const jestJson = (rows: [string, number][]) => ({
  testResults: rows.map(([name, secs]) => ({
    name,
    startTime: 1_000_000,
    endTime: 1_000_000 + secs * 1000,
  })),
});

describe("issue 845 clause 1: times from the runs", () => {
  it("CI's absolute paths become repo paths", () => {
    expect(
      call<string | null>(
        "repoPath",
        "/home/runner/work/den/den/tests/unit/a.test.ts",
      ),
    ).toBe("tests/unit/a.test.ts");
    expect(call<string | null>("repoPath", "tests/unit/b.test.ts")).toBe(
      "tests/unit/b.test.ts",
    );
    expect(call<string | null>("repoPath", "/somewhere/else.ts")).toBeNull();
  });

  it("a run's times: one per file (its longest), from every shard's report", () => {
    expect(
      call<Record<string, number>>("runTimes", [
        jestJson([
          ["/home/runner/work/den/den/tests/a.test.ts", 4],
          ["/home/runner/work/den/den/tests/b.test.ts", 10],
        ]),
        jestJson([["/home/runner/work/den/den/tests/a.test.ts", 6]]),
      ]),
    ).toEqual({ "tests/a.test.ts": 6, "tests/b.test.ts": 10 });
  });

  it("each file's time is its median over the runs; a file gone from the repo drops out; one never measured keeps its old time", () => {
    const out = call<{ files: Record<string, number> }>(
      "refreshTimes",
      {
        files: {
          "tests/a.test.ts": 99,
          "tests/c.test.ts": 7,
          "tests/gone.test.ts": 5,
        },
      },
      [
        { "tests/a.test.ts": 4, "tests/b.test.ts": 10 },
        { "tests/a.test.ts": 6, "tests/b.test.ts": 30 },
        { "tests/a.test.ts": 50 },
      ],
      ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"],
    );
    expect(out.files).toEqual({
      "tests/a.test.ts": 6,
      "tests/b.test.ts": 20,
      "tests/c.test.ts": 7,
    });
    // Sorted by path, so a refresh's diff is readable.
    expect(Object.keys(out.files)).toEqual([
      "tests/a.test.ts",
      "tests/b.test.ts",
      "tests/c.test.ts",
    ]);
  });
});

describe("issue 845 clause 1: each shard's p90 within 20% of the others", () => {
  const runs = [
    { "1": 400, "2": 420, "3": 410 },
    { "1": 405, "2": 430, "3": 415 },
    { "1": 410, "2": 425, "3": 470 },
  ];

  it("p90 per shard, from its job seconds over the runs (nearest rank)", () => {
    expect(call<Record<string, number>>("shardP90s", runs)).toEqual({
      "1": 410,
      "2": 430,
      "3": 470,
    });
  });

  it("balanced when the slowest p90 is at most 20% over the fastest; says the spread", () => {
    expect(
      call<{ ok: boolean; spreadPct: number }>("balance", {
        "1": 410,
        "2": 430,
        "3": 470,
      }),
    ).toEqual({ ok: true, spreadPct: 14.6, slowest: "3", fastest: "1" });
    expect(
      call<{ ok: boolean }>("balance", { "1": 400, "2": 481 }),
    ).toMatchObject({ ok: false, spreadPct: 20.3, slowest: "2" });
  });

  it("the limit is --limit-pct (default 20); a bad value is refused, naming the flag", () => {
    expect(call<number>("limitPct", [])).toBe(20);
    expect(call<number>("limitPct", ["--limit-pct", "15"])).toBe(15);
    for (const bad of ["0", "-5", "abc", ""])
      expect(
        String(call<unknown>("limitPctOrError", ["--limit-pct", bad])),
      ).toContain("--limit-pct");
    expect(
      call<{ ok: boolean }>("balance", { "1": 400, "2": 460 }, 10),
    ).toMatchObject({ ok: false, spreadPct: 15 });
  });

  it("fewer than two shards measured: nothing to compare, never a pass", () => {
    expect(call<{ ok: boolean | null }>("balance", { "1": 400 })).toMatchObject(
      {
        ok: null,
      },
    );
  });

  it("the repo's times file keeps only test files that exist", () => {
    const t = JSON.parse(
      fs.readFileSync(path.join(ROOT, "tests", "shard-times.json"), "utf-8"),
    ) as { files: Record<string, number> };
    const missing = Object.keys(t.files).filter(
      (f) => !fs.existsSync(path.join(ROOT, f)),
    );
    expect(missing).toEqual([]);
  });
});

describe("issue 845 clause 1: refreshed from main's runs, every week", () => {
  type Wf = {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        steps: { run?: string; uses?: string; with?: Record<string, string> }[];
      }
    >;
  };
  const load = (): Wf =>
    yaml.parse(
      fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "shard-times.yml"),
        "utf-8",
      ),
    ) as Wf;
  const stepsOf = (wf: Wf) => Object.values(wf.jobs).flatMap((j) => j.steps);

  it("runs weekly and on demand, reading only", () => {
    const wf = load();
    expect(wf.on.schedule).toBeDefined();
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.permissions).toEqual({ contents: "read", actions: "read" });
  });

  it("a red week opens or comments the one Shard balance issue, from its own job", () => {
    const wf = load() as Wf & {
      jobs: Record<
        string,
        {
          needs?: string[] | string;
          if?: string;
          permissions?: Record<string, string>;
        }
      >;
    };
    const [name, job] =
      Object.entries(wf.jobs).find(([, j]) =>
        j.steps.some((s) => (s.run ?? "").includes("gh issue create")),
      ) ?? [];
    expect(name).toBeDefined();
    expect([job!.needs].flat()).toContain("refresh");
    expect(job!.if).toMatch(/failure\(\)/);
    // issues: write on this job only.
    expect(job!.permissions).toEqual({ issues: "write", actions: "read" });
    for (const [n, j] of Object.entries(wf.jobs))
      if (n !== name) expect(j.permissions?.issues).toBeUndefined();
    const run = job!.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toMatch(/title="Shard balance"/);
    expect(run).toMatch(/gh issue comment/);
    // The summary table goes in the body.
    expect(run).toMatch(/shard-balance\.md/);
  });

  it("refreshes from the staging branch's runs, checks the balance, and keeps the new file", () => {
    const steps = stepsOf(load());
    const run = steps.find((s) =>
      (s.run ?? "").includes("shard-times-refresh.mjs"),
    );
    expect(run?.run).toMatch(/--branch next\/queue/);
    expect(run?.run).toMatch(/--check/);
    // bash -e stops at a failing command: the status is kept with ||, so
    // the table still reaches the summary before the step fails.
    expect(run?.run).toMatch(/--check \|\| status=\$\?/);
    // Tunable without a code change: the runs and the limit are flags.
    expect(run?.run).toMatch(/--runs \d+/);
    expect(run?.run).toMatch(/--limit-pct \d+/);
    expect(run?.run).toMatch(/GITHUB_STEP_SUMMARY/);
    const up = steps.find((s) =>
      (s.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    expect(up?.uses).toMatch(/@[0-9a-f]{40}/);
    expect(up?.with?.path).toBe("tests/shard-times.json");
  });
});
