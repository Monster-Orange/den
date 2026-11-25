/**
 * issue_write: an agent creates and updates GitHub issues in its own
 * project's repos, as a direct, audited action (no person, no held write).
 * One action per call:
 *
 *   create     title (1–256), body (optional), labels, milestone
 *   comment    issue, body
 *   label      issue, add and/or remove
 *   milestone  issue, milestone (its title)
 *
 * Closing, reopening, deleting, transferring and locking are never done
 * here: they are a person's (Den has no held write for them yet).
 *
 * The settings (user.yml, Settings › Agents; else den.yml `agents:`):
 *   agents.issue_writes           the persona roles allowed (a list;
 *                                 default ISSUE_WRITE_DEFAULT_ROLES; [] none)
 *   agents.issue_writes_per_hour  writes per hour for the whole install,
 *                                 every agent counted (default 60)
 *
 * This file is the pure part: the checks, the settings, the `gh` arguments,
 * the footer and the limit. The route (ui/server/issue-write-routes.ts)
 * runs it as the agent its token proves.
 */

/** The actions issue_write does. */
export const ISSUE_WRITE_ACTIONS = [
  "create",
  "comment",
  "label",
  "milestone",
] as const;
export type IssueWriteAction = (typeof ISSUE_WRITE_ACTIONS)[number];

/** What it never does: refused, pointing to a person. */
export const ISSUE_WRITE_REFUSED_ACTIONS = [
  "close",
  "reopen",
  "delete",
  "transfer",
  "lock",
  "unlock",
  "pin",
  "unpin",
] as const;

/**
 * The roles allowed when agents.issue_writes is unset: those whose work
 * files and tends issues (Den's planner, orchestrator, sde and reviewer;
 * "lead" and "builder", the names a distribution gives an orchestrator and
 * an implementer), and "install", Den's own agent (the install's). Tester and designer are
 * off: they report through the others.
 */
export const ISSUE_WRITE_DEFAULT_ROLES: readonly string[] = [
  "planner",
  "orchestrator",
  "lead",
  "sde",
  "builder",
  "reviewer",
  "install",
];

/** Den's own agent's role here (its persona has none): the install's agent. */
export const SERVER_AGENT_ROLE = "install";

/** agents.issue_writes_per_hour: default and range. */
export const ISSUE_WRITES_PER_HOUR = {
  default: 60,
  min: 1,
  max: 10_000,
} as const;

/**
 * Issue 1127: agents.issue_writes_visibility_minutes, how old a repo's
 * visibility may be when the words check asks it (a repo made public is
 * checked from then on, at most this late). Default and range.
 */
export const ISSUE_WRITES_VISIBILITY_MINUTES = {
  default: 10,
  min: 1,
  max: 1440,
} as const;

/** A title's length, GitHub's own limit. */
export const ISSUE_TITLE_MAX = 256;
/** A body's or comment's length, in characters (GitHub's own limit). */
export const ISSUE_BODY_MAX = 65_536;
/** A label's or milestone's length. */
const NAME_MAX = 100;
/** Labels on one call. */
const LABELS_MAX = 20;

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface IssueWriteSettings {
  roles: string[];
  perHour: number;
  /** Issue 1127: agents.issue_writes_visibility_minutes. */
  visibilityMinutes: number;
}

type UserLike = { agents?: Record<string, unknown> | null } | null | undefined;

/**
 * agents.issue_writes and agents.issue_writes_per_hour: user.yml's, else
 * the distribution's (den.yml `agents:`), else the defaults. A wrong value
 * throws naming its key and file.
 */
