/**
 * Issue 1166: no watch holds a slot forever, and the cap never refuses a
 * watch while GitHub's budget has room.
 *  - A pull request's watch ends, and tells its agent once, when the pull
 *    request merges or closes, or a newer push replaces its head.
 *  - A watch with no progress for github.watch_stale_minutes ends, with a
 *    note, and frees its slot.
 *  - The cap is github.watches_max at least, raised by the calls left
 *    before GitHub's reset; an agent at the cap is queued ("N ahead"), and
 *    the watch starts, then delivers, once a slot frees.
 * GitHub is a fake (fake-github.ts): no network. Invented names only.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import { GithubWatcher } from "../../../../src/shared/github-watch/watcher.js";
import {
  githubWatchSettings,
  type GithubWatchSettings,
} from "../../../../src/shared/github-watch/settings.js";
import { githubWatchLine } from "../../../../src/shared/github-watch/status-line.js";
import type { Delivery } from "../../../../src/shared/hub-delivery.js";
import { FakeGithub } from "./fake-github.js";

const A = "acme/north";
const SHA1 = "a1".repeat(20);
const SHA2 = "b2".repeat(20);
const SHA3 = "c3".repeat(20);
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
const ask = (pr: number, agent = "planner") => ({
  agent,
  project: "north",
  repo: A,
  pr,
  allowedRepos: [A],
});
const running = (sha: string, id = 11) =>
  gh.check(A, sha, {
    id,
    name: "lint",
    status: "in_progress",
    conclusion: null,
    suite: 5,
  });
const passed = (sha: string, id = 11) =>
  gh.check(A, sha, {
    id,
    name: "lint",
    status: "completed",
    conclusion: "success",
    suite: 5,
  });

/** Ticks every minute for `mins` minutes, delivering as it goes. */
async function minutes(w: GithubWatcher, mins: number) {
  for (let i = 0; i < mins; i++) {
    t += MIN;
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
    maxIntervalSeconds: 60,
    budgetFloor: 500,
    watchesMax: 50,
    staleMinutes: 60,
  };
  gh.pr(A, 1, SHA1);
  gh.pr(A, 2, SHA2);
  gh.pr(A, 3, SHA3);
});

