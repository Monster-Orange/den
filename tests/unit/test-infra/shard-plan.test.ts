/**
 * Issue 998: a pull request's big test run is split by measured time, not
 * by file count, so every shard finishes under a limit. scripts/shard-plan.cjs
 * packs files longest-first into the fewest shards (at least the minimum)
 * whose load fits; a file too slow for any shard runs alone and is named.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { plan } = require("../../../scripts/shard-plan.cjs") as {
  plan: (o: {
    files: string[];
    times: Record<string, number>;
    workers: number;
    limitMin: number;
    minShards: number;
    maxShards?: number;
  }) => {
    count: number;
    shards: string[][];
    loads: number[];
    oversized: string[];
    timeOf: (f: string) => number;
  };
};

const ROOT = process.cwd();

function files(n: number, prefix = "tests/f"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}.test.ts`);
}

describe("issue 998: the shard plan", () => {
  it("no shard's load goes over the limit, and every file is in exactly one shard", () => {
    const fs_ = files(200);
    const times = Object.fromEntries(fs_.map((f, i) => [f, 5 + (i % 40) * 3]));
    const p = plan({
      files: fs_,
      times,
      workers: 2,
      limitMin: 9,
      minShards: 6,
    });
    for (const load of p.loads) expect(load).toBeLessThanOrEqual(9 * 60);
    const all = p.shards.flat();
    expect([...all].sort()).toEqual([...fs_].sort());
    expect(new Set(all).size).toBe(fs_.length);
    expect(p.shards.length).toBe(p.count);
    expect(p.count).toBeGreaterThanOrEqual(6);
  });

  it("takes the fewest shards that fit, never fewer than the minimum", () => {
    const fs_ = files(10);
    const times = Object.fromEntries(fs_.map((f) => [f, 10]));
    expect(
      plan({ files: fs_, times, workers: 2, limitMin: 9, minShards: 6 }).count,
    ).toBe(6);
    // 60 files of 60 s on 2 workers: 30 min of load, so 4 shards of 7.5 min.
    const many = files(60);
    const t2 = Object.fromEntries(many.map((f) => [f, 60]));
    expect(
      plan({ files: many, times: t2, workers: 2, limitMin: 9, minShards: 1 })
        .count,
    ).toBe(4);
  });

  it("a file slower than the limit runs alone, and is named", () => {
    const fs_ = files(20);
    const times: Record<string, number> = Object.fromEntries(
      fs_.map((f) => [f, 20]),
    );
    times["tests/f3.test.ts"] = 11 * 60;
    const p = plan({
      files: fs_,
      times,
      workers: 2,
      limitMin: 9,
      minShards: 2,
    });
    expect(p.oversized).toEqual(["tests/f3.test.ts"]);
    const own = p.shards.find((s) => s.includes("tests/f3.test.ts"));
    expect(own).toEqual(["tests/f3.test.ts"]);
    for (const [i, s] of p.shards.entries())
      if (s !== own) expect(p.loads[i]).toBeLessThanOrEqual(9 * 60);
  });

  it("a file with no recorded time counts as the median", () => {
    const known = files(5);
    const times = Object.fromEntries(
      known.map((f, i) => [f, [10, 20, 30, 40, 50][i]]),
    );
    const p = plan({
      files: [...known, "tests/new.test.ts"],
      times,
      workers: 1,
      limitMin: 9,
      minShards: 1,
    });
    expect(p.timeOf("tests/new.test.ts")).toBe(30);
    expect(p.loads.reduce((a, b) => a + b, 0)).toBe(
      10 + 20 + 30 + 40 + 50 + 30,
    );
  });

  it("the same input gives the same plan (every shard job plans alone)", () => {
    const fs_ = files(80);
    const times = Object.fromEntries(fs_.map((f, i) => [f, (i * 37) % 90]));
    const a = plan({
      files: fs_,
      times,
      workers: 2,
      limitMin: 9,
      minShards: 6,
    });
    const b = plan({
      files: [...fs_].reverse(),
      times,
      workers: 2,
      limitMin: 9,
      minShards: 6,
    });
    expect(a.shards).toEqual(b.shards);
  });

  it("the committed times plan the whole suite into shards under the limit", () => {
    const times = JSON.parse(
      fs.readFileSync(path.join(ROOT, "tests", "shard-times.json"), "utf-8"),
    ) as { files: Record<string, number> };
    const p = plan({
      files: Object.keys(times.files),
      times: times.files,
      workers: 2,
      limitMin: 9,
      minShards: 6,
    });
    for (const [i, load] of p.loads.entries())
      if (!p.oversized.includes(p.shards[i][0]))
        expect(load).toBeLessThanOrEqual(9 * 60);
  });
});

describe("issue 998: ci.yml's Nodes and shards", () => {
  type Step = { run?: string; env?: Record<string, string>; if?: string };
  type Job = {
    if?: string;
    needs?: string | string[];
    strategy?: { matrix?: { node?: string[]; shard?: unknown } };
    steps: Step[];
    permissions?: Record<string, string>;
  };
  const doc = yaml.parse(
    fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf-8"),
  ) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  const runs = (j: Job) => j.steps.map((s) => s.run ?? "").join("\n");

  it("a pull request runs on Node 24 only", () => {
    for (const name of ["pr", "pr-shards"])
      expect([name, doc.jobs[name].strategy?.matrix?.node]).toEqual([
        name,
        ["24.13.0"],
      ]);
  });

  it("the run's `tested` record is written on a Node the pr matrix runs", () => {
    const steps = doc.jobs.pr.steps as (Step & {
      name?: string;
      with?: Record<string, unknown>;
    })[];
    const rec = steps.filter(
      (s) =>
        s.name === "What this run tests" ||
        (s as { with?: { name?: string } }).with?.name === "tested",
    );
    expect(rec).toHaveLength(2);
    const nodes = doc.jobs.pr.strategy?.matrix?.node ?? [];
    for (const s of rec) {
      const m = /matrix\.node == '([\d.]+)'/.exec(s.if ?? "");
      expect([s.if, m && nodes.includes(m[1])]).toEqual([s.if, true]);
    }
  });

  it('the record says "all" exactly when the whole suite runs, and a large subset in shards runs only its own files', () => {
    const rec = doc.jobs.pr.steps.find((s) =>
      (s.run ?? "").includes("tested.json"),
    );
    // "all" comes from the selection being ALL, the one case the shards
    // list and run every test file.
    expect(rec?.run).toMatch(
      /sel=affected\s*\n\s*if \[ "\$\(head -1 affected\.txt\)" = ALL \]; then sel=all; fi/,
    );
    const pick = doc.jobs["pr-shards"].steps
      .map((s) => s.run ?? "")
      .find((r) => r.includes("shard-plan.cjs"));
    // ALL becomes every test file; any other selection stays its own list.
    expect(pick).toMatch(
      /if \[ "\$\(head -1 affected\.txt\)" = ALL \]; then\s*\n\s*npx jest --listTests[^\n]*> affected\.txt/,
    );
    expect(pick).toMatch(/shard-plan\.cjs --files affected\.txt --shard/);
    expect(pick).not.toMatch(/: > affected\.txt/);
  });

  it("the nightly Node 22 run keeps what a pull request ran on Node 22: the checks and the install smoke", () => {
    const nightly22 = Object.values(doc.jobs).filter(
      (j) =>
        (j.if ?? "").includes("github.event_name == 'schedule'") &&
        (j.strategy?.matrix?.node ?? []).includes("22.13.0"),
    );
    const text = nightly22.map(runs).join("\n");
    for (const gate of [
      "npm run typecheck",
      "npm run lint",
      "scripts/words-gate.mjs",
      "scripts/dist-smoke.sh",
    ])
      expect([gate, text.includes(gate)]).toEqual([gate, true]);
  });

  it("Node 22 runs nightly on main, and a red night opens or updates one issue", () => {
    expect(doc.on.schedule).toBeDefined();
    const nightly = Object.entries(doc.jobs).filter(([, j]) =>
      (j.if ?? "").includes("github.event_name == 'schedule'"),
    );
    const tests = nightly.find(([, j]) => /\bnpm test\b/.test(runs(j)));
    expect(tests?.[1].strategy?.matrix?.node).toEqual(["22.13.0"]);
    const report = nightly.find(([, j]) =>
      runs(j).includes("Nightly: Node 22 tests fail"),
    );
    expect(report?.[1].permissions?.issues).toBe("write");
    expect(report?.[1].if).toContain("failure()");
  });

  it("pr-shards runs the files its plan gives it, never jest's even split, and an empty shard runs nothing", () => {
    const sh = doc.jobs["pr-shards"];
    const text = runs(sh);
    expect(text).toContain("scripts/shard-plan.cjs");
    for (const s of sh.steps.filter((st) => /\bnpm test\b/.test(st.run ?? "")))
      expect(s.run).not.toMatch(/--shard=/);
    expect(text).toMatch(/\[ -s shard\.txt \]/);
    const select = doc.jobs.pr.steps.map((s) => s.run ?? "").join("\n");
    expect(select).toContain("scripts/shard-plan.cjs");
  });
});
