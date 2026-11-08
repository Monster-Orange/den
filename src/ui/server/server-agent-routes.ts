/**
 * The server agent's routes (ON-6):
 *
 *   GET  /api/server-agent          what it is, its runtime (or why none),
 *                                   whether it runs, whether this Den is
 *                                   fresh, and the manual path
 *   POST /api/server-agent/start    { runtime? }: start it, or bring it
 *                                   back (resume, relaunch); a person only
 *   POST /api/server-agent/runtime  { runtime: id | null }: the person's
 *                                   choice (user.yml agents.server_runtime)
 *   POST /api/server-agent/model    { model: id | null }: the person's
 *                                   model, one of the runtime's own
 *                                   (user.yml agents.server_model)
 *
 * An agent never starts the server agent or picks its runtime: any agent
 * credential or claim is refused (403).
 */
import type * as http from "http";
import { HostError } from "../../shared/sessions/client.js";
import { AgentError, type AgentsDeps } from "../cli/agent-ops.js";
import {
  serverAgentStatus,
  setServerModel,
  setServerRuntime,
  startServerAgent,
  type ServerAgentDeps,
} from "../cli/server-agent-ops.js";
import { webDeps } from "./agent-routes.js";
import { recordAction } from "./audit.js";
import { readBody, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";

export interface ServerAgentRouteDeps {
  agents?: AgentsDeps;
  server?: ServerAgentDeps;
}

const MAX_BODY = 4 * 1024;

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof AgentError) {
    sendJson(
      res,
      {
        ok: false,
        error: e.message,
        ...(e.code ? { code: e.code } : {}),
        ...(e.hints.length ? { hints: e.hints } : {}),
      },
      e.status,
    );
    return;
  }
  if (e instanceof HostError) {
    sendJson(res, { ok: false, error: e.message, code: "session_host" }, 503);
    return;
  }
  sendJson(res, { ok: false, error: (e as Error).message }, 500);
}

async function body(
  req: http.IncomingMessage,
): Promise<{ runtime?: unknown; model?: unknown }> {
  const raw = await readBody(req);
  if (raw.length > MAX_BODY)
    throw new AgentError("body too large", { status: 413 });
  if (!raw.trim()) return {};
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    throw new AgentError("body must be JSON", { usage: true });
  }
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new AgentError("body must be an object", { usage: true });
  return b as { runtime?: unknown; model?: unknown };
}

export async function handleServerAgentRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: ServerAgentRouteDeps = {},
): Promise<boolean> {
  if (
    pathname !== "/api/server-agent" &&
    pathname !== "/api/server-agent/start" &&
    pathname !== "/api/server-agent/runtime" &&
    pathname !== "/api/server-agent/model"
  )
    return false;
  const method = req.method ?? "GET";
  const d = webDeps(deps.agents);
  if (pathname === "/api/server-agent") {
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("Allow", "GET");
      sendJson(res, { ok: false, error: "method not allowed" }, 405);
      return true;
    }
    try {
      sendJson(res, await serverAgentStatus(d, deps.server));
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  if (method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, { ok: false, error: "method not allowed" }, 405);
    return true;
  }
  const actor = auditActorOf(req);
  const verb = pathname.endsWith("/start")
    ? "start"
    : pathname.endsWith("/model")
      ? "model"
      : "runtime";
  const audit = (detail: string, reason?: string) =>
    recordAction(
      actor,
      {
        verb: "server-agent",
        detail,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      principalOf(req),
    );
  try {
    // The person's: an agent's credential, or a claim to be one, never.
    if (agentPrincipalOf(req) || actor)
      throw new AgentError(
        "only a person can start the server agent or pick its runtime or model",
        { status: 403 },
      );
    const b = await body(req);
    if (
      b.runtime !== undefined &&
      b.runtime !== null &&
      typeof b.runtime !== "string"
    )
      throw new AgentError("runtime must be a runtime id", { usage: true });
    if (verb === "model") {
      if (b.model !== null && typeof b.model !== "string")
        throw new AgentError("model must be a model id or null", {
          usage: true,
        });
      const id = (b.model as string | null) ?? null;
      await setServerModel(d, id, deps.server);
      audit(id ? `model ${id}` : "model cleared");
      sendJson(res, { ok: true, ...(await serverAgentStatus(d, deps.server)) });
      return true;
    }
    if (verb === "runtime") {
      const id = (b.runtime as string | null | undefined) ?? null;
      setServerRuntime(id, deps.server);
      audit(id ? `runtime ${id}` : "runtime cleared");
      sendJson(res, { ok: true, ...(await serverAgentStatus(d, deps.server)) });
      return true;
    }
    const s = await startServerAgent(
      d,
      typeof b.runtime === "string" ? { runtime: b.runtime } : {},
      deps.server,
    );
    audit(`${s.how} on ${s.runtime}`);
    sendJson(res, { ok: true, ...s });
  } catch (e) {
    audit(verb, (e as Error).message);
    sendError(res, e);
  }
  return true;
}
