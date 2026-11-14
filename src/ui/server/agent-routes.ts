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
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import {
  configuredRemoveStoppedAfter,
  getReposRoot,
  readAgentsConfig,
  readMcpConfig,
} from "../../shared/den-config.js";
import type { AgentRecord } from "../../shared/agents/records.js";
import {
  readWorkspacesFile,
  conversationFolders,
  listWorkspaceServices,
  resolveWorkspaceDir,
} from "../../shared/environment-manager/workspaces.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import { getStateDir } from "../../shared/paths.js";
import { HostError } from "../../shared/sessions/client.js";
import { resolveWorkspaceInput } from "../../shared/environment-manager/workspaces.js";
import {
  AgentError,
  defaultId,
  agentRecord,
  checkInstruction,
  createPersona,
  deletePersona,
  listAgents,
  agentDetails,
  agentTools,
  restartAgent,
  staleAgents,
  agentHelpers,
  agentHelperTranscript,
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
  moveAgent,
  setAgentRepo,
  checkRepoName,
  workspaceRepoFolders,
  migrateAgentLinks,
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
  setAgentResumeOnRestart,
  clearAgentHelpers,
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
  workspacePermissionOf,
} from "../cli/agent-ops.js";
import { agentSessionName } from "../../shared/agents/session-name.js";
import { recordAction } from "./audit.js";
import {
  agentFile,
  agentPathLinks,
  attachmentHeader,
  MAX_PATHS,
  type PathFence,
} from "./agent-paths.js";
import {
  uploadsRoot,
  UPLOAD_DEFAULTS,
  UPLOAD_SESSION_RE,
} from "../../shared/agents/uploads.js";
import { FILE_DENY_DEFAULTS } from "../../shared/agents/file-deny.js";
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
import { product } from "../../shared/product.js";
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
  /** H5 (tests): Den Hub's GitHub coverage, and the project sync. */
  hubGithub?: () => Promise<
    | { orgs: import("../../shared/hub-project-sync.js").OrgCoverage[] }
    | { error: string }
    | null
  >;
  projectSync?: import("../../shared/hub-project-sync.js").ProjectSync;
  /** 0.4.40 (tests): comment delivery, restarted on connect, stopped on disconnect. */
  hubDeliveries?: { restart(): void; stop(): void };
  /** HUB-1.7: Connect to Hub's state (tests: fake Hub calls and store). */
  hubConnect?: import("./hub-connect.js").HubConnect;
  /** H5: Settings › Project setup › Hub project (tests swap Hub and the store). */
  hubProject?: Partial<import("./hub-project-routes.js").HubProjectRouteDeps>;
}

const AGENTS_PATH =
  /^\/api\/workspaces\/([^/]+)\/agents(?:\/([^/]+)\/(stop|resume|fresh|relaunch|remove|name|paths|persona|keep|settings|handoff|clear-helpers|restart|link|move|file))?$/;

/** D32: an agent's helpers, and one helper's transcript (read-only). */
const HELPERS_PATH =
  /^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/helpers(?:\/([^/]+))?$/;
/** D45: a stopped agent's details (read-only). */
const DETAILS_PATH = /^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/details$/;
/** D44: whether an agent's tools are current (read-only, for its MCP). */
const TOOLS_PATH = /^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/tools$/;
const RUNTIME_PATH = /^\/api\/agents\/runtimes\/([^/]+)\/path$/;
const PERSONA_PATH = /^\/api\/personas\/([^/]+)$/;
const PLAIN_PATH = /^\/api\/workspaces\/([^/]+)\/sessions$/;

/** The double-click fix: agent actions answered once per agent at a time. */
const ONCE_ACTIONS = new Set([
  "stop",
  "resume",
  "fresh",
  "relaunch",
  "restart",
  "handoff",
]);
const inFlightActions = new Map<
  string,
  Promise<{ status: number; body: string }>
>();
const CONVERSATIONS_PATH =
  /^\/api\/workspaces\/([^/]+)\/conversations(?:\/([^/]+)\/import)?$/;
