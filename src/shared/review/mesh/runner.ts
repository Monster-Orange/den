/**
 * Issue 476 (REVIEW-MESH-SPEC slice S1, part 1): the reviewer's loop.
 *
 * Each tick looks at the watched repos' open PRs (one conditional GET per
 * repo: an unchanged list is a 304). For a PR head it hasn't seen:
 *   1. the trigger (settings.ts, triggers.ts): ready, not a fork, base not
 *      denied; a fork ends the check "waiting for a person";
 *   2. the repo's rules, read from the base branch, plus the guard on the
 *      review section (rulesFor); none matched ends "no review needed";
 *   3. the limits (limits.ts); a tripped one ends "no reviewer free" and
 *      tells the person why;
 *   4. the claim in the PR's own thread (claim.ts): post "queued" with the
 *      marker, wait the claim window, reread, and the lowest id wins. The
 *      winner edits its comment to "started" and opens the check; a loser
 *      deletes its comment;
 *   5. a fresh leg: a reviewer session in a read-only checkout at the head
 *      (prepare, startLeg), with a brief naming the skill, the lenses, the
 *      ticket, the scoped instruction files and the review_submit leg id.
 * A new head on a PR ends the old head's leg; the new head starts over.
 *
 * submit() takes the leg's findings. Only the leg's own session, for that
 * PR and head, is accepted (legs.ts); a refusal is audited. If the PR has
 * moved since, the result is "outdated" and no verdict is posted.
 * Otherwise Den posts ONE batched review under the person's login, named
 * for the agent (post.ts), finishes the check with its summary, edits the
 * status comment, and hands back: to the author's agent if it is one of
 * this install's, else to the person's notifications. The model never
 * writes to GitHub: Den does.
 */
import type { GhGet, GhResponse, GhSend } from "../../github-watch/gh-http.js";
import type { UsageLeftReader } from "../../usage/left.js";
import type { MatchedRule, ReviewPr } from "../rules.js";
import { scrubLegText } from "./post.js";
import { claimMarker, claimWinner, parseClaims } from "./claim.js";
import { ReviewLegs, type LegRefusal } from "./legs.js";
import { limitsSkip } from "./limits.js";
import { CHECK_NAME, checkFor, type Outcome } from "./outcome.js";
import {
  checkSummary,
  findingMarker,
  reviewEvent,
  reviewHeader,
  type FindingRef,
} from "./post.js";
import type { ReviewSettings } from "./settings.js";
import { reviewTrigger } from "./triggers.js";

/** What Den knows of an open PR. */
export interface PrInfo {
  repo: string;
  number: number;
  url: string;
  draft: boolean;
  fork: boolean;
  head: string;
  headRef: string;
  base: string;
  author: string;
  labels: string[];
  body: string;
}

export interface Finding {
  id: string;
  path: string;
  line: number;
  severity: FindingRef["severity"];
  lens: string;
  blocking: boolean;
  body: string;
}

/** What a leg sends back through review_submit. */
export interface Submission {
  leg: string;
  repo: string;
  pr: number;
  sha: string;
  /** The verdict, in a sentence or two, for the review body. */
  verdict: string;
  findings: Finding[];
  depth: string;
  model: string;
  tokens: number | null;
  costUsd: number | null;
}

export interface LegStart {
  legId: string;
  repo: string;
  pr: number;
  sha: string;
  dir: string;
  brief: string;
}

export interface RunnerDeps {
  get: GhGet;
  send: GhSend;
  settings(): ReviewSettings;
  usageLeft: UsageLeftReader;
  /** This install, and the GitHub login its agents post as. */
  who: { install: string; person: string };
  /** The rules for a PR: the base branch's, plus the review-section guard. */
  rulesFor(pr: PrInfo, facts: ReviewPr): Promise<MatchedRule[]>;
  /** The author's agent on this install, if an agent of ours opened it. */
  authorAgent(pr: PrInfo): string | null;
  /** Fetches the head and makes the read-only checkout; its folder. */
  prepare(repo: string, pr: number, sha: string): Promise<string>;
  /** The instruction files covering the changed paths, in the checkout. */
  instructionFiles(dir: string, paths: string[]): string[];
  /** Starts the leg's reviewer session; its agent id. */
  startLeg(l: LegStart): Promise<string>;
  /** Stops a leg's session and removes its checkout. */
  endLeg(agent: string, dir: string): Promise<void>;
  /** Hands a message to an agent's session (routing); false if it can't. */
  relay(agent: string, text: string): Promise<boolean>;
  /** The person's notifications. */
  notify(n: {
    kind: string;
    text: string;
    link?: string;
    vars?: Record<string, string>;
  }): void;
  /** An audit line for a refused review_submit. */
  audit(a: {
    why: LegRefusal;
    agent: string | undefined;
    repo: string;
    pr: number;
  }): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A review in flight, keyed by repo#pr. */
interface Live {
  pr: PrInfo;
  sha: string;
  /** Our status comment, once posted. */
  comment?: number;
  check?: number;
  leg?: string;
  agent?: string;
  dir?: string;
  rules: MatchedRule[];
}

/** Legs get this long to submit before the leg is refused. */
const LEG_MINUTES = 120;

export class ReviewRunner {
  readonly legs = new ReviewLegs();
  private etags = new Map<string, string>();
  /** The head last handled per PR (repo#n → sha). */
  private seen = new Map<string, string>();
  private live = new Map<string, Live>();

