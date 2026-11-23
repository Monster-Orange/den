/**
 * Issue 476 (REVIEW-MESH-SPEC, slice S1): one reviewer agent on one install
 * claims, reviews and re-checks pull requests. These are the pure parts:
 * the person's Settings, the claim protocol in the PR's own thread, the
 * triggers, the limits that make a reviewer skip, the named outcomes and
 * the one check that always finishes, the identity header on every review,
 * and the hidden finding markers later rounds track.
 */
import { describe, expect, it } from "@jest/globals";
import {
  REVIEW_LIMITS,
  reviewSettings,
} from "../../../src/shared/review/mesh/settings.js";
import {
  claimMarker,
  parseClaims,
  claimWinner,
} from "../../../src/shared/review/mesh/claim.js";
import { reviewTrigger } from "../../../src/shared/review/mesh/triggers.js";
import { limitsSkip } from "../../../src/shared/review/mesh/limits.js";
import {
  OUTCOMES,
  checkFor,
  type Outcome,
} from "../../../src/shared/review/mesh/outcome.js";
import {
  findingMarker,
  parseFindings,
  reviewHeader,
  reviewEvent,
  checkSummary,
} from "../../../src/shared/review/mesh/post.js";

describe("Settings › Agents › Reviews", () => {
  it("off by default, with permissive limits", () => {
    const s = reviewSettings({});
    expect(s.enabled).toBe(false);
    expect(s.reviewer).toBeNull();
    expect(s.minSessionLeftPct).toBe(0);
    expect(s.minWeeklyLeftPct).toBe(0);
    expect(s.maxConcurrent).toBe(REVIEW_LIMITS.max_concurrent.def);
    expect(s.claimWindowSeconds).toBe(10);
    expect(s.maxRounds).toBe(3);
    expect(s.agentsMayApprove).toBe(false);
    expect(s.resolve).toBe("person");
  });

  it("reads one reviewer with its repos, skill and args; bad values fall back", () => {
    const s = reviewSettings({
      reviews: {
        enabled: true,
        min_session_left_pct: 25,
        min_weekly_left_pct: 500, // out of range: default
        claim_window_seconds: 30,
        reviewer: {
          agent: "den-reviewer",
          repos: ["octo/app", "not a repo"],
          skill: "deep-review:deep-review",
          skill_args: "--depth standard",
        },
      },
    });
    expect(s.enabled).toBe(true);
    expect(s.minSessionLeftPct).toBe(25);
    expect(s.minWeeklyLeftPct).toBe(0);
    expect(s.claimWindowSeconds).toBe(30);
    expect(s.reviewer).toEqual({
      agent: "den-reviewer",
      repos: ["octo/app"],
      skill: "deep-review:deep-review",
      skillArgs: "--depth standard",
    });
  });

  it("a reviewer with no agent or no repo is no reviewer", () => {
    expect(
      reviewSettings({
        reviews: { enabled: true, reviewer: { repos: ["a/b"] } },
      }).reviewer,
    ).toBeNull();
    expect(
      reviewSettings({
        reviews: { enabled: true, reviewer: { agent: "r", repos: [] } },
      }).reviewer,
    ).toBeNull();
  });
});

