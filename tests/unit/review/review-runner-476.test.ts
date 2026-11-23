/**
 * Issue 476 (REVIEW-MESH-SPEC slice S1, part 1): the reviewer end to end
 * against a fake GitHub. It watches the repo, claims a PR in the PR's own
 * thread, opens the one "Den review" check, starts a fresh review leg in a
 * read-only checkout, posts ONE batched review under the person's login
 * with the agent named, and hands it back to the author. Every path ends
 * the check: no review needed, no reviewer free, waiting for a person,
 * outdated, or reviewed.
 */
import { describe, expect, it } from "@jest/globals";
import type {
  GhGet,
  GhResponse,
  GhSend,
} from "../../../src/shared/github-watch/gh-http.js";
import { reviewSettings } from "../../../src/shared/review/mesh/settings.js";
import {
  ReviewRunner,
  type RunnerDeps,
  type Submission,
} from "../../../src/shared/review/mesh/runner.js";
import type { MatchedRule } from "../../../src/shared/review/rules.js";

const REPO = "octo/app";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

interface Pr {
  number: number;
  draft: boolean;
  head: string;
  ref: string;
  fork: boolean;
  base: string;
}

class FakeGithub {
  prs = new Map<number, Pr>();
  comments = new Map<
    number,
    { id: number; body: string; created_at: string }[]
  >();
  checks = new Map<number, Record<string, unknown>>();
  reviews: { pr: number; body: Record<string, unknown> }[] = [];
  writes: string[] = [];
  private nextId = 100;
  private etag = 0;
  constructor(private now: () => number) {}

  pr(p: Partial<Pr> & { number: number }) {
    this.prs.set(p.number, {
      draft: false,
      head: SHA1,
      ref: "feat/1-thing",
      fork: false,
      base: "next/queue",
      ...p,
    });
    this.etag++;
  }
  private json(p: Pr) {
    return {
      number: p.number,
      draft: p.draft,
      html_url: `https://github.com/${REPO}/pull/${p.number}`,
      user: { login: "octo-person" },
      labels: [],
      body: "Refs #7",
      head: {
        sha: p.head,
        ref: p.ref,
        repo: { full_name: p.fork ? "stranger/app" : REPO },
      },
      base: { ref: p.base, repo: { full_name: REPO } },
    };
  }
  private ok(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): GhResponse {
    return { status, headers, body };
  }

  get: GhGet = async (path, opts) => {
    if (path.startsWith(`repos/${REPO}/pulls?`)) {
      const tag = `"v${this.etag}"`;
      if (opts?.etag === tag) return this.ok(null, 304, { etag: tag });
      return this.ok(
        [...this.prs.values()].map((p) => this.json(p)),
        200,
        { etag: tag },
      );
    }
    let m = /^repos\/octo\/app\/pulls\/(\d+)\/files/.exec(path);
    if (m)
      return this.ok([{ filename: "src/a.ts", additions: 3, deletions: 1 }]);
    m = /^repos\/octo\/app\/pulls\/(\d+)$/.exec(path);
    if (m) {
      const p = this.prs.get(Number(m[1]));
      return p ? this.ok(this.json(p)) : this.ok(null, 404);
    }
    m = /^repos\/octo\/app\/issues\/(\d+)\/comments/.exec(path);
    if (m) return this.ok(this.comments.get(Number(m[1])) ?? []);
    if (path.startsWith(`repos/${REPO}/issues/comments?`))
      return this.ok([], 200, { etag: '"c"' });
    return this.ok(null, 404);
  };

