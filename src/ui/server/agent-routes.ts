/**
 * The Workspaces page's Agents section (AG-4a, AG spec §5c), its routes:
 *
 *   GET  /api/personas[?workspace=<ws>]           personas and runtimes (each
 *                                                 with its path, where it came
 *                                                 from and its version: AG-0.2;
 *                                                 for <ws>, its own paths win)
 *   GET  /api/agents/runtimes[?workspace=<ws>]    the runtime catalog as
 *                                                 Settings › Agents lists it
 *   POST /api/agents/runtimes/<id>/path           { scope: global|workspace,
 *                                                 workspace?, bin: path|null }:
 *                                                 runs its version command and
 *                                                 refuses a path that isn't
 *                                                 that runtime (AG-0.5)
 *   GET  /api/workspaces/<ws>/agents              the workspace's agents
 *   POST /api/workspaces/<ws>/agents              start { persona, runtime?, model?, id? }
 *   POST /api/workspaces/<ws>/agents/<id>/stop
 *   POST /api/workspaces/<ws>/agents/<id>/resume  the same conversation (AG-14)
 *   POST /api/workspaces/<ws>/agents/<id>/fresh   a new conversation, same
 *                                                 persona and workspace
 *   POST /api/workspaces/<ws>/agents/<id>/relaunch  a rotated agent (den#4):
 *                                                 a new conversation whose
 *                                                 first prompt is its
 *                                                 handoff.md; a resume of
 *                                                 one is refused (409 rotated)
 *   POST /api/workspaces/<ws>/agents/<id>/remove  forget a stopped one (Undo:
 *                                                 /api/agents/restore)
 *   POST /api/agents/clear-stopped                { workspaces: [...] }: forget
 *                                                 every stopped one there
 *   POST /api/agents/restore                      { agents: [ids] }: Undo
 *   POST /api/agents/resume-interrupted           { workspaces: [...] }: Resume
 *                                                 all after a restart (AG-14.3)
 *
 * Each calls the CLI's own operation (cli/agent-ops.ts): neither the page
 * nor the CLI keeps state of its own, so an agent started here is the one
 * `<cli> agents list -w <ws>` shows, and the other way round. A workspace
 * lists its own agents only: another workspace's id is no agent here.
 *
 * Guards on Start, Stop and Resume:
 *   - a person only: an agent (its actor token, SEC-1c) can't start or
 *     stop agents from the page (403; agents use MCP agent_spawn, §5,
 *     under its own guards);
 *   - agents.max_concurrent (the host's cap on agents, never plain
 *     sessions: 429 cap).
 * The admin password (R8) is no guard here (LK-0): it is for sudo, and
 * nothing an agent route does runs sudo. Starting, stopping and resuming
 * an agent never asks for it.
 * The env is the CLI's (§5a-env): the allowlist and the runtime's, built
 * from this server's environment, never all of it. Every action, refused
 * or done, is audited (recordAction) with the person as its actor.
 *
 * There is no terminal here: the Agents tab's io (session-routes.ts) is
 * the only route that writes to a session or streams its output.
 */
import * as http from "http";
import {
  configuredRemoveStoppedAfter,
  getReposRoot,
  readMcpConfig,
} from "../../shared/den-config.js";
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
  markInterrupted,
  NOT_IN_WORKSPACE,
  pruneStopped,
  removeAgent,
  removeStopped,
  restoreAgents,
  resumeInterrupted,
  setRuntimePath,
  resolveAgentsDeps,
  relaunchAgent,
  resumeAgent,
  startAgent,
  startFresh,
  stopAgent,
  type AgentsDeps,
  type AgentsResolved,
  type Started,
} from "../cli/agent-ops.js";
import { recordAction } from "./audit.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";
import { agentResumeRefusal } from "./agent-resume-grant.js";
import { readBody, sendJson } from "./http-helpers.js";
import type { Actor } from "../../shared/agent-actor.js";

