import { beforeEach, describe, expect, it } from "@jest/globals";
import { GithubWatcher } from "../../../../src/shared/github-watch/watcher.js";
import type { GithubWatchSettings } from "../../../../src/shared/github-watch/settings.js";
import type { Delivery } from "../../../../src/shared/hub-delivery.js";
import { FakeGithub } from "./fake-github.js";

const A = "acme/north";
const SHA1 = "c3".repeat(20);

let t = Date.parse("2030-01-01T12:00:00Z");
const now = () => t;
let gh: FakeGithub;
let sent: Delivery[];
let settings: GithubWatchSettings;

function watcher() {
  return new GithubWatcher({
    get: gh.get,
    settings: () => settings,
    relay: async (dv) => {
      sent.push(dv);
      return true;
    },
    now,
  });
}

async function rounds(w: GithubWatcher, n: number) {
  for (let i = 0; i < n; i++) {
    t = Math.max(t, w.nextAt);
    await w.tick();
    await w.deliver();
  }
}

function run(
  suite: number,
  wf: number,
  o: {
    conclusion?: string | null;
    event?: string;
    created?: string;
    prs?: number[];
  } = {},
) {
  gh.run(A, {
    id: 900 + suite,
    name: `wf-${wf}`,
    status: "completed",
    conclusion: o.conclusion === undefined ? "success" : o.conclusion,
    head_sha: SHA1,
    check_suite_id: suite,
    workflow_id: wf,
    ...(o.event ? { event: o.event } : {}),
    ...(o.created ? { created_at: o.created } : {}),
    ...(o.prs ? { pull_requests: o.prs.map((number) => ({ number })) } : {}),
  });
}

function check(
  id: number,
  name: string,
  suite: number,
  conclusion: string,
  started?: string,
) {
  gh.check(A, SHA1, {
    id,
    name,
    status: "completed",
    conclusion,
    suite,
    ...(started ? { started_at: started } : {}),
  });
}

async function result(): Promise<string> {
  const w = watcher();
  const r = await w.create({
    agent: "planner",
    project: "north",
    repo: A,
    allowedRepos: [A],
    pr: 1,
  });
  if (!r.ok) throw new Error("not created");
  await rounds(w, 6);
  const mine = sent.filter((d) => (d.text ?? "").includes(r.watch.id));
  expect(mine).toHaveLength(1);
  return mine[0]!.text ?? "";
}

beforeEach(() => {
  t = Date.parse("2030-01-01T12:00:00Z");
  gh = new FakeGithub(now);
  sent = [];
  settings = {
    intervalSeconds: 60,
    maxIntervalSeconds: 300,
    budgetFloor: 500,
    watchesMax: 50,
    staleMinutes: 60,
    maxOpenHours: 24,
    rerunLookMinutes: 5,
  };
  gh.pr(A, 1, SHA1);
});

describe("issue 1279: per workflow, only its newest run on the head counts", () => {
  it("an older run's job that the newest run doesn't have is left out", async () => {
    run(1, 70, { conclusion: "failure", created: "2030-01-01T11:00:00Z" });
    check(11, "no-label", 1, "failure", "2030-01-01T11:00:10Z");
    check(12, "tests", 1, "failure", "2030-01-01T11:00:10Z");
    run(2, 70, { created: "2030-01-01T11:02:00Z" });
    check(21, "tests", 2, "success", "2030-01-01T11:02:10Z");
    const text = await result();
    expect(text).toContain("1 passed, 0 failed, 0 skipped.");
    expect(text).toContain("All passed.");
  });

  it("an older run cancelled by a newer one is never a failure, nor listed as cancelled", async () => {
    run(1, 71, { conclusion: "cancelled", created: "2030-01-01T11:00:00Z" });
    check(11, "closing-keywords", 1, "cancelled", "2030-01-01T11:00:05Z");
    check(12, "ci-ok", 1, "failure", "2030-01-01T11:00:06Z");
    run(2, 71, { created: "2030-01-01T11:00:20Z" });
    check(21, "closing-keywords", 2, "success", "2030-01-01T11:00:25Z");
    const text = await result();
    expect(text).toContain("1 passed, 0 failed, 0 skipped.");
    expect(text).not.toContain("cancelled");
  });

  it("the newest run's own failure still counts", async () => {
    run(1, 72, { created: "2030-01-01T11:00:00Z" });
    check(11, "tests", 1, "success", "2030-01-01T11:00:10Z");
    run(2, 72, { conclusion: "failure", created: "2030-01-01T11:05:00Z" });
    check(21, "tests", 2, "failure", "2030-01-01T11:05:10Z");
    const text = await result();
    expect(text).toContain("0 passed, 1 failed, 0 skipped.");
    expect(text).toContain("Failed: tests");
  });
});

describe("issue 1608: a PR watch counts only the PR's own runs", () => {
  it("workflow_dispatch and push runs that share the head are left out", async () => {
    run(1, 73);
    check(11, "tests", 1, "success");
    run(2, 74, { event: "workflow_dispatch", conclusion: "failure" });
    check(21, "verify", 2, "failure");
    run(3, 75, { event: "push", conclusion: "cancelled" });
    check(31, "deploy", 3, "cancelled");
    const text = await result();
    expect(text).toContain("1 passed, 0 failed, 0 skipped.");
    expect(text).toContain("All passed.");
  });

  it("pull_request_target and merge_group runs count", async () => {
    run(1, 76, { event: "pull_request_target" });
    check(11, "label-check", 1, "success");
    run(2, 77, { event: "merge_group", conclusion: "failure" });
    check(21, "queue-tests", 2, "failure");
    const text = await result();
    expect(text).toContain("1 passed, 1 failed, 0 skipped.");
  });

  it("another PR's newer run on the same head never hides this PR's failure", async () => {
    run(1, 79, {
      conclusion: "failure",
      created: "2030-01-01T11:00:00Z",
      prs: [1],
    });
    check(11, "tests", 1, "failure", "2030-01-01T11:00:10Z");
    run(2, 79, { created: "2030-01-01T11:05:00Z", prs: [2] });
    check(21, "tests", 2, "success", "2030-01-01T11:05:10Z");
    const text = await result();
    expect(text).toContain("0 passed, 1 failed, 0 skipped.");
    expect(text).toContain("Failed: tests");
  });

  it("a run with no pull request listed (a fork's, a merge queue's) still counts", async () => {
    run(1, 80, { conclusion: "failure", prs: [] });
    check(11, "tests", 1, "failure");
    const text = await result();
    expect(text).toContain("0 passed, 1 failed, 0 skipped.");
  });

  it("another app's checks (no workflow run at all) still count", async () => {
    run(1, 78);
    check(11, "tests", 1, "success");
    check(41, "external-scan", 99, "failure");
    const text = await result();
    expect(text).toContain("1 passed, 1 failed, 0 skipped.");
  });
});