  send: GhSend = async (method, path, body) => {
    this.writes.push(`${method} ${path}`);
    const b = (body ?? {}) as Record<string, unknown>;
    let m = /^repos\/octo\/app\/issues\/(\d+)\/comments$/.exec(path);
    if (m && method === "POST") {
      const id = this.nextId++;
      const l = this.comments.get(Number(m[1])) ?? [];
      l.push({
        id,
        body: String(b.body),
        created_at: new Date(this.now()).toISOString(),
      });
      this.comments.set(Number(m[1]), l);
      return this.ok({ id }, 201);
    }
    m = /^repos\/octo\/app\/issues\/comments\/(\d+)$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      for (const l of this.comments.values()) {
        const i = l.findIndex((c) => c.id === id);
        if (i < 0) continue;
        if (method === "DELETE") l.splice(i, 1);
        else l[i] = { ...l[i], body: String(b.body) };
      }
      return this.ok({}, method === "DELETE" ? 204 : 200);
    }
    if (path === `repos/${REPO}/check-runs` && method === "POST") {
      const id = this.nextId++;
      this.checks.set(id, { ...b });
      return this.ok({ id }, 201);
    }
    m = /^repos\/octo\/app\/check-runs\/(\d+)$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      this.checks.set(id, { ...this.checks.get(id), ...b });
      return this.ok({ id });
    }
    m = /^repos\/octo\/app\/pulls\/(\d+)\/reviews$/.exec(path);
    if (m) {
      this.reviews.push({ pr: Number(m[1]), body: b });
      return this.ok({ id: this.nextId++ }, 200);
    }
    return this.ok(null, 404);
  };

  statusBodies(pr: number) {
    return (this.comments.get(pr) ?? []).map((c) => c.body);
  }
  onlyCheck() {
    const all = [...this.checks.values()];
    expect(all).toHaveLength(1);
    return all[0];
  }
}

const RULE: MatchedRule = {
  rule: "default",
  reviews: 1,
  lenses: ["correctness"],
  blocksMerge: false,
};

function setup(
  o: {
    gh?: FakeGithub;
    install?: string;
    user?: Record<string, unknown>;
    rules?: MatchedRule[];
    usage?: { sessionLeftPct: number; weeklyLeftPct: number } | null;
    author?: string | null;
  } = {},
) {
  let t = Date.parse("2026-11-22T18:00:00Z");
  const now = () => t;
  const gh = o.gh ?? new FakeGithub(now);
  const started: {
    legId: string;
    repo: string;
    pr: number;
    sha: string;
    dir: string;
    brief: string;
  }[] = [];
  const ended: string[] = [];
  const relayed: { agent: string; text: string }[] = [];
  const bell: { kind: string; text: string }[] = [];
  const audit: { why: string }[] = [];
  const settings = reviewSettings(
    o.user ?? {
      reviews: {
        enabled: true,
        reviewer: {
          agent: "den-reviewer",
          repos: [REPO],
          skill: "deep-review:deep-review",
        },
      },
    },
  );
  let legSeq = 0;
  const deps: RunnerDeps = {
    get: gh.get,
    send: gh.send,
    settings: () => settings,
    usageLeft: async () =>
      o.usage === undefined
        ? { sessionLeftPct: 90, weeklyLeftPct: 90 }
        : o.usage,
    who: { install: o.install ?? "den-1", person: "octo-person" },
    rulesFor: async () => o.rules ?? [RULE],
    authorAgent: () => (o.author === undefined ? "builder-1" : o.author),
    prepare: async (_repo, pr, sha) => `/legs/${pr}-${sha.slice(0, 7)}`,
    instructionFiles: () => ["CLAUDE.md", "src/AGENTS.md"],
    startLeg: async (l) => {
      started.push(l);
      return `rev-${++legSeq}`;
    },
    endLeg: async (agent) => {
      ended.push(agent);
    },
    relay: async (agent, text) => {
      relayed.push({ agent, text });
      return true;
    },
    notify: (n) => bell.push(n),
    audit: (a) => audit.push(a),
    now,
    sleep: (ms) => {
      t += ms;
      return new Promise((r) => setTimeout(r, 2));
    },
  };
  const runner = new ReviewRunner(deps);
  return {
    gh,
    runner,
    started,
    ended,
    relayed,
    bell,
    audit,
    advance: (ms: number) => (t += ms),
  };
}

const findings: Submission["findings"] = [
  {
    id: "f-1",
    path: "src/a.ts",
    line: 2,
    severity: "high",
    lens: "correctness",
    blocking: true,
    body: "The null case returns undefined.",
  },
  {
    id: "f-2",
    path: "src/a.ts",
    line: 3,
    severity: "low",
    lens: "correctness",
    blocking: false,
    body: "A clearer name would help.",
  },
];

function submission(
  started: { legId: string; sha: string },
  sha = started.sha,
): Submission {
  return {
    leg: started.legId,
    repo: REPO,
    pr: 1,
    sha,
    verdict: "Two findings; one blocks.",
    findings,
    depth: "standard",
    model: "claude-opus-5-5",
    tokens: 120_000,
    costUsd: null,
  };
}

