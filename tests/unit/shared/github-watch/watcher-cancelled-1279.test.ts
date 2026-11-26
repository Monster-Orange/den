/**
 * Issues 1279 and 1065: a watch reported checks that no longer counted as
 * failures.
 *
 * 1. A newer run of the same check on the same head (a re-run, a label
 *    added, a PR's text edited): the older one, cancelled or failed, is
 *    superseded. Only the newest of each name counts, as the PR's own
 *    check list shows.
 * 2. A cancelled check is not a failure: it is counted and listed as
 *    cancelled. That goes for a run watch's jobs too.
 * 3. A push cancels the old head's runs (cancel-in-progress): before a
 *    result with cancelled checks is reported, Den looks at the pull
 *    request's head. Moved, the watch ends as replaced, with no failures
 *    listed; still the head, the result is reported.
 * GitHub is a fake (fake-github.ts).
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import { GithubWatcher } from "../../../../src/shared/github-watch/watcher.js";
import type { GithubWatchSettings } from "../../../../src/shared/github-watch/settings.js";
import type { Delivery } from "../../../../src/shared/hub/hub-delivery.js";
import { FakeGithub } from "./fake-github.js";

const A = "acme/north";
const SHA1 = "a1".repeat(20);
const SHA2 = "b2".repeat(20);

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

const ask = (o: { pr?: number; run?: number }) => ({
  agent: "planner",
  project: "north",
  repo: A,
  allowedRepos: [A],
  ...o,
});

async function rounds(w: GithubWatcher, n: number) {
  for (let i = 0; i < n; i++) {
    t = Math.max(t, w.nextAt);
    await w.tick();
    await w.deliver();
  }
}

/** A workflow run on SHA1: check suite `suite`, of workflow `wf`. */
const wfRun = (
  suite: number,
  wf: number,
  status = "completed",
  conclusion: string | null = "success",
) =>
  gh.run(A, {
    id: 500 + suite,
    name: `wf-${wf}`,
    status,
    conclusion,
    head_sha: SHA1,
    check_suite_id: suite,
    workflow_id: wf,
  });

const told = (id: string) => sent.filter((d) => (d.text ?? "").includes(id));

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