  constructor(private d: RunnerDeps) {}

  /** How many legs run now (for max_concurrent). */
  running(): number {
    return [...this.live.values()].filter((l) => l.leg).length;
  }

  async tick(): Promise<void> {
    const s = this.d.settings();
    if (!s.enabled || !s.reviewer) return;
    for (const repo of s.reviewer.repos) await this.scan(repo, s);
  }

  private async scan(repo: string, s: ReviewSettings): Promise<void> {
    const r = await this.d.get(`repos/${repo}/pulls?state=open&per_page=50`, {
      etag: this.etags.get(repo),
    });
    if (r.status === 304 || r.status !== 200 || !Array.isArray(r.body)) return;
    if (r.headers.etag) this.etags.set(repo, r.headers.etag);
    for (const raw of r.body) {
      const pr = prInfo(repo, raw);
      if (!pr) continue;
      const key = `${repo}#${pr.number}`;
      const last = this.seen.get(key);
      if (last === pr.head && !pr.draft) continue;
      const old = this.live.get(key);
      if (old && old.sha !== pr.head) await this.cancel(key, old);
      const t = reviewTrigger(s, {
        repo,
        kind: "opened",
        draft: pr.draft,
        fork: pr.fork,
        baseRef: pr.base,
      });
      if (!t.start) {
        if (t.why === "draft" || t.why === "base_denied") continue;
        this.seen.set(key, pr.head);
        if (t.why === "fork_waits_for_person") {
          this.d.notify({
            kind: "review_waiting",
            text: `A PR from a fork waits for your "Review this": ${pr.url}`,
            link: pr.url,
            vars: { pr: pr.url },
          });
          await this.finish(
            pr,
            pr.head,
            "awaiting_human",
            'A PR from a fork waits for a person\'s "Review this".',
          );
        }
        continue;
      }
      this.seen.set(key, pr.head);
      await this.consider(pr, s, t.lenses ?? []);
    }
  }

  private async consider(
    pr: PrInfo,
    s: ReviewSettings,
    asked: string[],
  ): Promise<void> {
    const files = await this.d.get(
      `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`,
    );
    const list = Array.isArray(files.body)
      ? (files.body as {
          filename?: unknown;
          additions?: unknown;
          deletions?: unknown;
        }[])
      : [];
    const paths = list.map((f) => String(f.filename ?? "")).filter(Boolean);
    const lines = list.reduce(
      (n, f) => n + (Number(f.additions) || 0) + (Number(f.deletions) || 0),
      0,
    );
    const authorAgent = this.d.authorAgent(pr);
    const rules = await this.d.rulesFor(pr, {
      paths,
      labels: pr.labels,
      linesChanged: lines,
      author: authorAgent ? "agent" : "person",
      draft: pr.draft,
    });
    if (rules.length === 0) {
      await this.finish(
        pr,
        pr.head,
        "no_review_needed",
        "No review needed: no review rule matches this PR.",
      );
      return;
    }
    const skip = limitsSkip(s, await this.d.usageLeft(), this.running());
    if (skip) {
      const why = `${skip.limit}: have ${skip.have ?? "unknown"}, need ${skip.need}`;
      this.d.notify({
        kind: "review_skipped",
        text: `Den review skipped ${pr.url}: ${why}`,
        link: pr.url,
        vars: { pr: pr.url, why },
      });
      await this.finish(
        pr,
        pr.head,
        "no_reviewer_free",
        `No reviewer free. ${why}`,
      );
      return;
    }
    const key = `${pr.repo}#${pr.number}`;
    const live: Live = { pr, sha: pr.head, rules };
    this.live.set(key, live);
    if (!(await this.claim(live, s))) {
      this.live.delete(key);
      return;
    }
    const lenses = [...new Set([...rules.flatMap((r) => r.lenses), ...asked])];
    const check = await this.d.send("POST", `repos/${pr.repo}/check-runs`, {
      name: CHECK_NAME,
      head_sha: pr.head,
      status: "in_progress",
      output: {
        title: "Reviewing",
        summary: `Agent review by ${s.reviewer!.agent} on ${this.d.who.person}'s Den.`,
      },
    });
    live.check = idOf(check);
    const dir = await this.d.prepare(pr.repo, pr.number, pr.head);
    const legId = this.legs.open(
      { agent: "", repo: pr.repo, pr: pr.number, sha: pr.head },
      this.d.now(),
      LEG_MINUTES,
    );
    const brief = legBrief({
      pr,
      legId,
      skill: s.reviewer!.skill,
      skillArgs: s.reviewer!.skillArgs,
      lenses,
      rules,
      files: this.d.instructionFiles(dir, paths),
    });
    const agent = await this.d.startLeg({
      legId,
      repo: pr.repo,
      pr: pr.number,
      sha: pr.head,
      dir,
      brief,
    });
    this.legs.bind(legId, agent);
    Object.assign(live, { leg: legId, agent, dir });
  }

