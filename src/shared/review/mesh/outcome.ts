/**
 * Issue 476 (REVIEW-MESH-SPEC RV-8 item 3, RV-9 item 6): every run ends in
 * a named outcome, and the one check, "Den review", always finishes. None
 * fails silently: each reaches the person's notifications.
 */
export const OUTCOMES = [
  "converged",
  "no_progress",
  "cap_reached",
  "awaiting_human",
  "no_review_needed",
  "no_reviewer_free",
  "auth",
  "usage_cap",
  "transient",
  "error",
] as const;

export type Outcome = (typeof OUTCOMES)[number];

export const CHECK_NAME = "Den review";

export interface CheckResult {
  name: typeof CHECK_NAME;
  status: "completed";
  conclusion: "success" | "neutral" | "failure" | "action_required";
  /** Requeue after this wait; `times` null = until it works. */
  retry: { afterMinutes: number; times: number | null } | null;
  notify: true;
}

const TABLE: Record<Outcome, Pick<CheckResult, "conclusion" | "retry">> = {
  converged: { conclusion: "success", retry: null },
  no_progress: { conclusion: "neutral", retry: null },
  cap_reached: { conclusion: "neutral", retry: null },
  awaiting_human: { conclusion: "action_required", retry: null },
  no_review_needed: { conclusion: "success", retry: null },
  no_reviewer_free: { conclusion: "neutral", retry: null },
  auth: { conclusion: "neutral", retry: { afterMinutes: 10, times: null } },
  usage_cap: {
    conclusion: "neutral",
    retry: { afterMinutes: 30, times: null },
  },
  transient: { conclusion: "neutral", retry: { afterMinutes: 1, times: 3 } },
  error: { conclusion: "failure", retry: null },
};

export function checkFor(o: Outcome): CheckResult {
  return { name: CHECK_NAME, status: "completed", ...TABLE[o], notify: true };
}
