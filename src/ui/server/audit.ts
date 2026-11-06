/**
 * The action audit trail: every service exec, test run and sync, with who
 * asked (a person in the UI, or an agent through `<cli> mcp`). Each action
 * becomes a lifecycle line in the server log, the stream the /logs page shows
 * as the web-server log, so agent actions sit beside the UI's own; the
 * structured entries are kept in a small in-memory ring.
 */
import {
  actorLabel,
  type Actor,
  type AgentActor,
} from "../../shared/agent-actor.js";

export { actorFromHeaders } from "../../shared/agent-actor.js";

export interface AuditEntry {
  ts: string;
  actor: "agent" | "user";
  client?: string;
  clientVersion?: string;
  mcpPid?: number | null;
  session?: string;
  /** A scoped MCP server's actor, `agent:<id>` (AG-2a-core). */
  agent?: string;
  /** The workspace that scoped server is pinned to. */
  workspace?: string;
  /** exec | run | sync, or the MCP tool name for a refused non-lifecycle call */
  verb: string;
  detail: string;
  /** Set when the action never ran: a guard or the server refused it. */
  outcome?: "refused";
  /** Why it was refused (first line). */
  reason?: string;
}

type Sink = (line: string, actor: AgentActor | null) => void;

const RING_MAX = 200;
const ring: AuditEntry[] = [];
let sink: Sink | null = null;

/** Where audit lines go (the server log); null to disconnect. */
export function setAuditSink(fn: Sink | null): void {
  sink = fn;
}

/** " · by agent …" for an agent, "" for a person. */
export function actorSuffix(actor: Actor): string {
  return actor ? ` · by ${actorLabel(actor)}` : "";
}

export function recordAction(
  actor: Actor,
  action: {
    verb: string;
    detail: string;
    outcome?: "refused";
    reason?: string;
  },
): AuditEntry {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    actor: actor ? "agent" : "user",
    ...(actor
      ? {
          client: actor.client,
          clientVersion: actor.clientVersion,
          mcpPid: actor.mcpPid,
          session: actor.session,
          ...(actor.agent ? { agent: actor.agent } : {}),
          ...(actor.workspace ? { workspace: actor.workspace } : {}),
        }
      : {}),
    verb: action.verb,
    detail: action.detail,
    ...(action.outcome ? { outcome: action.outcome } : {}),
    ...(action.reason ? { reason: clean(action.reason, 300) } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  const mark = entry.outcome === "refused" ? "✗" : "▶";
  const why = entry.reason ? ` — refused: ${entry.reason}` : "";
  sink?.(
    `${mark} ${action.verb} ${action.detail}${why}${actorSuffix(actor)}`,
    actor,
  );
  return entry;
}

/** One line, printable characters only, at most `max` long. */
function clean(v: unknown, max: number): string {
  const line = String(v ?? "").split(/[\r\n]/)[0];
  return [...line]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join("")
    .slice(0, max);
}

const SAFE_PART = /^[A-Za-z0-9._-]{1,128}$/;
const LIFECYCLE_TOOL = /^service_(up|down|restart)$/;

/**
 * An MCP guard refused an agent's call before it reached an action route.
 * The agent's own report, so every field is sanitised: a lifecycle tool with
 * a valid repo becomes an "exec" entry for that service (what the panel's
 * activity list shows); anything else is recorded under the tool's name.
 */
export function recordAgentRefusal(
  actor: Actor,
  report: {
    tool?: unknown;
    repo?: unknown;
    service?: unknown;
    reason?: unknown;
  },
): AuditEntry {
  const tool = clean(report.tool, 64).replace(/[^A-Za-z0-9_]/g, "") || "tool";
  const repo = typeof report.repo === "string" ? report.repo : "";
  const service = typeof report.service === "string" ? report.service : "";
  const lifecycle = LIFECYCLE_TOOL.exec(tool);
  const reason = clean(report.reason, 300) || "refused";
  if (lifecycle && SAFE_PART.test(repo)) {
    const address =
      service && SAFE_PART.test(service) ? `${repo}/${service}` : repo;
    return recordAction(actor, {
      verb: "exec",
      detail: `${address} ${lifecycle[1]} (local)`,
      outcome: "refused",
      reason,
    });
  }
  return recordAction(actor, {
    verb: tool,
    detail: "",
    outcome: "refused",
    reason,
  });
}

/** The most recent actions, oldest first. */
export function recentActions(): AuditEntry[] {
  return ring.slice();
}