  /** The claim protocol; true when this install won. */
  private async claim(live: Live, s: ReviewSettings): Promise<boolean> {
    const { pr } = live;
    const marker = claimMarker({
      sha: pr.head,
      inst: this.d.who.install,
      agent: s.reviewer!.agent,
      for: this.d.who.person,
    });
    const posted = await this.d.send(
      "POST",
      `repos/${pr.repo}/issues/${pr.number}/comments`,
      {
        body: status("queued", s.reviewer!.agent, this.d.who, marker),
      },
    );
    live.comment = idOf(posted);
    if (live.comment === undefined) return false;
    await this.d.sleep(s.claimWindowSeconds * 1000);
    const thread = await this.d.get(
      `repos/${pr.repo}/issues/${pr.number}/comments?per_page=100`,
    );
    if (thread.status === 200 && Array.isArray(thread.body)) {
      const claims = parseClaims(
        (
          thread.body as { id: number; body?: string; created_at?: string }[]
        ).map((c) => ({
          id: c.id,
          body: c.body ?? "",
          createdAt: Date.parse(c.created_at ?? "") || 0,
        })),
      );
      const win = claimWinner(
        claims,
        pr.head,
        this.d.now(),
        s.claimTimeoutMinutes * 60_000,
      );
      if (win && win.id !== live.comment) {
        await this.d.send(
          "DELETE",
          `repos/${pr.repo}/issues/comments/${live.comment}`,
          {},
        );
        return false;
      }
    }
    // Won, or the thread couldn't be read: a duplicate review beats none.
    await this.d.send(
      "PATCH",
      `repos/${pr.repo}/issues/comments/${live.comment}`,
      {
        body: status("started", s.reviewer!.agent, this.d.who, marker),
      },
    );
    return true;
  }

  /** The PR moved on: the old head's leg ends, unposted. */
  private async cancel(key: string, live: Live): Promise<void> {
    this.live.delete(key);
    if (live.leg) this.legs.close(live.leg);
    if (live.agent) await this.d.endLeg(live.agent, live.dir ?? "");
    if (live.check !== undefined)
      await this.completeCheck(
        live.pr,
        live.check,
        "outdated",
        "Outdated: the PR has a newer head, which gets its own review.",
      );
    if (live.comment !== undefined) await this.editStatus(live, "outdated");
  }

