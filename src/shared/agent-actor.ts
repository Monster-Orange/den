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
  /** A scoped server's actor id (`agent:<id>`, AG-2a-core). */
  agent: "x-den-mcp-agent",
  /** The workspace a scoped server is pinned to (AG-2a-core). */
  workspace: "x-den-mcp-workspace",
} as const;

/**
 * `agent:<id>`: what `<cli> mcp --actor` takes. The id is letters, digits,
 * dots, dashes and underscores, 1-64 long, starting with a letter or digit.
 */
export const AGENT_ACTOR_RE = /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A workspace name, as the config accepts it (1-64 long here). */
export const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AgentInfo {
  /** The MCP client's self-reported name (clientInfo.name). */
  client: string;
  /** The MCP client's self-reported version (clientInfo.version). */
  clientVersion: string;
  /** The MCP server process's pid. */
  mcpPid: number | null;
  /** The MCP server's session id (one per `<cli> mcp` process). */
  session: string;
  /** A scoped server's actor (`agent:<id>`); absent when unscoped. */
  agent?: string;
  /** The workspace a scoped server is pinned to; absent when unscoped. */
  workspace?: string;
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
    // Only a scoped server sends these: an unscoped one's headers are as before.
    ...(info.agent && AGENT_ACTOR_RE.test(info.agent)
      ? { [AUDIT_HEADERS.agent]: info.agent }
      : {}),
    ...(info.workspace && WORKSPACE_NAME_RE.test(info.workspace)
      ? { [AUDIT_HEADERS.workspace]: info.workspace }
      : {}),
  };
}

/** The actor an incoming request names, or null for a person in the UI. */
export function actorFromHeaders(
  headers: IncomingHttpHeaders | Record<string, string | undefined>,
): Actor {
  const h = headers as Record<string, string | string[] | undefined>;
  if (clean(h[AUDIT_HEADERS.actor]) !== "agent") return null;
  const pid = clean(h[AUDIT_HEADERS.pid], 10);
  // Kept only when well-formed: a malformed value is dropped, never cleaned
  // into something that looks like another agent's id.
  const agent = clean(h[AUDIT_HEADERS.agent], 80);
  const workspace = clean(h[AUDIT_HEADERS.workspace], 80);
  return {
    kind: "agent",
    client: clean(h[AUDIT_HEADERS.client]) || "unknown",
    clientVersion: clean(h[AUDIT_HEADERS.clientVersion], 32) || "unknown",
    mcpPid: /^\d+$/.test(pid) ? Number(pid) : null,
    session: clean(h[AUDIT_HEADERS.session]).replace(/[^A-Za-z0-9-]/g, ""),
    ...(AGENT_ACTOR_RE.test(agent) ? { agent } : {}),
    ...(WORKSPACE_NAME_RE.test(workspace) ? { workspace } : {}),
  };
}

/**
 * "agent <client> <version> (mcp pid <pid>, session <id>)"; a scoped
 * server's actor leads: "agent:<id> <client> <version> (workspace <ws>,
 * mcp pid <pid>, session <id>)".
 */
export function actorLabel(actor: AgentActor): string {
  const who = actor.agent ?? "agent";
  const ws = actor.workspace ? `workspace ${actor.workspace}, ` : "";
  return (
    `${who} ${actor.client} ${actor.clientVersion} ` +
    `(${ws}mcp pid ${actor.mcpPid ?? "?"}, session ${actor.session || "?"})`
  );
}
