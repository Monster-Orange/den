import type * as http from "http";
import {
  listRecords,
  readRecord,
  writeRecord,
  type AgentRecord,
} from "../../shared/agents/records.js";
import {
  acceptResumeReport,
  conversationHeldElsewhere,
  resumeReportProblem,
  type ResumeReport,
} from "../../shared/agents/resume-command.js";
import { getRuntime } from "../../shared/agents/runtimes.js";
import { agentTokenPrincipalOf, type AgentPrincipal } from "./request-guard.js";
import { readBodyCapped, sendJson } from "./http-helpers.js";

export const RESUME_REPORT_PATH = "/api/agents/self/resume-command";

export interface ResumeReportDeps {
  stateDir: () => string;
  log: (line: string) => void;
  principal?: (req: http.IncomingMessage) => AgentPrincipal | null;
  now?: () => Date;
}

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
