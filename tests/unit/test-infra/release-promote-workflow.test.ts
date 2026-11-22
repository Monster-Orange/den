/**
 * Issue 922: release.yml publishes the tested dev tag's tree, never main's
 * HEAD.
 *
 * - A release starts by hand (workflow_dispatch) with `promote`: the
 *   release's version commit. scripts/release-promote.sh decides (its own
 *   test: release-promote.test.ts). Nothing else publishes: a push to main,
 *   such as merging the release's version commit afterwards, runs nothing
 *   here, so main takes merges at any time.
 * - The gates, the tag, the publish and the kit all build that commit.
 * - The tarball carries release.json, and SHA256SUMS names the dev tag
 *   and its commit (scripts/release-record.mjs).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();
const DIR = path.join(ROOT, ".github", "workflows");

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}
const text = (f: string): string => fs.readFileSync(path.join(DIR, f), "utf8");
const wf = (f: string): Workflow => yaml.parse(text(f)) as Workflow;
const checkouts = (j: Job): Step[] =>
  (j.steps ?? []).filter((s) => s.uses?.startsWith("actions/checkout@"));
const REF = "${{ needs.check.outputs.ref }}";

describe("release.yml: a release is a promoted dev tag (issue 922)", () => {
  const w = wf("release.yml");

  it("starts only by hand, with the version commit to promote; a push to main runs nothing", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    const inputs = (
      w.on.workflow_dispatch as { inputs?: Record<string, unknown> }
    ).inputs;
    expect(inputs?.promote).toMatchObject({ type: "string" });
  });

  it("the check runs release-promote.sh on it, and only that says release", () => {
    const check = w.jobs.check;
    const step = check.steps?.find((s) => s.id === "promote");
    expect(step?.if).toBe("inputs.promote != ''");
    expect(step?.run).toContain('sh scripts/release-promote.sh "$PROMOTE"');
    expect(step?.env).toMatchObject({
      PROMOTE: "${{ inputs.promote }}",
      RELEASE_BED_CONTEXT: "${{ vars.RELEASE_BED_CONTEXT }}",
    });
    expect(String(check.outputs?.release)).toBe(
      "${{ steps.promote.outputs.release == 'true' }}",
    );
    for (const k of ["ref", "dev_tag", "dev_sha"])
      expect(String(check.outputs?.[k])).toBe(
        `\${{ steps.promote.outputs.${k} }}`,
      );
    // The tags and full history, to find the dev tag and diff against it.
    const co = checkouts(check)[0];
    expect(co?.with).toMatchObject({ "fetch-depth": 0, "fetch-tags": true });
  });

  it("the gates, the tag and the kit build the promoted commit", () => {
    expect(w.jobs.gates.with).toMatchObject({
      ref: REF,
      "dev-tag": "${{ needs.check.outputs.dev_tag }}",
      "dev-commit": "${{ needs.check.outputs.dev_sha }}",
    });
    for (const j of ["tag", "den-ui"])
      for (const co of checkouts(w.jobs[j]))
        expect([j, co.with?.ref]).toEqual([j, REF]);
    // The tag goes on the promoted commit, never on the run's own commit.
    const tagText = JSON.stringify(w.jobs.tag);
    expect(tagText).not.toContain("GITHUB_SHA");
    expect(tagText).toContain("needs.check.outputs.ref");
  });

  it("the GitHub release carries release.json beside the tarball and SHA256SUMS", () => {
    expect(JSON.stringify(w.jobs["github-release"])).toContain(
      "release/release.json",
    );
  });
});

describe("release-gates.yml builds the commit it is given", () => {
  const w = wf("release-gates.yml");
  const inputs = (
    w.on.workflow_call as { inputs?: Record<string, { default?: unknown }> }
  ).inputs;

  it("takes ref, dev-tag and dev-commit, empty by default (the dry run's own commit)", () => {
    for (const i of ["ref", "dev-tag", "dev-commit"])
      expect(inputs?.[i]?.default).toBe("");
  });

  it("every job checks out that ref", () => {
    for (const [n, j] of Object.entries(w.jobs))
      for (const co of checkouts(j))
        expect([n, co.with?.ref]).toEqual([n, "${{ inputs.ref }}"]);
  });

  it("the pack writes release.json before npm pack, and names the dev tag in SHA256SUMS", () => {
    const run = (w.jobs.pack.steps ?? []).map((s) => s.run ?? "").join("\n");
    const json = run.indexOf("node scripts/release-record.mjs json");
    const pack = run.indexOf("npm pack");
    const sums = run.indexOf("node scripts/release-record.mjs sums");
    expect(json).toBeGreaterThanOrEqual(0);
    expect(json).toBeLessThan(pack);
    expect(sums).toBeGreaterThan(pack);
  });

  it("release.json ships in the package", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("release.json");
  });
});

describe("release-record.mjs", () => {
  let tmp = "";
  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "record-")));
  });
  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });
  const record = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [path.join(ROOT, "scripts", "release-record.mjs"), ...args],
      { cwd: tmp, encoding: "utf8" },
    );
  const DEV = "a".repeat(40);
  const REL = "b".repeat(40);

  it("json: release.json names the version, the dev tag, its commit and the release commit", () => {
    record("json", "1.2.3", "v1.2.3-dev.4", DEV, REL);
    expect(
      JSON.parse(fs.readFileSync(path.join(tmp, "release.json"), "utf8")),
    ).toEqual({
      version: "1.2.3",
      devTag: "v1.2.3-dev.4",
      devCommit: DEV,
      commit: REL,
    });
  });

  it("sums: SHA256SUMS gets one line naming the dev tag and its commit, and still checks", () => {
    const dir = path.join(tmp, "release");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "pkg-1.2.3.tgz"), "tarball");
    fs.copyFileSync(
      path.join(tmp, "release.json"),
      path.join(dir, "release.json"),
    );
    execFileSync(
      "sh",
      ["-c", "shasum -a 256 pkg-1.2.3.tgz release.json > SHA256SUMS"],
      { cwd: dir },
    );
    record("sums", dir, "v1.2.3-dev.4", DEV);
    const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
    expect(sums.trim().split("\n").pop()).toBe(
      `# built from v1.2.3-dev.4, commit ${DEV}`,
    );
    expect(() =>
      execFileSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], {
        cwd: dir,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("refuses a dev tag or commit that isn't one", () => {
    for (const args of [
      ["json", "1.2.3", "not a tag", DEV, REL],
      ["json", "1.2.3", "v1.2.3-dev.4", "xyz", REL],
      ["sums", tmp, "v1.2.3-dev.4", "xyz"],
    ])
      expect(() => record(...args)).toThrow();
  });
});