describe("claiming in the PR's own thread", () => {
  const me = {
    sha: "a1b2c3d",
    inst: "den-1",
    agent: "rev",
    for: "octo-person",
  };

  it("the marker carries the head, the install, the agent and whose behalf", () => {
    expect(claimMarker(me)).toBe(
      "<!-- den-review-claim v=1 sha=a1b2c3d inst=den-1 agent=rev for=octo-person -->",
    );
  });

  it("a value that would break the marker is refused", () => {
    expect(() => claimMarker({ ...me, agent: "rev -->" })).toThrow();
  });

  it("the lowest comment id among recent claims for this head wins", () => {
    const at = Date.parse("2026-11-22T10:00:00Z");
    const comments = [
      { id: 50, body: "unrelated", createdAt: at },
      {
        id: 41,
        body: claimMarker({ ...me, sha: "old0000" }),
        createdAt: at,
      },
      { id: 52, body: claimMarker(me), createdAt: at },
      {
        id: 51,
        body: claimMarker({ ...me, inst: "den-2", agent: "rev2" }),
        createdAt: at,
      },
    ];
    const claims = parseClaims(comments);
    expect(claims.map((c) => c.id)).toEqual([41, 52, 51]);
    const w = claimWinner(claims, "a1b2c3d", at + 5_000, 30 * 60_000);
    expect(w?.id).toBe(51);
    expect(w?.inst).toBe("den-2");
  });

  it("a claim older than the timeout no longer holds the PR", () => {
    const at = Date.parse("2026-11-22T10:00:00Z");
    const claims = parseClaims([
      { id: 9, body: claimMarker(me), createdAt: at },
    ]);
    expect(claimWinner(claims, me.sha, at + 31 * 60_000, 30 * 60_000)).toBe(
      null,
    );
  });
});

describe("what starts a review", () => {
  const base = {
    repo: "octo/app",
    draft: false,
    fork: false,
    baseRef: "next/queue",
  };
  const settings = reviewSettings({
    reviews: {
      enabled: true,
      reviewer: { agent: "rev", repos: ["octo/app"] },
      base_deny: ["main"],
      commenters_block: ["mallory"],
    },
  });

  it("a PR opened ready, or leaving draft", () => {
    expect(reviewTrigger(settings, { ...base, kind: "opened" })).toEqual({
      start: true,
    });
    expect(
      reviewTrigger(settings, { ...base, kind: "ready_for_review" }),
    ).toEqual({ start: true });
    expect(
      reviewTrigger(settings, { ...base, kind: "opened", draft: true }),
    ).toEqual({ start: false, why: "draft" });
  });

  it("a /pleasereview comment, which may add lenses and overrides base_deny", () => {
    expect(
      reviewTrigger(settings, {
        ...base,
        baseRef: "main",
        kind: "comment",
        commenter: "octo-person",
        body: "/pleasereview --lens security,performance",
      }),
    ).toEqual({ start: true, lenses: ["security", "performance"] });
    expect(
      reviewTrigger(settings, {
        ...base,
        kind: "comment",
        commenter: "mallory",
        body: "/pleasereview",
      }),
    ).toEqual({ start: false, why: "commenter_blocked" });
    expect(
      reviewTrigger(settings, {
        ...base,
        kind: "comment",
        commenter: "octo-person",
        body: "looks fine",
      }),
    ).toEqual({ start: false, why: "not_a_trigger" });
  });

  it("base_deny skips the automatic review; forks wait for a person", () => {
    expect(
      reviewTrigger(settings, { ...base, baseRef: "main", kind: "opened" }),
    ).toEqual({ start: false, why: "base_denied" });
    expect(
      reviewTrigger(settings, { ...base, fork: true, kind: "opened" }),
    ).toEqual({ start: false, why: "fork_waits_for_person" });
  });

  it("off, or a repo the reviewer doesn't watch, starts nothing", () => {
    expect(
      reviewTrigger(reviewSettings({}), { ...base, kind: "opened" }),
    ).toEqual({ start: false, why: "reviews_off" });
    expect(
      reviewTrigger(settings, { ...base, repo: "octo/other", kind: "opened" }),
    ).toEqual({ start: false, why: "repo_not_watched" });
  });
});