export function issueWriteSettings(
  readUser: () => unknown,
  readDen: () => unknown = () => ({}),
): IssueWriteSettings {
  const agentsOf = (c: unknown) =>
    ((c as UserLike)?.agents ?? {}) as Record<string, unknown>;
  const user = agentsOf(readUser());
  let den: Record<string, unknown> | null = null;
  const pick = (k: string): [unknown, string] => {
    if (user[k] !== undefined && user[k] !== null) return [user[k], "user.yml"];
    den ??= agentsOf(readDen());
    return [den[k], "the distribution's config"];
  };
  const [r, rFrom] = pick("issue_writes");
  let roles = [...ISSUE_WRITE_DEFAULT_ROLES];
  if (r !== undefined && r !== null) {
    if (
      !Array.isArray(r) ||
      !r.every((x) => typeof x === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(x))
    )
      throw new Error(
        `agents.issue_writes must be a list of roles, such as [planner, sde] (${rFrom}; got ${JSON.stringify(r)})`,
      );
    roles = [...new Set(r as string[])];
  }
  const [p, pFrom] = pick("issue_writes_per_hour");
  let perHour: number = ISSUE_WRITES_PER_HOUR.default;
  if (p !== undefined && p !== null) {
    if (
      typeof p !== "number" ||
      !Number.isInteger(p) ||
      p < ISSUE_WRITES_PER_HOUR.min ||
      p > ISSUE_WRITES_PER_HOUR.max
    )
      throw new Error(
        `agents.issue_writes_per_hour must be a whole number from ${ISSUE_WRITES_PER_HOUR.min} to ${ISSUE_WRITES_PER_HOUR.max} (${pFrom}; got ${JSON.stringify(p)})`,
      );
    perHour = p;
  }
  const [v, vFrom] = pick("issue_writes_visibility_minutes");
  let visibilityMinutes: number = ISSUE_WRITES_VISIBILITY_MINUTES.default;
  if (v !== undefined && v !== null) {
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < ISSUE_WRITES_VISIBILITY_MINUTES.min ||
      v > ISSUE_WRITES_VISIBILITY_MINUTES.max
    )
      throw new Error(
        `agents.issue_writes_visibility_minutes must be a whole number from ${ISSUE_WRITES_VISIBILITY_MINUTES.min} to ${ISSUE_WRITES_VISIBILITY_MINUTES.max} (${vFrom}; got ${JSON.stringify(v)})`,
      );
    visibilityMinutes = v;
  }
  return { roles, perHour, visibilityMinutes };
}

/** One checked write. */
export type IssueOp =
  | {
      action: "create";
      repo: string;
      title: string;
      body: string;
      labels: string[];
      milestone?: string;
    }
  | { action: "comment"; repo: string; issue: number; body: string }
  | {
      action: "label";
      repo: string;
      issue: number;
      add: string[];
      remove: string[];
    }
  | { action: "milestone"; repo: string; issue: number; milestone: string };

export type IssueCheck =
  | { ok: true; op: IssueOp }
  | { ok: false; error: string; action?: string };

/** Why a closing (or similar) action is refused. */
export function refusedActionReason(action: string): string {
  return `issue_write doesn't ${action} issues: that is a person's call. Ask your person to do it on GitHub; Den has no held write for it yet.`;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A name (label or milestone): one line, 1–100, no comma for a label. */
function nameOk(v: unknown, label: boolean): v is string {
  return (
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.length <= NAME_MAX &&
    !/[\p{Cc}]/u.test(v) &&
    !(label && v.includes(","))
  );
}

function labelList(
  v: unknown,
  key: string,
): { ok: true; list: string[] } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, list: [] };
  if (!Array.isArray(v) || v.length > LABELS_MAX)
    return {
      ok: false,
      error: `${key}: a list of up to ${LABELS_MAX} label names`,
    };
  for (const l of v)
    if (!nameOk(l, true))
      return {
        ok: false,
        error: `${key}: each label is a non-empty name of at most ${NAME_MAX} characters, one line, no comma`,
      };
  return { ok: true, list: (v as string[]).map((l) => l.trim()) };
}

function issueOf(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : null;
}

