import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();
const TEST = "tests/unit/agents/os-user-linux-988.test.ts";
const text = fs.readFileSync(
  path.join(ROOT, ".github", "workflows", "ci.yml"),
  "utf-8",
);
interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: unknown;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
}
const ci = yaml.parse(text) as { jobs: Record<string, Job> };
const job = ci.jobs["os-user-linux"];
const runs = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");

describe("the real-Linux OS-user test runs in CI (issue 1736)", () => {
  it("is a job of its own, on a GitHub-hosted runner, with read-only access", () => {
    expect(job).toBeDefined();
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|DEN_SELF_HOSTED/);
    const checkout = (job.steps ?? []).find((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("runs the test as root with DEN_OS_USER_E2E=1, and fails if it ran nothing", () => {
    expect(runs).toMatch(/sudo /);
    expect(runs).toMatch(/DEN_OS_USER_E2E=1/);
    expect(runs).toContain(TEST);
    expect(runs).toMatch(/numPendingTests/);
    expect(runs).toMatch(/numPassedTests/);
  });

  it("closes the runner's open /opt to 0755 before the test, as a real machine has it", () => {
    const at = (re: RegExp) => runs.search(re);
    expect(at(/sudo chmod 0755 \/opt\n/)).toBeGreaterThan(-1);
    expect(at(/sudo chmod 0755 \/opt\n/)).toBeLessThan(at(/DEN_OS_USER_E2E=1/));
  });

  it("runs on a pull request that touches the OS-user code, and by hand", () => {
    expect(job.needs).toEqual(["fast", "pr"]);
    expect(job.if).toMatch(/workflow_dispatch/);
    expect(job.if).toMatch(/needs\.pr\.outputs\.osuser == 'true'/);
    expect(job.if).toMatch(/needs\.fast\.result == 'success'/);
    const pr = ci.jobs.pr;
    expect(pr.outputs?.osuser).toMatch(/steps\.select\.outputs\.osuser/);
    const select = (pr.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(select).toContain(TEST);
    expect(select).toMatch(/osuser=true/);
  });
});
