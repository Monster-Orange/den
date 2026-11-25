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
    staleMinutes: 60,
    maxOpenHours: 24,
    rerunLookMinutes: 5,
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

describe("issue 1560: a head off the page isn't done while a run on it is still going", () => {
  it("its check runs all complete, a later job not started: it waits, then finishes", async () => {
    const w = watcher();
    // A run still going whose next job (needs:) has no check run yet.
    gh.run(A, {
      id: 101,
      name: "ci",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA1,
      check_suite_id: 1,
    });
    gh.check(A, SHA1, {
      id: 11,
      name: "build",
      status: "completed",
      conclusion: "success",
      suite: 1,
    });
    gh.run(A, {
      id: 201,
      name: "ci",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA2,
      check_suite_id: 3,
    });
    const one = await w.create(ask(1));
    await w.create(ask(2));
    if (!one.ok) throw new Error("not created");
    for (let i = 0; i < 120; i++)
      gh.run(A, {
        id: 3000 + i,
        name: "ci",
        status: "completed",
        conclusion: "success",
        head_sha: SHA9,
        check_suite_id: 990 + i,
      });
    await rounds(w, 8);
    expect(sent.filter((d) => (d.text ?? "").includes(one.watch.id))).toEqual(
      [],
    );
    expect(
      w.list("planner").find((x) => x.id === one.watch.id)?.state,
    ).not.toBe("done");
    // The later job runs and fails; the run completes.
    gh.check(A, SHA1, {
      id: 12,
      name: "e2e",
      status: "completed",
      conclusion: "failure",
      suite: 1,
    });
    gh.run(A, {
      id: 101,
      name: "ci",
      status: "completed",
      conclusion: "failure",
      head_sha: SHA1,
      check_suite_id: 1,
    });
    await rounds(w, 8);
    const mine = sent.filter((d) => (d.text ?? "").includes(one.watch.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("1 passed, 1 failed");
    expect(mine[0]!.text).toContain("Failed: e2e (");
  });
});

describe("issue 1560: the head moved, and the new ask is refused", () => {
  const movedNote = `The pull request's head moved to ${SHA2.slice(0, 7)}.`;

  it("the queue is full (too_many): the old watch ends saying so, and the refusal says it too", async () => {
    settings = { ...settings, watchesMax: 2 };
    gh.remaining = 600; // over the floor, paying for one watch an hour: the cap is watches_max
    gh.reset = Math.floor(t / 1000) + 3600;
    const w = watcher();
    expect((await w.create(ask(2))).ok).toBe(true);
    const first = await w.create(ask(1));
    if (!first.ok) throw new Error("not created");
    settings = { ...settings, watchesMax: 1 };
    for (let n = 100; ; n++) {
      const q = await w.create(ask(n));
      if (!q.ok) break; // the queue is full
    }
    gh.pr(A, 1, SHA2); // a push
    const again = await w.create(ask(1));
    if (again.ok) throw new Error("not refused");
    expect(again.code).toBe("too_many");
    expect(again.error).toContain(
      `${first.watch.id} on head ${SHA1.slice(0, 7)} ended: ${movedNote}`,
    );
    const old = w.list("planner").find((x) => x.id === first.watch.id);
    expect(old).toMatchObject({ state: "done", note: movedNote });
  });

  it("GitHub's budget is low (budget_low): the same", async () => {
    const w = watcher();
    const first = await w.create(ask(1));
    if (!first.ok) throw new Error("not created");
    gh.pr(A, 1, SHA2); // a push
    gh.remaining = 420; // the look at the head comes back under the floor
    gh.reset = Math.floor(t / 1000) + 900;
    const again = await w.create(ask(1));
    if (again.ok) throw new Error("not refused");
    expect(again.code).toBe("budget_low");
    expect(again.error).toContain(
      `${first.watch.id} on head ${SHA1.slice(0, 7)} ended: ${movedNote}`,
    );
    const old = w.list("planner").find((x) => x.id === first.watch.id);
    expect(old).toMatchObject({ state: "done", note: movedNote });
  });
});

describe("issue 1560: a run watch in a busy repo (issue 1214 reads its run itself)", () => {
  it("is never marked off the page", async () => {
    const w = watcher();
    gh.run(A, {
      id: 777,
      name: "ci",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA1,
      check_suite_id: 7,
    });
    gh.run(A, {
      id: 201,
      name: "ci",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA2,
      check_suite_id: 3,
    });
    gh.run(A, {
      id: 202,
      name: "ci",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA1,
      check_suite_id: 4,
    });
    const run = await w.create({ ...ask(1), pr: undefined, run: 777 });
    if (!run.ok) throw new Error("not created");
    expect((await w.create(ask(1))).ok).toBe(true);
    expect((await w.create(ask(2))).ok).toBe(true);
    for (let i = 0; i < 120; i++)
      gh.run(A, {
        id: 6000 + i,
        name: "ci",
        status: "completed",
        conclusion: "success",
        head_sha: SHA9,
        check_suite_id: 2900 + i,
      });
    const notes: string[] = [];
    for (let i = 0; i < 8; i++) {
      await rounds(w, 1);
      notes.push(
        w.list("planner").find((x) => x.id === run.watch.id)?.note ?? "",
      );
    }
    expect(notes.filter((n) => /lists them by head/.test(n))).toEqual([]);
  });
});

describe("issue 1560: a head off the page waiting its turn", () => {
  it("isn't ended as stale before its own runs are read", async () => {
    settings = { ...settings, staleMinutes: 5 };
    const w = watcher();
    const shas = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n}d`.repeat(20));
    const ids: string[] = [];
    for (const [i, sha] of shas.entries()) {
      gh.pr(A, 20 + i, sha);
      gh.run(A, {
        id: 400 + i,
        name: "ci",
        status: "in_progress",
        conclusion: null,
        head_sha: sha,
        check_suite_id: 40 + i,
      });
      const r = await w.create(ask(20 + i));
      if (!r.ok) throw new Error("not created");
      ids.push(r.watch.id);
    }
    for (let i = 0; i < 120; i++)
      gh.run(A, {
        id: 5000 + i,
        name: "ci",
        status: "completed",
        conclusion: "success",
        head_sha: SHA9,
        check_suite_id: 1900 + i,
      });
    // Rounds until every head's own runs have been read once.
    for (let i = 0; i < 40; i++) {
      await rounds(w, 1);
      if (
        shas.every((sha) => gh.calls.some((c) => c.includes(`head_sha=${sha}`)))
      )
        break;
    }
    for (const sha of shas)
      expect(gh.calls.some((c) => c.includes(`head_sha=${sha}`))).toBe(true);
    const views = w.list("planner").filter((x) => ids.includes(x.id));
    expect(views.filter((x) => x.state === "done").map((x) => x.note)).toEqual(
      [],
    );
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

    // Issue 1166's recheck later: the replaced watch isn't ended or told again.
    for (let i = 0; i < 4; i++) {
      t += 11 * 60_000;
      await rounds(w, 1);
    }
    expect(sent.some((d) => (d.text ?? "").includes(first.watch.id))).toBe(
      false,
    );
    expect(w.list("planner").find((x) => x.id === first.watch.id)?.note).toBe(
      `Replaced by watch ${again.watch.id} on head ${SHA2.slice(0, 7)}.`,
    );
  });

  it("the loop ended it first (issue 1166): a new ask makes a new watch, the old one untouched", async () => {
    const w = watcher();
    const first = await w.create(ask(1));
    if (!first.ok) throw new Error("not created");
    gh.pr(A, 1, SHA2); // a push
    for (let i = 0; i < 4; i++) {
      t += 11 * 60_000;
      await rounds(w, 1);
    }
    const told = sent.filter((d) => (d.text ?? "").includes(first.watch.id));
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain("was replaced by");
    const old = w.list("planner").find((x) => x.id === first.watch.id);
    const note = old?.note;
    const again = await w.create(ask(1));
    if (!again.ok) throw new Error("not created");
    expect(again.watch.id).not.toBe(first.watch.id);
    expect(again.watch.head).toBe(SHA2);
    expect(w.list("planner").find((x) => x.id === first.watch.id)?.note).toBe(
      note,
    );
    expect(
      sent.filter((d) => (d.text ?? "").includes(first.watch.id)),
    ).toHaveLength(1);
  });
});

describe("issue 1560: the check-runs fallback is bounded", () => {
  const shas = [1, 2, 3, 4, 5].map((n) => `${n}e`.repeat(20));

  it("one call per repo per round, each skipped head read in turn, none under the budget floor", async () => {
    const w = watcher();
    for (const [i, sha] of shas.entries()) {
      gh.pr(A, 10 + i, sha);
      gh.run(A, {
        id: 300 + i,
        name: "ci",
        status: "in_progress",
        conclusion: null,
        head_sha: sha,
        check_suite_id: 30 + i,
      });
      gh.check(A, sha, {
        id: 40 + i,
        name: "unit",
        status: "in_progress",
        conclusion: null,
        suite: 30 + i,
      });
      expect((await w.create(ask(10 + i))).ok).toBe(true);
    }
    // Every head's runs are pushed off the list's page.
    for (let i = 0; i < 120; i++)
      gh.run(A, {
        id: 2000 + i,
        name: "ci",
        status: "completed",
        conclusion: "success",
        head_sha: SHA9,
        check_suite_id: 950 + i,
      });
    gh.calls = [];
    const perRound: number[] = [];
    for (let i = 0; i < 12; i++) {
      const before = gh.calls.length;
      await rounds(w, 1);
      perRound.push(gh.calls.length - before);
    }
    // One GitHub call a round for the repo, however many heads are skipped.
    expect(perRound.every((n) => n === 1)).toBe(true);
    // Each skipped head's own runs are listed, in turn. Its runs still
    // going, its check runs aren't read yet.
    for (const sha of shas) {
      expect(gh.calls.some((c) => c.includes(`head_sha=${sha}`))).toBe(true);
      expect(gh.calls.some((c) => c.includes(`/commits/${sha}/`))).toBe(false);
    }
    // Under the budget floor: no call at all until GitHub's reset.
    gh.remaining = 420;
    gh.reset = Math.floor(t / 1000) + 900;
    t = Math.max(t, w.nextAt);
    await w.tick();
    gh.calls = [];
    for (let i = 0; i < 3; i++) {
      t += 2 * 60_000; // past the interval, before the reset
      await w.tick();
    }
    expect(gh.calls).toEqual([]);
    // Nor does a repeat ask look at the head then.
    const again = await w.create(ask(10));
    expect(again.ok).toBe(true);
    expect(gh.calls).toEqual([]);
  });
});
