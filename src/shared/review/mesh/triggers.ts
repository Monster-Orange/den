/**
 * Issue 476 (REVIEW-MESH-SPEC RV-9 item 4): what starts a review. A PR
 * opened ready or leaving draft, or a `/pleasereview` comment (which may
 * add lenses: `/pleasereview --lens security,performance`). `base_deny`
 * skips the automatic review into some bases; the comment overrides it.
 * PRs from forks wait for a person's "Review this" (RV-6).
 */
import type { ReviewSettings } from "./settings.js";

export type TriggerEvent = {
  repo: string;
  draft: boolean;
  fork: boolean;
  baseRef: string;
} & (
  | { kind: "opened" | "ready_for_review" | "synchronize" }
  | { kind: "comment"; commenter: string; body: string }
);

export type Trigger =
  | { start: true; lenses?: string[] }
  | {
      start: false;
      why:
        | "reviews_off"
        | "repo_not_watched"
        | "draft"
        | "fork_waits_for_person"
        | "base_denied"
        | "commenter_blocked"
        | "not_a_trigger";
    };

const ASK_RE = /^\/pleasereview(?:\s+--lens\s+([A-Za-z0-9_,-]+))?\s*$/m;

/** A base matches a deny entry exactly, or by a trailing `*`. */
const denied = (deny: readonly string[], base: string) =>
  deny.some((d) =>
    d.endsWith("*") ? base.startsWith(d.slice(0, -1)) : d === base,
  );

export function reviewTrigger(s: ReviewSettings, e: TriggerEvent): Trigger {
  if (!s.enabled || !s.reviewer) return { start: false, why: "reviews_off" };
  if (!s.reviewer.repos.includes(e.repo))
    return { start: false, why: "repo_not_watched" };
  if (e.kind === "comment") {
    const m = ASK_RE.exec(e.body);
    if (!m) return { start: false, why: "not_a_trigger" };
    const who = e.commenter.toLowerCase();
    const has = (l: readonly string[]) =>
      l.some((x) => x.toLowerCase() === who);
    if (
      has(s.commentersBlock) ||
      (s.commentersAllow.length > 0 && !has(s.commentersAllow))
    )
      return { start: false, why: "commenter_blocked" };
    const lenses = m[1]?.split(",").filter(Boolean);
    return lenses?.length ? { start: true, lenses } : { start: true };
  }
  if (e.draft) return { start: false, why: "draft" };
  if (e.fork) return { start: false, why: "fork_waits_for_person" };
  if (denied(s.baseDeny, e.baseRef))
    return { start: false, why: "base_denied" };
  return { start: true };
}
