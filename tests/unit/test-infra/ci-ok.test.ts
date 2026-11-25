/**
 * Issue 843: `ci-ok` is the one check the merge queue requires. It needs
 * every job a pull request runs, and passes only when each passed, or was
 * skipped because `pr` said it had nothing to run (no nav change: no
 * den-ui-nav; no shards: no pr-shards). Any other skip, a failure or a
 * cancel fails it, so the ruleset never needs the shard count.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "ci-ok.mjs");

interface Job {
  needs?: string | string[];
  if?: string;
  steps?: { run?: string; env?: Record<string, string> }[];
}
const ci = yaml.parse(
  fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf-8"),
) as { jobs: Record<string, Job> };
const needs = (j: Job | undefined): string[] =>
  ([] as string[]).concat(j?.needs ?? []);

type R = "success" | "failure" | "skipped" | "cancelled";
function run(
  r: Partial<Record<"fast" | "pr" | "den-ui-nav" | "pr-shards", R>>,
  out: { nav?: string; shards?: string } = { nav: "true", shards: "[1,2]" },
) {
  const all = {
    fast: "success",
    pr: "success",
    "den-ui-nav": "success",
    "pr-shards": "success",
    ...r,
  };
  const NEEDS = JSON.stringify(
    Object.fromEntries(
      Object.entries(all).map(([k, v]) => [
        k,
        { result: v, outputs: k === "pr" ? out : {} },
      ]),
    ),
  );
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf-8",
    env: { ...process.env, NEEDS },
  });
}

describe("issue 843: ci-ok, the merge queue's one required check", () => {
  it("passes when every job passed", () => {
    expect(run({}).status).toBe(0);
  });

  it.each([
    ["fast failed", { fast: "failure" }],
    ["pr failed", { pr: "failure" }],
    ["a shard failed", { "pr-shards": "failure" }],
    ["den-ui-nav failed", { "den-ui-nav": "failure" }],
    ["a job was cancelled", { "pr-shards": "cancelled" }],
    ["fast was skipped", { fast: "skipped" }],
    ["pr was skipped", { pr: "skipped" }],
  ] as [string, Record<string, R>][])("fails when %s", (_k, r) => {
    const p = run(r);
    expect(p.status).toBe(1);
    expect(p.stdout + p.stderr).toMatch(
      new RegExp(`^${Object.keys(r)[0]}: `, "m"),
    );
  });

  it("the shards skipped while pr planned some: fails", () => {
    expect(run({ "pr-shards": "skipped" }).status).toBe(1);
  });
  it("the shards skipped because pr planned none: passes", () => {
    expect(
      run({ "pr-shards": "skipped" }, { nav: "true", shards: "[]" }).status,
    ).toBe(0);
  });
  it("den-ui-nav skipped while pr said nav changed: fails", () => {
    expect(run({ "den-ui-nav": "skipped" }).status).toBe(1);
  });
  it("den-ui-nav skipped because no nav changed: passes", () => {
    expect(
      run({ "den-ui-nav": "skipped" }, { nav: "false", shards: "[1]" }).status,
    ).toBe(0);
  });
  it("no NEEDS (run by hand, or a broken job): fails", () => {
    const p = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf-8",
      env: { ...process.env, NEEDS: "" },
    });
    expect(p.status).toBe(1);
  });

  it("the job runs on pull requests and the merge queue, even after a failure, and reads every need", () => {
    const j = ci.jobs["ci-ok"];
    expect(j).toBeDefined();
    expect(j.if).toMatch(/always\(\)/);
    expect(j.if).toMatch(/pull_request/);
    expect(j.if).toMatch(/merge_group/);
    const step = (j.steps ?? []).find((s) => s.run?.includes("ci-ok.mjs"));
    expect(step?.env?.NEEDS).toMatch(/toJSON\(needs\)/);
  });

  it("issue 1522: a slow checkout can't time the job out (GitHub shows that as cancelled, a false red)", () => {
    const j = ci.jobs["ci-ok"];
    // At 2 minutes, a checkout that took 2 (PR 1518's run, 08:00:33Z to
    // 08:02:36Z) cancelled the one required check.
    expect(j["timeout-minutes"]).toBeGreaterThanOrEqual(10);
    const co = (j.steps ?? []).find((s) =>
      String(s.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(co).toBeDefined();
    // The checkout has its own limit, under the job's, so a stuck one
    // fails as itself and the job's own step still has time to run.
    expect(co["timeout-minutes"]).toBeGreaterThan(0);
    expect(co["timeout-minutes"]).toBeLessThan(j["timeout-minutes"]);
    // One commit, one file: the checkout stays as small as it can be.
    expect(co.with?.["fetch-depth"]).toBe(1);
    expect(co.with?.["sparse-checkout"]).toBe("scripts/ci-ok.mjs");
  });

  it("needs every job a pull request runs, so a new one can't slip past", () => {
    const pr = Object.entries(ci.jobs)
      .filter(([k]) => k !== "ci-ok")
      .filter(
        ([k, j]) =>
          k === "fast" ||
          /pull_request/.test(j.if ?? "") ||
          needs(j).includes("pr"),
      )
      .map(([k]) => k)
      .sort();
    expect(needs(ci.jobs["ci-ok"]).sort()).toEqual(pr);
  });
});
