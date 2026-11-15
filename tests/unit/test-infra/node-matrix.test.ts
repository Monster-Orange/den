/**
 * den#84: every gate runs on both ends of the supported Node range, the
 * lowest that package.json's engines allows and the Node installs run, in
 * CI and before a release publishes. The release tarball is built on the
 * lowest, only after both have passed.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();
const INSTALLS_RUN = "24.13.0";

interface Job {
  needs?: string | string[];
  strategy?: {
    matrix?: { node?: string[]; shard?: number[] };
    "fail-fast"?: boolean;
  };
  "continue-on-error"?: boolean;
  steps?: { run?: string; with?: Record<string, unknown> }[];
}

function jobs(file: string): Record<string, Job> {
  const doc = yaml.parse(
    fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf-8"),
  ) as { jobs: Record<string, Job> };
  return doc.jobs;
}

function lowest(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
  ) as { engines: { node: string } };
  const m = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(pkg.engines.node);
  if (!m) throw new Error(`engines.node isn't >=X.Y: ${pkg.engines.node}`);
  return `${m[1]}.${m[2]}.${m[3] ?? 0}`;
}

function runsTests(j: Job): boolean {
  return (j.steps ?? []).some((s) => /\bnpm test\b/.test(s.run ?? ""));
}

function blockingOnBoth(j: Job | undefined): void {
  expect(j).toBeDefined();
  expect(j!["continue-on-error"]).not.toBe(true);
  expect(j!.strategy?.["fail-fast"]).toBe(false);
  expect([...(j!.strategy?.matrix?.node ?? [])].sort()).toEqual(
    [lowest(), INSTALLS_RUN].sort(),
  );
}

function everyShard(t: Job | undefined): void {
  expect(t).toBeDefined();
  const shards = [...(t!.strategy?.matrix?.shard ?? [])].sort((a, b) => a - b);
  expect(shards.length).toBeGreaterThan(0);
  expect(shards).toEqual(shards.map((_, i) => i + 1));
  const run = (t!.steps ?? []).find((s) =>
    /\bnpm test\b/.test(s.run ?? ""),
  )?.run;
  expect(run).toContain(`--shard=\${{ matrix.shard }}/${shards.length}`);
}

function checksAndTests(j: Record<string, Job>): void {
  blockingOnBoth(j.checks);
  expect(
    (j.checks!.steps ?? []).some((s) => /typecheck/.test(s.run ?? "")),
  ).toBe(true);
  blockingOnBoth(j.tests);
  expect(runsTests(j.tests!)).toBe(true);
}

describe("the Node matrix (den#84)", () => {
  it("ci.yml: the checks, the tests and the install smoke block on both ends", () => {
    const j = jobs("ci.yml");
    checksAndTests(j);
    blockingOnBoth(j["dist-smoke"]);
  });

  it("ci.yml: the tests' shards are 1..N and each runs its own part of N, so every test runs", () => {
    everyShard(jobs("ci.yml").tests);
  });

  it("release.yml: the checks and the tests block on both ends, before the tarball is built and tagged", () => {
    const j = jobs("release.yml");
    checksAndTests(j);
    for (const after of ["pack", "tag"])
      expect(([] as string[]).concat(j[after]?.needs ?? [])).toEqual(
        expect.arrayContaining(["checks", "tests"]),
      );
  });

  it("release.yml: the tests' shards are 1..N and each runs its own part of N", () => {
    everyShard(jobs("release.yml").tests);
  });

  it("release.yml: the tarball is built on the lowest Node", () => {
    const steps = jobs("release.yml").pack?.steps ?? [];
    const v = steps.find((s) => s.with?.["node-version"])?.with?.[
      "node-version"
    ];
    expect(String(v).split(".").slice(0, 2).join(".")).toBe(
      lowest().split(".").slice(0, 2).join("."),
    );
  });
});
