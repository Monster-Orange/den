/**
 * Issue TBD: Den's one CI watcher and the GitHub budget's reserve, against
 * a fake GitHub on 127.0.0.1 (never the real API, never the real gh).
 *
 *   - Ten agents waiting on one run share one poll: one conditional
 *     request per interval, not ten, and over an hour the budget stays
 *     above the reserve (304s cost nothing, as on GitHub).
 *   - Below the reserve, an agent's wait is refused with the reason and
 *     the reset time; the release path and a person still go through.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { GithubBudget } from "../../../src/shared/github-budget/budget.js";
import { createGithubHttp } from "../../../src/shared/github-budget/client.js";
import {
  CiWatcher,
  type Timers,
} from "../../../src/shared/github-budget/ci-watcher.js";

/** A fake GitHub: runs, PRs and check runs; ETags; a budget it spends. */
class FakeGitHub {
  requests: { path: string; status: number; inm: string | null }[] = [];
  remaining = 5000;
  readonly limit = 5000;
  reset = Math.floor(Date.now() / 1000) + 1800;
  runs = new Map<string, { status: string; conclusion: string | null }>();
  prs = new Map<string, string>();
  checks = new Map<string, { status: string; conclusion: string | null }[]>();
  server = http.createServer((req, res) => this.handle(req, res));
  base = "";

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    this.server.close();
  }
  /** Calls that cost (not rate_limit, not a 304). */
  get spent() {
    return this.requests.filter(
      (r) => r.path !== "/rate_limit" && r.status === 200,
    ).length;
  }
  get polls() {
    return this.requests.filter((r) => r.path !== "/rate_limit").length;
  }

  private body(p: string): unknown | null {
    let m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(p);
    if (m) {
      const r = this.runs.get(`${m[1]}#${m[2]}`);
      return r ? { id: Number(m[2]), html_url: `https://x/${m[2]}`, ...r } : null;
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(p);
    if (m) {
      const sha = this.prs.get(`${m[1]}#${m[2]}`);
      return sha ? { number: Number(m[2]), head: { sha } } : null;
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/check-runs$/.exec(p);
    if (m) {
      const c = this.checks.get(m[2]) ?? [];
      return {
        total_count: c.length,
        check_runs: c.map((x, i) => ({ name: `c${i}`, ...x })),
      };
    }
    return null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const p = new URL(req.url ?? "/", this.base).pathname;
    const inm = (req.headers["if-none-match"] as string | undefined) ?? null;
    const rate = {
      "x-ratelimit-limit": String(this.limit),
      "x-ratelimit-reset": String(this.reset),
    };
    const send = (status: number, body?: unknown, etag?: string) => {
      this.requests.push({ path: p, status, inm });
      res.writeHead(status, {
        "content-type": "application/json",
        ...rate,
        "x-ratelimit-remaining": String(this.remaining),
        ...(etag ? { etag } : {}),
      });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (req.headers.authorization !== "Bearer test-token")
      return send(401, { message: "Bad credentials" });
    if (p === "/rate_limit")
      return send(200, {
        resources: {
          core: {
            limit: this.limit,
            remaining: this.remaining,
            reset: this.reset,
          },
        },
      });
    const body = this.body(p);
    if (body === null) {
      this.remaining--;
      return send(404, { message: "Not Found" });
    }
    const etag = `"${Buffer.from(JSON.stringify(body)).toString("base64url").slice(-24)}"`;
    if (inm === etag) return send(304, undefined, etag);
    this.remaining--;
    send(200, body, etag);
  }
}

/** A manual clock: timers run only when the test moves time on. */
class ManualTimers implements Timers {
  t = 0;
  private q: { id: number; at: number; fn: () => void }[] = [];
  private n = 0;
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const id = ++this.n;
    this.q.push({ id, at: this.t + ms, fn });
    return id;
  };
  clear = (id: unknown) => {
    this.q = this.q.filter((x) => x.id !== id);
  };
  /** Move time on by ms, running each timer due (and its poll) in order. */
  async advance(ms: number, w: CiWatcher) {
    const end = this.t + ms;
    for (;;) {
      await w.idle();
      this.q.sort((a, b) => a.at - b.at);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await w.idle();
  }
}

const gh = new FakeGitHub();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ghb-"));
beforeAll(() => gh.start());
afterAll(() => {
  gh.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(reserve = 1000) {
  const timers = new ManualTimers();
  const api = createGithubHttp({
    apiBase: gh.base,
    token: async () => "test-token",
  });
  const budget = new GithubBudget({
    reserve: () => reserve,
    readRateLimit: () => api.rateLimit(),
    snapshotFile: path.join(dir, `snap-${Math.random()}.json`),
    now: () => Date.now(),
  });
  const watcher = new CiWatcher({
    http: api,
    budget,
    pollSeconds: () => 60,
    timers,
  });
  return { timers, budget, watcher };
}

describe("ten agents waiting on one run share one poll", () => {
  it("one conditional request per interval, and the budget holds over an hour", async () => {
    gh.requests = [];
    gh.remaining = 5000;
    gh.runs.set("o/r#100", { status: "in_progress", conclusion: null });
    const { timers, budget, watcher } = setup();
    const waits = Array.from({ length: 10 }, (_, i) =>
      watcher.wait({
        repo: "o/r",
        run: 100,
        timeoutSeconds: 4000,
        actor: `agent:a${i}`,
      }),
    );
    await timers.advance(3600_000, watcher);
    // One poll now and one a minute: 61, never 610.
    expect(gh.polls).toBeLessThanOrEqual(61);
    expect(gh.polls).toBeGreaterThanOrEqual(59);
    // Each after the first is conditional, and costs nothing (304).
    expect(gh.requests.filter((r) => r.inm).length).toBe(gh.polls - 1);
    expect(gh.spent).toBe(1);
    expect(budget.current()!.remaining).toBeGreaterThan(1000);
    // The run ends: every waiter hears it from the same poll.
    gh.runs.set("o/r#100", { status: "completed", conclusion: "success" });
    await timers.advance(60_000, watcher);
    const results = await Promise.all(waits);
    for (const r of results) {
      expect(r.done).toBe(true);
      expect(r.conclusion).toBe("success");
    }
    expect(gh.polls).toBeLessThanOrEqual(62);
    // The one request that cost was shared among the ten.
    const by = budget.spendBy();
    expect(by.length).toBe(10);
    expect(by.reduce((n, s) => n + s.requests, 0)).toBeCloseTo(2, 5);
  });

  it("a wait that runs out of time says where the run stands", async () => {
    gh.runs.set("o/r#101", { status: "queued", conclusion: null });
    const { timers, watcher } = setup();
    const w = watcher.wait({
      repo: "o/r",
      run: 101,
      timeoutSeconds: 120,
      actor: "agent:a1",
    });
    await timers.advance(130_000, watcher);
    const r = await w;
    expect(r.done).toBe(false);
    expect(r.status).toBe("queued");
  });

  it("a PR waits for all its check runs, and fails when one fails", async () => {
    gh.prs.set("o/r#7", "abc123");
    gh.checks.set("abc123", [
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ]);
    const { timers, watcher } = setup();
    const w = watcher.wait({
      repo: "o/r",
      pr: 7,
      timeoutSeconds: 600,
      actor: "agent:a1",
    });
    await timers.advance(60_000, watcher);
    gh.checks.set("abc123", [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ]);
    await timers.advance(60_000, watcher);
    const r = await w;
    expect(r.done).toBe(true);
    expect(r.conclusion).toBe("failure");
  });
});

describe("the reserve keeps the last of the budget for releases and people", () => {
  it("below the reserve, an agent's wait is refused with the reason and reset; the release path and a person go through", async () => {
    gh.remaining = 400;
    gh.runs.set("o/r#200", { status: "in_progress", conclusion: null });
    const { budget, watcher } = setup(1000);
    await budget.refresh();
    const r = await watcher.wait({
      repo: "o/r",
      run: 200,
      timeoutSeconds: 60,
      actor: "agent:a1",
    });
    expect(r.done).toBe(false);
    expect(r.refused?.reason).toMatch(/400/);
    expect(r.refused?.reason).toMatch(/reserve of 1000/);
    expect(r.refused?.resetAt).toBeTruthy();
    expect(budget.check({ actor: "agent:a1" }).ok).toBe(false);
    expect(budget.check({ actor: "agent:a1", essential: true }).ok).toBe(true);
    expect(budget.check({ actor: "person:me" }).ok).toBe(true);
    expect(budget.check({ actor: "den", essential: true }).ok).toBe(true);
  });

  it("rate_limit is read without spending, and the snapshot carries the reserve", async () => {
    gh.remaining = 4321;
    gh.requests = [];
    const snap = path.join(dir, "snap.json");
    const api = createGithubHttp({
      apiBase: gh.base,
      token: async () => "test-token",
    });
    const b = new GithubBudget({
      reserve: () => 1000,
      readRateLimit: () => api.rateLimit(),
      snapshotFile: snap,
    });
    await b.refresh();
    expect(gh.remaining).toBe(4321);
    const s = JSON.parse(fs.readFileSync(snap, "utf-8"));
    expect(s).toMatchObject({ remaining: 4321, limit: 5000, reserve: 1000 });
    expect(JSON.stringify(s)).not.toMatch(/test-token/);
  });
});