describe("a pull request's watch ends with its pull request", () => {
  it("merges while its checks still run: ends, and delivers merged, once", async () => {
    const w = watcher();
    running(SHA1);
    const r = await w.create(ask(1));
    expect(r.ok).toBe(true);
    await minutes(w, 2);
    expect(w.list("planner")[0].state).toBe("running");
    gh.pr(A, 1, SHA1, "merged");
    await minutes(w, 15);
    const v = w.list("planner")[0];
    expect(v.state).toBe("done");
    expect(v.note).toMatch(/merged/);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/pull request 1 .*merged/);
    expect(w.status().active).toBe(0);
  });

  it("closed without merging: ends with closed", async () => {
    const w = watcher();
    running(SHA1);
    await w.create(ask(1));
    gh.pr(A, 1, SHA1, "closed");
    await minutes(w, 15);
    expect(w.list("planner")[0].state).toBe("done");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/closed/);
  });

  it("a newer push replaces its head: ends with replaced by <sha>", async () => {
    const w = watcher();
    running(SHA1);
    await w.create(ask(1));
    gh.pr(A, 1, SHA3);
    await minutes(w, 15);
    const v = w.list("planner")[0];
    expect(v.state).toBe("done");
    expect(v.note).toContain(`replaced by ${SHA3.slice(0, 7)}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`replaced by ${SHA3.slice(0, 7)}`);
  });

  it("asks about the pull request now and then, never every round", async () => {
    const w = watcher();
    running(SHA1);
    await w.create(ask(1));
    gh.calls = [];
    await minutes(w, 30);
    const looks = gh.calls.filter((c) => c === `repos/${A}/pulls/1`).length;
    expect(looks).toBeGreaterThanOrEqual(1);
    expect(looks).toBeLessThanOrEqual(5);
  });
});

describe("a watch with no progress", () => {
  it("ends after github.watch_stale_minutes, with a note, and frees its slot", async () => {
    settings = { ...settings, staleMinutes: 20, watchesMax: 1 };
    const w = watcher();
    running(SHA1);
    await w.create(ask(1));
    // GitHub stops answering for the checks: nothing changes.
    gh.get = (() => {
      const real = gh.get;
      return async (p: string) =>
        p.includes("check-runs")
          ? { status: 502, headers: gh.headers(), body: { message: "Bad" } }
          : real(p);
    })();
    await minutes(w, 19);
    expect(w.list("planner")[0].state).not.toBe("done");
    await minutes(w, 3);
    const v = w.list("planner")[0];
    expect(v.state).toBe("done");
    expect(v.note).toMatch(/no progress .*20 minutes/i);
    expect(sent).toHaveLength(1);
    expect(w.status().active).toBe(0);
  });

  it("a change counts as progress: a running watch that moves isn't ended", async () => {
    settings = { ...settings, staleMinutes: 20 };
    const w = watcher();
    running(SHA1);
    await w.create(ask(1));
    for (let i = 0; i < 4; i++) {
      running(SHA1, 20 + i); // a new job starts every 15 minutes
      await minutes(w, 15);
    }
    expect(w.list("planner")[0].state).toBe("running");
  });

  it("is a Setting: github.watch_stale_minutes, 60 by default, kept in range", () => {
    expect(githubWatchSettings({}).staleMinutes).toBe(60);
    expect(
      githubWatchSettings({ github: { watch_stale_minutes: 15 } }).staleMinutes,
    ).toBe(15);
    expect(
      githubWatchSettings({ github: { watch_stale_minutes: 1 } }).staleMinutes,
    ).toBe(60);
  });
});

describe("the cap", () => {
  it("with a large budget left, the cap is above the Setting's floor", async () => {
    settings = { ...settings, watchesMax: 2 };
    const w = watcher();
    await w.create(ask(1));
    // 4000 calls left, an hour to the reset, a look a minute.
    expect(w.status().cap).toBeGreaterThan(2);
    gh.remaining = 600; // little to spare: the floor holds
    await minutes(w, 1);
    expect(w.status().cap).toBe(2);
  });

  it("at the cap, a new watch is queued, then starts and delivers once a slot frees", async () => {
    settings = { ...settings, watchesMax: 1 };
    gh.remaining = 520; // the budget can't raise the cap
    const w = watcher();
    running(SHA1);
    running(SHA2, 12);
    expect((await w.create(ask(1))).ok).toBe(true);
    const q = await w.create(ask(2, "tester"));
    expect(q.ok).toBe(true);
    expect(q.watch?.state).toBe("queued");
    expect(q.watch?.note).toMatch(/queued, 0 ahead/i);
    expect(w.status()).toMatchObject({ active: 1, queued: 1 });
    // A queued watch asks GitHub nothing.
    gh.calls = [];
    await minutes(w, 1);
    expect(gh.calls.some((c) => c.includes(SHA2) || c.endsWith("/2"))).toBe(
      false,
    );
    passed(SHA1);
    await minutes(w, 2);
    expect(sent.map((d) => d.agent)).toEqual(["planner"]);
    expect(w.list("tester")[0].state).not.toBe("queued");
    passed(SHA2, 12);
    await minutes(w, 3);
    expect(sent.map((d) => d.agent)).toEqual(["planner", "tester"]);
    expect(sent[1].text).toMatch(/pull request 2 .*1 passed/);
  });

  it("the queue counts who is ahead", async () => {
    settings = { ...settings, watchesMax: 1 };
    gh.remaining = 520;
    const w = watcher();
    await w.create(ask(1));
    await w.create(ask(2, "tester"));
    const third = await w.create(ask(3, "scribe"));
    expect(third.watch?.note).toMatch(/queued, 1 ahead/i);
  });
});

describe("doctor's line", () => {
  it("shows the open watches, the queued ones and the oldest's age", async () => {
    settings = { ...settings, watchesMax: 1 };
    gh.remaining = 520;
    const w = watcher();
    running(SHA1);
    await w.create(ask(1));
    await w.create(ask(2, "tester"));
    t += 42 * MIN;
    const line = githubWatchLine(w.status())?.text ?? "";
    expect(line).toMatch(/1 watch\b/);
    expect(line).toMatch(/1 queued/);
    expect(line).toMatch(/oldest 42 min/);
  });
});
