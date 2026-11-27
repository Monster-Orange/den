import type http from "node:http";
import { SUBAGENT_START_ROUTE } from "../../shared/agents/guardrails/subagent-hook.js";
import type { SubagentDecision } from "../../shared/agents/subagent-gate.js";

export const SUBAGENT_START_PATH = SUBAGENT_START_ROUTE;

export interface SubagentRouteDeps {
  agentOf: (req: http.IncomingMessage) => string | null;
  gate: (agent: string) => Promise<SubagentDecision>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export async function handleSubagentStart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: SubagentRouteDeps,
): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "method", message: "POST only." });
  }
  const agent = deps.agentOf(req);
  if (!agent)
    return send(res, 403, {
      error: "agent_only",
      message: "Only an agent's own token asks to start a subagent.",
    });
  req.resume();
  let d: SubagentDecision;
  try {
    d = await deps.gate(agent);
  } catch (e) {
    return send(res, 500, {
      error: "subagent_gate",
      message: `Den couldn't check its subagent limit: ${(e as Error).message}`,
    });
  }
  return d.ok ? send(res, 200, { ok: true }) : send(res, 409, d);
}
