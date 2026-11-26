/**
 * Issue 785: an agent reports how to resume its conversation, with its own
 * token: POST /api/agents/self/resume-command { conversation, cwd, seq }.
 *
 * Only the conversation's id: Den builds the command from the runtime's
 * own template (resume-command.ts), so a report can't change what the
 * agent starts as. Den keeps the newest by sequence on the agent's
 * record. One that breaks a rule is refused and logged by its reason
 * only, never its words.
 */
import type * as http from "http";
import {
  listRecords,
  readRecord,
  recordFileTrusted,
  writeRecord,
  type AgentRecord,
} from "../../shared/agents/records.js";
import {
  acceptResumeReport,
  conversationHeldElsewhere,
  RESUME_REPORT_PATH,
  resumeReportProblem,
  type ResumeReport,
} from "../../shared/agents/resume-command.js";
import { getRuntime } from "../../shared/agents/runtimes.js";
import { sessionStoreOf } from "../../shared/agents/session-files.js";
import { resumeReportLimits } from "../../shared/den-config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Issue 785: when each agent's last report was checked against its
 * runtime's session record (ms), for agents.resume_report_min_seconds.
 */
const lastCheck = new Map<string, number>();

/** Tests: forget every agent's last check. */
export function resetResumeReportChecks(): void {
  lastCheck.clear();
}
import { agentTokenPrincipalOf, type AgentPrincipal } from "./request-guard.js";
import { readBodyCapped, sendJson } from "./http-helpers.js";

export { RESUME_REPORT_PATH };

export interface ResumeReportDeps {
  stateDir: () => string;
  log: (line: string) => void;
  /** Tests: the agent the request is from. */
  principal?: (req: http.IncomingMessage) => AgentPrincipal | null;
  now?: () => Date;
  /** Den's own environment, where the runtime keeps its sessions (tests). */
  env?: NodeJS.ProcessEnv;
  /** agents.resume_* limits (default: user.yml). */
  limits?: () => { firstLineMaxBytes: number; minSeconds: number };
}

/** The body: a JSON object, at most 4 KiB (a report fits in well under). */
async function jsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBodyCapped(req, 4 * 1024);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function refuse(
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
): true {
  sendJson(res, { ok: false, code, error }, status);
  return true;
}

