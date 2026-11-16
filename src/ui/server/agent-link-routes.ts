/**
 * Issue 103, the deep link: `GET /p/<project>/agents/<id>[?context=<url>]`
 * opens the Agents page on that agent (keyed by project and agent record
 * id: an id alone may repeat across projects), with the URL in its
 * composer. Nothing is sent until the person sends it. The link stays the
 * same across restarts and session changes: it names the record, never a
 * session.
 *
 * Checked here, before the page: the project exists, the agent is that
 * project's, and `context` (when given) is an http or https URL no longer
 * than Settings › Embedding's url_max_chars. A bad one gets the error page
 * saying which (404 for the project or agent, 400 for the context), never
 * a blank Agents page.
 */
import type * as http from "http";
import { AGENT_ID_RE, readRecord } from "../../shared/agents/records.js";
import { WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";

const LINK_PATH = /^\/p\/([^/]+)\/agents\/([^/]+)\/?$/;

/** Why a deep link can't open, for the error page (error-page.js). */
export interface AgentLinkProblem {
  status: 400 | 404;
  reason: "project" | "agent" | "context_scheme" | "context_long";
  project: string;
  agent: string;
  max?: number;
  message: string;
}

export interface AgentLinkDeps {
  stateDir(): string;
  workspaceExists(ws: string): boolean;
  urlMax(): number;
  contextProblem(
    v: string,
    max: number,
  ): { reason: "context_scheme" | "context_long"; max: number } | null;
  serveAgents(res: http.ServerResponse): void;
  sendProblem(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    p: AgentLinkProblem,
  ): void;
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The project and agent a deep link names, or null when it isn't one. */
export function agentLinkOf(
  pathname: string,
): { project: string; agent: string } | null {
  const m = LINK_PATH.exec(pathname);
  if (!m) return null;
  const project = decode(m[1]);
  const agent = decode(m[2]);
  if (project === null || agent === null) return null;
  return { project, agent };
}

/** Why the link can't open, or null when it can. Pure but for `deps`. */
export function agentLinkProblem(
  link: { project: string; agent: string },
  context: string | null,
  deps: Pick<
    AgentLinkDeps,
    "stateDir" | "workspaceExists" | "urlMax" | "contextProblem"
  >,
): AgentLinkProblem | null {
  const { project, agent } = link;
  if (!WORKSPACE_NAME_RE.test(project) || !deps.workspaceExists(project))
    return {
      status: 404,
      reason: "project",
      project,
      agent,
      message: `There is no project "${project}" in this Den.`,
    };
  const rec = AGENT_ID_RE.test(agent)
    ? readRecord(deps.stateDir(), agent)
    : null;
  if (!rec || rec.workspace !== project)
    return {
      status: 404,
      reason: "agent",
      project,
      agent,
      message: `Project "${project}" has no agent "${agent}". It may have been removed.`,
    };
  if (context !== null) {
    const bad = deps.contextProblem(context, deps.urlMax());
    if (bad)
      return {
        status: 400,
        project,
        agent,
        ...bad,
        message:
          bad.reason === "context_long"
            ? `The link's context URL is longer than ${bad.max} characters (Settings › Embedding).`
            : "The link's context must be an http or https URL.",
      };
  }
  return null;
}

/** The deep link's page, or false when `pathname` isn't one. */
export function handleAgentLink(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  search: URLSearchParams,
  deps: AgentLinkDeps,
): boolean {
  if (!LINK_PATH.test(pathname)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
    res.end("Method not allowed");
    return true;
  }
  const link = agentLinkOf(pathname) ?? { project: "", agent: "" };
  const problem = agentLinkProblem(link, search.get("context"), deps);
  if (problem) deps.sendProblem(req, res, problem);
  else deps.serveAgents(res);
  return true;
}