function bodyOf(
  v: unknown,
  need: boolean,
): { ok: true; body: string } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "")
    return need
      ? { ok: false, error: "body: give the text (it is posted on GitHub)" }
      : { ok: true, body: "" };
  if (typeof v !== "string") return { ok: false, error: "body: text" };
  if (need && !v.trim())
    return { ok: false, error: "body: give the text (it is posted on GitHub)" };
  if (v.length > ISSUE_BODY_MAX)
    return {
      ok: false,
      error: `body: at most ${ISSUE_BODY_MAX} characters (got ${v.length})`,
    };
  return { ok: true, body: v };
}

/** The checks at the boundary: one action and its fields, or why not. */
export function checkIssueWrite(a: unknown): IssueCheck {
  if (!isObj(a)) return { ok: false, error: "give an action and its fields" };
  const action = typeof a.action === "string" ? a.action.trim() : "";
  if ((ISSUE_WRITE_REFUSED_ACTIONS as readonly string[]).includes(action))
    return { ok: false, error: refusedActionReason(action), action };
  if (!(ISSUE_WRITE_ACTIONS as readonly string[]).includes(action))
    return {
      ok: false,
      error: `action: one of ${ISSUE_WRITE_ACTIONS.join(", ")}`,
    };
  const repo = typeof a.repo === "string" ? a.repo.trim() : "";
  if (!REPO_RE.test(repo))
    return { ok: false, error: "repo: a GitHub repo, owner/name", action };
  if (action === "create") {
    const title = typeof a.title === "string" ? a.title.trim() : "";
    if (!title || title.length > ISSUE_TITLE_MAX || /[\r\n]/.test(title))
      return {
        ok: false,
        error: `title: one line of 1 to ${ISSUE_TITLE_MAX} characters`,
        action,
      };
    const b = bodyOf(a.body, false);
    if (!b.ok) return { ...b, action };
    const labels = labelList(a.labels, "labels");
    if (!labels.ok) return { ...labels, action };
    if (a.milestone !== undefined && !nameOk(a.milestone, false))
      return {
        ok: false,
        error: `milestone: its title, 1 to ${NAME_MAX} characters`,
        action,
      };
    return {
      ok: true,
      op: {
        action,
        repo,
        title,
        body: b.body,
        labels: labels.list,
        ...(typeof a.milestone === "string"
          ? { milestone: a.milestone.trim() }
          : {}),
      },
    };
  }
  const issue = issueOf(a.issue);
  if (issue === null)
    return {
      ok: false,
      error: "issue: the issue's number, a whole number from 1",
      action,
    };
  if (action === "comment") {
    const b = bodyOf(a.body, true);
    if (!b.ok) return { ...b, action };
    return { ok: true, op: { action, repo, issue, body: b.body } };
  }
  if (action === "label") {
    const add = labelList(a.add, "add");
    if (!add.ok) return { ...add, action };
    const remove = labelList(a.remove, "remove");
    if (!remove.ok) return { ...remove, action };
    if (!add.list.length && !remove.list.length)
      return {
        ok: false,
        error: "label: give add or remove (label names), or both",
        action,
      };
    return {
      ok: true,
      op: { action, repo, issue, add: add.list, remove: remove.list },
    };
  }
  if (!nameOk(a.milestone, false))
    return {
      ok: false,
      error: `milestone: its title, 1 to ${NAME_MAX} characters`,
      action,
    };
  return {
    ok: true,
    op: {
      action: "milestone",
      repo,
      issue,
      milestone: (a.milestone as string).trim(),
    },
  };
}

/** A name as the footer says it: one line, printable, no @-mention. */
function plainName(v: string, max: number): string {
  return (
    [...v.replace(/[\r\n]+/g, " ")]
      .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
      .join("")
      .replace(/@/g, "")
      .trim()
      .slice(0, max) || "agent"
  );
}

/** The footer every created issue and comment carries (in English: GitHub's). */
export function issueWriteFooter(agent: string, install: string): string {
  return `— written by agent ${plainName(agent, 60)} in ${plainName(install, 60)}`;
}

/** The body as posted: the text, then the footer. */
export function withFooter(body: string, footer: string): string {
  const b = body.replace(/\s+$/, "");
  return b ? `${b}\n\n${footer}` : footer;
}