export async function handleResumeReportRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: ResumeReportDeps,
): Promise<boolean> {
  if (pathname !== RESUME_REPORT_PATH) return false;
  if ((req.method ?? "GET").toUpperCase() !== "POST")
    return refuse(res, 405, "method", "POST only.");
  // Its own token: never an agent's read-only view (issue 796).
  const agent = (d.principal ?? agentTokenPrincipalOf)(req);
  if (!agent)
    return refuse(
      res,
      403,
      "agent_only",
      "Only an agent's own token reports its resume command.",
    );
  const id = agent.actor.slice("agent:".length);
  const found = (): AgentRecord | null => {
    const rec = readRecord(d.stateDir(), id);
    return rec && rec.workspace === agent.workspace ? rec : null;
  };
  const first = found();
  if (!first)
    return refuse(res, 404, "no_agent", `no agent ${id} in ${agent.workspace}`);
  if (!getRuntime(first.runtime)?.reportedResume)
    return refuse(
      res,
      400,
      "not_reported",
      `${first.runtime} has no resume command that takes a reported conversation: there is nothing to report`,
    );
  const b = await jsonBody(req);
  if (!b) return refuse(res, 400, "bad_body", "a JSON object, at most 4 KiB");
  const extra = Object.keys(b).filter(
    (k) => k !== "conversation" && k !== "cwd" && k !== "seq",
  );
  if (extra.length) {
    // The log never carries the agent's own text; the reply names the
    // field cleaned and short.
    d.log(`agent ${id}: resume report refused: unknown field`);
    const clean = extra[0]!.replace(/[^A-Za-z0-9_]/g, "");
    const name =
      (clean.slice(0, 32) || "field") + (clean.length > 32 ? "…" : "");
    return refuse(
      res,
      400,
      "unknown_field",
      `${name}: unknown field (a report takes conversation, cwd and seq)`,
    );
  }
  const report: ResumeReport = {
    conversation: b.conversation as string,
    cwd: b.cwd as string,
    seq: b.seq as number,
  };
  const problem = resumeReportProblem(report);
  if (problem) {
    d.log(`agent ${id}: resume report refused: ${problem}`);
    return refuse(res, 400, "refused_report", problem);
  }
  // C's nit: a sequence in milliseconds more than a day ahead would pin
  // this report past every later one.
  const nowMs = (d.now?.() ?? new Date()).getTime();
  if (report.seq > 1e12 && report.seq > nowMs + DAY_MS) {
    const why = "its sequence is more than a day ahead of now";
    d.log(`agent ${id}: resume report refused: ${why}`);
    return refuse(res, 400, "refused_report", why);
  }
  // Issue 785: a report that would be kept, with a conversation new to the
  // record, is checked against the runtime's own session record (Codex: a
  // main thread that began in the agent's folder after it was created).
  // The check reads files without blocking, at most once every
  // agents.resume_report_min_seconds per agent, and before the record is
  // read again for the write.
  const before = found();
  if (!before)
    return refuse(res, 404, "no_agent", `no agent ${id} in ${agent.workspace}`);
  // The cheap refusal first: another agent's conversation costs no walk.
  if (
    conversationHeldElsewhere(
      before,
      report.conversation,
      listRecords(d.stateDir()),
    )
  ) {
    const why = "it is another agent's conversation";
    d.log(`agent ${id}: resume report refused: ${why}`);
    return refuse(res, 400, "refused_report", why);
  }
  const rt0 = getRuntime(before.runtime);
  const needsCheck =
    !!rt0?.reportedConversationOk &&
    acceptResumeReport(before.resumeReport, report) &&
    before.resumeReport?.conversation !== report.conversation;
  if (needsCheck) {
    const limits = (d.limits ?? (() => resumeReportLimits()))();
    const last = lastCheck.get(before.id) ?? -Infinity;
    if (nowMs - last < limits.minSeconds * 1000)
      return refuse(
        res,
        429,
        "too_soon",
        `one checked report every ${limits.minSeconds} s: report again later`,
      );
    lastCheck.set(before.id, nowMs);
    const store = sessionStoreOf(
      before,
      d.env ?? process.env,
      recordFileTrusted(d.stateDir(), before.id),
    );
    const ok =
      !!store &&
      (await rt0!.reportedConversationOk!(report.conversation, {
        store,
        cwd: before.cwd,
        notBefore: before.createdAt ?? before.startedAt,
        firstLineMaxBytes: limits.firstLineMaxBytes,
      }));
    if (!ok) {
      const why = `it is not a main thread of ${before.runtime} that began in the agent's folder after the agent was created`;
      d.log(`agent ${id}: resume report refused: ${why}`);
      return refuse(res, 400, "not_main_thread", why);
    }
  }
  // From here to the write, nothing awaits: the record is read again now
  // (the body's pace is the agent's, and a person may have changed the
  // record meanwhile), and only its report changes.
  const rec = found();
  if (!rec)
    return refuse(res, 404, "no_agent", `no agent ${id} in ${agent.workspace}`);
  if (!getRuntime(rec.runtime)?.reportedResume)
    return refuse(
      res,
      400,
      "not_reported",
      `${rec.runtime} has no resume command that takes a reported conversation: there is nothing to report`,
    );
  if (
    conversationHeldElsewhere(
      rec,
      report.conversation,
      listRecords(d.stateDir()),
    )
  ) {
    const why = "it is another agent's conversation";
    d.log(`agent ${id}: resume report refused: ${why}`);
    return refuse(res, 400, "refused_report", why);
  }
  const prev = rec.resumeReport;
  if (!acceptResumeReport(prev, report)) {
    sendJson(res, { ok: true, kept: false, seq: prev!.seq });
    return true;
  }
  // What the check rested on must still hold: the same runtime, folder,
  // creation and login, and (unchecked) the same conversation as before.
  const same =
    rec.runtime === before.runtime &&
    rec.cwd === before.cwd &&
    rec.createdAt === before.createdAt &&
    rec.startedAt === before.startedAt &&
    JSON.stringify(rec.runAs ?? null) ===
      JSON.stringify(before.runAs ?? null) &&
    (needsCheck ||
      prev?.conversation === report.conversation ||
      !rt0?.reportedConversationOk);
  if (!same)
    return refuse(
      res,
      409,
      "changed",
      "the agent's record changed while its report was checked: report again",
    );
  writeRecord(d.stateDir(), {
    ...rec,
    resumeReport: {
      conversation: report.conversation,
      cwd: report.cwd,
      seq: report.seq,
      at: (d.now?.() ?? new Date()).toISOString(),
    },
  });
  sendJson(res, { ok: true, kept: true, seq: report.seq });
  return true;
}