describe("issue 1279: a check superseded on the same head", () => {
  it("only the newest run of each name counts", async () => {
    const w = watcher();
    gh.check(A, SHA1, {
      id: 11,
      name: "lint",
      status: "completed",
      conclusion: "success",
      suite: 1,
    });
    // A first run, cancelled when an edit started a second; the second passed.
    gh.check(A, SHA1, {
      id: 12,
      name: "closing-keywords",
      status: "completed",
      conclusion: "cancelled",
      suite: 2,
      started_at: "2030-01-01T11:20:00Z",
    });
    gh.check(A, SHA1, {
      id: 13,
      name: "closing-keywords",
      status: "completed",
      conclusion: "success",
      suite: 3,
      started_at: "2030-01-01T11:36:00Z",
    });
    // An unlabelled run failed fast; the labelled run passed.
    gh.check(A, SHA1, {
      id: 14,
      name: "tests",
      status: "completed",
      conclusion: "failure",
      suite: 4,
    });
    gh.check(A, SHA1, {
      id: 15,
      name: "tests",
      status: "completed",
      conclusion: "success",
      suite: 5,
    });
    // Suite 1: one workflow; 2 and 3: runs of another (pr-text); 4 and 5:
    // runs of a third (ci).
    wfRun(1, 70);
    wfRun(2, 71, "completed", "cancelled");
    wfRun(3, 71);
    wfRun(4, 72, "completed", "failure");
    wfRun(5, 72);
    const r = await w.create(ask({ pr: 1 }));
    if (!r.ok) throw new Error("not created");
    await rounds(w, 5);
    const mine = told(r.watch.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("3 passed, 0 failed, 0 skipped.");
    expect(mine[0]!.text).toContain("All passed.");
  });

  it("two workflows with a job of the same name: both count, the older one's failure too", async () => {
    const w = watcher();
    // ci.yml and release-gates.yml on one head, each with a job "test".
    gh.check(A, SHA1, {
      id: 31,
      name: "test",
      status: "completed",
      conclusion: "failure",
      suite: 6,
      started_at: "2030-01-01T11:10:00Z",
    });
    gh.check(A, SHA1, {
      id: 32,
      name: "test",
      status: "completed",
      conclusion: "success",
      suite: 7,
      started_at: "2030-01-01T11:30:00Z",
    });
    wfRun(6, 80, "completed", "failure");
    wfRun(7, 81);
    const r = await w.create(ask({ pr: 1 }));
    if (!r.ok) throw new Error("not created");
    await rounds(w, 5);
    const mine = told(r.watch.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("1 passed, 1 failed, 0 skipped.");
    expect(mine[0]!.text).toContain(
      "Failed: test (https://github.example/acme/north/runs/31)",
    );
  });

  it("checks of another app (no workflow run) are never merged, after one look", async () => {
    const w = watcher();
    gh.check(A, SHA1, {
      id: 41,
      name: "deploy",
      status: "completed",
      conclusion: "failure",
      suite: 8,
    });
    gh.check(A, SHA1, {
      id: 42,
      name: "deploy",
      status: "completed",
      conclusion: "success",
      suite: 9,
    });
    const r = await w.create(ask({ pr: 1 }));
    if (!r.ok) throw new Error("not created");
    await rounds(w, 6);
    const mine = told(r.watch.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("1 passed, 1 failed");
    // GitHub was asked which workflow they belong to, once.
    expect(gh.calls.filter((c) => c.includes("head_sha="))).toHaveLength(1);
  });

  it("a newer run still going: it isn't finished on the older run's result", async () => {
    const w = watcher();
    gh.check(A, SHA1, {
      id: 14,
      name: "tests",
      status: "completed",
      conclusion: "failure",
      suite: 4,
    });
    gh.check(A, SHA1, {
      id: 15,
      name: "tests",
      status: "in_progress",
      conclusion: null,
      suite: 5,
    });
    wfRun(4, 72, "completed", "failure");
    wfRun(5, 72, "in_progress", null);
    const r = await w.create(ask({ pr: 1 }));
    if (!r.ok) throw new Error("not created");
    await rounds(w, 3);
    expect(told(r.watch.id)).toEqual([]);
    gh.check(A, SHA1, {
      id: 15,
      name: "tests",
      status: "completed",
      conclusion: "success",
      suite: 5,
    });
    await rounds(w, 3);
    expect(told(r.watch.id)).toHaveLength(1);
    expect(told(r.watch.id)[0]!.text).toContain("1 passed, 0 failed");
  });
});

describe("issue 1065: cancelled is not failed", () => {
  it("still the head: reported as cancelled, after a look at the head", async () => {
    const w = watcher();
    gh.check(A, SHA1, {
      id: 11,
      name: "lint",
      status: "completed",
      conclusion: "success",
      suite: 1,
    });
    gh.check(A, SHA1, {
      id: 12,
      name: "shard 2",
      status: "completed",
      conclusion: "cancelled",
      suite: 1,
    });
    const r = await w.create(ask({ pr: 1 }));
    if (!r.ok) throw new Error("not created");
    gh.calls = [];
    await rounds(w, 5);
    const mine = told(r.watch.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(
      "1 passed, 0 failed, 0 skipped, 1 cancelled.",
    );
    expect(mine[0]!.text).toContain("Cancelled, not passed: shard 2 (");
    expect(mine[0]!.text).not.toContain("Failed:");
    expect(mine[0]!.text).not.toContain("All passed.");
    // The pull request was looked at before it was reported.
    expect(gh.calls).toContain(`repos/${A}/pulls/1`);
  });

  it("a push moved the head: the watch ends as replaced, no failures listed", async () => {
    const w = watcher();
    const r = await w.create(ask({ pr: 1 }));
    if (!r.ok) throw new Error("not created");
    gh.pr(A, 1, SHA2); // a push; cancel-in-progress cancels the old head's runs
    for (let i = 0; i < 12; i++)
      gh.check(A, SHA1, {
        id: 20 + i,
        name: `pr-shards (${i})`,
        status: "completed",
        conclusion: "cancelled",
        suite: 2,
      });
    gh.check(A, SHA1, {
      id: 40,
      name: "fast",
      status: "completed",
      conclusion: "success",
      suite: 2,
    });
    await rounds(w, 5);
    const mine = told(r.watch.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(`was replaced by ${SHA2.slice(0, 7)}`);
    expect(mine[0]!.text).not.toContain("failed:");
    expect(mine[0]!.text).not.toMatch(/[1-9]\d* failed/);
  });

  it("a run watch's cancelled jobs are cancelled, not failed", async () => {
    const w = watcher();
    gh.run(A, {
      id: 900,
      name: "ci",
      status: "completed",
      conclusion: "cancelled",
      head_sha: SHA1,
      check_suite_id: 9,
    });
    gh.job(A, 900, {
      id: 1,
      name: "fast",
      status: "completed",
      conclusion: "success",
    });
    for (let i = 0; i < 4; i++)
      gh.job(A, 900, {
        id: 2 + i,
        name: `shard ${i}`,
        status: "completed",
        conclusion: "cancelled",
      });
    const r = await w.create(ask({ run: 900 }));
    if (!r.ok) throw new Error("not created");
    await rounds(w, 4);
    const mine = told(r.watch.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(
      "1 passed, 0 failed, 0 skipped, 4 cancelled.",
    );
    expect(mine[0]!.text).not.toContain("Failed:");
  });
});
