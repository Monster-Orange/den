/**
 * The Workspaces page's Agents section (AG-4a, AG spec §5c), its routes:
 *
 *   GET  /api/personas                            personas and runtimes
 *   GET  /api/workspaces/<ws>/agents              the workspace's agents
 *   POST /api/workspaces/<ws>/agents              start { persona, runtime?, model?, id? }
 *   POST /api/workspaces/<ws>/agents/<id>/stop
 *   POST /api/workspaces/<ws>/agents/<id>/resume
 *
 * Each calls the CLI's own operation (cli/agent-ops.ts): neither the page
 * nor the CLI keeps state of its own, so an agent started here is the one
 * `<cli> agents list -w <ws>` shows, and the other way round. A workspace
 * lists its own agents only: another workspace's id is no agent here.
 *
 * Guards on Start, Stop and Resume, as on a service action:
 *   - the lock (R8): locked, the action is refused (423 locked); the page
 *     opens the lock popover first, as Local Dev's service actions do;
 *   - a person only: an agent (its actor token, SEC-1c) can't start or
 *     stop agents from the page (403; agents use MCP agent_spawn, §5,
 *     under its own guards);
 *   - agents.max_concurrent (the host's cap: 429 cap).
 * The env is the CLI's (§5a-env): the allowlist and the runtime's, built
 * from this server's environment, never all of it. Every action, refused
 * or done, is audited (recordAction) with the person as its actor.
 *
 * There is no terminal here: nothing writes to a session or streams its
 * output to the browser (that is SEC-1's, with AG-4a's Open).
 */
import * as http from "http";
import { getReposRoot } from "../../shared/den-config.js";
import {
  readWorkspacesFile,
  resolveWorkspaceDir,
} from "../../shared/environment-manager/workspaces.js";
import { getStateDir } from "../../shared/paths.js";
import { HostError } from "../../shared/sessions/client.js";
import {
  AgentError,
  agentRecord,
  listAgents,
  listPersonas,
  listRuntimes,
  NOT_IN_WORKSPACE,
  resolveAgentsDeps,
  resumeAgent,
  startAgent,
  stopAgent,
  type AgentsDeps,
  type AgentsResolved,
  type Started,
} from "../cli/agent-ops.js";
import { recordAction } from "./audit.js";
import { auditActorOf, principalOf } from "./request-guard.js";
import { readBody, sendJson } from "./http-helpers.js";
import { hasPasswordlessSudo, hasSudoPassword } from "./sudo-store.js";
import type { Actor } from "../../shared/agent-actor.js";

export interface AgentRouteDeps {
  /** The operations' deps (tests: an in-process host, a temp state dir). */
  agents?: AgentsDeps;
  /** R8: whether the lock is open (the lock chip's own status). */
  unlocked?: () => boolean;
}

const AGENTS_PATH =
  /^\/api\/workspaces\/([^/]+)\/agents(?:\/([^/]+)\/(stop|resume))?$/;
/** A start's body is a few short names. */
const MAX_BODY = 4096;

/** Never a TTY: a web start's terminal is 80×24. */
const NO_TTY = { isTTY: false } as NodeJS.WriteStream;

function webDeps(over: AgentsDeps = {}): AgentsResolved {
  return resolveAgentsDeps({
    stateDir: () => getStateDir(),
    workspaceExists: (ws) => Boolean(readWorkspacesFile().workspaces[ws]),
    workspaceDir: (ws) => {
      const cfg = readWorkspacesFile().workspaces[ws];
      if (!cfg) throw new AgentError(`workspace "${ws}" does not exist`);
      return resolveWorkspaceDir(ws, cfg, getReposRoot());
    },
    stdout: NO_TTY,
    out: () => undefined,
    err: () => undefined,
    ...over,
  });
}

/** The lock chip's state: an admin password set, or sudo without one. */
function defaultUnlocked(): boolean {
  return hasSudoPassword() || hasPasswordlessSudo();
}

/** An AgentError (or the host's refusal) as the R26 answer. */
function sendError(res: http.ServerResponse, e: unknown, ws?: string): void {
  if (e instanceof AgentError) {
    // From another workspace, an agent isn't there at all: no name of it.
    const error =
      e.code === NOT_IN_WORKSPACE && ws
        ? `no agent here in workspace ${ws}`
        : e.message;
    sendJson(
      res,
      {
        ok: false,
        error,
        ...(e.code && e.code !== NOT_IN_WORKSPACE ? { code: e.code } : {}),
        ...(e.hints.length ? { hints: e.hints } : {}),
      },
      e.status,
    );
    return;
  }
  if (e instanceof HostError) {
    sendJson(
      res,
      { ok: false, error: e.message, code: "session_host" },
      e.code === "cap" ? 429 : 503,
    );
    return;
  }
  throw e;
}

