/**
 * The shared GitHub watcher's routes (github-watch/watcher.ts), an agent's
 * own: its actor token says which agent, never the body.
 *
 *   POST /api/agents/self/github-watches          { repo, pr | run }: a
 *        watch id and where it stands now; the agent is told in its session
 *        when the checks or the run finish
 *   GET  /api/agents/self/github-watches          { watches }: its own
 *   POST /api/agents/self/github-watches/cancel   { id }: one of its own
 *
 * The repo must be one of its projects' repos (its project and the ones
 * granted to it; the server agent's scope reaches every project's). A
 * person's request is refused: a watch tells an agent. Refusals: 400 a bad
 * ask, 403 another project's repo, 404 no such pull request or run, 409 too
 * many watches, 429 GitHub's API budget is under the floor (with the reset).
 */
import type * as http from "http";
import { isServerScope } from "../../shared/agents/server-agent.js";
import type { GithubWatcher } from "../../shared/github-watch/watcher.js";
import { readBody, sendJson } from "./http-helpers.js";
import { agentPrincipalOf, type AgentPrincipal } from "./request-guard.js";

export const GITHUB_WATCH_PATHS = [
  "/api/agents/self/github-watches",
  "/api/agents/self/github-watches/cancel",
] as const;

export const isGithubWatchPath = (p: string): boolean =>
  (GITHUB_WATCH_PATHS as readonly string[]).includes(p);

export interface GithubWatchRouteDeps {
  watcher: () => GithubWatcher;
  /** A project's repos as owner/name (project-repos.ts projectRepos). */
  reposOf: (project: string) => string[];
  /** The server agent's scope: every project's repos. */
  allRepos?: () => string[];
  /**
   * Issue 1270: a project's agents.watch_repos (watch-repos.ts
   * projectWatchRepos), extra repos its own agents may watch, read-only.
   */
  watchReposOf?: (project: string) => string[];
  /** Tests pass one; the server reads the request's actor token. */
  principal?: (req: http.IncomingMessage) => AgentPrincipal | null;
}

const STATUS: Record<string, number> = {
  bad_request: 400,
  scope: 403,
  not_found: 404,
  too_many: 409,
  budget_low: 429,
};

const refuse = (
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
) => sendJson(res, { ok: false, code, error }, status);

async function jsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    if (raw.length > 4096) return null;
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The repos an agent may watch: its project's and its grants', and (issue
 * 1270) its own project's agents.watch_repos. A granted project's list is
 * that project's agents' only.
 */
function scopeRepos(p: AgentPrincipal, d: GithubWatchRouteDeps): string[] {
  // A server-scope agent works across the install's projects.
  if (isServerScope(p.workspace) && d.allRepos) return d.allRepos();
  const out: string[] = [];
  const add = (r: string) => {
    if (!out.some((o) => o.toLowerCase() === r.toLowerCase())) out.push(r);
  };
  for (const ws of [p.workspace, ...(p.grants ?? [])])
    for (const r of d.reposOf(ws)) add(r);
  for (const r of d.watchReposOf?.(p.workspace) ?? []) add(r);
  return out;
}

export async function handleGithubWatchRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: GithubWatchRouteDeps,
): Promise<boolean> {
  if (!isGithubWatchPath(pathname)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  const p = (d.principal ?? agentPrincipalOf)(req);
  if (!p) {
    refuse(
      res,
      403,
      "agent_only",
      "A GitHub watch is an agent's: Den tells that agent when it finishes. Ask with the MCP tool github_watch.",
    );
    return true;
  }
  const agent = p.actor.slice("agent:".length);
  const w = d.watcher();

  if (pathname === "/api/agents/self/github-watches") {
    if (method === "GET") {
      sendJson(res, { ok: true, watches: w.list(agent), status: w.status() });
      return true;
    }
    if (method !== "POST") {
      refuse(res, 405, "method", "GET or POST only.");
      return true;
    }
    const b = await jsonBody(req);
    if (!b) {
      refuse(
        res,
        400,
        "bad_request",
        "the body is { repo, pr } or { repo, run }",
      );
      return true;
    }
    const r = await w.create({
      agent,
      project: p.workspace,
      repo: typeof b.repo === "string" ? b.repo.trim() : "",
      pr: typeof b.pr === "number" ? b.pr : undefined,
      run: typeof b.run === "number" ? b.run : undefined,
      allowedRepos: scopeRepos(p, d),
    });
    if (r.ok) sendJson(res, r);
    else refuse(res, STATUS[r.code] ?? 400, r.code, r.error);
    return true;
  }

  if (pathname !== "/api/agents/self/github-watches/cancel") return false;
  if (method !== "POST") {
    refuse(res, 405, "method", "POST only.");
    return true;
  }
  const b = await jsonBody(req);
  const id = typeof b?.id === "string" ? b.id : "";
  const r = w.cancel(agent, id);
  if (r.ok) sendJson(res, r);
  else refuse(res, 404, "not_found", r.error);
  return true;
}