describe("a tripped limit makes the reviewer skip, with the reason", () => {
  const s = reviewSettings({
    reviews: {
      enabled: true,
      min_session_left_pct: 25,
      min_weekly_left_pct: 15,
      max_concurrent: 1,
      reviewer: { agent: "rev", repos: ["octo/app"] },
    },
  });

  it("each limit names itself", () => {
    expect(
      limitsSkip(s, { sessionLeftPct: 80, weeklyLeftPct: 80 }, 0),
    ).toBeNull();
    expect(limitsSkip(s, { sessionLeftPct: 20, weeklyLeftPct: 80 }, 0)).toEqual(
      { limit: "min_session_left_pct", have: 20, need: 25 },
    );
    expect(limitsSkip(s, { sessionLeftPct: 80, weeklyLeftPct: 10 }, 0)).toEqual(
      { limit: "min_weekly_left_pct", have: 10, need: 15 },
    );
    expect(limitsSkip(s, { sessionLeftPct: 80, weeklyLeftPct: 80 }, 1)).toEqual(
      { limit: "max_concurrent", have: 1, need: 1 },
    );
  });

  it("usage Den can't read fails closed, but only when a usage limit is set", () => {
    expect(limitsSkip(s, null, 0)).toEqual({
      limit: "usage_unreadable",
      have: null,
      need: 25,
    });
    const off = reviewSettings({
      reviews: { enabled: true, reviewer: { agent: "rev", repos: ["a/b"] } },
    });
    expect(limitsSkip(off, null, 0)).toBeNull();
  });
});

describe("named outcomes, and one check that always finishes", () => {
  it("every outcome maps to a finished check, a notice and a retry plan", () => {
    for (const o of OUTCOMES) {
      const c = checkFor(o);
      expect(c.name).toBe("Den review");
      expect(c.status).toBe("completed");
      expect(["success", "neutral", "failure", "action_required"]).toContain(
        c.conclusion,
      );
      expect(c.notify).toBe(true);
    }
  });

  it("auth, usage cap and transient requeue with their waits", () => {
    const retry = (o: Outcome) => checkFor(o).retry;
    expect(retry("auth")).toEqual({ afterMinutes: 10, times: null });
    expect(retry("usage_cap")).toEqual({ afterMinutes: 30, times: null });
    expect(retry("transient")).toEqual({ afterMinutes: 1, times: 3 });
    expect(retry("converged")).toBeNull();
  });

  it("no review needed, no reviewer free and waiting for a person all finish", () => {
    expect(checkFor("no_review_needed").conclusion).toBe("success");
    expect(checkFor("no_reviewer_free").conclusion).toBe("neutral");
    expect(checkFor("awaiting_human").conclusion).toBe("action_required");
  });
});

describe("what gets posted", () => {
  const who = { agent: "rev", install: "den-1", person: "octo-person" };

  it("every review starts with the agent, the install and whose behalf", () => {
    expect(reviewHeader(who)).toBe(
      "**Agent review by rev on octo-person's Den** (den-1). This is not octo-person's approval.",
    );
  });

  it("the review never approves unless agents_may_approve is on", () => {
    expect(reviewEvent({ blocking: 0, agentsMayApprove: false })).toBe(
      "COMMENT",
    );
    expect(reviewEvent({ blocking: 2, agentsMayApprove: false })).toBe(
      "COMMENT",
    );
    expect(reviewEvent({ blocking: 0, agentsMayApprove: true })).toBe(
      "APPROVE",
    );
    expect(reviewEvent({ blocking: 1, agentsMayApprove: true })).toBe(
      "REQUEST_CHANGES",
    );
  });

  it("each finding carries a hidden id marker that later rounds read back", () => {
    const body = `Null check missing.\n\n${findingMarker({ id: "f-1", severity: "high", lens: "correctness", sha: "a1b2c3d" })}`;
    expect(body).toContain(
      "<!-- den-review-finding v=1 id=f-1 sev=high lens=correctness sha=a1b2c3d -->",
    );
    expect(parseFindings([body, "plain comment"])).toEqual([
      { id: "f-1", severity: "high", lens: "correctness", sha: "a1b2c3d" },
    ]);
  });

  it("the check summary shows depth, model, tokens or cost, and finding counts", () => {
    const s = checkSummary({
      depth: "standard",
      model: "claude-opus-5-5",
      tokens: 182_000,
      costUsd: null,
      findings: { blocking: 2, other: 3 },
    });
    expect(s).toContain("Depth: standard");
    expect(s).toContain("Model: claude-opus-5-5");
    expect(s).toContain("Tokens: 182,000");
    expect(s).toContain("Findings: 2 blocking, 3 other");
  });
});