/**
 * The `gh` call for one write, and its stdin (the body, footer and all):
 * the body goes through stdin (--body-file -), never the command line.
 */
export function ghIssueArgs(
  op: IssueOp,
  footer: string,
): { args: string[]; stdin?: string } {
  switch (op.action) {
    case "create":
      return {
        args: [
          "issue",
          "create",
          "--repo",
          op.repo,
          "--title",
          op.title,
          "--body-file",
          "-",
          ...op.labels.flatMap((l) => ["--label", l]),
          ...(op.milestone ? ["--milestone", op.milestone] : []),
        ],
        stdin: withFooter(op.body, footer),
      };
    case "comment":
      return {
        args: [
          "issue",
          "comment",
          String(op.issue),
          "--repo",
          op.repo,
          "--body-file",
          "-",
        ],
        stdin: withFooter(op.body, footer),
      };
    case "label":
      return {
        args: [
          "issue",
          "edit",
          String(op.issue),
          "--repo",
          op.repo,
          ...op.add.flatMap((l) => ["--add-label", l]),
          ...op.remove.flatMap((l) => ["--remove-label", l]),
        ],
      };
    case "milestone":
      return {
        args: [
          "issue",
          "edit",
          String(op.issue),
          "--repo",
          op.repo,
          "--milestone",
          op.milestone,
        ],
      };
  }
}

/** The issue number in `gh issue create`'s answer (its URL), or undefined. */
export function createdIssue(
  stdout: string,
): { issue: number; url: string } | undefined {
  const m = stdout.match(/https:\/\/\S+\/issues\/(\d+)/);
  return m ? { issue: Number(m[1]), url: m[0] } : undefined;
}

/** The audit's short summary: what was done, never the body. */
export function issueWriteSummary(op: IssueOp, issue?: number): string {
  const n = issue ?? ("issue" in op ? op.issue : undefined);
  const which = n !== undefined ? `issue ${n}` : "an issue";
  const s =
    op.action === "create"
      ? `created ${which} on ${op.repo}: ${op.title}`
      : op.action === "comment"
        ? `commented on ${which} on ${op.repo}`
        : op.action === "label"
          ? `labels on ${which} on ${op.repo}: ${[
              ...op.add.map((l) => `+${l}`),
              ...op.remove.map((l) => `-${l}`),
            ].join(" ")}`
          : `milestone of ${which} on ${op.repo}: ${op.milestone}`;
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * GitHub's error as a plain line: its HTTP status when gh names one, and
 * the last lines of what it said, with anything like a token taken out.
 */
export function ghFailure(r: {
  code: number;
  stdout: string;
  stderr: string;
}): { status?: number; error: string } {
  const text = (r.stderr || r.stdout || "").trim();
  const m = text.match(/HTTP (\d{3})/);
  const status = m ? Number(m[1]) : undefined;
  const said = text
    .split("\n")
    .slice(-2)
    .join(" ")
    .replace(
      /\b(gh[opsur]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,
      "[redacted]",
    )
    .replace(
      /\b(token|authorization|bearer)\b\s*[:=]?\s*\S+/gi,
      "$1 [redacted]",
    )
    .slice(0, 300);
  return {
    ...(status ? { status } : {}),
    error: status
      ? `GitHub answered ${status}: ${said}`
      : `gh failed (exit ${r.code}): ${said || "no output"}`,
  };
}

/**
 * The install's limit: writes in the last hour by every agent. take()
 * counts one and says ok, or says how long until the oldest leaves the
 * hour.
 */
export class IssueWriteLimit {
  private readonly at: number[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  take(perHour: number): { ok: true } | { ok: false; waitMs: number } {
    const t = this.now();
    while (this.at.length && t - this.at[0] >= 3_600_000) this.at.shift();
    if (this.at.length >= perHour)
      return { ok: false, waitMs: this.at[0] + 3_600_000 - t };
    this.at.push(t);
    return { ok: true };
  }
}
