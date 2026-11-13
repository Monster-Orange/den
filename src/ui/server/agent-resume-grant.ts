/**
 * MCP `agent_resume` (AG-14.4): the one agent route an agent's own token
 * may reach, and only when all of these hold:
 *
 *   - the org config opts in: `mcp.actions` lists agent_resume (off by
 *     default, like every MCP action);
 *   - the agent to resume is in the caller's workspace, or one its
 *     agents.<id>.grants gives it (the scope agent_spawn has, AG spec §5);
 *   - it isn't the caller itself.
 *
 * The request checks (request-guard.ts agentRefusal) and the route
 * (agent-routes.ts) both ask. Starting, stopping and removing agents stay a
 * person's.
 */
export const AGENT_RESUME_ACTION = "agent_resume";

/** POST /api/workspaces/<ws>/agents/<id>/resume. */
export const AGENT_RESUME_ROUTE =
  /^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/resume$/;

export interface ResumingAgent {
  actor: string;
  workspace: string;
  grants: readonly string[];
}

/** Why this agent may not resume agent `id` of `ws`, or null when it may. */
export function agentResumeRefusal(
  p: ResumingAgent,
  ws: string,
  id: string,
  actions: readonly string[],
): string | null {
  if (!actions.includes(AGENT_RESUME_ACTION))
    return `${p.actor} can't resume agents: the org config's mcp.actions doesn't list ${AGENT_RESUME_ACTION}.`;
  if (ws !== p.workspace && !p.grants.includes(ws))
    return `${p.actor} can resume agents of project ${p.workspace} only${p.grants.length ? ` (or ${p.grants.join(", ")}, its grants)` : ""}, not ${ws}.`;
  if (`agent:${id}` === p.actor) return `${p.actor} can't resume itself.`;
  return null;
}

/** The route's workspace and agent id, decoded; null when it isn't it. */
export function agentResumeTarget(
  pathname: string,
): { ws: string; id: string } | null {
  const m = AGENT_RESUME_ROUTE.exec(pathname);
  if (!m) return null;
  try {
    return { ws: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/**
 * MCP `agent_import` (AG-17.1): bring a conversation in as an agent, and
 * list the ones there are. Off unless `mcp.actions` lists it; only in the
 * caller's workspace or one its grants give it. A person's otherwise.
 */
export const AGENT_IMPORT_ACTION = "agent_import";

/** GET /api/workspaces/<ws>/conversations, POST …/<id>/import. */
export const AGENT_IMPORT_ROUTE =
  /^\/api\/workspaces\/([^/]+)\/conversations(?:\/([^/]+)\/import)?$/;

/** Why this agent may not bring in a conversation of `ws`, or null. */
export function agentImportRefusal(
  p: ResumingAgent,
  ws: string,
  actions: readonly string[],
): string | null {
  if (!actions.includes(AGENT_IMPORT_ACTION))
    return `${p.actor} can't bring in conversations: the org config's mcp.actions doesn't list ${AGENT_IMPORT_ACTION}.`;
  if (ws !== p.workspace && !p.grants.includes(ws))
    return `${p.actor} can bring in conversations of project ${p.workspace} only${p.grants.length ? ` (or ${p.grants.join(", ")}, its grants)` : ""}, not ${ws}.`;
  return null;
}

/** The import route's workspace, decoded; null when it isn't it. */
export function agentImportTarget(pathname: string): { ws: string } | null {
  const m = AGENT_IMPORT_ROUTE.exec(pathname);
  if (!m) return null;
  try {
    return { ws: decodeURIComponent(m[1]) };
  } catch {
    return null;
  }
}