export interface AgentRouteDeps {
  /** The operations' deps (tests: an in-process host, a temp state dir). */
  agents?: AgentsDeps;
}

const AGENTS_PATH =
  /^\/api\/workspaces\/([^/]+)\/agents(?:\/([^/]+)\/(stop|resume|fresh|relaunch|remove))?$/;

const RUNTIME_PATH = /^\/api\/agents\/runtimes\/([^/]+)\/path$/;
/** A start's body is a few short names. */
const MAX_BODY = 4096;
/** A list of names (a page's workspaces, an Undo's agents). */
const MANY_BODY = 64 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
function sendStarted(
  res: http.ServerResponse,
  s: Started & { fresh?: boolean },
): void {
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
      // The host's id: the Agents tab opens its pane by it (?open=<id>).
      sessionId: s.info.ref.id,
      startedAt: s.rec.startedAt,
    },
    // A resume with nothing to continue yet started fresh (same id).
    ...(s.fresh ? { fresh: true } : {}),
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
  const rp = RUNTIME_PATH.exec(pathname);
  // AG-14's routes over many agents at once.
  const many =
    pathname === "/api/agents/clear-stopped" ||
    pathname === "/api/agents/restore" ||
    pathname === "/api/agents/resume-interrupted";
  if (
    pathname !== "/api/personas" &&
    pathname !== "/api/agents/runtimes" &&
    !m &&
    !rp &&
    !many
  )
    return false;
  const method = req.method ?? "GET";
  const d = webDeps(deps.agents);

  if (rp) return runtimePath(req, res, safeDecode(rp[1]), d);
  if (many) return manyAgents(req, res, pathname, d);
  if (!m) {
    if (method !== "GET" && method !== "HEAD")
      return methodNotAllowed(res, "GET");
    try {
      const ws = queryWorkspace(req, d);
      const runtimes = await listRuntimes(d, ws);
      sendJson(res, {
        ...(pathname === "/api/personas" ? { personas: listPersonas(d) } : {}),
        runtimes,
        ...(ws ? { workspace: ws } : {}),
        // AG-0.2: the file a person edits to set a runtime's path.
        userConfig: d.userConfigFile(),
      });
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
  const action = m[3] as
    | "stop"
    | "resume"
    | "fresh"
    | "relaunch"
    | "remove"
    | undefined;

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
    // it, before anything else is said about it.
    if (id !== undefined) agentRecord(d, id, ws);
    // AG-14.4: MCP agent_resume may resume another agent of its scope.
    const agent = agentPrincipalOf(req);
    if (verb === "resume" && agent) {
      const why = agentResumeRefusal(agent, ws, id!, mcpActions());
      if (why) throw new AgentError(why, { status: 403 });
    } else guard(actor);
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
      // The answer comes once the session has ended (200, stopped: true),
      // or, still running after the wait, 202 with stillStopping: true.
      const s = await stopAgent(d, id!, ws);
      audit(s.stillStopping ? `${what} (still stopping)` : what);
      sendJson(
        res,
        {
          ok: true,
          agent: s.rec.id,
          wasRunning: !!s.session,
          stopped: !s.stillStopping,
          ...(s.stillStopping ? { stillStopping: true } : {}),
        },
        s.stillStopping ? 202 : 200,
      );
    } else if (verb === "fresh") {
      const s = await startFresh(d, id!, ws);
      what = `start ${s.rec.id} fresh (${s.rec.persona}, ${s.rec.runtime}) in ${ws}`;
      audit(what, s.early ? "exited at once" : undefined);
      sendStarted(res, s);
    } else if (verb === "relaunch") {
      const s = await relaunchAgent(d, id!, ws);
      what = `relaunch ${s.rec.id} from its handoff (${s.why}) in ${ws}`;
      audit(what, s.early ? "exited at once" : undefined);
      sendStarted(res, s);
    } else if (verb === "remove") {
      const removed = await removeAgent(d, id!, ws);
      audit(what);
      sendJson(res, { ok: true, removed });
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

/** The org config's mcp.actions; none when it can't be read. */
function mcpActions(): readonly string[] {
  try {
    return readMcpConfig().actions;
  } catch {
    return [];
  }
}

/** A POST body's JSON object (a usage error otherwise). */
async function jsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req).catch(() => "");
  if (raw.length > MANY_BODY)
    throw new AgentError("request too large", { status: 413, usage: true });
  let v: unknown;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    throw new AgentError("invalid JSON", { usage: true });
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new AgentError("the body must be a JSON object", { usage: true });
  return v as Record<string, unknown>;
}

