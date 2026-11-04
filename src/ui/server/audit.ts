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
  /** exec | run | sync */
  verb: string;
  detail: string;
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
  action: { verb: string; detail: string },
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
        }
      : {}),
    verb: action.verb,
    detail: action.detail,
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  sink?.(`▶ ${action.verb} ${action.detail}${actorSuffix(actor)}`, actor);
  return entry;
}

/** The most recent actions, oldest first. */
export function recentActions(): AuditEntry[] {
  return ring.slice();
}