/** A start's body: a few names, commands and a first instruction. */
const MAX_BODY = 32 * 1024;
/** A list of names (a page's workspaces, an Undo's agents). */
const MANY_BODY = 64 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Never a TTY: a web start's terminal is 80×24. */
const NO_TTY = { isTTY: false } as NodeJS.WriteStream;

/** 0.4.40: the server's comment delivery (hub-delivery-service.ts). */
async function deliveriesService(): Promise<{ restart(): void; stop(): void }> {
  const m = await import("./hub-delivery-service.js");
  return { restart: m.restartDeliveries, stop: m.stopDeliveries };
}

export function webDeps(over: AgentsDeps = {}): AgentsResolved {
  return resolveAgentsDeps({
    stateDir: () => getStateDir(),
    workspaceExists: (ws) => Boolean(readWorkspacesFile().workspaces[ws]),
    workspaceDir: (ws) => {
      const cfg = readWorkspacesFile().workspaces[ws];
      if (!cfg) throw new AgentError(`project "${ws}" does not exist`);
      return resolveWorkspaceDir(ws, cfg, getReposRoot());
    },
    // AG-17.1: its folder and each by-path repo's, outside it too. A caller
    // that gives its own folder (a test) gives its folders too, or just it.
    ...(over.workspaceDir
      ? {}
      : {
          workspaceFolders: (ws: string) => {
            const cfg = readWorkspacesFile().workspaces[ws];
            if (!cfg) throw new AgentError(`project "${ws}" does not exist`);
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
        ? `no agent here in project ${ws}`
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
  /** D65 v2: the repo it works on (a service card's); null: none. */
  repo?: string | null;
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
  "repo",
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
  if (o.repo === null || o.repo === "") out.repo = null;
  else if (o.repo !== undefined) out.repo = checkRepoName(o.repo);
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
  const hp = HELPERS_PATH.exec(pathname);
  if (hp) return helpersRoute(req, res, hp, webDeps(deps.agents));
  const dp = DETAILS_PATH.exec(pathname);
  if (dp) return detailsRoute(req, res, dp, webDeps(deps.agents));
  const tp = TOOLS_PATH.exec(pathname);
  if (tp) return toolsRoute(req, res, tp, webDeps(deps.agents));
  if (
    pathname === "/api/agents/stale" ||
    pathname === "/api/agents/restart-stale"
  )
    return staleRoute(req, res, pathname, webDeps(deps.agents), deps);
  // H5: the Hub project a project works on.
  if (pathname.endsWith("/hub-project")) {
    const { HUB_PROJECT_ROUTE, hubProjectRoute } =
      await import("./hub-project-routes.js");
    const hub = HUB_PROJECT_ROUTE.exec(pathname);
    if (hub) return hubProjectRoute(req, res, hub[1], deps.hubProject);
  }
  // #68: link every project to Hub's suggestion in one confirm.
  if (pathname === "/api/hub/link-suggestions") {
    const [{ hubLinkAllRoute }, hp, link, w, audit, guard, sa] =
      await Promise.all([
        import("./hub-link-all-routes.js"),
        import("./hub-project-routes.js"),
        import("../../shared/hub-project-link.js"),
        import("../../shared/environment-manager/workspaces.js"),
        import("./audit.js"),
        import("./request-guard.js"),
        import("../../shared/agents/server-agent.js"),
      ]);
    return hubLinkAllRoute(req, res, {
      projects: () => {
        try {
          return Object.keys(w.readWorkspacesFile().workspaces ?? {})
            .filter((k) => !sa.isServerScope(k))
            .sort();
        } catch {
          return [];
        }
      },
      choices: hp.defaultChoices,
      read: (ws) => link.hubProjectOf(ws),
      write: (ws, l) =>
        link.setHubProject(
          ws,
          l,
          `Link projects to Hub (${guard.principalOf(req) ?? "person"})`,
        ),
      changed: hp.defaultChanged,
      audit: (line) =>
        audit.recordAction(
          guard.auditActorOf(req),
          { verb: "hub-link", detail: line.slice(0, 400) },
          guard.principalOf(req),
        ),
    });
  }
  // H5: Den Hub's GitHub App coverage, and a sync on demand.
  if (pathname === "/api/hub/github" || pathname === "/api/hub/sync") {
    const svc = await import("./hub-sync-service.js");
    const method = req.method ?? "GET";
    if (pathname === "/api/hub/github") {
      if (method !== "GET" && method !== "HEAD")
        return methodNotAllowed(res, "GET");
      const c = await (deps.hubGithub ?? svc.githubCoverage)();
      sendJson(
        res,
        c === null ? { connected: false, orgs: [] } : { connected: true, ...c },
      );
      return true;
    }
    if (method !== "POST") return methodNotAllowed(res, "POST");
    const sync = deps.projectSync ?? svc.projectSync();
    sendJson(res, { ok: true, last: await sync.now() });
    return true;
  }
  // HUB-1.5: Settings › Hub. Never the token: hubStatus doesn't return it.
  if (pathname === "/api/hub") {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD")
      return methodNotAllowed(res, "GET");
    const { hubStatus } = await import("../../shared/hub.js");
    // #71: this is where Den takes a token Hub rotates (Settings, and the
    // rail's look every minute); doctor and the CLI only report.
    const { hubTokenRotation } = await import("./hub-connect.js");
    const st = await (
      deps.hubStatus ?? (() => hubStatus({ rotation: hubTokenRotation() }))
    )();
    // HUB-1.7: what the last Connect came to, once (words only). The
    // rail's look (?rail=1) leaves it for Settings, which shows it.
    const rail =
      new URL(req.url ?? "/", "http://localhost").searchParams.get("rail") ===
      "1";
    const last = rail
      ? null
      : (deps.hubConnect ?? defaultConnect)?.lastResult();
    // 0.4.45: the editions Settings names under Connect (den.yml).
    const { hubEditions } = await import("../../shared/hub-editions.js");
    const { readDenConfig } = await import("../../shared/den-config.js");
    let editions = null;
    try {
      editions = hubEditions(readDenConfig().hub_editions);
    } catch {
      editions = null;
    }
    const out = { ...st, ...(editions ? { editions } : {}) };
    sendJson(res, last ? { ...out, connect: last } : out);
    return true;
  }
  // HUB-1.7: Connect to Hub, and its callback (see hub-connect.ts).
  if (
    pathname === "/api/hub/connect" ||
    pathname === "/api/hub/disconnect" ||
    pathname === "/hub/callback"
  )
    return hubConnectRoute(req, res, pathname, deps);
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
        // D65 v2: the repos the Start dialog's Repo offers.
        ...(pathname === "/api/personas" && ws
          ? { repos: [...workspaceRepoFolders(d, ws).keys()].sort() }
          : {}),
        ...(ws ? { workspace: ws } : {}),
        // den#48: the workspace's default mode, Start's first choice.
        ...(ws ? workspacePermissionField(d, ws) : {}),
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
    sendJson(res, { ok: false, error: "not a project name" }, 400);
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
    | "settings"
    | "handoff"
    | "clear-helpers"
    | "link"
    | "move"
    | "restart"
    | "file"
    | undefined;

  // The double-click fix: the same start, resume, fresh, relaunch,
  // restart or stop of one agent while the first is still running gets
  // the first one's answer; it never runs twice.
  if (method === "POST" && id && action && ONCE_ACTIONS.has(action)) {
    const key = `${ws}\0${id}\0${action}`;
    const first = inFlightActions.get(key);
    if (first) {
      const r = await first;
      sendJson(res, JSON.parse(r.body || "{}"), r.status);
      return true;
    }
    let settle!: (r: { status: number; body: string }) => void;
    inFlightActions.set(key, new Promise((r) => (settle = r)));
    const end = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
    let done = false;
    const finish = (body: string) => {
      if (done) return;
      done = true;
      inFlightActions.delete(key);
      settle({ status: res.statusCode, body });
    };
    res.end = ((...a: unknown[]) => {
      const c = a[0];
      finish(
        typeof c === "string" ? c : Buffer.isBuffer(c) ? c.toString() : "",
      );
      return end(...a);
    }) as typeof res.end;
    res.on("close", () => finish("{}"));
  }

  if (!action && method === "GET") {
    try {
      if (!d.workspaceExists(ws))
        throw new AgentError(`project "${ws}" does not exist`, {
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
      sendJson(res, {
        paths: agentPathLinks(
          given,
          rec.cwd,
          agentRoots(d, rec, ws),
          agentFence(d, rec),
        ),
      });
    } catch (e) {
      sendError(res, e, ws);
    }
    return true;
  }
  // AG-DROP-2: a file the agent printed (or was given), back to the
  // browser's machine: inside its workspace, its cwd or its uploads.
  if (action === "file") {
    if (method !== "GET" && method !== "HEAD")
      return methodNotAllowed(res, "GET");
    try {
      const rec = agentRecord(d, id!, ws);
      const given =
        new URL(req.url ?? "/", "http://localhost").searchParams.get("p") ?? "";
      const file = given
        ? agentFile(given, rec.cwd, agentRoots(d, rec, ws), agentFence(d, rec))
        : null;
      const audit = (detail: string, reason?: string) =>
        recordAction(
          auditActorOf(req),
          {
            verb: "download",
            detail,
            targetWorkspace: ws,
            ...(reason ? { outcome: "refused" as const, reason } : {}),
          },
          principalOf(req),
        );
      if (!file) {
        audit(`${rec.id}: ${given.slice(0, 300)}`, "not_found");
        sendJson(
          res,
          {
            ok: false,
            error: `${given || "(no path)"} is not a file in ${rec.id}'s project or uploads`,
            code: "not_found",
          },
          404,
        );
        return true;
      }
      const size = fs.statSync(file).size;
      audit(`${rec.id}: ${file} (${size} bytes)`);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": attachmentHeader(file),
        "Content-Length": String(size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (method === "HEAD") {
        res.end();
        return true;
      }
      const stream = fs.createReadStream(file);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
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
    // D59: an agent could keep itself running across every restart.
    if (verb === "settings" && (agent || actor))
      throw new AgentError("only a person can change an agent's settings", {
        status: 403,
      });
    // D44: a restart is the person's (it stops a session).
    if (verb === "restart" && (agent || actor))
      throw new AgentError("only a person can restart an agent", {
        status: 403,
      });
    // D72: an agent could move itself out of its scope.
    if (verb === "move" && (agent || actor))
      throw new AgentError("only a person can move an agent", {
        status: 403,
      });
    // D65: what an agent is listed under is the person's call.
    if (verb === "link" && (agent || actor))
      throw new AgentError("only a person can link an agent to a repo", {
        status: 403,
      });
    // D34: clearing what a person sees is a person's.
    if (verb === "clear-helpers" && (agent || actor))
      throw new AgentError("only a person can clear an agent's helpers", {
        status: 403,
      });
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
        ...(body.repo !== undefined ? { repo: body.repo } : {}),
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
    } else if (verb === "settings") {
      const body = await jsonBody(req);
      for (const k of Object.keys(body))
        if (k !== "resumeOnRestart")
          throw new AgentError(
            `${k}: unknown field (settings takes resumeOnRestart)`,
            { usage: true },
          );
      const v = body.resumeOnRestart;
      if (v !== null && typeof v !== "boolean")
        throw new AgentError(
          "resumeOnRestart must be true, false or null (its persona's)",
          { usage: true },
        );
      const rec = setAgentResumeOnRestart(d, id!, ws, v);
      what = `set ${rec.id}'s resume after a restart to ${v === null ? "its persona's" : v ? "on" : "off"} in ${ws}`;
      audit(what);
      sendJson(res, { ok: true, agent: rec.id, resumeOnRestart: v });
    } else if (verb === "clear-helpers") {
      const body = await jsonBody(req);
      for (const k of Object.keys(body))
        throw new AgentError(`${k}: unknown field (clear-helpers takes none)`, {
          usage: true,
        });
      const r = clearAgentHelpers(d, id!, ws);
      what = `clear ${r.rec.id}'s finished helpers in ${ws}`;
      audit(what);
      sendJson(res, { ok: true, agent: r.rec.id, clearedAt: r.clearedAt });
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
    } else if (verb === "link") {
      // D65 v2: the repo of its project it works on. Body {repo: <name>|null}.
      const body = await jsonBody(req);
      for (const k of Object.keys(body))
        if (k !== "repo")
          throw new AgentError(`${k}: unknown field (link takes repo)`, {
            usage: true,
          });
      if (body.repo === undefined)
        throw new AgentError(
          "repo is required (a repo's name, or null for none)",
          {
            usage: true,
          },
        );
      const repo =
        body.repo === null || body.repo === ""
          ? null
          : checkRepoName(body.repo);
      if (repo && !workspaceRepoFolders(d, ws).has(repo))
        throw new AgentError(`project ${ws} has no repo "${repo}"`, {
          status: 404,
        });
      const rec = setAgentRepo(d, id!, ws, repo);
      what = `link ${rec.id} in ${ws}: ${rec.repo ?? "no repo"}`;
      audit(what);
      sendJson(res, {
        ok: true,
        agent: rec.id,
        project: rec.project,
        repo: rec.repo ?? null,
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
    } else if (verb === "restart") {
      const body = await jsonBody(req);
      for (const k of Object.keys(body))
        if (k !== "when")
          throw new AgentError(`${k}: unknown field (restart takes when)`, {
            usage: true,
          });
      const when = body.when ?? "after-turn";
      if (when !== "now" && when !== "after-turn")
        throw new AgentError("when must be now or after-turn", {
          usage: true,
        });
      what = `restart ${id} in ${ws} (${when === "now" ? "now" : "at its next idle"}), same conversation`;
      if (when === "after-turn") {
        // It may wait for a long turn: answer now, audit when it's done.
        void restartAgent(
          d,
          id!,
          ws,
          "after-turn",
          deps.personaWait ?? {},
        ).then(
          (s) => audit(what, s.early ? "exited at once" : undefined),
          (e: unknown) =>
            audit(what, e instanceof Error ? e.message : String(e)),
        );
        sendJson(res, { ok: true, agent: id, pending: true }, 202);
        return true;
      }
      const s = await restartAgent(d, id!, ws, "now");
      audit(what, s.early ? "exited at once" : undefined);
      sendStarted(res, s, d, s.fresh ? { note: FRESH_NOTE } : {});
    } else if (verb === "move") {
      // D72: {to, when}: to another workspace, same conversation.
      const body = await jsonBody(req);
      for (const k of Object.keys(body))
        if (k !== "to" && k !== "when")
          throw new AgentError(`${k}: unknown field (move takes to, when)`, {
            usage: true,
          });
      if (typeof body.to !== "string" || !body.to.trim())
        throw new AgentError("to is required (the project to move it to)", {
          usage: true,
        });
      const to = resolveWorkspaceInput(body.to.trim());
      const when = body.when ?? "after-turn";
      if (when !== "now" && when !== "after-turn")
        throw new AgentError("when must be now or after-turn", {
          usage: true,
        });
      what = `move ${id} from ${ws} to ${to} (${when === "now" ? "now" : "at its next idle"}), same conversation`;
      const go = () => moveAgent(d, id!, ws, to, when, deps.personaWait ?? {});
      if (when === "after-turn") {
        // Checks first, so a bad move answers now; then it may wait.
        if (!d.workspaceExists(to))
          throw new AgentError(`there is no project "${to}"`, {
            status: 404,
          });
        void go().then(
          (m) => audit(what, m.resumed?.early ? "exited at once" : undefined),
          (e: unknown) =>
            audit(what, e instanceof Error ? e.message : String(e)),
        );
        sendJson(res, { ok: true, agent: id, to, pending: true }, 202);
        return true;
      }
      const m = await go();
      audit(what, m.resumed?.early ? "exited at once" : undefined);
      sendJson(res, {
        ok: true,
        agent: m.rec.id,
        from: m.from,
        to,
        ...(m.resumed ? { resumed: true } : {}),
      });
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

const IMPORT_KEYS = ["persona", "runtime", "id", "model", "version", "outside"];
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
      const { outside, ...listed } = listConversations(d, ws, runtime);
      // D56: those started outside every project are a person's to bring
      // in, never an agent's to see.
      sendJson(res, {
        workspace: ws,
        folder: d.workspaceDir(ws),
        ...listed,
        ...(agent ? {} : { outside }),
      });
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
    // D56: the folder it started in, outside the project: a person's ask.
    const out = body.outside;
    if (out !== undefined && out !== null && out !== "") {
      if (typeof out !== "string" || !path.isAbsolute(out) || out.length > 4096)
        throw new AgentError("outside must be the folder's full path", {
          usage: true,
        });
      if (agent)
        throw new AgentError(
          "only a person can bring in a conversation from outside the project",
          { status: 403 },
        );
    }
    const outside = typeof out === "string" && out ? out : undefined;
    const s = await importAgent(d, {
      workspace: ws,
      session,
      persona,
      runtime: str("runtime"),
      id: str("id"),
      ...(str("model") !== undefined ? { model: str("model") } : {}),
      ...(str("version") !== undefined ? { version: str("version") } : {}),
      ...(outside ? { outside } : {}),
    });
    what = `bring in ${session} as ${s.rec.id} (${s.rec.persona}, ${s.rec.runtime}) in ${ws}${outside ? `, from outside the project (${outside})` : ""}`;
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
        throw new AgentError(`project "${w}" does not exist`, {
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
    throw new AgentError(`project "${ws}" does not exist`, { status: 404 });
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
    // D65 v2: once, agents from before the link get it from their folder.
    try {
      const m = migrateAgentLinks(d);
      if (m.linked.length || m.unlinked.length)
        log(
          `Agents linked to their project: ${[...m.linked, ...m.unlinked].join(", ")}` +
            (m.unlinked.length
              ? ` · on no one repo: ${m.unlinked.join(", ")} (agents doctor)`
              : ""),
        );
    } catch (e) {
      log(`  ⚠ agent links: ${(e as Error).message}`);
    }
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

let defaultConnect: import("./hub-connect.js").HubConnect | null = null;

/** HUB-1.7: start a connect, finish it (Hub's redirect), or disconnect. */
async function hubConnectRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: AgentRouteDeps,
): Promise<true> {
  const m = await import("./hub-connect.js");
  const hc = deps.hubConnect ?? (defaultConnect ??= new m.HubConnect());
  res.setHeader("Cache-Control", "no-store");
  const method = req.method ?? "GET";
  if (pathname === "/hub/callback") {
    if (method !== "GET") return methodNotAllowed(res, "GET");
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const r = await hc.finish(q);
    // H5: a new connection gets the full project list at once.
    if (r.ok) {
      const sync =
        deps.projectSync ??
        (await import("./hub-sync-service.js")).projectSync();
      sync.request();
      // 0.4.40: comments reach agents over the new connection.
      const dl = deps.hubDeliveries ?? (await deliveriesService());
      dl.restart();
    }
    res.writeHead(r.ok ? 200 : 400, {
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    res.end(
      m.callbackPage(product().title, {
        ok: r.ok,
        ...(r.ok ? {} : { reason: r.reason }),
        message: r.ok
          ? `Connected to Hub${r.team ? ` (${r.team})` : ""}. Going back to Settings…`
          : r.message,
      }),
    );
    return true;
  }
  if (method !== "POST") return methodNotAllowed(res, "POST");
  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    body = raw ? ((JSON.parse(raw) as Record<string, unknown>) ?? {}) : {};
  } catch {
    sendJson(res, { ok: false, error: "the body must be JSON" }, 400);
    return true;
  }
  if (pathname === "/api/hub/connect") {
    // The browser's Origin (request-guard checked it is this Den's).
    const origin = String(req.headers.origin ?? "");
    if (!origin) {
      sendJson(
        res,
        {
          ok: false,
          error: "Connect from Settings › Agents › Hub in a browser",
        },
        400,
      );
      return true;
    }
    const r = hc.start(origin, body.url);
    sendJson(res, r, r.ok ? 200 : 400);
    return true;
  }
  const r = await hc.disconnect(body.force === true);
  if (r.ok) (deps.hubDeliveries ?? (await deliveriesService())).stop();
  sendJson(res, r, r.ok ? 200 : 502);
  return true;
}

/**
 * D45: GET .../agents/:id/details: what agent :id was last asked and how
 * its session ended (agentDetails). Read-only.
 */
async function detailsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dp: RegExpExecArray,
  d: AgentsResolved,
): Promise<true> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD")
    return methodNotAllowed(res, "GET");
  const ws = safeDecode(dp[1]);
  const id = safeDecode(dp[2]);
  try {
    if (!d.workspaceExists(ws))
      throw new AgentError(`project "${ws}" does not exist`, { status: 404 });
    sendJson(res, await agentDetails(d, id, ws));
  } catch (e) {
    sendError(res, e, ws);
  }
  return true;
}

/**
 * D44: GET .../agents/:id/tools: whether agent :id's MCP servers are
 * current. Hub `connected` (it would get Hub now), `loaded` (its running
 * session has Hub's tools), and `restart` (a restart brings them in line).
 * Read-only; an agent may read its own (its MCP's whoami).
 */
async function toolsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tp: RegExpExecArray,
  d: AgentsResolved,
): Promise<true> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD")
    return methodNotAllowed(res, "GET");
  const ws = safeDecode(tp[1]);
  const id = safeDecode(tp[2]);
  try {
    if (!d.workspaceExists(ws))
      throw new AgentError(`project "${ws}" does not exist`, { status: 404 });
    sendJson(res, await agentTools(d, id, ws));
  } catch (e) {
    sendError(res, e, ws);
  }
  return true;
}

/**
 * D44: GET /api/agents/stale: the running agents whose MCP servers are out
 * of date (`?fresh=1` asks Hub's config again, after Connect or
 * Disconnect). POST /api/agents/restart-stale: restarts each at its next
 * idle, same conversation; a person's only, audited.
 */
async function staleRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: AgentsResolved,
  deps: AgentRouteDeps,
): Promise<true> {
  const method = req.method ?? "GET";
  const post = pathname === "/api/agents/restart-stale";
  if (post ? method !== "POST" : method !== "GET" && method !== "HEAD")
    return methodNotAllowed(res, post ? "POST" : "GET");
  const fresh =
    new URL(req.url ?? "/", "http://localhost").searchParams.get("fresh") ===
    "1";
  if (!post) {
    try {
      sendJson(res, { agents: await staleAgents(d, { fresh }) });
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  const actor = auditActorOf(req);
  let what = "restart agents with out-of-date tools at their next idle";
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
  try {
    if (agentPrincipalOf(req) || actor)
      throw new AgentError("only a person can restart agents", {
        status: 403,
      });
    guard(actor);
    const body = await jsonBody(req);
    for (const k of Object.keys(body))
      throw new AgentError(`${k}: unknown field (restart-stale takes none)`, {
        usage: true,
      });
    const list = await staleAgents(d, { fresh: true });
    what = `${what}: ${list.map((a) => `${a.id} (${a.workspace})`).join(", ") || "none"}`;
    audit(what);
    for (const a of list) {
      const one = `restart ${a.id} in ${a.workspace} (at its next idle), same conversation, for its tools`;
      void restartAgent(
        d,
        a.id,
        a.workspace,
        "after-turn",
        deps.personaWait ?? {},
      ).then(
        (s) => audit(one, s.early ? "exited at once" : undefined),
        (e: unknown) => audit(one, e instanceof Error ? e.message : String(e)),
      );
    }
    sendJson(res, { ok: true, pending: list }, 202);
  } catch (e) {
    audit(what, e instanceof Error ? e.message : String(e));
    sendError(res, e);
  }
  return true;
}

/**
 * D32: GET .../agents/:id/helpers: the helpers agent :id started in its
 * own session (D34: less those "Clear done" hid; ?all=1 lists them as
 * `cleared`); .../helpers/:helper: one helper's transcript (?limit=).
 * Read-only: nothing here stops or steers a helper.
 */
async function helpersRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hp: RegExpExecArray,
  d: AgentsResolved,
): Promise<true> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD")
    return methodNotAllowed(res, "GET");
  const ws = safeDecode(hp[1]);
  const id = safeDecode(hp[2]);
  const helper = hp[3] === undefined ? undefined : safeDecode(hp[3]);
  try {
    if (!d.workspaceExists(ws))
      throw new AgentError(`project "${ws}" does not exist`, { status: 404 });
    if (helper === undefined) {
      const r = await agentHelpers(d, id, ws);
      // D34: those "Clear done" hid are a count; ?all=1 lists them too.
      const all =
        new URL(req.url ?? "/", "http://localhost").searchParams.get("all") ===
        "1";
      sendJson(res, {
        agent: r.rec.id,
        workspace: ws,
        supported: r.supported,
        live: r.live,
        helpers: r.helpers,
        clearedCount: r.cleared.length,
        ...(r.clearedAt !== undefined ? { clearedAt: r.clearedAt } : {}),
        ...(all ? { cleared: r.cleared } : {}),
        note: r.note,
      });
      return true;
    }
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const limit = Number(q.get("limit") ?? "") || undefined;
    sendJson(res, await agentHelperTranscript(d, id, helper, ws, limit));
  } catch (e) {
    sendError(res, e, ws);
  }
  return true;
}

/** den#48: `{ workspacePermission }` when the workspace sets a good one. */
function workspacePermissionField(
  d: AgentsResolved,
  ws: string,
): { workspacePermission?: string } {
  try {
    const p = workspacePermissionOf(d, ws);
    return p ? { workspacePermission: p } : {};
  } catch {
    return {}; // a bad value: the start says so
  }
}

/** The agent's session's uploads folder, when it has one. */
function agentUploads(d: AgentsResolved, rec: AgentRecord): string | null {
  const sid = rec.session?.id;
  if (!sid || !UPLOAD_SESSION_RE.test(sid)) return null;
  let set = UPLOAD_DEFAULTS;
  try {
    set = readAgentsConfig().uploads ?? UPLOAD_DEFAULTS;
  } catch {
    /* the defaults */
  }
  return path.join(uploadsRoot(set, d.stateDir()), sid);
}

/** What its paths may never reach (agent-paths.ts PathFence). */
function agentFence(d: AgentsResolved, rec: AgentRecord): PathFence {
  const up = agentUploads(d, rec);
  let deny: readonly string[] = FILE_DENY_DEFAULTS;
  try {
    deny = readAgentsConfig().files?.deny ?? FILE_DENY_DEFAULTS;
  } catch {
    /* the defaults */
  }
  return {
    home: d.env.HOME || os.homedir(),
    stateDir: d.stateDir(),
    ...(up ? { uploads: up } : {}),
    deny,
  };
}

/** D56 item 4: whether `dir` is the home folder, or holds a project's folder. */
function holdsProjects(d: AgentsResolved, dir: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const at = real(dir);
  const home = d.env.HOME || os.homedir();
  if (home && at === real(home)) return true;
  const under = (p: string) => {
    const rel = path.relative(at, real(p));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  for (const ws of d.workspaceNames())
    try {
      if (d.workspaceFolders(ws).under.some(under)) return true;
    } catch {
      /* a workspace that can't say */
    }
  return false;
}

/**
 * The folders an agent's paths may point into (AG-4b, AG-DROP-2): its
 * workspace's, its own cwd, and its session's uploads folder.
 */
function agentRoots(d: AgentsResolved, rec: AgentRecord, ws: string): string[] {
  const roots: string[] = [];
  try {
    roots.push(d.workspaceDir(ws));
  } catch {
    /* no folder */
  }
  // D56 item 4: ~, or a folder holding projects, is never a file root:
  // an agent started there reaches its project's files only.
  if (!holdsProjects(d, rec.cwd)) roots.push(rec.cwd);
  const up = agentUploads(d, rec);
  if (up) roots.push(up);
  return roots.filter(Boolean);
}