/** A body's list of names (workspaces or agent ids), each checked. */
function names(v: unknown, key: string): string[] {
  if (!Array.isArray(v) || !v.length)
    throw new AgentError(`${key} must be a list of names`, { usage: true });
  for (const x of v)
    if (typeof x !== "string" || !NAME_RE.test(x))
      throw new AgentError(`${key}: "${String(x)}" is not a name`, {
        usage: true,
      });
  return [...new Set(v as string[])];
}

/**
 * POST /api/agents/clear-stopped, /restore, /resume-interrupted (AG-14):
 * a person only. Each is audited, refused or done.
 */
async function manyAgents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: AgentsResolved,
): Promise<true> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const actor = auditActorOf(req);
  const verb = pathname.slice("/api/agents/".length);
  let what = verb;
  const audit = (reason?: string) =>
    recordAction(
      actor,
      {
        verb: "agents",
        detail: what,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      principalOf(req),
    );
  try {
    guard(actor);
    const body = await jsonBody(req);
    if (verb === "restore") {
      const ids = names(body.agents, "agents");
      const restored = restoreAgents(d, ids);
      what = `restore ${restored.join(", ") || "nothing"}`;
      audit();
      sendJson(res, { ok: true, restored });
      return true;
    }
    const wss = names(body.workspaces, "workspaces");
    for (const w of wss)
      if (!d.workspaceExists(w))
        throw new AgentError(`workspace "${w}" does not exist`, {
          status: 404,
        });
    if (verb === "clear-stopped") {
      const removed = await removeStopped(d, wss);
      what = `clear stopped in ${wss.join(", ")}: ${removed.map((r) => r.agent).join(", ") || "none"}`;
      audit();
      sendJson(res, { ok: true, removed });
      return true;
    }
    const r = await resumeInterrupted(d, wss);
    what = `resume interrupted in ${wss.join(", ")}: ${r.resumed.map((x) => x.rec.id).join(", ") || "none"}`;
    audit(r.failed.length ? `${r.failed.length} could not resume` : undefined);
    sendJson(res, {
      ok: r.failed.length === 0,
      resumed: r.resumed.map((x) => ({
        id: x.rec.id,
        workspace: x.rec.workspace,
        sessionId: x.info.ref.id,
      })),
      failed: r.failed,
    });
  } catch (e) {
    audit(e instanceof Error ? e.message : String(e));
    sendError(res, e);
  }
  return true;
}

/** `?workspace=<ws>`, when it names a workspace here; else none. */
function queryWorkspace(
  req: http.IncomingMessage,
  d: AgentsResolved,
): string | undefined {
  const ws = new URL(req.url ?? "/", "http://x").searchParams.get("workspace");
  if (!ws) return undefined;
  if (!d.workspaceExists(ws))
    throw new AgentError(`workspace "${ws}" does not exist`, { status: 404 });
  return ws;
}

/**
 * POST /api/agents/runtimes/<id>/path: a person only, never an agent (it
 * runs the path given). Audited, refused or done; never the path's output.
 */