  async submit(
    who: { agent: string | undefined; verified: boolean },
    raw: Submission,
  ): Promise<{ ok: true; outcome: Outcome } | { ok: false; why: LegRefusal }> {
    const a = this.legs.accept(who, raw, this.d.now());
    if (!a.ok) {
      this.d.audit({
        why: a.why,
        agent: who.agent,
        repo: raw.repo,
        pr: raw.pr,
      });
      return a;
    }
    // Everything the leg wrote is scrubbed before it reaches GitHub, the
    // author agent or the bell. A finding whose path held a secret loses
    // its line (its path is never posted) and goes in the verdict instead.
    const tainted = raw.findings.filter((f) => scrubLegText(f.path) !== f.path);
    const sub: Submission = {
      ...raw,
      verdict:
        scrubLegText(raw.verdict) +
        (tainted.length
          ? `\n\n${tainted.length} finding(s) named a path that held a secret; Den left the path out:\n` +
            tainted
              .map((f) => `- ${scrubLegText(f.body).slice(0, 2000)}`)
              .join("\n")
          : ""),
      findings: raw.findings
        .filter((f) => !tainted.includes(f))
        .map((f) => ({ ...f, body: scrubLegText(f.body) })),
    };
    const key = `${sub.repo}#${sub.pr}`;
    const live = this.live.get(key);
    if (!live || live.leg !== a.leg.id)
      return { ok: false, why: "unknown_leg" };
    this.live.delete(key);
    this.legs.close(a.leg.id);
    const now = await this.d.get(`repos/${sub.repo}/pulls/${sub.pr}`);
    const head = (now.body as { head?: { sha?: string } } | null)?.head?.sha;
    if (head !== sub.sha) {
      if (live.check !== undefined)
        await this.completeCheck(
          live.pr,
          live.check,
          "outdated",
          "Outdated: the PR moved during the review, so no verdict is posted. The new head gets its own review.",
        );
      await this.editStatus(live, "outdated");
      await this.d.endLeg(live.agent!, live.dir ?? "");
      this.d.notify({
        kind: "review_outdated",
        text: `Den review of ${live.pr.url} is outdated: the PR moved during the review. The new head gets its own.`,
        link: live.pr.url,
        vars: { pr: live.pr.url },
      });
      return { ok: true, outcome: "outdated" };
    }
    const s = this.d.settings();
    const blocking = sub.findings.filter((f) => f.blocking).length;
    const whoPosts = {
      agent: s.reviewer?.agent ?? "reviewer",
      install: this.d.who.install,
      person: this.d.who.person,
    };
    const summary = checkSummary({
      depth: sub.depth,
      model: sub.model,
      tokens: sub.tokens,
      costUsd: sub.costUsd,
      findings: { blocking, other: sub.findings.length - blocking },
    });
    await this.d.send("POST", `repos/${sub.repo}/pulls/${sub.pr}/reviews`, {
      commit_id: sub.sha,
      event: reviewEvent({ blocking, agentsMayApprove: s.agentsMayApprove }),
      body: `${reviewHeader(whoPosts)}\n\n${sub.verdict}\n\n${summary}`,
      comments: sub.findings.map((f) => ({
        path: f.path,
        line: f.line,
        side: "RIGHT",
        body: `${f.blocking ? "**Blocking.** " : ""}${f.body}\n\n${findingMarker({ id: f.id, severity: f.severity, lens: f.lens, sha: sub.sha })}`,
      })),
    });
    if (live.check !== undefined)
      await this.completeCheck(live.pr, live.check, "converged", summary);
    await this.editStatus(live, "reviewed");
    await this.d.endLeg(live.agent!, live.dir ?? "");
    const text = `Den review posted on ${live.pr.url}: ${blocking} blocking, ${sub.findings.length - blocking} other. Fix or answer each thread, push, and reply on the PR.`;
    const author = this.d.authorAgent(live.pr);
    if (!author || !(await this.d.relay(author, text)))
      this.d.notify({
        kind: "review_posted",
        text,
        link: live.pr.url,
        vars: { pr: live.pr.url, blocking: String(blocking) },
      });
    return { ok: true, outcome: "converged" };
  }

  private async finish(
    pr: PrInfo,
    sha: string,
    o: Outcome,
    summary: string,
  ): Promise<void> {
    const c = checkFor(o);
    await this.d.send("POST", `repos/${pr.repo}/check-runs`, {
      name: CHECK_NAME,
      head_sha: sha,
      status: c.status,
      conclusion: c.conclusion,
      output: { title: TITLES[o], summary },
    });
  }

  private async completeCheck(
    pr: PrInfo,
    id: number,
    o: Outcome,
    summary: string,
  ): Promise<void> {
    const c = checkFor(o);
    await this.d.send("PATCH", `repos/${pr.repo}/check-runs/${id}`, {
      status: c.status,
      conclusion: c.conclusion,
      output: { title: TITLES[o], summary },
    });
  }

