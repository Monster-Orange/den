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
 *   GET  /api/personas/<id>                       one persona with its
 *                                                 instructions (Details)
 *   POST /api/personas                            New persona (AG-10.7): a
 *                                                 local one; a person only
 *   POST /api/personas/<id>                       Edit: a local one only
 *                                                 (409 read_only otherwise)
 *   DELETE /api/personas/<id>                     Delete: a local one only
 *   GET  /api/workspaces/<ws>/agents              the workspace's agents
 *   POST /api/workspaces/<ws>/agents              start { persona, runtime?,
 *                                                 model?, version?,
 *                                                 permission?, allow?,
 *                                                 instruction?, id? }
 *                                                 (AG-10.1): each checked
 *                                                 against the catalog; the
 *                                                 instruction is typed into
 *                                                 the session once it is
 *                                                 ready, never an argument
 *   GET  /api/workspaces/<ws>/conversations[?runtime=<r>]  Bring in
 *                                                 (AG-17.1): each runtime's
 *                                                 own conversations in the
 *                                                 workspace's folder, newest
 *                                                 first, with which runtimes
 *                                                 can bring one in
 *   POST /api/workspaces/<ws>/conversations/<id>/import  { persona,
 *                                                 runtime?, id? }: the
 *                                                 runtime's resume of it, as
 *                                                 a Den agent; 409
 *                                                 open_elsewhere when it was
 *                                                 written in the last minute
 *   POST /api/workspaces/<ws>/sessions            a plain session: the login
 *                                                 shell in the workspace's
 *                                                 folder (AG-10.1)
 *   POST /api/workspaces/<ws>/agents/<id>/stop
 *   POST /api/workspaces/<ws>/agents/<id>/resume  the same conversation (AG-14)
 *   POST /api/workspaces/<ws>/agents/<id>/fresh   a new conversation, same
 *                                                 persona and workspace
 *   POST /api/workspaces/<ws>/agents/<id>/relaunch  a rotated agent (den#4):
 *                                                 a new conversation whose
 *                                                 first prompt is its
 *                                                 handoff.md; a resume of
 *                                                 one is refused (409 rotated)
 *   POST /api/workspaces/<ws>/agents/<id>/name    { name: string | null }: the
 *                                                 name its tab and the lists
 *                                                 show (AG-4b); the id never
 *                                                 changes; null or "" clears
 *   GET  /api/workspaces/<ws>/agents/<id>/paths?p=…  which printed paths are
 *                                                 links (AG-4b): inside its
 *                                                 workspace and there (stat
 *                                                 only; agent-paths.ts)
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
  conversationFolders,
  listWorkspaceServices,
  resolveWorkspaceDir,
} from "../../shared/environment-manager/workspaces.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import { getStateDir } from "../../shared/paths.js";
import { HostError } from "../../shared/sessions/client.js";
import {
  AgentError,
  defaultId,
  agentRecord,
  checkInstruction,
  createPersona,
  deletePersona,
  listAgents,
  listPersonas,
  personaDetail,
  registries,
  sendFirstInstruction,
  startPlainSession,
  updatePersona,
  listRuntimes,
  markInterrupted,
  cancelStalePersonaChanges,
  NOT_IN_WORKSPACE,
  pruneStopped,
  removeAgent,
  renameAgent,
  removeStopped,
  restoreAgents,
  resumeInterrupted,
  setRuntimePath,
  resolveAgentsDeps,
  importAgent,
  changePersona,
  listConversations,
  relaunchAgent,
  resumeOrRelaunch,
  keepAgentConversation,
  askForHandoff,
  rotationChoices,
  rotationSettings,
  setRotationSetting,
  rotationTick,
  ROTATION_TICK_MS,
  startAgent,
  startFresh,
  stopAgent,
  type AgentsDeps,
  type AgentsResolved,
  type Started,
  FRESH_NOTE,
} from "../cli/agent-ops.js";
import { agentSessionName } from "../../shared/agents/session-name.js";
import { recordAction } from "./audit.js";
import { agentPathLinks, MAX_PATHS } from "./agent-paths.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";
import {
  agentImportRefusal,
  agentResumeRefusal,
} from "./agent-resume-grant.js";
import { readBody, sendJson } from "./http-helpers.js";
import type { Actor } from "../../shared/agent-actor.js";

