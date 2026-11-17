/**
 * Which Nodes run what (ci.yml, release.yml).
 *
 * A pull request's tests run on both Nodes: #398's replay found real
 * failures on one Node only, on each (12 on Node 22 alone, 11 on Node 24
 * alone), in the unit tests and the browser specs. Its checks and the
 * install smoke never failed on one Node alone, so a pull request runs
 * them on Node 22 only, unless it changes the Node or the dependencies
 * (scripts/pr-nodes.js). A push to main runs everything on both Nodes, a
 * nightly run does too, and release.yml releases only from a commit whose
 * push run passed on both (scripts/release-ci-green.js).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { checkNodes, nodeChange } from "../../../scripts/pr-nodes.js";
import { judge, waitForCi } from "../../../scripts/release-ci-green.js";

const ROOT = process.cwd();
const BOTH = ["22.13.0", "24.13.0"];

interface Step {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  "runs-on"?: unknown;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { matrix?: { node?: unknown } };
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

function wf(file: string): Workflow {
  return yaml.parse(
    fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf-8"),
  ) as Workflow;
}

const CHECKS = [
  "npm run typecheck",
  "scripts/words-gate.mjs",
  "npm run lint",
  "gate:den-ui",
  "scripts/org-name-gate.mjs",
  "scripts/org-name-commits.mjs",
  "scripts/dist-smoke.sh",
];
const ON_CHECK_NODES =
  "contains(fromJSON(steps.select.outputs.check-nodes), matrix.node)";

describe("a pull request: tests on both Nodes, checks on Node 22", () => {
  const ci = wf("ci.yml");

  it("the pr job and pr-shards run the tests on both Nodes", () => {
    for (const name of ["pr", "pr-shards"])
      expect([name, ci.jobs[name].strategy?.matrix?.node]).toEqual([
        name,
        BOTH,
      ]);
  });

  it("each check and the install smoke run only on the select step's check-nodes", () => {
    const steps = ci.jobs.pr.steps ?? [];
    for (const c of CHECKS) {
      const s = steps.find((x) => (x.run ?? "").includes(c));
      expect([c, s?.if]).toEqual([c, ON_CHECK_NODES]);
    }
  });

  it("the select step picks the Nodes first, before any check", () => {
    const steps = ci.jobs.pr.steps ?? [];
    const sel = steps.findIndex((s) => s.id === "select");
    expect(sel).toBeGreaterThan(-1);
    const first = steps.findIndex((s) =>
      CHECKS.some((c) => (s.run ?? "").includes(c)),
    );
    expect(sel).toBeLessThan(first);
    const run = steps[sel].run ?? "";
    expect(run).toMatch(
      /node scripts\/pr-nodes\.js "\$BASE" HEAD --nodes "\$NODES" >> "\$GITHUB_OUTPUT"/,
    );
    // the Nodes it chooses from are the job's own matrix
    expect(steps[sel].env?.NODES).toBe(BOTH.join(","));
  });

  it("the tests in the pr job are not limited to the check Nodes", () => {
    for (const s of ci.jobs.pr.steps ?? [])
      if (/npm test|npx jest/.test(s.run ?? ""))
        expect(s.if ?? "").not.toContain("check-nodes");
  });
});

describe("the path rule (scripts/pr-nodes.js)", () => {
  it.each([
    [["package.json"], BOTH],
    [["package-lock.json"], BOTH],
    [[".nvmrc"], BOTH],
    [["packages/den-ui/package.json", "src/a.ts"], BOTH],
    [["src/ui/server/server.ts", "README.md"], ["22.13.0"]],
    [["docs/package.json.md", "tests/fixtures/package.json"], ["22.13.0"]],
    [[], ["22.13.0"]],
  ])("%j → %j", (changed, want) => {
    expect(checkNodes(changed, BOTH)).toEqual(want);
  });

  it("says which files made it a Node change", () => {
    expect(nodeChange(["a.ts", "package.json", ".nvmrc"])).toEqual([
      "package.json",
      ".nvmrc",
    ]);
  });
});

describe("main: every push, and a nightly run, on both Nodes", () => {
  const ci = wf("ci.yml");

  it("ci.yml runs on a nightly schedule", () => {
    const sched = ci.on.schedule as { cron: string }[] | undefined;
    expect(sched?.length).toBeGreaterThan(0);
    expect(sched![0].cron).toMatch(/^\S+ \S+ \* \* \*$/);
  });

  it("the full matrix runs on push and on the schedule, never on a pull request", () => {
    for (const name of ["checks", "tests", "dist-smoke"]) {
      expect([name, ci.jobs[name].if]).toEqual([
        name,
        "github.event_name != 'pull_request'",
      ]);
      expect([name, ci.jobs[name].strategy?.matrix?.node]).toEqual([
        name,
        BOTH,
      ]);
    }
    expect(ci.jobs["den-ui-nav"].if).toContain(
      "github.event_name != 'pull_request'",
    );
  });
});

describe("every push to main gets its own full run (the release guard needs it)", () => {
  // GitHub keeps one pending run per concurrency group and cancels the
  // one before it, even with cancel-in-progress off: 11 of main's last 30
  // push runs ended cancelled, and the release guard would never release
  // from those commits. A push's group is its sha.
  const c = (
    yaml.parse(
      fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "ci.yml"),
        "utf-8",
      ),
    ) as { concurrency: { group: string; "cancel-in-progress": string } }
  ).concurrency;

  it("a push's concurrency group is its own sha; a pull request's is its ref", () => {
    expect(c.group).toBe(
      "ci-${{ github.event_name }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
    );
    expect(c["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });
});

describe("release.yml: only from a commit whose push run passed on both Nodes", () => {
  const SHA = "a".repeat(40);
  const run = (over: Record<string, unknown> = {}) => ({
    id: 7,
    run_number: 3,
    head_sha: SHA,
    event: "push",
    status: "completed",
    conclusion: "success",
    ...over,
  });
  const green = [
    ...BOTH.flatMap((n) => [
      { name: `checks (${n})`, conclusion: "success" },
      { name: `dist-smoke (${n})`, conclusion: "success" },
      ...[1, 2, 3, 4].map((s) => ({
        name: `tests (${n}, ${s})`,
        conclusion: "success",
      })),
    ]),
    { name: "static", conclusion: "success" },
    { name: "den-ui-nav", conclusion: "success" },
  ];

  it("green: the push run passed, both Nodes' jobs there and green", () => {
    expect(judge([run()], green, SHA, BOTH).state).toBe("green");
  });

  it("red: the run failed", () => {
    expect(judge([run({ conclusion: "failure" })], green, SHA, BOTH)).toEqual({
      state: "red",
      reason: "ci.yml run 7 (push, aaaaaaa) ended failure",
    });
  });

  it("red: a Node's tests are missing", () => {
    const only22 = green.filter((j) => !j.name.includes("24.13.0"));
    expect(judge([run()], only22, SHA, BOTH).reason).toMatch(
      /no tests job on Node 24\.13\.0/,
    );
  });

  it("red: one Node's job didn't pass, even if the run says success", () => {
    const jobs = green.map((j) =>
      j.name === "tests (24.13.0, 2)" ? { ...j, conclusion: "skipped" } : j,
    );
    expect(judge([run()], jobs, SHA, BOTH).reason).toMatch(
      /on Node 24\.13\.0, tests \(24\.13\.0, 2\) skipped/,
    );
  });

  it("only a push run counts, and the newest one", () => {
    expect(
      judge([run({ event: "pull_request" })], green, SHA, BOTH).state,
    ).toBe("wait");
    expect(
      judge(
        [run(), run({ id: 8, run_number: 4, conclusion: "failure" })],
        green,
        SHA,
        BOTH,
      ).state,
    ).toBe("red");
  });

  it("waits while the run is going, then judges it", async () => {
    const answers = [
      { workflow_runs: [] },
      { workflow_runs: [run({ status: "in_progress", conclusion: null })] },
      { workflow_runs: [run()] },
      { jobs: green },
    ];
    const asked: string[] = [];
    let t = 0;
    const v = await waitForCi({
      api: async (p: string) => {
        asked.push(p);
        return answers.shift();
      },
      sha: SHA,
      nodes: BOTH,
      waitMinutes: 10,
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
    });
    expect(v.state).toBe("green");
    expect(asked[0]).toBe(
      `actions/workflows/ci.yml/runs?head_sha=${SHA}&event=push&per_page=20`,
    );
    expect(asked[3]).toMatch(/^actions\/runs\/7\/jobs\?filter=latest/);
  });

  it("gives up after CI_WAIT_MINUTES: not released, and says why", async () => {
    let t = 0;
    const v = await waitForCi({
      api: async () => ({
        workflow_runs: [run({ status: "queued", conclusion: null })],
      }),
      sha: SHA,
      nodes: BOTH,
      waitMinutes: 2,
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
    });
    expect(v.state).toBe("red");
    expect(v.reason).toMatch(/is queued after 2 min \(CI_WAIT_MINUTES\)/);
  });

  describe("the check job runs it", () => {
    const rel = wf("release.yml");
    const check = rel.jobs.check;
    const step = (check.steps ?? []).find((s) =>
      (s.run ?? "").includes("scripts/release-ci-green.js"),
    );

    it("after the version check, only when that one says release, with github.token", () => {
      expect(step).toBeDefined();
      expect(step!.id).toBe("ci");
      expect(step!.if).toBe("steps.check.outputs.release == 'true'");
      expect(step!.run).toContain('"$GITHUB_SHA"');
      expect(step!.env?.GH_TOKEN).toBe("${{ github.token }}");
      const ids = (check.steps ?? []).map((s) => s.id);
      expect(ids.indexOf("check")).toBeLessThan(ids.indexOf("ci"));
    });

    it("on ci.yml's Nodes", () => {
      expect(step!.env?.NODES).toBe(
        (wf("ci.yml").jobs.tests.strategy?.matrix?.node as string[]).join(" "),
      );
    });

    it("release is true only when both say so", () => {
      expect(check.outputs?.release).toBe(
        "${{ steps.check.outputs.release == 'true' && steps.ci.outputs.release == 'true' && 'true' || 'false' }}",
      );
    });

    it("may read Actions, waits long enough, and stays GitHub-hosted", () => {
      expect(check.permissions).toEqual({ contents: "read", actions: "read" });
      expect(check["runs-on"]).toBe("ubuntu-latest");
      expect(step!.env?.CI_WAIT_MINUTES).toMatch(
        /vars\.RELEASE_CI_WAIT_MINUTES/,
      );
      expect(check["timeout-minutes"]).toBeGreaterThanOrEqual(60);
    });
  });
});
