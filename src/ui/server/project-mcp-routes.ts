/**
 * Issue 473: a project's extra MCP servers' bearers, served by Den's
 * server from its own secrets store (never the agent's process).
 *
 *   POST /api/agents/self/mcp-headers  {name}: an agent's own token only.
 *        The headers for its project's server `name`: the project is the
 *        one its token was minted for, never the body's. The answer holds
 *        the bearer, so it is no-store and is never logged.
 *   GET  /api/mcp-servers/bearers      doctor's check: each project's
 *        servers with a bearer, and why one can't be served (or none).
 *        Never a value; an agent's token sees its own project's only.
 */
import type * as http from "http";
import {
  MCP_HEADERS_ROUTE,
  PROJECT_MCP_NAME_RE,
  parseProjectMcpServers,
  projectMcpHeaderFor,
  projectMcpUnserved,
  type McpHeaderSource,
  type ProjectMcpServer,
} from "../../shared/agents/project-mcp.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import {
  readWorkspacesFile,
  workspaceMcpServersRaw,
} from "../../shared/environment-manager/workspaces.js";
import { HUB_SERVER } from "../../shared/hub.js";
import { product } from "../../shared/product.js";
import { redactSecrets } from "../../shared/redact.js";
import {
  getSecretsProvider,
  namedSecretRef,
} from "../../shared/secrets/index.js";
import { readBody, sendJson } from "./http-helpers.js";
import { agentPrincipalOf } from "./request-guard.js";

export const MCP_BEARERS_ROUTE = "/api/mcp-servers/bearers";

export const isProjectMcpPath = (p: string) =>
  p === MCP_HEADERS_ROUTE || p === MCP_BEARERS_ROUTE;

export interface ProjectMcpRouteDeps extends McpHeaderSource {
  /** Every project with servers (doctor's check). */
  projects: () => string[];
}

const refuse = (
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
) => sendJson(res, { ok: false, code, error }, status);

export async function handleProjectMcpRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: ProjectMcpRouteDeps,
): Promise<boolean> {
  if (!isProjectMcpPath(pathname)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  const agent = agentPrincipalOf(req);

  if (pathname === "/api/agents/self/mcp-headers") {
    if (method !== "POST")
      return (refuse(res, 405, "method", "POST only."), true);
    if (!agent)
      return (
        refuse(
          res,
          403,
          "agent_only",
          "Only an agent's own token gets its project's MCP headers.",
        ),
        true
      );
    let body: Record<string, unknown> | null = null;
    try {
      const raw = await readBody(req);
      const v: unknown = raw.length > 4096 ? null : JSON.parse(raw || "{}");
      if (v && typeof v === "object" && !Array.isArray(v))
        body = v as Record<string, unknown>;
    } catch {
      body = null;
    }
    const keys = body ? Object.keys(body) : [];
    if (
      !body ||
      typeof body.name !== "string" ||
      !PROJECT_MCP_NAME_RE.test(body.name) ||
      keys.some((k) => k !== "name")
    )
      return (
        refuse(
          res,
          400,
          "bad_body",
          "The body is {name} (an MCP entry's name): the project is the one the agent's token was minted for.",
        ),
        true
      );
    let r;
    try {
      r = await projectMcpHeaderFor(agent.workspace, body.name, deps);
    } catch (e) {
      // Never the value: a store's words, scrubbed (redact.ts).
      const why = redactSecrets(String((e as Error)?.message ?? e));
      return (refuse(res, 500, "error", why.slice(0, 200)), true);
    }
    if (!r.ok) return (refuse(res, r.status, r.code, r.error), true);
    sendJson(res, { ok: true, headers: r.headers });
    return true;
  }

  if (pathname !== "/api/mcp-servers/bearers") return false;
  if (method !== "GET" && method !== "HEAD")
    return (refuse(res, 405, "method", "GET only."), true);
  const out: {
    project: string;
    name: string;
    served: boolean;
    why?: string;
  }[] = [];
  // An agent (doctor run in its session) sees its own project's only.
  const projects = agent ? [agent.workspace] : deps.projects();
  for (const ws of projects) {
    let servers: ProjectMcpServer[];
    try {
      servers = deps.servers(ws);
    } catch {
      continue;
    }
    for (const sv of servers) {
      if (!sv.bearer) continue;
      let why: string | null;
      try {
        why = await projectMcpUnserved(ws, sv, deps);
      } catch (e) {
        why = redactSecrets(String((e as Error)?.message ?? e)).slice(0, 200);
      }
      out.push({
        project: ws,
        name: sv.name,
        served: !why,
        ...(why ? { why } : {}),
      });
    }
  }
  sendJson(res, { ok: true, servers: out });
  return true;
}

/**
 * The server's own reads: the projects' checked servers (never Den's own
 * name nor Hub's, as agent-ops.ts writes them), and its own secrets store.
 */
export function defaultProjectMcpDeps(): ProjectMcpRouteDeps {
  const taken = [product().cli, HUB_SERVER];
  return {
    projects: () => {
      try {
        return Object.keys(readWorkspacesFile().workspaces ?? {});
      } catch {
        return [];
      }
    },
    servers: (ws) =>
      isServerScope(ws)
        ? []
        : parseProjectMcpServers(workspaceMcpServersRaw(ws), taken).servers,
    secret: async (ref) => {
      const sref = namedSecretRef(ref);
      if (!sref) throw new Error(`secrets.refs.${ref} is not set`);
      return getSecretsProvider().get(sref);
    },
  };
}
