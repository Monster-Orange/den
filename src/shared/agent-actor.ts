/**
 * Who asked: the headers the MCP server (`<cli> mcp`) sends with every web
 * API call, so the server can record an action as an agent's. The client
 * name and version are what the MCP client reported about itself at
 * initialize: a label for the audit trail, never used for authorization.
 */
import type { IncomingHttpHeaders } from "http";

export const AUDIT_HEADERS = {
  actor: "x-den-actor",
  client: "x-den-mcp-client",
  clientVersion: "x-den-mcp-client-version",
  pid: "x-den-mcp-pid",
  session: "x-den-mcp-session",
} as const;

export interface AgentInfo {
  /** The MCP client's self-reported name (clientInfo.name). */
  client: string;
  /** The MCP client's self-reported version (clientInfo.version). */
  clientVersion: string;
  /** The MCP server process's pid. */
  mcpPid: number | null;
  /** The MCP server's session id (one per `<cli> mcp` process). */
  session: string;
}

export interface AgentActor extends AgentInfo {
  kind: "agent";
}

/** null: a person in the web UI (no agent headers). */
export type Actor = AgentActor | null;

/** Printable, single-line, bounded: these values land in log lines. */
function clean(v: unknown, max = 64): string {
  const s = Array.isArray(v) ? v[0] : v;
  return String(s ?? "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, max);
}

/** The headers the MCP client sends (see AUDIT_HEADERS). */
export function agentAuditHeaders(info: AgentInfo): Record<string, string> {
  return {
    [AUDIT_HEADERS.actor]: "agent",
    [AUDIT_HEADERS.client]: clean(info.client) || "unknown",
    [AUDIT_HEADERS.clientVersion]: clean(info.clientVersion) || "unknown",
    [AUDIT_HEADERS.pid]: info.mcpPid === null ? "" : String(info.mcpPid),
    [AUDIT_HEADERS.session]: clean(info.session).replace(/[^A-Za-z0-9-]/g, ""),
  };
}

/** The actor an incoming request names, or null for a person in the UI. */
export function actorFromHeaders(
  headers: IncomingHttpHeaders | Record<string, string | undefined>,
): Actor {
  const h = headers as Record<string, string | string[] | undefined>;
  if (clean(h[AUDIT_HEADERS.actor]) !== "agent") return null;
  const pid = clean(h[AUDIT_HEADERS.pid], 10);
  return {
    kind: "agent",
    client: clean(h[AUDIT_HEADERS.client]) || "unknown",
    clientVersion: clean(h[AUDIT_HEADERS.clientVersion], 32) || "unknown",
    mcpPid: /^\d+$/.test(pid) ? Number(pid) : null,
    session: clean(h[AUDIT_HEADERS.session]).replace(/[^A-Za-z0-9-]/g, ""),
  };
}

/** "agent <client> <version> (mcp pid <pid>, session <id>)". */
export function actorLabel(actor: AgentActor): string {
  return (
    `agent ${actor.client} ${actor.clientVersion} ` +
    `(mcp pid ${actor.mcpPid ?? "?"}, session ${actor.session || "?"})`
  );
}