export interface AgentRouteDeps {
  /** The operations' deps (tests: an in-process host, a temp state dir). */
  agents?: AgentsDeps;
  /** When a first instruction counts its session ready (tests: shorter). */
  instruction?: { quietMs?: number; maxMs?: number };
  /** AG-18: how "after this turn" polls (tests: shorter). */
  personaWait?: { pollMs?: number; maxMs?: number };
  /** HUB-1.5: GET /api/hub's answer (tests: a fake Hub). */
  hubStatus?: () => Promise<import("../../shared/hub.js").HubStatus>;
}

const AGENTS_PATH =
  /^\/api\/workspaces\/([^/]+)\/agents(?:\/([^/]+)\/(stop|resume|fresh|relaunch|remove|name|paths|persona|keep|handoff))?$/;

const RUNTIME_PATH = /^\/api\/agents\/runtimes\/([^/]+)\/path$/;
const PERSONA_PATH = /^\/api\/personas\/([^/]+)$/;
const PLAIN_PATH = /^\/api\/workspaces\/([^/]+)\/sessions$/;
const CONVERSATIONS_PATH =
  /^\/api\/workspaces\/([^/]+)\/conversations(?:\/([^/]+)\/import)?$/;
/** A start's body: a few names, commands and a first instruction. */
const MAX_BODY = 32 * 1024;
/** A list of names (a page's workspaces, an Undo's agents). */
const MANY_BODY = 64 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Never a TTY: a web start's terminal is 80×24. */
const NO_TTY = { isTTY: false } as NodeJS.WriteStream;