  private async editStatus(
    live: Live,
    state: "reviewed" | "outdated",
  ): Promise<void> {
    if (live.comment === undefined) return;
    const s = this.d.settings();
    const marker = claimMarker({
      sha: live.sha,
      inst: this.d.who.install,
      agent: s.reviewer?.agent ?? "reviewer",
      for: this.d.who.person,
    });
    await this.d.send(
      "PATCH",
      `repos/${live.pr.repo}/issues/comments/${live.comment}`,
      {
        body: status(
          state,
          s.reviewer?.agent ?? "reviewer",
          this.d.who,
          marker,
        ),
      },
    );
  }
}

const TITLES: Record<Outcome, string> = {
  converged: "Reviewed",
  no_progress: "Reviewed (more may remain)",
  cap_reached: "Reviewed (round cap reached)",
  awaiting_human: "Waiting for a person",
  no_review_needed: "No review needed",
  no_reviewer_free: "No reviewer free",
  outdated: "Outdated",
  auth: "Sign-in expired; will retry",
  usage_cap: "Usage cap; will retry",
  transient: "Will retry",
  error: "Review failed",
};

const STATUS_TEXT = {
  queued: "In queue for a Den review.",
  started: "Den review started.",
  reviewed: "Den review: reviewed. See the review below.",
  outdated:
    "Den review: outdated. The PR moved during the review; the new head gets its own.",
} as const;

function status(
  state: keyof typeof STATUS_TEXT,
  agent: string,
  who: { install: string; person: string },
  marker: string,
): string {
  return `${STATUS_TEXT[state]} Reviewer: ${agent} on ${who.person}'s Den (${who.install}).\n\n${marker}`;
}

function idOf(r: GhResponse): number | undefined {
  const id = (r.body as { id?: unknown } | null)?.id;
  return r.status >= 200 && r.status < 300 && typeof id === "number"
    ? id
    : undefined;
}

function prInfo(repo: string, raw: unknown): PrInfo | null {
  const p = raw as {
    number?: unknown;
    draft?: unknown;
    html_url?: unknown;
    user?: { login?: unknown };
    labels?: { name?: unknown }[];
    body?: unknown;
    head?: {
      sha?: unknown;
      ref?: unknown;
      repo?: { full_name?: unknown } | null;
    };
    base?: { ref?: unknown };
  };
  if (
    typeof p?.number !== "number" ||
    typeof p.head?.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(p.head.sha)
  )
    return null;
  return {
    repo,
    number: p.number,
    url:
      typeof p.html_url === "string"
        ? p.html_url
        : `https://github.com/${repo}/pull/${p.number}`,
    draft: p.draft === true,
    fork: p.head.repo?.full_name !== repo,
    head: p.head.sha,
    headRef: typeof p.head.ref === "string" ? p.head.ref : "",
    base: typeof p.base?.ref === "string" ? p.base.ref : "",
    author: typeof p.user?.login === "string" ? p.user.login : "",
    labels: (p.labels ?? []).map((l) => String(l.name ?? "")).filter(Boolean),
    body: typeof p.body === "string" ? p.body : "",
  };
}

/** The first prompt of a review leg. */
export function legBrief(o: {
  pr: PrInfo;
  legId: string;
  skill: string | null;
  skillArgs: string;
  lenses: string[];
  rules: MatchedRule[];
  files: string[];
}): string {
  return [
    `You are reviewing ${o.pr.url} (head ${o.pr.head}). Your folder is a read-only checkout of that head: you can't edit, commit or push, and you don't post to GitHub. Den posts what you submit.`,
    `1. Ticket coverage first: read the issue the PR links (its body: "${o.pr.body.slice(0, 200).replace(/\s+/g, " ")}"), and check each of its acceptance clauses against the diff. A missing clause is a blocking finding.`,
    `2. Then review with ${o.skill ? `the skill ${o.skill}${o.skillArgs ? ` ${o.skillArgs}` : ""}` : "your reviewer persona's method"}${o.lenses.length ? `, with these lenses: ${o.lenses.join(", ")}` : ""}. The rules that asked for this review: ${o.rules.map((r) => r.rule).join(", ")}.`,
    `3. Read these instruction files first; they cover the changed paths: ${o.files.length ? o.files.join(", ") : "none found"}.`,
    `4. Verify each finding by reading the code; drop anything you can't show. Give each a short id, its file and line on the PR head, a severity (high, medium, low), its lens, and whether it blocks.`,
    `5. When done, call the review_submit tool once with leg "${o.legId}", repo "${o.pr.repo}", pr ${o.pr.number}, sha "${o.pr.head}", your verdict in a sentence or two, the findings, the depth, your model, and the tokens you used if you know them. Then stop.`,
  ].join("\n\n");
}