/** A started or resumed agent's answer: its record, or its early exit. */
function sendStarted(res: http.ServerResponse, s: Started): void {
  if (s.early) {
    const code =
      s.early.exitCode === undefined ? "" : ` (exit ${s.early.exitCode})`;
    sendJson(
      res,
      {
        ok: false,
        error: `agent ${s.rec.id} exited at once${code}`,
        code: "exited_at_once",
        tail: s.early.tail,
        session: s.early.sessionName,
        ...(s.warnings.length ? { warnings: s.warnings } : {}),
      },
      502,
    );
    return;
  }
  sendJson(res, {
    ok: true,
    agent: {
      id: s.rec.id,
      persona: s.rec.persona,
      runtime: s.rec.runtime,
      workspace: s.rec.workspace,
      cwd: s.rec.cwd,
      session: s.rec.sessionName,
      startedAt: s.rec.startedAt,
    },
    ...(s.warnings.length ? { warnings: s.warnings } : {}),
  });
}

/** What a POST's body names: a few optional strings. */
async function startBody(
  req: http.IncomingMessage,
): Promise<Record<string, string | undefined>> {
  const raw = await readBody(req).catch(() => "");
  if (raw.length > MAX_BODY)
    throw new AgentError("request too large", { status: 413, usage: true });
  let v: unknown;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    throw new AgentError("invalid JSON", { usage: true });
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new AgentError("the body must be a JSON object", { usage: true });
  const out: Record<string, string | undefined> = {};
  for (const k of ["persona", "runtime", "model", "id"]) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined || x === null || x === "") continue;
    if (typeof x !== "string")
      throw new AgentError(`${k} must be a string`, { usage: true });
    out[k] = x;
  }
  return out;
}

/**
 * Handles the routes above; false when `pathname` is none of them. Every
 * answer is JSON; an error is R26's { ok: false, error, code, requestId }
 * (the server's jsonApiErrors adds the requestId).
 */
export async function handleAgentRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: AgentRouteDeps = {},
): Promise<boolean> {
  const m = AGENTS_PATH.exec(pathname);
  if (pathname !== "/api/personas" && !m) return false;
  const method = req.method ?? "GET";
  const d = webDeps(deps.agents);

  if (!m) {
    if (method !== "GET") return methodNotAllowed(res, "GET");
    try {
      sendJson(res, { personas: listPersonas(d), runtimes: listRuntimes(d) });
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }

  let ws: string;
  try {
    ws = decodeURIComponent(m[1]);
  } catch {
    sendJson(res, { ok: false, error: "not a workspace name" }, 400);
    return true;
  }
  const id = m[2] === undefined ? undefined : safeDecode(m[2]);
  const action = m[3] as "stop" | "resume" | undefined;

  if (!action && method === "GET") {
    try {
      if (!d.workspaceExists(ws))
        throw new AgentError(`workspace "${ws}" does not exist`, {
          status: 404,
        });
      sendJson(res, {
        workspace: ws,
        // Asking never starts a session host: with none, nothing runs.
        agents: await listAgents(d, ws, { startHost: false }),
        maxConcurrent: d.maxConcurrent(),
      });
    } catch (e) {
      sendError(res, e, ws);
    }
    return true;
  }
  if (method !== "POST")
    return methodNotAllowed(res, action ? "POST" : "GET, POST");

  // From the credential (SEC-1c): an agent's actor token, never a header.
  const actor = auditActorOf(req);
  const verb = action ?? "start";
  const audit = (detail: string, reason?: string) =>
    recordAction(
      actor,
      {
        verb: "agents",
        detail,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      principalOf(req),
    );
  let what = `${verb} ${id ?? "?"} in ${ws}`;
  try {
    // Another workspace's agent is no agent here: a 404 that doesn't name
    // it, before the lock (a locked request says the same).
    if (id !== undefined) agentRecord(d, id, ws);
    guard(actor, deps.unlocked ?? defaultUnlocked);
    if (verb === "start") {
      const body = await startBody(req);
      if (!body.persona)
        throw new AgentError("persona is required", { usage: true });
      what = `start ${body.id ?? body.persona} in ${ws}`;
      const s = await startAgent(d, {
        workspace: ws,
        persona: body.persona,
        runtime: body.runtime,
        model: body.model,
        id: body.id,
      });
      what = `start ${s.rec.id} (${s.rec.persona}, ${s.rec.runtime}) in ${ws}`;
      audit(what, s.early ? "exited at once" : undefined);
      sendStarted(res, s);
    } else if (verb === "stop") {
      const s = await stopAgent(d, id!, ws);
      audit(what);
      sendJson(res, { ok: true, agent: s.rec.id, wasRunning: !!s.session });
    } else {
      const s = await resumeAgent(d, id!, ws);
      audit(what);
      sendStarted(res, s);
    }
  } catch (e) {
    audit(what, e instanceof Error ? e.message : String(e));
    sendError(res, e, ws);
  }
  return true;
}

/**
 * R8 and the actor: a person, with the lock open. An agent is one its actor
 * token proves (the request checks already refuse its start and resume);
 * an x-den-actor header alone is an unverified claim, not an agent.
 */
function guard(actor: Actor, unlocked: () => boolean): void {
  if (actor && !actor.unverified)
    throw new AgentError(
      "an agent can't start, stop or resume agents from the page; agents use MCP agent_spawn",
      { status: 403 },
    );
  if (!unlocked())
    throw new AgentError("Unlock first: agent actions need the lock open", {
      status: 423,
      code: "locked",
    });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function methodNotAllowed(res: http.ServerResponse, allow: string): true {
  res.setHeader("Allow", allow);
  sendJson(res, { ok: false, error: "method not allowed" }, 405);
  return true;
}