export function webDeps(over: AgentsDeps = {}): AgentsResolved {
  return resolveAgentsDeps({
    stateDir: () => getStateDir(),
    workspaceExists: (ws) => Boolean(readWorkspacesFile().workspaces[ws]),
    workspaceDir: (ws) => {
      const cfg = readWorkspacesFile().workspaces[ws];
      if (!cfg) throw new AgentError(`workspace "${ws}" does not exist`);
      return resolveWorkspaceDir(ws, cfg, getReposRoot());
    },
    // AG-17.1: its folder and each by-path repo's, outside it too. A caller
    // that gives its own folder (a test) gives its folders too, or just it.
    ...(over.workspaceDir
      ? {}
      : {
          workspaceFolders: (ws: string) => {
            const cfg = readWorkspacesFile().workspaces[ws];
            if (!cfg) throw new AgentError(`workspace "${ws}" does not exist`);
            return conversationFolders(ws, cfg, getReposRoot());
          },
        }),
    // D28: the service scope of rotation settings.
    workspaceServices: (ws) => {
      const cfg = readWorkspacesFile().workspaces[ws];
      if (!cfg) return [];
      return listWorkspaceServices(cfg, readCatalog(), ws).map((r) => ({
        address: r.address,
        path: r.repoPath,
      }));
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
        ...(e.running ? { running: e.running } : {}),
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

function sessionTitleOf(
  rec: Started["rec"],
  d: AgentsResolved,
): { sessionTitle?: string } {
  const n = agentSessionName(rec, d.stateDir());
  return n ? { sessionTitle: n } : {};
}

/** A started or resumed agent's answer: its record, or its early exit. */
function sendStarted(
  res: http.ServerResponse,
  s: Started & { fresh?: boolean },
  d: AgentsResolved,
  extra: Record<string, unknown> = {},
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
      ...(s.rec.model ? { model: s.rec.model } : {}),
      ...(s.rec.version ? { version: s.rec.version } : {}),
      ...(s.rec.permission ? { permission: s.rec.permission } : {}),
      ...(s.rec.overrides?.length ? { overrides: s.rec.overrides } : {}),
      ...(s.rec.displayName ? { displayName: s.rec.displayName } : {}),
      // AG-4b: the name its session shows (Den's rename or the runtime's),
      // as the lists show it (MCP agent_resume answers with this). Its
      // handle is `session`.
      ...sessionTitleOf(s.rec, d),
    },
    // A resume with nothing to continue yet started fresh (same id).
    ...(s.fresh ? { fresh: true } : {}),
    ...(s.warnings.length ? { warnings: s.warnings } : {}),
    ...extra,
  });
}

/** What a start's body names: optional strings, a command list, an instruction. */
interface StartBody {
  persona?: string;
  runtime?: string;
  model?: string;
  id?: string;
  version?: string;
  permission?: string;
  allow?: unknown;
  instruction?: unknown;
  /** AG-10.10: a display name, checked as a rename's is. */
  name?: unknown;
  /** 0.4.18: the folder it runs in (Start agent here). */
  folder?: string;
}

const START_KEYS = [
  "persona",
  "runtime",
  "model",
  "id",
  "version",
  "permission",
  "allow",
  "instruction",
  "name",
  "folder",
];

async function startBody(req: http.IncomingMessage): Promise<StartBody> {
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
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!START_KEYS.includes(k))
      throw new AgentError(
        `${k}: unknown field (a start takes ${START_KEYS.join(", ")})`,
        { usage: true },
      );
  const out: Record<string, unknown> = {};
  for (const k of [
    "persona",
    "runtime",
    "model",
    "id",
    "version",
    "permission",
  ]) {
    const x = o[k];
    if (x === undefined || x === null || x === "") continue;
    if (typeof x !== "string")
      throw new AgentError(`${k} must be a string`, { usage: true });
    if (x.length > 128 || /[^\x21-\x7e]/.test(x))
      throw new AgentError(
        `${k} must be a short name (no spaces or control characters)`,
        {
          usage: true,
        },
      );
    out[k] = x;
  }
  if (o.allow !== undefined && o.allow !== null) out.allow = o.allow;
  if (o.instruction !== undefined) out.instruction = o.instruction;
  if (o.name !== undefined && o.name !== null && o.name !== "")
    out.name = o.name;
  if (o.folder !== undefined && o.folder !== null && o.folder !== "") {
    if (typeof o.folder !== "string" || o.folder.length > 4096)
      throw new AgentError("folder must be a path", { usage: true });
    out.folder = o.folder;
  }
  return out as StartBody;
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
  const pp = PERSONA_PATH.exec(pathname);
  const plain = PLAIN_PATH.exec(pathname);
  const conv = CONVERSATIONS_PATH.exec(pathname);
  // AG-14's routes over many agents at once.
  const many =
    pathname === "/api/agents/clear-stopped" ||
    pathname === "/api/agents/restore" ||
    pathname === "/api/agents/resume-interrupted";
  if (pathname === "/api/agents/rotation")
    return rotationRoute(req, res, webDeps(deps.agents));
  // HUB-1.5: Settings › Hub. Never the token: hubStatus doesn't return it.
  if (pathname === "/api/hub") {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD")
      return methodNotAllowed(res, "GET");
    const { hubStatus } = await import("../../shared/hub.js");
    sendJson(res, await (deps.hubStatus ?? (() => hubStatus()))());
    return true;
  }
  if (
    pathname !== "/api/personas" &&
    pathname !== "/api/agents/runtimes" &&
    !m &&
    !rp &&
    !pp &&
    !plain &&
    !conv &&
    !many
  )
    return false;
  const method = req.method ?? "GET";
  const d = webDeps(deps.agents);

  if (pp) return personaRoute(req, res, safeDecode(pp[1]), d);
  if (plain) return plainSession(req, res, safeDecode(plain[1]), d);
  if (conv)
    return conversations(
      req,
      res,
      safeDecode(conv[1]),
      conv[2] === undefined ? undefined : safeDecode(conv[2]),
      d,
    );
  if (pathname === "/api/personas" && method === "POST")
    return personaRoute(req, res, null, d);

  if (rp) return runtimePath(req, res, safeDecode(rp[1]), d);
  if (many) return manyAgents(req, res, pathname, d);
  if (!m) {
    if (method !== "GET" && method !== "HEAD")
      return methodNotAllowed(
        res,
        pathname === "/api/personas" ? "GET, POST" : "GET",
      );
    try {
      const ws = queryWorkspace(req, d);
      const runtimes = await listRuntimes(d, ws);
      sendJson(res, {
        ...(pathname === "/api/personas"
          ? { personas: listPersonas(d), ...registries(d) }
          : {}),
        // AG-10.10: the id a new start of each persona takes here.
        ...(pathname === "/api/personas" && ws
          ? {
              startsAs: Object.fromEntries(
                listPersonas(d).flatMap((p) => {
                  try {
                    return [[p.id, defaultId(d.stateDir(), p.id, ws)]];
                  } catch {
                    return []; // no free id: the start says so
                  }
                }),
              ),
            }
          : {}),
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
    | "name"
    | "paths"
    | "persona"
    | "keep"
    | "handoff"
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
  // AG-4b: which paths an agent printed are links (read-only: stat only).
  if (action === "paths") {
    if (method !== "GET" && method !== "HEAD")
      return methodNotAllowed(res, "GET");
    try {
      const rec = agentRecord(d, id!, ws);
      const given = new URL(
        req.url ?? "/",
        "http://localhost",
      ).searchParams.getAll("p");
      if (given.length > MAX_PATHS)
        throw new AgentError(`at most ${MAX_PATHS} paths at once`, {
          usage: true,
        });
      let wsDir: string | null = null;
      try {
        wsDir = d.workspaceDir(ws);
      } catch {
        wsDir = null;
      }
      sendJson(res, {
        paths: agentPathLinks(
          given,
          rec.cwd,
          [wsDir, rec.cwd].filter((x): x is string => !!x),
        ),
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
    // AG-18: a persona is the person's choice: an agent could widen its
    // own permissions with it. Any agent credential or claim is refused.
    if (verb === "persona" && (agent || actor))
      throw new AgentError(
        "only a person can change an agent's persona (an agent can't change its own or another's)",
        { status: 403 },
      );
    // D28: an agent could keep itself from ever rotating.
    if (verb === "keep" && (agent || actor))
      throw new AgentError(
        "only a person can keep an agent's conversation past its rotation",
        { status: 403 },
      );
    if (verb === "resume" && agent) {
      const why = agentResumeRefusal(agent, ws, id!, mcpActions());
      if (why) throw new AgentError(why, { status: 403 });
    } else guard(actor);
    if (verb === "start") {
      const body = await startBody(req);
      if (!body.persona)
        throw new AgentError("persona is required", { usage: true });
      what = `start ${body.id ?? body.persona} in ${ws}`;
      const instruction = checkInstruction(body.instruction);
      const s = await startAgent(d, {
        workspace: ws,
        persona: body.persona,
        runtime: body.runtime,
        model: body.model,
        id: body.id,
        ...(body.version !== undefined ? { version: body.version } : {}),
        ...(body.permission !== undefined
          ? { permission: body.permission }
          : {}),
        ...(body.allow !== undefined ? { allow: body.allow } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.folder !== undefined ? { folder: body.folder } : {}),
        strict: true,
      });
      const ov = s.rec.overrides?.length
        ? `; overrides ${s.rec.overrides.join(", ")}`
        : "";
      what = `start ${s.rec.id} (${s.rec.persona}, ${s.rec.runtime}${ov}) in ${ws}`;
      audit(what, s.early ? "exited at once" : undefined);
      sendStarted(res, s, d, instruction ? { instruction: "pending" } : {});
      // AG-10.1: its first message, once it is ready: typed into its
      // session (the host's write path), never an argument. Its text is
      // never logged; its length is.
      if (instruction && !s.early) {
        const id = s.rec.id;
        void sendFirstInstruction(
          d,
          s.info.ref.id,
          s.rec.runtime,
          instruction,
          deps.instruction ?? {},
        ).then((sent) =>
          recordAction(
            actor,
            {
              verb: "agents",
              detail: `first instruction to ${id} in ${ws} (${instruction.length} characters)`,
              ...(sent
                ? {}
                : {
                    outcome: "refused" as const,
                    reason: "its session ended or no host",
                  }),
            },
            principalOf(req),
          ),
        );
      }
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
      sendStarted(res, s, d);
    } else if (verb === "keep") {
      const body = await jsonBody(req);
      for (const k of Object.keys(body))
        if (k !== "never")
          throw new AgentError(`${k}: unknown field (keep takes never)`, {
            usage: true,
          });
      if (body.never !== undefined && typeof body.never !== "boolean")
        throw new AgentError("never must be true or false", { usage: true });
      const rec = keepAgentConversation(d, id!, ws, {
        never: body.never === true,
      });
      what = `keep ${rec.id}'s conversation in ${ws}${body.never ? " (never rotate)" : ""}`;
      audit(what);
      sendJson(res, { ok: true, agent: rec.id, never: body.never === true });
    } else if (verb === "handoff") {
      const body = await jsonBody(req);
      for (const k of Object.keys(body))
        if (k !== "relaunch")
          throw new AgentError(`${k}: unknown field (handoff takes relaunch)`, {
            usage: true,
          });
      const relaunch = body.relaunch === true;
      const rec = await askForHandoff(d, id!, ws, undefined, { relaunch });
      what = `ask ${rec.id} for its handoff in ${ws}${relaunch ? ", then relaunch" : ""}${rec.resumed ? " (resumed to write it)" : ""}`;
      audit(what);
      sendJson(res, {
        ok: true,
        agent: rec.id,
        relaunch,
        ...(rec.resumed ? { resumed: true } : {}),
      });
    } else if (verb === "relaunch") {
      const s = await relaunchAgent(d, id!, ws);
      what = `relaunch ${s.rec.id} from its handoff (${s.why}) in ${ws}`;
      audit(what, s.early ? "exited at once" : undefined);
      sendStarted(res, s, d);
    } else if (verb === "name") {
      const body = await jsonBody(req);
      if (!("name" in body))
        throw new AgentError("name is required (null clears it)", {
          usage: true,
        });
      const rec = renameAgent(d, id!, ws, body.name);
      audit(what);
      sendJson(res, {
        ok: true,
        agent: rec.id,
        ...(rec.displayName ? { displayName: rec.displayName } : {}),
      });
    } else if (verb === "persona") {
      const body = await jsonBody(req);
      for (const k of Object.keys(body))
        if (!PERSONA_KEYS.includes(k))
          throw new AgentError(
            `${k}: unknown field (a persona change takes ${PERSONA_KEYS.join(", ")})`,
            { usage: true },
          );
      const str = (k: string): string | undefined => {
        const v = body[k];
        if (v === undefined || v === null || v === "") return undefined;
        if (typeof v !== "string" || v.length > 128 || /[^\x21-\x7e]/.test(v))
          throw new AgentError(`${k} must be a short name`, { usage: true });
        return v;
      };
      const persona = str("persona");
      if (!persona)
        throw new AgentError("persona is required", { usage: true });
      const when = str("when");
      if (when !== undefined && when !== "now" && when !== "after-turn")
        throw new AgentError("when must be now or after-turn", {
          usage: true,
        });
      const from = agentRecord(d, id!, ws).persona;
      const by = principalOf(req) ?? "this machine";
      what = `persona ${id} in ${ws}: ${from} → ${persona}, by ${by}`;
      const change = () =>
        changePersona(
          d,
          id!,
          ws,
          {
            persona,
            ...(str("model") !== undefined ? { model: str("model") } : {}),
            ...(str("version") !== undefined
              ? { version: str("version") }
              : {}),
            ...(when ? { when: when as "now" | "after-turn" } : {}),
            by,
          },
          deps.personaWait ?? {},
        );
      if (when === "after-turn") {
        // It may wait for a long turn: answer now, audit when it's done.
        agentRecord(d, id!, ws);
        void change().then(
          (s) => audit(what, s.early ? "exited at once" : undefined),
          (e: unknown) =>
            audit(what, e instanceof Error ? e.message : String(e)),
        );
        sendJson(res, { ok: true, agent: id, pending: true, persona }, 202);
        return true;
      }
      const s = await change();
      audit(what, s.early ? "exited at once" : undefined);
      // Never prompted: nothing was resumed, so it says so (not "same
      // conversation").
      sendStarted(res, s, d, s.fresh ? { note: FRESH_NOTE } : {});
    } else if (verb === "remove") {
      const removed = await removeAgent(d, id!, ws);
      audit(what);
      sendJson(res, { ok: true, removed });
    } else {
      // D28: a due agent under auto relaunches from its handoff instead.
      const r = await resumeOrRelaunch(d, id!, ws);
      if (r.kind === "relaunched") {
        what = `relaunch ${r.s.rec.id} from its handoff (${r.s.why}) in ${ws}, on Resume`;
        audit(what, r.s.early ? "exited at once" : undefined);
        sendStarted(res, r.s, d, { relaunched: true });
      } else {
        audit(what);
        sendStarted(res, r.s, d);
      }
    }
  } catch (e) {
    audit(what, e instanceof Error ? e.message : String(e));
    sendError(res, e, ws);
  }
  return true;
}

const IMPORT_KEYS = ["persona", "runtime", "id", "model", "version"];
/** AG-18: what a persona change takes. */
const PERSONA_KEYS = ["persona", "model", "version", "when"];

/**
 * Bring in (AG-17.1): GET lists the workspace's conversations, POST
 * …/<id>/import brings one in. A person's, or an agent's opted in through
 * mcp.actions' agent_import inside its scope. Every import is audited.
 */
async function conversations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ws: string,
  session: string | undefined,
  d: AgentsResolved,
): Promise<true> {
  const method = req.method ?? "GET";
  const actor = auditActorOf(req);
  const agent = agentPrincipalOf(req);
  const allowed = () => {
    if (agent) {
      const why = agentImportRefusal(agent, ws, mcpActions());
      if (why) throw new AgentError(why, { status: 403 });
    } else guard(actor);
  };
  if (session === undefined) {
    if (method !== "GET" && method !== "HEAD")
      return methodNotAllowed(res, "GET");
    try {
      allowed();
      const runtime =
        new URL(req.url ?? "/", "http://x").searchParams.get("runtime") ??
        undefined;
      const listed = listConversations(d, ws, runtime);
      sendJson(res, { workspace: ws, folder: d.workspaceDir(ws), ...listed });
    } catch (e) {
      sendError(res, e, ws);
    }
    return true;
  }
  if (method !== "POST") return methodNotAllowed(res, "POST");
  let what = `bring in ${session} in ${ws}`;
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
    allowed();
    const body = await jsonBody(req);
    for (const k of Object.keys(body))
      if (!IMPORT_KEYS.includes(k))
        throw new AgentError(
          `${k}: unknown field (an import takes ${IMPORT_KEYS.join(", ")})`,
          { usage: true },
        );
    const str = (k: string): string | undefined => {
      const v = body[k];
      if (v === undefined || v === null || v === "") return undefined;
      if (typeof v !== "string" || !NAME_RE.test(v))
        throw new AgentError(`${k} must be a name`, { usage: true });
      return v;
    };
    const persona = str("persona");
    if (!persona) throw new AgentError("persona is required", { usage: true });
    const s = await importAgent(d, {
      workspace: ws,
      session,
      persona,
      runtime: str("runtime"),
      id: str("id"),
      ...(str("model") !== undefined ? { model: str("model") } : {}),
      ...(str("version") !== undefined ? { version: str("version") } : {}),
    });
    what = `bring in ${session} as ${s.rec.id} (${s.rec.persona}, ${s.rec.runtime}) in ${ws}`;
    audit(s.early ? "exited at once" : undefined);
    sendStarted(res, s, d);
  } catch (e) {
    audit(e instanceof Error ? e.message : String(e));
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
 * The persona routes (AG-10.6, 10.7): GET one (anyone who may read);
 * POST (new: `id` null; edit: a local one), DELETE (a local one): a
 * person only. An agent's token can't make or change a persona (its
 * permissions are the person's to set). Every change is audited, refused
 * or done; never the instructions themselves.
 */
async function personaRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string | null,
  d: AgentsResolved,
): Promise<true> {
  const method = req.method ?? "GET";
  if (id !== null && (method === "GET" || method === "HEAD")) {
    try {
      sendJson(res, { persona: personaDetail(d, id) });
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  if (method !== "POST" && !(method === "DELETE" && id !== null))
    return methodNotAllowed(
      res,
      id === null ? "GET, POST" : "GET, POST, DELETE",
    );
  const actor = auditActorOf(req);
  const verb = id === null ? "create" : method === "DELETE" ? "delete" : "edit";
  let what = `persona ${verb}${id ? ` ${id}` : ""}`;
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
      throw new AgentError(
        "an agent can't create, change or delete personas: a person sets what agents may do",
        { status: 403 },
      );
    if (verb === "delete") {
      deletePersona(d, id!);
      audit();
      sendJson(res, { ok: true, deleted: id });
      return true;
    }
    const body = await jsonBody(req);
    const p =
      verb === "create" ? createPersona(d, body) : updatePersona(d, id!, body);
    what = `persona ${verb} ${p.id}`;
    audit();
    sendJson(res, { ok: true, persona: p });
  } catch (e) {
    audit(e instanceof Error ? e.message : String(e));
    sendError(res, e);
  }
  return true;
}

/**
 * POST /api/workspaces/<ws>/sessions (AG-10.1 Plain session): a person's
 * login shell in the workspace's folder. A person only; audited.
 */
async function plainSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ws: string,
  d: AgentsResolved,
): Promise<true> {
  if (req.method !== "POST") return methodNotAllowed(res, "POST");
  const actor = auditActorOf(req);
  let what = `plain session in ${ws}`;
  const audit = (reason?: string) =>
    recordAction(
      actor,
      {
        verb: "sessions",
        detail: what,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      principalOf(req),
    );
  try {
    if (actor && !actor.unverified)
      throw new AgentError("an agent can't start a session from the page", {
        status: 403,
      });
    const { info } = await startPlainSession(d, ws);
    what = `plain session ${info.name} in ${ws}`;
    audit();
    sendJson(res, {
      ok: true,
      session: { id: info.ref.id, name: info.name, workspace: ws },
    });
  } catch (e) {
    audit(e instanceof Error ? e.message : String(e));
    sendError(res, e, ws);
  }
  return true;
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
    // AG-18: a persona change waiting for a turn's end lived in memory.
    try {
      for (const c of cancelStalePersonaChanges(d)) {
        const what = `persona ${c.id} in ${c.workspace}: ${c.from} → ${c.to}, by ${c.by ?? "this machine"}`;
        recordAction(null, {
          verb: "agents",
          detail: what,
          outcome: "refused",
          reason: "persona change cancelled: Den restarted",
        });
        log(`Persona change cancelled (Den restarted): ${what}`);
      }
    } catch (e) {
      log(`  ⚠ persona changes after the restart: ${(e as Error).message}`);
    }
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
  // D28: due agents under on_due auto, at idle: asked for the handoff,
  // then relaunched from it. One look at a time.
  let looking = false;
  const rotate = async () => {
    if (looking) return;
    looking = true;
    try {
      for (const e of await rotationTick(d)) {
        const who = `${e.agent} in ${e.workspace}`;
        if (e.kind === "relaunched") {
          const what = `relaunch ${who} from its handoff (${e.why}), by itself; the old conversation ${e.old ?? "?"} is kept`;
          recordAction(null, { verb: "agents", detail: what });
          log(`Relaunched ${who} from its handoff after ${e.why}`);
        } else if (e.kind === "asked")
          log(`Asked ${who} for its handoff (${e.asked} of 2)`);
        else if (e.kind === "fell-back")
          log(
            `  ⚠ ${who} wrote no handoff after 2 asks: its callout asks the person`,
          );
        else log(`  ⚠ rotation of ${who}: ${e.why}`);
      }
    } catch (e) {
      log(`  ⚠ agents.rotate: ${(e as Error).message}`);
    } finally {
      looking = false;
    }
  };
  setTimeout(() => {
    void restart().then(prune);
  }, deps.delayMs ?? 2000).unref();
  setInterval(() => void prune(), PRUNE_EVERY_MS).unref();
  setInterval(() => void rotate(), ROTATION_TICK_MS).unref();
}

/**
 * D28, `/api/agents/rotation`. GET: the settings (install, overrides,
 * defaults) and, with `?ws=&agent=`, that agent's effective values and
 * where each comes from. PUT `{ scope, target?, key, value }` sets one
 * (value null clears it): a person's only.
 */
async function rotationRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  d: AgentsResolved,
): Promise<boolean> {
  const method = req.method ?? "GET";
  try {
    if (method === "GET" || method === "HEAD") {
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const ws = q.get("ws") ?? undefined;
      const agent = q.get("agent") ?? undefined;
      if ((ws && !NAME_RE.test(ws)) || (agent && !NAME_RE.test(agent)))
        throw new AgentError("not a name", { usage: true });
      // D30: ?choices=1 adds what the overrides form can pick, by name.
      sendJson(res, {
        ...rotationSettings(d, agent, ws),
        ...(q.get("choices") === "1"
          ? {
              choices: await rotationChoices(
                d,
                Object.keys(readWorkspacesFile().workspaces ?? {}),
              ),
            }
          : {}),
      });
      return true;
    }
    if (method !== "PUT") return methodNotAllowed(res, "GET, PUT");
    if (agentPrincipalOf(req) || auditActorOf(req))
      throw new AgentError("only a person can change rotation settings", {
        status: 403,
      });
    const body = await jsonBody(req);
    for (const k of Object.keys(body))
      if (!["scope", "target", "key", "value"].includes(k))
        throw new AgentError(
          `${k}: unknown field (takes scope, target, key, value)`,
          { usage: true },
        );
    const out = setRotationSetting(d, body);
    recordAction(
      null,
      {
        verb: "agents",
        detail: `rotation ${String(body.scope)}${body.target ? ` ${String(body.target)}` : ""} ${String(body.key)} = ${body.value === null ? "(unset)" : JSON.stringify(body.value)}`,
      },
      principalOf(req),
    );
    sendJson(res, { ok: true, ...out });
  } catch (e) {
    sendError(res, e);
  }
  return true;
}
