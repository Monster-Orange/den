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
import { readRecord, writeRecord } from "../../shared/agents/records.js";
import {
  acceptResumeReport,
  resumeReportProblem,
  type ResumeReport,
} from "../../shared/agents/resume-command.js";
import { getRuntime } from "../../shared/agents/runtimes.js";
import { agentPrincipalOf, type AgentPrincipal } from "./request-guard.js";
import { readBodyCapped, sendJson } from "./http-helpers.js";

export const RESUME_REPORT_PATH = "/api/agents/self/resume-command";

export interface ResumeReportDeps {
  stateDir: () => string;
  log: (line: string) => void;
  /** Tests: the agent the request is from. */
  principal?: (req: http.IncomingMessage) => AgentPrincipal | null;
  now?: () => Date;
}

/** The body: a JSON object, at most 32 KiB (an 8 KiB command, escaped). */
async function jsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBodyCapped(req, 32 * 1024);
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
  const agent = (d.principal ?? agentPrincipalOf)(req);
  if (!agent)
    return refuse(
      res,
      403,
      "agent_only",
      "Only an agent's own token reports its resume command.",
    );
  const id = agent.actor.slice("agent:".length);
  const rec = readRecord(d.stateDir(), id);
  if (!rec || rec.workspace !== agent.workspace)
    return refuse(res, 404, "no_agent", `no agent ${id} in ${agent.workspace}`);
  if (!getRuntime(rec.runtime)?.reportedResume)
    return refuse(
      res,
      400,
      "not_reported",
      `${rec.runtime} has no resume command that takes a reported conversation: there is nothing to report`,
    );
  const b = await jsonBody(req);
  if (!b) return refuse(res, 400, "bad_body", "a JSON object");
  const extra = Object.keys(b).filter(
    (k) => k !== "conversation" && k !== "cwd" && k !== "seq",
  );
  if (extra.length) {
    d.log(`agent ${id}: resume report refused: unknown field ${extra[0]}`);
    return refuse(
      res,
      400,
      "unknown_field",
      `${extra[0]}: unknown field (a report takes conversation, cwd and seq)`,
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
  const prev = rec.resumeReport;
  if (!acceptResumeReport(prev, report)) {
    sendJson(res, { ok: true, kept: false, seq: prev!.seq });
    return true;
  }
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