describe("claim → review → hand back", () => {
  it("claims in the thread, opens the check, and starts a fresh leg in a read-only checkout", async () => {
    const s = setup();
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    const bodies = s.gh.statusBodies(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(
      "<!-- den-review-claim v=1 sha=" +
        SHA1 +
        " inst=den-1 agent=den-reviewer for=octo-person -->",
    );
    expect(bodies[0]).toContain("started");
    const check = s.gh.onlyCheck();
    expect(check).toMatchObject({
      name: "Den review",
      head_sha: SHA1,
      status: "in_progress",
    });
    expect(s.started).toHaveLength(1);
    expect(s.started[0]).toMatchObject({
      repo: REPO,
      pr: 1,
      sha: SHA1,
      dir: `/legs/1-${SHA1.slice(0, 7)}`,
    });
    const brief = s.started[0].brief;
    expect(brief).toContain("deep-review:deep-review");
    expect(brief).toContain("review_submit");
    expect(brief).toContain(s.started[0].legId);
    expect(brief).toMatch(/ticket coverage first/i);
    expect(brief).toContain("src/AGENTS.md");
    // A second look at an unchanged list asks nothing new.
    await s.runner.tick();
    expect(s.started).toHaveLength(1);
  });

  it("posts ONE batched review naming the agent, finishes the check, and hands back to the author agent", async () => {
    const s = setup();
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    const r = await s.runner.submit(
      { agent: "rev-1", verified: true },
      submission(s.started[0]),
    );
    expect(r).toEqual({ ok: true, outcome: "converged" });
    expect(s.gh.reviews).toHaveLength(1);
    const rev = s.gh.reviews[0].body;
    expect(rev.event).toBe("COMMENT");
    expect(rev.commit_id).toBe(SHA1);
    expect(
      String(rev.body).startsWith(
        "**Agent review by den-reviewer on octo-person's Den** (den-1).",
      ),
    ).toBe(true);
    const comments = rev.comments as {
      path: string;
      line: number;
      body: string;
    }[];
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ path: "src/a.ts", line: 2 });
    expect(comments[0].body).toContain(
      "<!-- den-review-finding v=1 id=f-1 sev=high lens=correctness sha=" +
        SHA1 +
        " -->",
    );
    const check = s.gh.onlyCheck();
    expect(check).toMatchObject({ status: "completed", conclusion: "success" });
    expect(JSON.stringify(check.output)).toContain(
      "Findings: 1 blocking, 1 other",
    );
    expect(JSON.stringify(check.output)).toContain("Model: claude-opus-5-5");
    expect(s.gh.statusBodies(1)[0]).toContain("reviewed");
    expect(s.relayed).toEqual([
      {
        agent: "builder-1",
        text: expect.stringContaining(`https://github.com/${REPO}/pull/1`),
      },
    ]);
    expect(s.ended).toEqual(["rev-1"]);
  });

  it("scrubs secrets a leg may have read before anything reaches GitHub (fork content is untrusted)", async () => {
    const s = setup();
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    const gh = "ghp_" + "a".repeat(36);
    const den = "den_at_" + "b".repeat(32);
    const sub = submission(s.started[0]);
    sub.verdict = `Leaked ${gh} and ${den}.`;
    sub.findings = [
      { ...findings[0], body: `token ${den} here`, path: "src/a.ts" },
      { ...findings[1], body: `and ${gh}` },
    ];
    expect(
      await s.runner.submit({ agent: "rev-1", verified: true }, sub),
    ).toMatchObject({ ok: true });
    const posted = JSON.stringify(s.gh.reviews[0].body);
    expect(posted).not.toContain(gh);
    expect(posted).not.toContain(den);
    expect(posted).toContain("[REDACTED]");
    // The check's summary and the hand-back carry the verdict too.
    const all = JSON.stringify([
      [...s.gh.checks.values()],
      [...s.gh.comments.values()],
      s.relayed,
      s.bell,
    ]);
    expect(all).not.toContain(gh);
    expect(all).not.toContain(den);
  });

  it("an author who isn't an agent here gets it in the person's notifications", async () => {
    const s = setup({ author: null });
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    await s.runner.submit(
      { agent: "rev-1", verified: true },
      submission(s.started[0]),
    );
    expect(s.relayed).toEqual([]);
    expect(s.bell.some((b) => b.kind === "review_posted")).toBe(true);
  });
});

