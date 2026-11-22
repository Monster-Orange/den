/**
 * issue_write's route (shared/issue-write.ts):
 *   POST /api/agents/self/issue-write  an agent (its actor token only)
 *        creates an issue, comments, labels or sets a milestone in one of
 *        its own project's repos: {action, repo, project?, issue?, title?,
 *        body?, labels?, add?, remove?, milestone?}.
 *
 * Which agent and project come from the token, never the body. Den's own
 * agent names the project. A direct action, audited, not a held write: the
 * checks are the role (agents.issue_writes), the project's repos and the
 * install's limit (agents.issue_writes_per_hour). It runs `gh issue …`
 * through the call path pr_close's close uses (runGh: the person's own gh
 * and its credentials); Den holds no GitHub credential of its own for it.
 */
import type * as http from "http";
import {
  SERVER_AGENT_ROLE,
  checkIssueWrite,
  createdIssue,
  ghFailure,
  ghIssueArgs,
  issueWriteFooter,
  issueWriteSummary,
  type IssueWriteLimit,
  type IssueWriteSettings,
} from "../../shared/issue-write.js";
import {
  filedTextHits,
  filedTextRefusal,
  needsFiledCheck,
  type FiledText,
} from "../../shared/filed-text-check.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import { readBody, sendJson } from "./http-helpers.js";
import { agentPrincipalOf } from "./request-guard.js";

export const ISSUE_WRITE_PATH = "/api/agents/self/issue-write";

/** One audit row: never the body. */
export interface IssueWriteAudit {
  agent: string;
  project?: string;
  repo?: string;
  issue?: number;
  action: string;
  summary: string;
  refused?: true;
  reason?: string;
}

export interface IssueWriteDeps {
  /** The agent's name and its persona's role, or null when Den has no such agent. */
  agentOf: (id: string) => { name: string; role?: string } | null;
  projectExists: (project: string) => boolean;
  /** The project's GitHub repos, owner/name. */
  projectRepos: (project: string) => string[];
  /** agents.issue_writes and agents.issue_writes_per_hour (throws on a bad value). */
  settings: () => IssueWriteSettings;
  limit: IssueWriteLimit;
  /** The gh call (report-routes.ts runGh; tests pass a fake). */
  gh: (
    args: string[],
    stdin?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** This install's label (the footer's). */
  installLabel: () => string;
  /**
   * Issue 1127: the listed names (shared/org-names.js orgPatterns; none:
   * nothing refused) and a repo's visibility no older than `maxAgeMs`
   * (null: not known, so checked).
   */
  namePatterns: () => RegExp[];
  visibility: (
    repo: string,
    maxAgeMs: number,
  ) => Promise<"public" | "private" | "internal" | null>;
  audit: (e: IssueWriteAudit) => void;
}

