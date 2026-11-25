/**
 * A fake GitHub REST API for the shared watcher's tests: pull requests,
 * workflow runs and check runs per repo, the rate-limit headers on every
 * answer, and one-off answers (a 403 with Retry-After). It records every
 * path asked. No network: the watcher's `get` is this.
 */
import type {
  GhGet,
  GhResponse,
} from "../../../../src/shared/github-watch/gh-http.js";

export interface FakeRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  check_suite_id: number;
}

export interface FakeCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  suite: number;
}

export class FakeGithub {
  calls: string[] = [];
  prs = new Map<string, { head: string; state: string }>();
  runs = new Map<string, FakeRun[]>();
  checks = new Map<string, FakeCheck[]>();
  remaining = 4000;
  limit = 5000;
  /** Seconds since the epoch. */
  reset = 0;
  /** One-off answers, taken in order before the usual ones. */
  next: Partial<GhResponse>[] = [];

  constructor(now: () => number) {
    this.reset = Math.floor(now() / 1000) + 3600;
  }

  pr(repo: string, n: number, head: string, state = "open"): void {
    this.prs.set(`${repo}#${n}`, { head, state });
  }
  /** Adds a run, or updates one in place: runs list by when they began. */
  run(repo: string, r: FakeRun): void {
    const l = this.runs.get(repo) ?? [];
    const i = l.findIndex((x) => x.id === r.id);
    this.runs.set(repo, i < 0 ? [...l, r] : l.map((x, j) => (j === i ? r : x)));
  }
  check(repo: string, sha: string, c: FakeCheck): void {
    const k = `${repo}@${sha}`;
    const l = this.checks.get(k) ?? [];
    this.checks.set(k, [...l.filter((x) => x.id !== c.id), c]);
  }

  headers(): Record<string, string> {
    return {
      "x-ratelimit-remaining": String(this.remaining),
      "x-ratelimit-limit": String(this.limit),
      "x-ratelimit-reset": String(this.reset),
    };
  }

  get: GhGet = async (path) => {
    this.calls.push(path);
    const once = this.next.shift();
    if (once)
      return {
        status: once.status ?? 200,
        headers: { ...this.headers(), ...(once.headers ?? {}) },
        body: once.body ?? {},
      };
    const ok = (body: unknown): GhResponse => {
      this.remaining = Math.max(0, this.remaining - 1);
      return { status: 200, headers: this.headers(), body };
    };
    const missing: GhResponse = {
      status: 404,
      headers: this.headers(),
      body: { message: "Not Found" },
    };
    let m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
    if (m) {
      const p = this.prs.get(`${m[1]}#${m[2]}`);
      return p
        ? ok({
            number: Number(m[2]),
            state: p.state,
            head: { sha: p.head },
            html_url: `https://github.example/${m[1]}/pull/${m[2]}`,
          })
        : missing;
    }
    m = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(path);
    if (m) {
      const r = (this.runs.get(m[1]) ?? []).find((x) => x.id === Number(m![2]));
      return r ? ok(this.runView(m[1], r)) : missing;
    }
    m = /^repos\/([^/]+\/[^/]+)\/actions\/runs\?/.exec(path);
    if (m) {
      const q0 = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const sha = q0.get("head_sha");
      const l = (this.runs.get(m[1]) ?? []).filter(
        (r) => !sha || r.head_sha === sha,
      );
      // Issue 1560: as GitHub lists them, newest first, one page of
      // per_page (default 30): a busy repo's older runs aren't on it.
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const per = Number(q.get("per_page") ?? 30);
      return ok({
        total_count: l.length,
        workflow_runs: [...l]
          .reverse()
          .slice(0, per)
          .map((r) => this.runView(m![1], r)),
      });
    }
    m = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/check-runs\?/.exec(path);
    if (m) {
      const l = this.checks.get(`${m[1]}@${m[2]}`) ?? [];
      return ok({
        total_count: l.length,
        check_runs: l.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          html_url: `https://github.example/${m![1]}/runs/${c.id}`,
          check_suite: { id: c.suite },
        })),
      });
    }
    return missing;
  };

  private runView(repo: string, r: FakeRun) {
    return {
      ...r,
      html_url: `https://github.example/${repo}/actions/runs/${r.id}`,
    };
  }
}