async function runtimePath(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  d: AgentsResolved,
): Promise<true> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const actor = auditActorOf(req);
  let what = `runtime ${id} path`;
  const audit = (reason?: string) =>
    recordAction(
      actor,
      {
        verb: "agents",
        detail: what,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      principalOf(req),
    );
  try {
    if (actor && !actor.unverified)
      throw new AgentError("an agent can't set a runtime's path", {
        status: 403,
      });
    const raw = await readBody(req).catch(() => "");
    if (raw.length > MAX_BODY)
      throw new AgentError("request too large", { status: 413, usage: true });
    let v: unknown;
    try {
      v = JSON.parse(raw || "{}");
    } catch {
      throw new AgentError("invalid JSON", { usage: true });
    }
    const b = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const scope = b.scope === "workspace" ? "workspace" : "global";
    if (
      b.scope !== undefined &&
      b.scope !== "global" &&
      b.scope !== "workspace"
    )
      throw new AgentError('scope must be "global" or "workspace"', {
        usage: true,
      });
    if (b.bin !== null && typeof b.bin !== "string")
      throw new AgentError("bin must be an absolute path, or null to clear", {
        usage: true,
      });
    const ws = typeof b.workspace === "string" ? b.workspace : undefined;
    what = `runtime ${id} path (${scope === "workspace" ? `workspace ${ws ?? "?"}` : "global"}${b.bin === null ? ", cleared" : ""})`;
    const row = await setRuntimePath(d, {
      id,
      scope,
      ...(ws ? { workspace: ws } : {}),
      bin: b.bin === null ? null : b.bin.trim(),
    });
    audit();
    sendJson(res, { ok: true, runtime: row });
  } catch (e) {
    audit(e instanceof Error ? e.message : String(e));
    sendError(res, e);
  }
  return true;
}

/**
 * The actor: a person. An agent is one its actor token proves (the request
 * checks already refuse its start and resume); an x-den-actor header alone
 * is an unverified claim, not an agent.
 */
function guard(actor: Actor): void {
  if (actor && !actor.unverified)
    throw new AgentError(
      "an agent can't start, stop or resume agents from the page; agents use MCP agent_spawn",
      { status: 403 },
    );
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

/** How often stopped agents are checked against remove_stopped_after. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * What the web server does for agents on its own (AG-14):
 *   - once, shortly after it starts: marks interrupted the agents whose
 *     session is gone (Den or the machine went down), and resumes the
 *     standing personas and those with `resume_on_restart: true`
 *     (markInterrupted). A session host that outlived a web-server-only
 *     restart keeps every session: nothing is marked;
 *   - at start and every hour: forgets stopped and exited agents older
 *     than user.yml's agents.remove_stopped_after (never by default;
 *     interrupted ones never).
 * Nothing here asks for the admin password (LK-0).
 */
export function startAgentUpkeep(
  log: (line: string) => void,
  deps: AgentRouteDeps & { delayMs?: number } = {},
): void {
  const d = webDeps(deps.agents);
  const restart = async () => {
    try {
      const f = await markInterrupted(d);
      if (f.interrupted.length)
        log(
          `Agents interrupted when Den restarted: ${f.interrupted.join(", ")}` +
            (f.resumed.length ? ` · resumed: ${f.resumed.join(", ")}` : ""),
        );
      for (const x of f.failed)
        log(`  ⚠ agent ${x.agent} did not resume: ${x.why}`);
    } catch (e) {
      log(`  ⚠ agents after the restart: ${(e as Error).message}`);
    }
  };
  const prune = async () => {
    try {
      const gone = await pruneStopped(d, configuredRemoveStoppedAfter());
      if (gone.length) log(`Removed stopped agents: ${gone.join(", ")}`);
    } catch (e) {
      log(`  ⚠ agents.remove_stopped_after: ${(e as Error).message}`);
    }
  };
  setTimeout(() => {
    void restart().then(prune);
  }, deps.delayMs ?? 2000).unref();
  setInterval(() => void prune(), PRUNE_EVERY_MS).unref();
}