describe("only the leg's own session may submit", () => {
  it("another agent is refused, audited, and nothing is posted", async () => {
    const s = setup();
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    const r = await s.runner.submit(
      { agent: "builder-1", verified: true },
      submission(s.started[0]),
    );
    expect(r).toEqual({ ok: false, why: "wrong_agent" });
    expect(s.audit).toEqual([expect.objectContaining({ why: "wrong_agent" })]);
    expect(s.gh.reviews).toHaveLength(0);
    expect(s.gh.onlyCheck().status).toBe("in_progress");
  });
});

describe("a head that moved during the review", () => {
  it("is posted as outdated, never as a verdict", async () => {
    const s = setup();
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    const leg = s.started[0];
    s.gh.prs.get(1)!.head = SHA2; // pushed while the leg ran, before Den looked
    const r = await s.runner.submit(
      { agent: "rev-1", verified: true },
      submission(leg),
    );
    expect(r).toEqual({ ok: true, outcome: "outdated" });
    expect(s.gh.reviews).toHaveLength(0);
    const first = [...s.gh.checks.values()][0];
    expect(first).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(JSON.stringify(first.output)).toMatch(/outdated/i);
    expect(JSON.stringify(first.output)).toMatch(/no verdict/i);
    expect(s.gh.statusBodies(1)[0]).toContain("outdated");
    expect(s.bell.some((b) => b.kind === "review_outdated")).toBe(true);
  });

  it("a new push seen by the watcher ends the old leg and reviews the new head", async () => {
    const s = setup();
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    s.gh.pr({ number: 1, head: SHA2 });
    await s.runner.tick();
    expect(s.ended).toEqual(["rev-1"]);
    expect(s.started.map((l) => l.sha)).toEqual([SHA1, SHA2]);
    const late = await s.runner.submit(
      { agent: "rev-1", verified: true },
      submission(s.started[0]),
    );
    expect(late).toEqual({ ok: false, why: "unknown_leg" });
  });
});

describe("every path finishes the check", () => {
  it("no rule matched: no review needed", async () => {
    const s = setup({ rules: [] });
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    expect(s.started).toHaveLength(0);
    expect(s.gh.onlyCheck()).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    expect(JSON.stringify(s.gh.onlyCheck().output)).toContain(
      "No review needed",
    );
    expect(s.gh.statusBodies(1)).toHaveLength(0);
  });

  it("a tripped limit: the reviewer skips, says why, and the check ends 'no reviewer free'", async () => {
    const s = setup({
      user: {
        reviews: {
          enabled: true,
          min_session_left_pct: 25,
          reviewer: { agent: "den-reviewer", repos: [REPO] },
        },
      },
      usage: { sessionLeftPct: 10, weeklyLeftPct: 90 },
    });
    s.gh.pr({ number: 1 });
    await s.runner.tick();
    expect(s.started).toHaveLength(0);
    expect(s.gh.statusBodies(1)).toHaveLength(0);
    const c = s.gh.onlyCheck();
    expect(c).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(JSON.stringify(c.output)).toContain("min_session_left_pct");
    expect(
      s.bell.some(
        (b) =>
          b.kind === "review_skipped" &&
          b.text.includes("min_session_left_pct"),
      ),
    ).toBe(true);
  });

  it("a fork waits for a person", async () => {
    const s = setup();
    s.gh.pr({ number: 1, fork: true });
    await s.runner.tick();
    expect(s.started).toHaveLength(0);
    expect(s.gh.onlyCheck()).toMatchObject({
      status: "completed",
      conclusion: "action_required",
    });
    expect(s.bell.some((b) => b.kind === "review_waiting")).toBe(true);
  });

  it("a draft gets no check and no review until it leaves draft", async () => {
    const s = setup();
    s.gh.pr({ number: 1, draft: true });
    await s.runner.tick();
    expect(s.gh.checks.size).toBe(0);
    s.gh.pr({ number: 1, draft: false });
    await s.runner.tick();
    expect(s.started).toHaveLength(1);
  });
});

describe("two reviewers, one PR", () => {
  it("exactly one reviews; the other deletes its claim", async () => {
    const a = setup({ install: "den-1" });
    const b = setup({ install: "den-2", gh: a.gh });
    a.gh.pr({ number: 1 });
    await Promise.all([a.runner.tick(), b.runner.tick()]);
    expect(a.started.length + b.started.length).toBe(1);
    const claims = a.gh
      .statusBodies(1)
      .filter((x) => x.includes("den-review-claim"));
    expect(claims).toHaveLength(1);
  });
});