export interface IssueWriteAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** One write, as agent `who.agent` of `who.workspace`. */
export async function runIssueWrite(
  d: IssueWriteDeps,
  who: { agent: string; workspace: string },
  b: Record<string, unknown>,
): Promise<IssueWriteAnswer> {
  const action = typeof b.action === "string" ? b.action.slice(0, 40) : "?";
  const named = typeof b.project === "string" ? b.project : undefined;
  const own = isServerScope(who.workspace);
  const project = own ? named : (named ?? who.workspace);
  const repo =
    typeof b.repo === "string" ? b.repo.trim().slice(0, 201) : undefined;
  const refuse = (
    status: number,
    code: string,
    error: string,
    issue?: number,
  ): IssueWriteAnswer => {
    d.audit({
      agent: who.agent,
      ...(project ? { project } : {}),
      ...(repo ? { repo } : {}),
      ...(issue !== undefined ? { issue } : {}),
      action,
      summary: `refused ${action}${repo ? ` on ${repo}` : ""}`,
      refused: true,
      reason: error.slice(0, 300),
    });
    return { status, body: { ok: false, code, error } };
  };

  const c = checkIssueWrite(b);
  if (!c.ok) return refuse(400, "issue_write_input", c.error);
  const op = c.op;
  const issueNo = "issue" in op ? op.issue : undefined;

  if (!project)
    return refuse(
      400,
      "issue_write_project",
      "name the project whose repo it is (project)",
      issueNo,
    );
  if (!own && project !== who.workspace)
    return refuse(
      403,
      "issue_write_scope",
      `you work in project "${who.workspace}" and write issues in its repos only, not project "${project}"; nothing was sent`,
      issueNo,
    );
  if (!d.projectExists(project))
    return refuse(
      403,
      "issue_write_scope",
      `there is no project "${project}"`,
      issueNo,
    );
  const repos = d.projectRepos(project);
  if (!repos.some((r) => r.toLowerCase() === op.repo.toLowerCase()))
    return refuse(
      403,
      "issue_write_scope",
      `${op.repo} is not one of project ${project}'s repos (${repos.join(", ") || "none on GitHub"}); nothing was sent`,
      issueNo,
    );

  const me = d.agentOf(who.agent);
  if (!me)
    return refuse(403, "issue_write_agent", "Den has no such agent", issueNo);
  let settings: IssueWriteSettings;
  try {
    settings = d.settings();
  } catch (e) {
    return refuse(500, "bad_config", (e as Error).message, issueNo);
  }
  const role = own ? SERVER_AGENT_ROLE : me.role;
  if (!role || !settings.roles.includes(role))
    return refuse(
      403,
      "issue_write_role",
      `${role ? `role ${role}` : "a persona with no role"} doesn't write issues here (agents.issue_writes: ${settings.roles.join(", ") || "none"}). A person changes that in Settings › Agents.`,
      issueNo,
    );

  // Issue 1127: the text a create or comment files, checked for listed
  // names before it is sent (and before it counts against the limit).
  const texts: FiledText[] =
    op.action === "create"
      ? [
          { field: "title", text: op.title },
          { field: "body", text: op.body },
        ]
      : op.action === "comment"
        ? [{ field: "comment", text: op.body }]
        : [];
  if (texts.length) {
    let patterns: RegExp[];
    try {
      patterns = d.namePatterns();
    } catch (e) {
      // A list file named but missing: fail closed.
      return refuse(500, "bad_config", (e as Error).message, issueNo);
    }
    if (patterns.length) {
      const vis = await d.visibility(op.repo, settings.visibilityMinutes * 60_000);
      if (needsFiledCheck(vis)) {
        const hits = filedTextHits(texts, patterns, op.repo);
        if (hits.length)
          return refuse(400, "issue_write_words", filedTextRefusal(hits), issueNo);
      }
    }
  }

  const took = d.limit.take(settings.perHour);
  if (!took.ok) {
    const min = Math.max(1, Math.ceil(took.waitMs / 60_000));
    return refuse(
      429,
      "issue_write_limit",
      `this Den made ${settings.perHour} issue writes in the last hour (agents.issue_writes_per_hour); try again in ${min} minute${min === 1 ? "" : "s"}`,
      issueNo,
    );
  }

  const footer = issueWriteFooter(me.name, d.installLabel());
  const call = ghIssueArgs(op, footer);
  const r = await d.gh(call.args, call.stdin);
  if (r.code !== 0) {
    const f = ghFailure(r);
    return refuse(502, "issue_write_github", f.error, issueNo);
  }
  const made = op.action === "create" ? createdIssue(r.stdout) : undefined;
  const issue = made?.issue ?? issueNo;
  d.audit({
    agent: who.agent,
    project,
    repo: op.repo,
    ...(issue !== undefined ? { issue } : {}),
    action: op.action,
    summary: issueWriteSummary(op, issue),
  });
  return {
    status: 200,
    body: {
      ok: true,
      action: op.action,
      repo: op.repo,
      ...(issue !== undefined ? { issue } : {}),
      ...(made ? { url: made.url } : {}),
    },
  };
}

async function jsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    // A body of 65536 characters, as JSON, fits.
    if (raw.length > 512 * 1024) return null;
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function handleIssueWriteRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: IssueWriteDeps,
): Promise<boolean> {
  if (pathname !== "/api/agents/self/issue-write") return false;
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, { ok: false, code: "method", error: "POST only." }, 405);
    return true;
  }
  const agent = agentPrincipalOf(req);
  if (!agent) {
    sendJson(
      res,
      {
        ok: false,
        code: "agent_only",
        error: "Only an agent's own token writes issues here.",
      },
      403,
    );
    return true;
  }
  const b = await jsonBody(req);
  if (!b) {
    sendJson(
      res,
      { ok: false, code: "bad_body", error: "a JSON object, under 512 KB" },
      400,
    );
    return true;
  }
  const a = await runIssueWrite(
    deps,
    { agent: agent.actor.slice("agent:".length), workspace: agent.workspace },
    b,
  );
  sendJson(res, a.body, a.status);
  return true;
}
