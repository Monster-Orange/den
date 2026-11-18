/**
 * Issue 487: Den's one CI watcher. Agents wait for a workflow run or a
 * PR's checks through the MCP tool ci_wait; the server polls each run once
 * for every agent waiting on it, at github_budget.poll_seconds (60 s by
 * default), with conditional requests (an unchanged answer is a free 304).
 * A wait ends when the run does, or at the waiter's own timeout.
 *
 * Before each poll the budget (budget.ts) is asked: when only agents wait
 * and the budget is below the reserve, the waits end refused, with the
 * reason and the reset time. Each request that cost the account is split
 * among those waiting on it (spend per agent).
 */
import type { BudgetCheck, GithubBudget } from "./budget.js";
import type { GithubHttp } from "./client.js";

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const REAL_TIMERS: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
};

export interface CiWaitRequest {
  /** owner/repo */
  repo: string;
  /** A workflow run id, or */
  run?: number;
  /** a pull request's number (all its check runs). */
  pr?: number;
  timeoutSeconds: number;
  /** Who waits: agent:<id> or person:<user>. */
  actor: string;
}

export interface CiCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CiWaitResult {
  /** The run (or every check) ended. */
  done: boolean;
  /** queued, in_progress, completed, … (a PR: pending or completed). */
  status: string;
  /** success, failure, cancelled, … once done. */
  conclusion: string | null;
  url?: string;
  /** A PR's check runs. */
  checks?: CiCheck[];
  waitedSeconds: number;
  /** Below the reserve: why, and when the budget resets. */
  refused?: { reason: string; resetAt: string };
  error?: string;
}

interface CiState {
  status: string;
  conclusion: string | null;
  done: boolean;
  url?: string;
  checks?: CiCheck[];
  error?: string;
}

interface Waiter {
  actor: string;
  started: number;
  timer: unknown;
  resolve: (r: CiWaitResult) => void;
}

interface Watch {
  key: string;
  repo: string;
  run?: number;
  pr?: number;
  waiters: Set<Waiter>;
  etags: Map<string, { etag: string; body: unknown }>;
  state: CiState | null;
  timer: unknown;
  polling: Promise<void> | null;
}

/** A check run that ended this way fails the PR. */
const FAILING = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

export const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

export class CiWatcher {
  private watches = new Map<string, Watch>();
  private readonly timers: Timers;

  constructor(
    private readonly o: {
      http: GithubHttp;
      budget: GithubBudget;
      /** github_budget.poll_seconds, read before each poll. */
      pollSeconds: () => number;
      timers?: Timers;
    },
  ) {
    this.timers = o.timers ?? REAL_TIMERS;
  }

  /** How many runs are watched, and how many wait on them. */
  stats(): { watches: number; waiters: number } {
    let waiters = 0;
    for (const w of this.watches.values()) waiters += w.waiters.size;
    return { watches: this.watches.size, waiters };
  }

  /** Resolves when no poll is in flight (tests move time on with it). */
  async idle(): Promise<void> {
    for (;;) {
      const p = [...this.watches.values()]
        .map((w) => w.polling)
        .filter((x): x is Promise<void> => !!x);
      if (!p.length) return;
      await Promise.all(p);
    }
  }

  wait(req: CiWaitRequest): Promise<CiWaitResult> {
    const started = this.timers.now();
    const key =
      req.run !== undefined
        ? `${req.repo}#run:${req.run}`
        : `${req.repo}#pr:${req.pr}`;
    const known = this.watches.get(key)?.state ?? null;
    const gate = this.o.budget.check({ actor: req.actor });
    if (!gate.ok)
      return Promise.resolve(this.refusedResult(known, gate, started));
    return new Promise((resolve) => {
      let w = this.watches.get(key);
      if (!w) {
        w = {
          key,
          repo: req.repo,
          ...(req.run !== undefined ? { run: req.run } : { pr: req.pr }),
          waiters: new Set(),
          etags: new Map(),
          state: null,
          timer: null,
          polling: null,
        };
        this.watches.set(key, w);
      }
      const watch = w;
      const waiter: Waiter = {
        actor: req.actor,
        started,
        resolve,
        timer: null,
      };
      waiter.timer = this.timers.set(
        () => this.leave(watch, waiter, this.result(watch.state, waiter)),
        Math.max(1, req.timeoutSeconds) * 1000,
      );
      watch.waiters.add(waiter);
      // The first waiter starts the poll; the others share it.
      if (!watch.polling && watch.timer === null) this.poll(watch);
    });
  }

  private result(s: CiState | null, w: Waiter): CiWaitResult {
    return {
      done: !!s?.done,
      status: s?.status ?? "unknown",
      conclusion: s?.conclusion ?? null,
      ...(s?.url ? { url: s.url } : {}),
      ...(s?.checks ? { checks: s.checks } : {}),
      ...(s?.error ? { error: s.error } : {}),
      waitedSeconds: Math.round((this.timers.now() - w.started) / 1000),
    };
  }

