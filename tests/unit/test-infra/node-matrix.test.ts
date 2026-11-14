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
  strategy?: { matrix?: { node?: string[] }; "fail-fast"?: boolean };
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

describe("the Node matrix (den#84)", () => {
  it("ci.yml: the gates and the install smoke block on both ends", () => {
    const j = jobs("ci.yml");
    blockingOnBoth(j.gates);
    expect(runsTests(j.gates!)).toBe(true);
    blockingOnBoth(j["dist-smoke"]);
  });

  it("release.yml: the gates block on both ends, before the tarball is built", () => {
    const j = jobs("release.yml");
    blockingOnBoth(j.gates);
    expect(runsTests(j.gates!)).toBe(true);
    const needs = ([] as string[]).concat(j.pack?.needs ?? []);
    expect(needs).toContain("gates");
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
