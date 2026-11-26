import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
const wf = yaml.parse(
  fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "pr-text.yml"),
    "utf-8",
  ),
) as {
  on: Record<string, unknown>;
  concurrency: { group: string };
  jobs: Record<string, { steps: Step[]; if?: string }>;
};
const job = wf.jobs["closing-keywords"];
const check = job?.steps.find((s) => s.run?.includes("no-close-keywords.mjs"));

describe("closing-keywords on the merge queue (issue 1235)", () => {
  it("runs on pull requests and on merge-queue runs, under the same job name", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["merge_group", "pull_request"]);
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
  });

  it("checks the pull request's range, or the merge group's", () => {
    expect(check?.env?.RANGE_BASE).toMatch(/pull_request\.base\.sha/);
    expect(check?.env?.RANGE_BASE).toMatch(/merge_group\.base_sha/);
    expect(check?.env?.RANGE_HEAD).toMatch(/pull_request\.head\.sha/);
    expect(check?.env?.RANGE_HEAD).toMatch(/merge_group\.head_sha/);
    expect(check?.run).toContain('"$RANGE_BASE..$RANGE_HEAD"');
  });

  it("changelog-line runs on pull requests only (a merge group has no body or pull request range)", () => {
    expect(wf.jobs["changelog-line"]?.if).toBe("github.event_name == 'pull_request'");
  });

  it("a merge-queue run has its own concurrency group (it has no pull request number)", () => {
    expect(wf.concurrency.group).toMatch(/pull_request\.number/);
    expect(wf.concurrency.group).toMatch(/github\.ref/);
  });
});
