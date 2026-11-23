/**
 * Issue 476 (REVIEW-MESH-SPEC RV-2, slice S1): Settings › Agents › Reviews,
 * in user.yml `reviews:` (a person's only: PERSON_ONLY_SETTINGS "reviews").
 *
 *   reviews:
 *     enabled: false               # off until the person turns it on
 *     reviewer:                    # S1: one reviewer agent on this install
 *       agent: den-reviewer        # an agent id, in a reviewer persona
 *       repos: [owner/name]        # the repos it watches
 *       skill: deep-review:deep-review   # the review skill it runs
 *       skill_args: ""
 *     min_session_left_pct: 0      # don't claim below this share left
 *     min_weekly_left_pct: 0
 *     max_concurrent: 1
 *     claim_window_seconds: 10     # wait, then reread the thread (RV-9)
 *     claim_timeout_minutes: 30    # nobody claimed: "waiting for a person"
 *     max_rounds: 3                # then the person is told
 *     agents_may_approve: false    # off: comments plus the check, never APPROVE
 *     base_deny: []                # bases with no automatic review
 *     commenters_allow: []         # who may /pleasereview (empty = anyone)
 *     commenters_block: []
 *
 * A value that is missing or out of range is its default. The rule's own
 * `require.skill` / `skill_args` in the repo's manifest win over these.
 */
export interface Reviewer {
  agent: string;
  repos: string[];
  skill: string | null;
  skillArgs: string;
}

export interface ReviewSettings {
  enabled: boolean;
  reviewer: Reviewer | null;
  minSessionLeftPct: number;
  minWeeklyLeftPct: number;
  maxConcurrent: number;
  claimWindowSeconds: number;
  claimTimeoutMinutes: number;
  maxRounds: number;
  agentsMayApprove: boolean;
  /** S1: a fixed thread is "IS RESOLVABLE" for a person to resolve. */
  resolve: "person";
  baseDeny: string[];
  commentersAllow: string[];
  commentersBlock: string[];
}

/** Each number's range and default (Settings and `config` check against these). */
export const REVIEW_LIMITS = {
  min_session_left_pct: { min: 0, max: 100, def: 0 },
  min_weekly_left_pct: { min: 0, max: 100, def: 0 },
  max_concurrent: { min: 1, max: 20, def: 1 },
  claim_window_seconds: { min: 1, max: 600, def: 10 },
  claim_timeout_minutes: { min: 1, max: 1440, def: 30 },
  max_rounds: { min: 1, max: 20, def: 3 },
} as const;

type Key = keyof typeof REVIEW_LIMITS;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

function num(b: Record<string, unknown>, k: Key): number {
  const l = REVIEW_LIMITS[k];
  const v = b[k];
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= l.min &&
    v <= l.max
    ? v
    : l.def;
}

const strings = (v: unknown, re: RegExp): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && re.test(x))
    : [];

function reviewer(v: unknown): Reviewer | null {
  const r = obj(v);
  const agent =
    typeof r.agent === "string" && NAME_RE.test(r.agent) ? r.agent : null;
  const repos = strings(r.repos, REPO_RE);
  if (!agent || repos.length === 0) return null;
  return {
    agent,
    repos,
    skill:
      typeof r.skill === "string" && NAME_RE.test(r.skill) ? r.skill : null,
    skillArgs: typeof r.skill_args === "string" ? r.skill_args : "",
  };
}

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./*-]{0,254}$/;

/** The settings from a user.yml (its parsed object). */
export function reviewSettings(user: unknown): ReviewSettings {
  const b = obj(obj(user).reviews);
  return {
    enabled: b.enabled === true,
    reviewer: reviewer(b.reviewer),
    minSessionLeftPct: num(b, "min_session_left_pct"),
    minWeeklyLeftPct: num(b, "min_weekly_left_pct"),
    maxConcurrent: num(b, "max_concurrent"),
    claimWindowSeconds: num(b, "claim_window_seconds"),
    claimTimeoutMinutes: num(b, "claim_timeout_minutes"),
    maxRounds: num(b, "max_rounds"),
    agentsMayApprove: b.agents_may_approve === true,
    resolve: "person",
    baseDeny: strings(b.base_deny, REF_RE),
    commentersAllow: strings(b.commenters_allow, LOGIN_RE),
    commentersBlock: strings(b.commenters_block, LOGIN_RE),
  };
}