  private refusedResult(
    s: CiState | null,
    gate: Extract<BudgetCheck, { ok: false }>,
    started: number,
  ): CiWaitResult {
    return {
      done: false,
      status: s?.status ?? "unknown",
      conclusion: null,
      waitedSeconds: Math.round((this.timers.now() - started) / 1000),
      refused: { reason: gate.reason, resetAt: gate.resetAt },
    };
  }

  private leave(w: Watch, waiter: Waiter, r: CiWaitResult): void {
    if (!w.waiters.delete(waiter)) return;
    this.timers.clear(waiter.timer);
    waiter.resolve(r);
    if (!w.waiters.size) this.stop(w);
  }

  private stop(w: Watch): void {
    if (w.timer !== null) this.timers.clear(w.timer);
    w.timer = null;
    if (this.watches.get(w.key) === w) this.watches.delete(w.key);
  }

  private poll(w: Watch): void {
    w.timer = null;
    w.polling = this.pollOnce(w)
      .catch(() => {
        /* a failed poll keeps the last state; the next one tries again */
      })
      .finally(() => {
        w.polling = null;
        if (!w.waiters.size) return this.stop(w);
        if (w.state?.done) {
          for (const x of [...w.waiters])
            this.leave(w, x, this.result(w.state, x));
          return;
        }
        const s = this.o.pollSeconds();
        w.timer = this.timers.set(() => this.poll(w), Math.max(1, s) * 1000);
      });
  }

  private actors(w: Watch): string[] {
    return [...new Set([...w.waiters].map((x) => x.actor))];
  }

  private async pollOnce(w: Watch): Promise<void> {
    const actors = this.actors(w);
    // A person waiting makes the poll theirs: never refused.
    const agentsOnly = actors.every((a) => a.startsWith("agent:"));
    if (agentsOnly) {
      const gate = this.o.budget.check({ actor: actors[0] ?? "agent:" });
      if (!gate.ok) {
        for (const x of [...w.waiters])
          this.leave(w, x, this.refusedResult(w.state, gate, x.started));
        return;
      }
    }
    w.state =
      w.run !== undefined ? await this.runState(w) : await this.prState(w);
  }

  /** A conditional GET: the cached body on a 304, which costs nothing. */
  private async cget(
    w: Watch,
    p: string,
  ): Promise<{ status: number; body: unknown }> {
    const cached = w.etags.get(p);
    const r = await this.o.http.get(p, cached?.etag);
    this.o.budget.observe(r.rate);
    if (r.status === 304 && cached) return { status: 200, body: cached.body };
    this.o.budget.spend(this.actors(w), 1);
    if (r.status === 200 && r.etag)
      w.etags.set(p, { etag: r.etag, body: r.body });
    return { status: r.status, body: r.body };
  }

  private async runState(w: Watch): Promise<CiState> {
    const r = await this.cget(w, `/repos/${w.repo}/actions/runs/${w.run}`);
    if (r.status !== 200)
      return this.missing(r.status, `run ${w.run} in ${w.repo}`);
    const b = r.body as {
      status?: string;
      conclusion?: string | null;
      html_url?: string;
    };
    const status = b?.status ?? "unknown";
    return {
      status,
      conclusion: b?.conclusion ?? null,
      done: status === "completed",
      ...(b?.html_url ? { url: b.html_url } : {}),
    };
  }

  private async prState(w: Watch): Promise<CiState> {
    const pr = await this.cget(w, `/repos/${w.repo}/pulls/${w.pr}`);
    if (pr.status !== 200)
      return this.missing(pr.status, `PR ${w.pr} in ${w.repo}`);
    const sha = (pr.body as { head?: { sha?: string } })?.head?.sha;
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha))
      return { status: "unknown", conclusion: null, done: false };
    const c = await this.cget(
      w,
      `/repos/${w.repo}/commits/${sha}/check-runs?per_page=100`,
    );
    if (c.status !== 200)
      return this.missing(c.status, `the checks of PR ${w.pr}`);
    const runs = ((c.body as { check_runs?: CiCheck[] })?.check_runs ?? []).map(
      (x) => ({
        name: String(x.name ?? ""),
        status: String(x.status ?? "unknown"),
        conclusion: x.conclusion ?? null,
      }),
    );
    const done = runs.length > 0 && runs.every((x) => x.status === "completed");
    return {
      status: done ? "completed" : "pending",
      conclusion: done
        ? runs.some((x) => FAILING.has(x.conclusion ?? ""))
          ? "failure"
          : "success"
        : null,
      done,
      checks: runs,
      url: `https://github.com/${w.repo}/pull/${w.pr}/checks`,
    };
  }

  /** A 404 (or 401/403) ends the wait: there is nothing to watch. */
  private missing(status: number, what: string): CiState {
    return {
      status: status === 404 ? "not_found" : "error",
      conclusion: null,
      done: true,
      error:
        status === 404
          ? `GitHub has no ${what} (or this account can't see it)`
          : `GitHub answered ${status} for ${what}`,
    };
  }
}
