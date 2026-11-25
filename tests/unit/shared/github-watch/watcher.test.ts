/**
 * The shared GitHub watcher: one loop for the install, at most one GitHub
 * call per repo per tick however many watches there are, a backoff that
 * doubles while nothing changes, the API budget floor, Retry-After, and
 * one message per finished watch. GitHub is a fake (fake-github.ts): no
 * network. Invented names only.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GithubWatcher } from "../../../../src/shared/github-watch/watcher.js";
import type { GithubWatchSettings } from "../../../../src/shared/github-watch/settings.js";
import type { Delivery } from "../../../../src/shared/hub-delivery.js";
import { FakeGithub } from "./fake-github.js";

const A = "acme/north";
const B = "acme/south";
const SHA1 = "a1".repeat(20);
const SHA2 = "b2".repeat(20);
const SHA3 = "c3".repeat(20);

let t = Date.parse("2030-01-01T12:00:00Z");
const now = () => t;
let gh: FakeGithub;
let sent: Delivery[];
let relayOk: boolean;
let settings: GithubWatchSettings;

function watcher(
  extra: Partial<ConstructorParameters<typeof GithubWatcher>[0]> = {},
) {
  return new GithubWatcher({
    get: gh.get,
    settings: () => settings,
    relay: async (dv) => {
      if (!relayOk) return false;
      sent.push(dv);
      return true;
    },
    now,
    ...extra,
  });
}

const ask = (
  over: Partial<Parameters<GithubWatcher["create"]>[0]> = {},
): Parameters<GithubWatcher["create"]>[0] => ({
  agent: "planner",
  project: "north",
  repo: A,
  allowedRepos: [A, B],
  ...over,
});

beforeEach(() => {
  t = Date.parse("2030-01-01T12:00:00Z");
  gh = new FakeGithub(now);
  sent = [];
  relayOk = true;
  settings = {
    intervalSeconds: 60,
    maxIntervalSeconds: 300,
    budgetFloor: 500,
    watchesMax: 50,
    staleMinutes: 60,
  };
  gh.pr(A, 1, SHA1);
  gh.pr(A, 2, SHA2);
  gh.pr(A, 3, SHA3);
  gh.pr(B, 7, SHA1);
  gh.pr(B, 8, SHA2);
});

describe("one call per repo per tick", () => {
  it("polls each repo once a tick, however many watches it has", async () => {
    const w = watcher();
    for (const pr of [1, 2, 3])
      expect((await w.create(ask({ pr }))).ok).toBe(true);
    for (const pr of [7, 8])
      expect((await w.create(ask({ repo: B, pr }))).ok).toBe(true);
    // A second agent watching the same pull request adds no call.
    expect((await w.create(ask({ agent: "tester", pr: 1 }))).ok).toBe(true);
    gh.calls = [];
    await w.tick();
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls.filter((c) => c.startsWith(`repos/${A}/`))).toHaveLength(1);
    expect(gh.calls.filter((c) => c.startsWith(`repos/${B}/`))).toHaveLength(1);
    // Several heads in a repo: the batched list of workflow runs, not one
    // call per head.
    expect(gh.calls.find((c) => c.startsWith(`repos/${A}/`))).toMatch(
      /^repos\/acme\/north\/actions\/runs\?/,
    );
  });

  it("one head in a repo: its check runs, one call", async () => {
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    await w.create(ask({ agent: "tester", pr: 1 }));
    gh.calls = [];
    await w.tick();
    expect(gh.calls).toEqual([
      `repos/${A}/commits/${SHA1}/check-runs?per_page=100&filter=latest`,
    ]);
  });
});

describe("backoff", () => {
  it("doubles while nothing changes, up to the cap, and resets on a change", async () => {
    const w = watcher();
    gh.check(A, SHA1, {
      id: 11,
      name: "lint",
      status: "in_progress",
      conclusion: null,
      suite: 5,
    });
    await w.create(ask({ pr: 1 }));
    await w.tick();
    expect(w.intervalSeconds).toBe(60);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      t = w.nextAt;
      await w.tick();
      seen.push(w.intervalSeconds);
    }
    expect(seen).toEqual([120, 240, 300, 300]);
    expect(w.nextAt).toBe(t + 300_000);
    // A check moves: back to the start.
    gh.check(A, SHA1, {
      id: 12,
      name: "unit",
      status: "queued",
      conclusion: null,
      suite: 5,
    });
    t = w.nextAt;
    await w.tick();
    expect(w.intervalSeconds).toBe(60);
  });

  it("a tick before nextAt makes no call", async () => {
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    await w.tick();
    gh.calls = [];
    t += 1000;
    await w.tick();
    expect(gh.calls).toEqual([]);
  });

  it("takes the interval and the cap from the Settings", async () => {
    settings = { ...settings, intervalSeconds: 20, maxIntervalSeconds: 50 };
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    await w.tick();
    expect(w.intervalSeconds).toBe(20);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      t = w.nextAt;
      await w.tick();
      seen.push(w.intervalSeconds);
    }
    expect(seen).toEqual([40, 50, 50]);
  });
});

describe("the API budget floor", () => {
  it("pauses polling until the reset, says so, and refuses new watches", async () => {
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    gh.remaining = 420; // under the floor of 500
    gh.reset = Math.floor(t / 1000) + 900;
    await w.tick();
    const resetIso = new Date(gh.reset * 1000).toISOString();
    gh.calls = [];
    // Past the interval, still before the reset: nothing is asked.
    t += 5 * 60_000;
    await w.tick();
    expect(gh.calls).toEqual([]);
    const [one] = w.list("planner");
    expect(one.state).toBe("paused");
    expect(one.note).toContain(resetIso);
    const r = await w.create(ask({ pr: 2 }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("budget_low");
    expect(r.error).toContain("500");
    expect(r.error).toContain(resetIso);
    expect(gh.calls).toEqual([]);
    expect(w.status()).toMatchObject({
      remaining: 419,
      resetAt: resetIso,
      active: 1,
    });
    // After the reset GitHub has a fresh budget: polling goes on.
    gh.remaining = 5000;
    t = gh.reset * 1000 + 1000;
    await w.tick();
    expect(gh.calls).toHaveLength(1);
    expect(w.list("planner")[0].state).not.toBe("paused");
  });

  it("takes the floor from the Settings", async () => {
    settings = { ...settings, budgetFloor: 100 };
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    gh.remaining = 420;
    await w.tick();
    t = w.nextAt;
    gh.calls = [];
    await w.tick();
    expect(gh.calls).toHaveLength(1);
  });
});

describe("Retry-After and secondary limits", () => {
  it("honours Retry-After: no call until it has passed", async () => {
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    gh.next.push({
      status: 403,
      headers: { "retry-after": "600" },
      body: { message: "You have exceeded a secondary rate limit." },
    });
    const at = t;
    await w.tick();
    gh.calls = [];
    for (const step of [60_000, 300_000, 599_000]) {
      t = at + step;
      await w.tick();
    }
    expect(gh.calls).toEqual([]);
    expect(w.list("planner")[0].note).toMatch(/GitHub asked/);
    t = at + 601_000;
    await w.tick();
    expect(gh.calls).toHaveLength(1);
  });

  it("a 429 with no Retry-After waits at least a minute and backs off", async () => {
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    gh.next.push({ status: 429, body: { message: "slow down" } });
    const at = t;
    await w.tick();
    gh.calls = [];
    t = at + 59_000;
    await w.tick();
    expect(gh.calls).toEqual([]);
    expect(w.intervalSeconds).toBeGreaterThanOrEqual(120);
  });
});

describe("the final message", () => {
  function finishedChecks() {
    gh.check(A, SHA1, {
      id: 11,
      name: "lint",
      status: "completed",
      conclusion: "success",
      suite: 5,
    });
    gh.check(A, SHA1, {
      id: 12,
      name: "unit",
      status: "completed",
      conclusion: "failure",
      suite: 5,
    });
    gh.check(A, SHA1, {
      id: 13,
      name: "e2e",
      status: "completed",
      conclusion: "timed_out",
      suite: 5,
    });
    gh.check(A, SHA1, {
      id: 14,
      name: "deploy",
      status: "completed",
      conclusion: "skipped",
      suite: 5,
    });
  }

  it("is delivered once, with the counts and each failure's URL", async () => {
    const w = watcher();
    const c = await w.create(ask({ pr: 1 }));
    finishedChecks();
    await w.tick();
    await w.deliver();
    t = w.nextAt;
    await w.tick();
    await w.deliver();
    expect(sent).toHaveLength(1);
    const dv = sent[0];
    expect(dv.agent).toBe("planner");
    expect(dv.project).toBe("north");
    expect(dv.text).toContain(c.watch.id);
    expect(dv.text).toContain("1 passed");
    expect(dv.text).toContain("2 failed");
    expect(dv.text).toContain("1 skipped");
    expect(dv.text).toContain(`unit (https://github.example/${A}/runs/12)`);
    expect(dv.text).toContain(`e2e (https://github.example/${A}/runs/13)`);
    expect(dv.text).not.toContain("\n");
    const [one] = w.list("planner");
    expect(one.state).toBe("done");
    expect(one.checks).toEqual({ pass: 1, fail: 2, skip: 1, pending: 0 });
    expect(one.failed).toHaveLength(2);
    // Done: polled no more.
    gh.calls = [];
    t = w.nextAt + 1;
    await w.tick();
    expect(gh.calls).toEqual([]);
  });

  it("waits for the agent: a relay not ready is tried again, still once", async () => {
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    finishedChecks();
    relayOk = false;
    await w.tick();
    await w.deliver();
    expect(sent).toHaveLength(0);
    relayOk = true;
    await w.deliver();
    await w.deliver();
    expect(sent).toHaveLength(1);
  });

  it("a run: its own jobs only, from the run's check suite", async () => {
    gh.run(A, {
      id: 900,
      name: "CI",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA1,
      check_suite_id: 5,
    });
    const w = watcher();
    const c = await w.create(ask({ run: 900 }));
    expect(c.ok).toBe(true);
    expect(c.watch.run).toBe(900);
    finishedChecks();
    // Another workflow's job on the same head: not this run's.
    gh.check(A, SHA1, {
      id: 20,
      name: "docs",
      status: "completed",
      conclusion: "failure",
      suite: 6,
    });
    await w.tick();
    await w.deliver();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("2 failed");
    expect(sent[0].text).not.toContain("docs");
  });

  it("several heads: the run list first, then the finished head's checks", async () => {
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    await w.create(ask({ pr: 2 }));
    gh.run(A, {
      id: 901,
      name: "CI",
      status: "completed",
      conclusion: "failure",
      head_sha: SHA1,
      check_suite_id: 5,
    });
    gh.run(A, {
      id: 902,
      name: "CI",
      status: "in_progress",
      conclusion: null,
      head_sha: SHA2,
      check_suite_id: 7,
    });
    finishedChecks();
    gh.calls = [];
    await w.tick();
    t = w.nextAt;
    await w.tick();
    await w.deliver();
    expect(gh.calls).toEqual([
      expect.stringMatching(/^repos\/acme\/north\/actions\/runs\?/),
      `repos/${A}/commits/${SHA1}/check-runs?per_page=100&filter=latest`,
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("pull request 1");
  });
});

describe("scope, list and cancel", () => {
  it("refuses a repo outside the agent's projects", async () => {
    const w = watcher();
    const r = await w.create(
      ask({ repo: "other/elsewhere", pr: 1, allowedRepos: [A] }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("scope");
    expect(gh.calls).toEqual([]);
  });

  it("matches the repo whatever its case", async () => {
    const w = watcher();
    const r = await w.create(ask({ repo: "Acme/North", pr: 1 }));
    expect(r.ok).toBe(true);
  });

  it("needs exactly one of pr and run, and an owner/name repo", async () => {
    const w = watcher();
    expect((await w.create(ask({}))).code).toBe("bad_request");
    expect((await w.create(ask({ pr: 1, run: 2 }))).code).toBe("bad_request");
    expect(
      (await w.create(ask({ repo: "../x", pr: 1, allowedRepos: ["../x"] })))
        .code,
    ).toBe("bad_request");
  });

  it("says when GitHub has no such pull request", async () => {
    const w = watcher();
    const r = await w.create(ask({ pr: 404 }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_found");
  });

  it("answers at once with the id and the state; the same ask again is the same watch", async () => {
    const w = watcher();
    const r = await w.create(ask({ pr: 1 }));
    expect(r.ok).toBe(true);
    expect(r.watch).toMatchObject({ repo: A, pr: 1, head: SHA1 });
    expect(typeof r.watch.id).toBe("string");
    expect(typeof r.watch.state).toBe("string");
    const again = await w.create(ask({ pr: 1 }));
    expect(again.watch.id).toBe(r.watch.id);
    expect(w.list("planner")).toHaveLength(1);
  });

  it("lists the agent's own watches only, and cancels its own", async () => {
    const w = watcher();
    const mine = await w.create(ask({ pr: 1 }));
    const theirs = await w.create(ask({ agent: "tester", pr: 2 }));
    expect(w.list("planner").map((x) => x.id)).toEqual([mine.watch.id]);
    expect(w.cancel("planner", theirs.watch.id).ok).toBe(false);
    expect(w.cancel("planner", mine.watch.id).ok).toBe(true);
    expect(w.list("planner")).toEqual([]);
    // Cancelled: no longer polled; the other repo head alone is.
    gh.calls = [];
    await w.tick();
    expect(gh.calls).toEqual([
      `repos/${A}/commits/${SHA2}/check-runs?per_page=100&filter=latest`,
    ]);
  });

  it("queues a watch past the cap (issue 1166), and refuses one only when the queue is full too", async () => {
    settings = { ...settings, watchesMax: 2 };
    gh.remaining = 520; // little over the floor: the budget can't raise the cap
    const w = watcher();
    await w.create(ask({ pr: 1 }));
    await w.create(ask({ pr: 2 }));
    const r = await w.create(ask({ pr: 3 }));
    expect(r.ok).toBe(true);
    expect(r.watch?.state).toBe("queued");
    // 1000 queued (the most): one more is refused, saying what is open.
    for (let n = 100; n < 1099; n++)
      expect((await w.create(ask({ pr: n }))).watch?.state).toBe("queued");
    const full = await w.create(ask({ pr: 5000 }));
    expect(full.ok).toBe(false);
    if (full.ok) return;
    expect(full.code).toBe("too_many");
    expect(full.error).toContain("2 are open");
    expect(full.error).toContain("1000 more queued");
  });
});

describe("the status line and the kept watches", () => {
  it("writes the status (remaining, reset, active, interval) to its file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ghwatch-"));
    try {
      const w = watcher({
        statusFile: path.join(dir, "status.json"),
        file: path.join(dir, "watches.json"),
      });
      await w.create(ask({ pr: 1 }));
      await w.tick();
      const s = JSON.parse(
        fs.readFileSync(path.join(dir, "status.json"), "utf-8"),
      );
      expect(s).toMatchObject({
        remaining: gh.remaining,
        active: 1,
        intervalSeconds: 60,
      });
      expect(typeof s.resetAt).toBe("string");
      // A restarted server keeps its watches.
      const again = watcher({ file: path.join(dir, "watches.json") });
      expect(again.list("planner")).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an idle watcher writes nothing", () => {
  it("with no watches, its rounds write neither the watches file nor the status file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-watch-idle-"));
    const file = path.join(dir, "github", "watches.json");
    const statusFile = path.join(dir, "github", "watch-status.json");
    const w = watcher({ file, statusFile });
    for (let i = 0; i < 5; i++) {
      t += 10 * 60_000;
      await w.tick();
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(statusFile)).toBe(false);
    expect(gh.calls.length).toBe(0);
  });

  it("after its last watch is cancelled, later rounds leave the files alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-watch-idle-"));
    const file = path.join(dir, "github", "watches.json");
    const statusFile = path.join(dir, "github", "watch-status.json");
    const w = watcher({ file, statusFile });
    const c = await w.create(ask({ pr: 1 }));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(w.cancel("planner", c.watch.id).ok).toBe(true);
    const before = [fs.statSync(file).mtimeMs, fs.statSync(statusFile).mtimeMs];
    const calls = gh.calls.length;
    for (let i = 0; i < 5; i++) {
      t += 10 * 60_000;
      await w.tick();
    }
    expect([
      fs.statSync(file).mtimeMs,
      fs.statSync(statusFile).mtimeMs,
    ]).toEqual(before);
    expect(gh.calls.length).toBe(calls);
  });
});
