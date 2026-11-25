/**
 * Issue 1560: a pull request watch that stayed "running" after every run
 * on its head had ended, and a new ask that handed back a watch on a head
 * a later push had replaced.
 *
 * 1. With several heads watched in a repo, each round lists the repo's
 *    workflow runs: one page, the newest 100. In a busy repo a head's runs
 *    fall off that page within hours, and the watch kept its last note
 *    ("1 of 2 workflow runs still going.") for good. It must still finish,
 *    once, with the failure.
 * 2. A new ask for a pull request whose head moved gets a new watch on the
 *    new head, and the old one ends ("replaced by <sha>").
 * GitHub is a fake (fake-github.ts) that pages as GitHub does.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import { GithubWatcher } from "../../../../src/shared/github-watch/watcher.js";
import type { GithubWatchSettings } from "../../../../src/shared/github-watch/settings.js";
import type { Delivery } from "../../../../src/shared/hub-delivery.js";
import { FakeGithub } from "./fake-github.js";

const A = "acme/north";
const SHA1 = "a1".repeat(20);
const SHA2 = "b2".repeat(20);
const SHA9 = "f9".repeat(20);

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

const ask = (pr: number) => ({
  agent: "planner",
  project: "north",
  repo: A,
  allowedRepos: [A],
  pr,
});

/** Rounds of the loop, each when it is due, delivering as the server does. */
async function rounds(w: GithubWatcher, n: number) {
  for (let i = 0; i < n; i++) {
    t = Math.max(t, w.nextAt);
    await w.tick();
    await w.deliver();
  }
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
  };
  gh.pr(A, 1, SHA1);
  gh.pr(A, 2, SHA2);
});

describe("issue 1560: a watch whose runs left the list's page", () => {
  it("still finishes once every run on its head has ended, with the failure", async () => {
    const w = watcher();
    gh.run(A, {
      id: 101,
      name: "ci",
      status: "completed",
      conclusion: "success",
      head_sha: SHA1,
      check_suite_id: 1,
    });
    gh.run(A, {
      id: 102,
      name: "pr-shards",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA1,
      check_suite_id: 2,
    });
    gh.check(A, SHA1, {
      id: 11,
      name: "lint",
      status: "completed",
      conclusion: "success",
      suite: 1,
    });
    gh.check(A, SHA1, {
      id: 12,
      name: "shard 3",
      status: "in_progress",
      conclusion: null,
      suite: 2,
    });
    // A second head in the repo, still going: each round lists the runs.
    gh.run(A, {
      id: 201,
      name: "ci",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA2,
      check_suite_id: 3,
    });
    const one = await w.create(ask(1));
    const two = await w.create(ask(2));
    if (!one.ok || !two.ok) throw new Error("not created");
    await rounds(w, 1);
    expect(w.list("planner").find((x) => x.id === one.watch.id)?.note).toBe(
      "1 of 2 workflow runs still going.",
    );
    // A busy repo: 120 newer runs, on other heads, push its runs off the
    // list's page; then its last run fails.
    for (let i = 0; i < 120; i++)
      gh.run(A, {
        id: 1000 + i,
        name: "ci",
        status: "completed",
        conclusion: "success",
        head_sha: SHA9,
        check_suite_id: 900 + i,
      });
    gh.run(A, {
      id: 102,
      name: "pr-shards",
      status: "completed",
      conclusion: "failure",
      head_sha: SHA1,
      check_suite_id: 2,
    });
    gh.check(A, SHA1, {
      id: 12,
      name: "shard 3",
      status: "completed",
      conclusion: "failure",
      suite: 2,
    });
    await rounds(w, 6);
    const mine = sent.filter((d) => (d.text ?? "").includes(one.watch.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("1 passed, 1 failed");
    expect(mine[0]!.text).toContain("Failed: shard 3 (");
    // The other head is still going: it is not told.
    expect(sent.some((d) => (d.text ?? "").includes(two.watch.id))).toBe(false);
  });
});

describe("issue 1560: a new ask after the head moved", () => {
  it("makes a new watch on the new head, and the old one ends, replaced", async () => {
    const w = watcher();
    const first = await w.create(ask(1));
    if (!first.ok) throw new Error("not created");
    expect(first.watch.head).toBe(SHA1);
    gh.pr(A, 1, SHA2); // a push
    const again = await w.create(ask(1));
    if (!again.ok) throw new Error("not created");
    expect(again.watch.id).not.toBe(first.watch.id);
    expect(again.watch.head).toBe(SHA2);
    const old = w.list("planner").find((x) => x.id === first.watch.id);
    expect(old).toMatchObject({ state: "done" });
    expect(old?.note).toBe(
      `Replaced by watch ${again.watch.id} on head ${SHA2.slice(0, 7)}.`,
    );
    // Same head again: the same watch, as before.
    const same = await w.create(ask(1));
    expect(same.ok && same.watch.id).toBe(again.watch.id);
  });
});
