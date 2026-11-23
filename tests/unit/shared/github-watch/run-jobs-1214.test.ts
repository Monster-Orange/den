/**
 * Issue 1214: a watch on a workflow run counts that run's own jobs (the
 * latest attempt, actions/runs/<id>/jobs), never the check runs on its
 * head commit, where filter=latest lets a push run's jobs with the same
 * names hide them and a busy head pushes them off page one. A re-run
 * reopens the watch. A pull request's watch pages past 100 check runs.
 * GitHub is a fake (fake-github.ts): no network. Invented names only.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import { GithubWatcher } from "../../../../src/shared/github-watch/watcher.js";
import {
  githubWatchSettings,
  type GithubWatchSettings,
} from "../../../../src/shared/github-watch/settings.js";
import type { Delivery } from "../../../../src/shared/hub-delivery.js";
import { FakeGithub } from "./fake-github.js";

const A = "acme/north";
const SHA1 = "a1".repeat(20);
const MIN = 60_000;

let t = Date.parse("2030-01-01T12:00:00Z");
const now = () => t;
let gh: FakeGithub;
let sent: Delivery[];
let settings: GithubWatchSettings;

const watcher = () =>
  new GithubWatcher({
    get: (p) => gh.get(p),
    settings: () => settings,
    relay: async (dv) => {
      sent.push(dv);
      return true;
    },
    now,
  });
const ask = (o: { pr?: number; run?: number }) => ({
  agent: "planner",
  project: "north",
  repo: A,
  allowedRepos: [A],
  ...o,
});
async function minutes(w: GithubWatcher, mins: number) {
  for (let i = 0; i < mins; i++) {
    t += MIN;
    await w.tick();
    await w.deliver();
  }
}
const run = (
  id: number,
  status: string,
  conclusion: string | null,
  attempt = 1,
) =>
  gh.run(A, {
    id,
    name: "e2e",
    status,
    conclusion,
    head_sha: SHA1,
    check_suite_id: id + 1000,
    run_attempt: attempt,
  });

beforeEach(() => {
  t = Date.parse("2030-01-01T12:00:00Z");
  gh = new FakeGithub(now);
  gh.remaining = 4900;
  sent = [];
  settings = {
    intervalSeconds: 60,
    maxIntervalSeconds: 60,
    budgetFloor: 500,
    watchesMax: 50,
    staleMinutes: 60,
    maxOpenHours: 24,
    rerunLookMinutes: 5,
  };
  gh.pr(A, 1, SHA1);
});

describe("a run watch counts the run's own jobs", () => {
  it("a dispatched run whose head also has a push run with the same job names: its 27 jobs and 1 failure", async () => {
    // The push run on the same head: the same 27 job names, all passed,
    // newer (filter=latest on the commit would keep these).
    run(800, "completed", "success");
    for (let i = 0; i < 27; i++)
      gh.check(A, SHA1, {
        id: 5000 + i,
        name: `job-${i}`,
        status: "completed",
        conclusion: "success",
        suite: 1800,
      });
    // The dispatched run, still going.
    run(900, "in_progress", null);
    for (let i = 0; i < 27; i++)
      gh.job(A, 900, {
        id: 9000 + i,
        name: `job-${i}`,
        status: "in_progress",
        conclusion: null,
      });
    const w = watcher();
    expect((await w.create(ask({ run: 900 }))).ok).toBe(true);
    await minutes(w, 2);
    expect(w.list("planner")[0].state).toBe("running");
    // It finishes: 26 passed, 1 failed.
    run(900, "completed", "failure");
    for (let i = 0; i < 27; i++)
      gh.job(A, 900, {
        id: 9000 + i,
        name: `job-${i}`,
        status: "completed",
        conclusion: i === 13 ? "failure" : "success",
      });
    await minutes(w, 3);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("run 900");
    expect(sent[0].text).toContain("26 passed, 1 failed, 0 skipped");
    expect(sent[0].text).toContain(
      `job-13 (https://github.example/${A}/actions/runs/900/job/9013)`,
    );
    // Never the head's check runs.
    expect(gh.calls.some((c) => c.includes("/check-runs"))).toBe(false);
  });

  it("an older run, finished before the watch: found and reported at once, whatever the runs list holds", async () => {
    run(700, "completed", "success");
    gh.job(A, 700, {
      id: 1,
      name: "lint",
      status: "completed",
      conclusion: "success",
    });
    const w = watcher();
    await w.create(ask({ run: 700 }));
    await minutes(w, 2);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("1 passed, 0 failed");
    expect(sent[0].text).not.toMatch(/no checks/i);
  });

  it("more than 100 jobs: counts every page", async () => {
    run(901, "completed", "success");
    for (let i = 0; i < 130; i++)
      gh.job(A, 901, {
        id: i + 1,
        name: `shard-${i}`,
        status: "completed",
        conclusion: "success",
      });
    const w = watcher();
    await w.create(ask({ run: 901 }));
    await minutes(w, 2);
    expect(sent[0].text).toContain("130 passed");
  });

  it("a re-run: the watch reopens and reports attempt 2's result", async () => {
    run(902, "completed", "failure");
    gh.job(A, 902, {
      id: 1,
      name: "e2e",
      status: "completed",
      conclusion: "failure",
    });
    const w = watcher();
    await w.create(ask({ run: 902 }));
    await minutes(w, 2);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("0 passed, 1 failed");
    // Re-run: attempt 2 starts, then passes.
    run(902, "in_progress", null, 2);
    gh.job(A, 902, {
      id: 2,
      name: "e2e",
      status: "in_progress",
      conclusion: null,
      attempt: 2,
    });
    await minutes(w, 6);
    const v = w.list("planner")[0];
    expect(v.state).toBe("running");
    expect(v.note).toMatch(/attempt 2/i);
    run(902, "completed", "success", 2);
    gh.job(A, 902, {
      id: 2,
      name: "e2e",
      status: "completed",
      conclusion: "success",
      attempt: 2,
    });
    await minutes(w, 5);
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toMatch(/attempt 2/);
    expect(sent[1].text).toContain("1 passed, 0 failed");
  });
});

describe("looking for a re-run costs little", () => {
  it("a finished run is looked at no more than every github.rerun_look_minutes", async () => {
    run(903, "completed", "success");
    gh.job(A, 903, {
      id: 1,
      name: "lint",
      status: "completed",
      conclusion: "success",
    });
    const w = watcher();
    await w.create(ask({ run: 903 }));
    await minutes(w, 2);
    expect(sent).toHaveLength(1);
    // Told at minute 1: no look until minute 6.
    gh.calls = [];
    await minutes(w, 3);
    expect(gh.calls.filter((c) => c === `repos/${A}/actions/runs/903`)).toEqual(
      [],
    );
    await minutes(w, 20);
    const looks = gh.calls.filter(
      (c) => c === `repos/${A}/actions/runs/903`,
    ).length;
    expect(looks).toBeGreaterThanOrEqual(3);
    expect(looks).toBeLessThanOrEqual(5);
  });

  it("is a Setting: github.rerun_look_minutes, 5 by default, kept in range", () => {
    expect(githubWatchSettings({}).rerunLookMinutes).toBe(5);
    expect(
      githubWatchSettings({ github: { rerun_look_minutes: 15 } })
        .rerunLookMinutes,
    ).toBe(15);
    expect(
      githubWatchSettings({ github: { rerun_look_minutes: 0 } })
        .rerunLookMinutes,
    ).toBe(5);
  });
});

describe("a pull request's watch pages past 100 check runs", () => {
  it("a head with more than 100 check runs: counts all of them", async () => {
    for (let i = 0; i < 150; i++)
      gh.check(A, SHA1, {
        id: i + 1,
        name: `check-${i}`,
        status: "completed",
        conclusion: i === 140 ? "failure" : "success",
        suite: 5,
      });
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    await minutes(w, 2);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("149 passed, 1 failed");
    expect(sent[0].text).toContain("check-140");
  });

  it("a check still going on page two keeps it running", async () => {
    for (let i = 0; i < 120; i++)
      gh.check(A, SHA1, {
        id: i + 1,
        name: `check-${i}`,
        status: i === 110 ? "in_progress" : "completed",
        conclusion: i === 110 ? null : "success",
        suite: 5,
      });
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    await minutes(w, 2);
    expect(sent).toHaveLength(0);
    expect(w.list("planner")[0].state).toBe("running");
  });
});
