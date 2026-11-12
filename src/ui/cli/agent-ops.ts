/**
 * What an agent operation does (AG-2a, AG spec §5c), once, for both of its
 * fronts: `<cli> agents` (agents-command.ts) and the Workspaces page's
 * Agents section (server/agent-routes.ts, AG-4a). Neither front keeps state
 * of its own: the agent record (shared/agents/records.ts) and the session
 * host are the whole of it. Nothing here prints: each operation returns
 * what happened, or throws an AgentError saying why it didn't.
 *
 *   start   resolves the persona (Den's default pack, then
 *           agents.persona_packs) and the runtime (its CLI from
 *           agents.runtimes.<id>.bin in user.yml, else the search:
 *           runtime-search.ts, AG-0.1; unavailable, it is refused with the
 *           fix), asks the runtime for argv,
 *           env and files (its MCP config: `<cli> mcp --workspace <ws>
 *           --actor agent:<id>`, plus a `--grant` per agents.<id>.grants),
 *           starts `<dist>-<ws>:<id>` in the workspace's dir, and writes the
 *           agent record (<stateDir>/agents/<id>.json, 0600; no env, no argv).
 *           SEC-1c: it mints the agent's actor token (den_at_…, its hash in
 *           <stateDir>/actor-tokens.json) and hands it to the session as
 *           DEN_ACTOR_TOKEN; any earlier token of the agent stops working.
 *           The agent's env is an allowlist plus what its runtime declares,
 *           less every runtime's scrubEnv (sessions/env.ts), never the
 *           caller's whole environment; no --keep-env. A session that exits
 *           non-zero in its first moments (exitWatchMs) is returned as an
 *           early exit with its last lines.
 *   list    the workspace's agents (sessions with an agent record), with
 *           persona, runtime and model; a record whose session is gone is
 *           listed as stopped or ended. A plain session is not an agent.
 *   stop    ends its session (TERM), marks the record stopped and revokes
 *           its actor token.
 *   resume  only when its runtime declares resume, the record has its
 *           resume token, and its session is not running: a new session,
 *           in the same cwd and workspace with the grants it had (never
 *           more than the config still gives), continuing the last run with
 *           the runtime's own resume (den-claude: `--resume <token>`);
 *           when that session was never prompted, a fresh start under the
 *           same conversation id (there is nothing to continue). A fresh
 *           actor token; the old one stops working.
 *   fresh   (AG-14) a new conversation with the same persona, runtime,
 *           model and workspace, under the same id.
 *   remove  (AG-14.1b) forgets a stopped, interrupted or exited agent: its
 *           record moves aside for Undo (restore). Never a running one.
 *           The runtime's own history stays.
 *   interrupted (AG-14.3) an agent whose session is gone though nobody
 *           stopped it and it never exited: Den or the machine went down.
 *           markInterrupted stamps them when the web server starts, and
 *           resumes the standing personas and those with
 *           `resume_on_restart: true`.
 *
 * Nothing here takes a grant: grants come from the org config only. The
 * host enforces agents.max_concurrent on every start, counting agents only.
 */
import { readWebPort } from "../../shared/edge/config.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { writeApiOnlyRules } from "../../shared/agents/api-only.js";
import {
  INHERIT,
  SUBAGENT_DEFAULTS,
  effectiveSubagentModel,
  orgModelFrom,
  type SubagentModelFrom,
} from "../../shared/agents/subagents.js";
import {
  capHelpers,
  HELPER_DEFAULTS,
  HELPERS_READ_ONLY_NOTE,
  type Helper,
  type HelperSettings,
  type HelperTranscript,
} from "../../shared/agents/helpers.js";
import {
  isEnded,
  readClearedAt,
  splitCleared,
  writeClearedAt,
} from "../../shared/agents/helpers-cleared.js";
import * as fs from "fs";
import * as path from "path";
import {
  AGENTS_RESERVED_KEYS,
  configuredRuntimeBin,
  configuredRuntimeCatalog,
  readAgentsConfig,
  setUserRuntimeBin,
  userConfigPath,
  type ResolvedAgentsConfig,
} from "../../shared/den-config.js";
import {
  setWorkspaceRuntimeBin,
  workspaceBinKey,
  workspaceRuntimeBin,
  workspaceAgentPermission,
  setWorkspaceAgentPermission,
  workspacePermissionKey,
} from "../../shared/environment-manager/workspaces.js";
import {
  BUILTIN_CATALOG,
  type CatalogEntry,
} from "../../shared/agents/catalog.js";
import { checkRuntimeBin } from "../../shared/agents/catalog-runtime.js";
import {
  agentSessionName,
  peerSessionName,
} from "../../shared/agents/session-name.js";
import { cliEntrypoint } from "../../shared/engine.js";
import { getDistRoot } from "../../shared/paths.js";
import { envKey } from "../../shared/product.js";
import { redactSecrets } from "../../shared/redact.js";
import {
  loadPersonas,
  serverPersona,
  resolvePackDirs,
  type Persona,
} from "../../shared/agents/personas.js";
import {
  checkModelChoice,
  checkPersonaInput,
  deleteLocalPersona,
  localPersonaExists,
  localPersonasDir,
  newPersonaId,
  PersonaInputError,
  writeLocalPersona,
  type PersonaInput,
} from "../../shared/agents/persona-store.js";
import {
  categoryRegistry,
  roleRegistry,
  rolePreset,
  type Category,
  type RoleTemplate,
} from "../../shared/agents/roles.js";
import {
  checkCommands,
  checkIntent,
  intentOf,
  type PermissionIntent,
} from "../../shared/agents/permissions.js";
import { softNewlineSeq } from "../../shared/agents/catalog.js";
import {
  AGENT_ID_RE,
  agentFilesDir,
  listRecords,
  purgeRemoved,
  readRecord,
  removeRecord,
  restoreRecord,
  writeRecord,
  checkDisplayName,
  nameSlug,
  writeRuntimeFiles,
  type AgentRecord,
  type Override,
} from "../../shared/agents/records.js";
import {
  agentSessionEnv,
  DEFAULT_RUNTIME_ID,
  getRuntime,
  LaunchError,
  runtimeIds,
  syncConfiguredRuntimes,
  type AgentMcp,
  type LaunchInput,
  type LaunchOutput,
  type Runtime,
} from "../../shared/agents/runtimes.js";
import type {
  RuntimeDetect,
  RuntimeModel,
  RuntimePermissions,
} from "../../shared/agents/runtime.js";
import {
  inScope,
  OPEN_ELSEWHERE_MESSAGE,
  openElsewhere,
  type RuntimeConversation,
} from "../../shared/agents/conversations.js";
import {
  OVERRIDE_SCOPES,
  readRotateFile,
  resolveRotate,
  ROTATE_DEFAULTS,
  setRotateValue,
  sourceText,
  type OrgRotate,
  type OverrideScope,
  type RotateFile,
  type RotateValues,
} from "../../shared/agents/rotate-settings.js";
import {
  archiveHandoff,
  keepConversation,
  noteAsked,
  noteFellBack,
  rotationInstruction,
  syncAfter,
  handoffFile,
  handoffPrompt,
  launchRotation,
  readHandoff,
  readRotation,
  writeRotation,
  reasonText,
  rotationInfo,
  type RotationEntry,
  type RotationInfo,
  type RotationPolicy,
} from "../../shared/agents/rotation.js";
import {
  binSettingKey,
  ensureInteractivePath,
  interactivePathAsked,
  runtimeVersion,
  type BinSetting,
  type BinSource,
} from "../../shared/agents/runtime-search.js";
import { WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";
import {
  SERVER_PERSONA_ID,
  isServerScope,
  serverAgentDir,
} from "../../shared/agents/server-agent.js";
import {
  bindActorSession,
  mintActorToken,
  ACTOR_TOKEN_ENV,
  revokeActorToken,
  revokeAgentTokens,
} from "../../shared/actor-token.js";
import { HostError, type HostClient } from "../../shared/sessions/client.js";
import { DEN_PTY_ID } from "../../shared/sessions/den-pty.js";
import { inWorkspace, sessionName } from "../../shared/sessions/names.js";
import type { SessionInfo } from "../../shared/sessions/types.js";
import { serverSpec } from "../mcp/connect.js";
import { HUB_SERVER } from "../../shared/hub.js";
import {
  contractInfo,
  loadWorkspaces,
  resolveDeps,
  state,
  withClient,
  type Resolved,
  type SessionsDeps,
} from "./sessions-command.js";

export interface AgentsDeps extends SessionsDeps {
  agentsConfig?: () => ResolvedAgentsConfig;
  distRoot?: () => string;
  /** A workspace's checkout directory: where its agents run. */
  workspaceDir?: (ws: string) => string;
  /**
   * AG-17.1: the folders a workspace's conversations may have run in: its
   * own folder, and each repo's path, a repo added by path outside it too.
   */
  workspaceFolders?: (ws: string) => { under: string[]; exact?: string[] };
  /** The MCP server binary and its env; Den adds the scoped args. */
  mcpServer?: () => { command: string[] | string; env: Record<string, string> };
  /**
   * How long start and resume watch a new session for an early non-zero
   * exit (default 3000 ms; 0: not at all).
   */
  exitWatchMs?: number;
  /**
   * How long stop waits for the session to end after TERM (default
   * 5000 ms; 0: it doesn't wait, as `--no-wait`).
   */
  stopWaitMs?: number;
  /** `agents.runtimes.<id>.bin` (default: user.yml's; undefined: unset). */
  runtimeBin?: (id: string) => unknown;
  /**
   * Workspace `ws`'s `agents.runtimes.<id>.bin` (default: workspaces.yml's;
   * undefined: unset). It wins over runtimeBin (AG-0.5).
   */
  workspaceRuntimeBin?: (ws: string, id: string) => unknown;
  /**
   * den#48: workspace `ws`'s `agents.permission` (default: workspaces.yml's;
   * undefined: unset), as written.
   */
  workspacePermission?: (ws: string) => unknown;
  /** den#48: save a checked intent as workspace `ws`'s (null clears it). */
  saveWorkspacePermission?: (
    ws: string,
    intent: PermissionIntent | null,
  ) => void;
  /** user.yml's runtime catalog entries, checked (default: user.yml's). */
  userCatalog?: (taken: readonly string[]) => CatalogEntry[];
  /** Save a checked path (null clears it): global or the workspace's. */
  saveRuntimeBin?: (
    scope: "global" | "workspace",
    ws: string | undefined,
    id: string,
    bin: string | null,
  ) => void;
  /** The user.yml a person edits to set it (default: config/local/user.yml). */
  userConfigFile?: () => string;
  /** D28: workspace `ws`'s services and their folders (the service scope). */
  workspaceServices?: (ws: string) => { address: string; path: string }[];
  /**
   * HUB-1.5: Den Hub's URL and this install's token (from its own store),
   * or null when hub.url isn't set or the token can't be read (default:
   * hub.* and the install's secrets backend).
   */
  hub?: () => Promise<{
    url: string;
    token: string;
    allowTools?: boolean;
    /** HUB-1.7: Hub's MCP endpoint (default <url>/mcp). */
    mcpUrl?: string;
    /** D41: hub.inbox_on_stop (default nudge). */
    inboxOnStop?: "nudge" | "off";
  } | null>;
  /** HUB-1.5: workspace `ws`'s repos as owner/repo (X-Den-Repos). */
  workspaceRepos?: (ws: string) => string[];
  /**
   * D52: Den's web server as an agent reaches it (http://localhost:<port>):
   * its Hub calls go through Den's proxy there.
   */
  denBase?: () => string;
}

export interface AgentsResolved extends Resolved {
  agentsConfig: () => ResolvedAgentsConfig;
  distRoot: () => string;
  workspaceDir: (ws: string) => string;
  workspaceFolders: (ws: string) => { under: string[]; exact?: string[] };
  mcpServer: () => { command: string[] | string; env: Record<string, string> };
  exitWatchMs: number;
  stopWaitMs: number;
  runtimeBin: (id: string) => unknown;
  workspaceRuntimeBin: (ws: string, id: string) => unknown;
  workspacePermission: (ws: string) => unknown;
  saveWorkspacePermission: (
    ws: string,
    intent: PermissionIntent | null,
  ) => void;
  userCatalog: (taken: readonly string[]) => CatalogEntry[];
  saveRuntimeBin: NonNullable<AgentsDeps["saveRuntimeBin"]>;
  userConfigFile: () => string;
  workspaceServices: (ws: string) => { address: string; path: string }[];
  hub: () => Promise<{
    url: string;
    token: string;
    allowTools?: boolean;
    mcpUrl?: string;
    inboxOnStop?: "nudge" | "off";
  } | null>;
  workspaceRepos: (ws: string) => string[];
  denBase: () => string;
}

/** The early-exit watch: at most this long, polling the host. */
export const EXIT_WATCH_MS = 3000;
const EXIT_POLL_MS = 100;
/** Stop waits at most this long for the session to end (0.4.8). */
export const STOP_WAIT_MS = 5000;
/** The most lines of an early exit's scrollback returned. */
const EXIT_TAIL_LINES = 10;

/**
 * Why an operation didn't happen. `usage` marks a request that was wrong
 * as asked (the CLI exits 2 with its usage line; others exit 1); `status`
 * is the HTTP answer the page gets, `code` its R26 code when the status's
 * own is not specific enough.
 */
export class AgentError extends Error {
  readonly status: number;
  readonly usage: boolean;
  readonly code?: string;
  readonly hints: string[];
  /** AG-10.10: the running agent a start collided with, so a page can open it. */
  readonly running?: { id: string; sessionId: string };
  constructor(
    message: string,
    o: {
      status?: number;
      usage?: boolean;
      code?: string;
      hints?: string[];
      running?: { id: string; sessionId: string };
    } = {},
  ) {
    super(message);
    this.name = "AgentError";
    this.status = o.status ?? (o.usage ? 400 : 409);
    this.usage = o.usage ?? false;
    this.code = o.code;
    this.hints = o.hints ?? [];
    if (o.running) this.running = o.running;
  }
}

/** A request that was wrong as asked (CLI exit 2; HTTP 400 unless given). */
const usage = (message: string, status = 400) =>
  new AgentError(message, { usage: true, status });
/** A refusal (CLI exit 1; HTTP 409 unless given). */
const refused = (message: string, hints: string[] = [], status = 409) =>
  new AgentError(message, { status, hints });

let workspaceDirFn: ((ws: string) => string) | null = null;
let servicesFn: ((ws: string) => { address: string; path: string }[]) | null =
  null;
let foldersFn: ((ws: string) => { under: string[]; exact?: string[] }) | null =
  null;
let reposFn: ((ws: string) => string[]) | null = null;
/** The workspaces config, for start and resume (loaded on first use). */
export async function loadAgentWorkspaces(d: AgentsDeps): Promise<void> {
  await loadWorkspaces(d);
  if (d.workspaceDir || workspaceDirFn) return;
  const ws = await import("../../shared/environment-manager/workspaces.js");
  const { getReposRoot } = await import("../../shared/den-config.js");
  workspaceDirFn = (name) => {
    const cfg = ws.readWorkspacesFile().workspaces[name];
    if (!cfg) throw usage(`workspace "${name}" does not exist`, 404);
    return ws.resolveWorkspaceDir(name, cfg, getReposRoot());
  };
  // A by-path repo's own folder (repo add <path>), wherever it is.
  foldersFn = (name) => {
    const cfg = ws.readWorkspacesFile().workspaces[name];
    if (!cfg) throw usage(`workspace "${name}" does not exist`, 404);
    return ws.conversationFolders(name, cfg, getReposRoot());
  };
  const { readCatalog } =
    await import("../../shared/environment-manager/catalog.js");
  servicesFn = (name) => {
    const cfg = ws.readWorkspacesFile().workspaces[name];
    if (!cfg) return [];
    return ws
      .listWorkspaceServices(cfg, readCatalog(), name)
      .map((r) => ({ address: r.address, path: r.repoPath }));
  };
  const { ownerRepo } = await import("../../shared/hub.js");
  reposFn = (name) => {
    const cfg = ws.readWorkspacesFile().workspaces[name];
    if (!cfg) return [];
    const cat = readCatalog();
    const out: string[] = [];
    for (const r of ws.listWorkspaceServices(cfg, cat, name)) {
      const slug = ownerRepo(cat[r.repoName]);
      if (slug && !out.includes(slug)) out.push(slug);
    }
    return out;
  };
}

/**
 * HUB-1.5: Den Hub's MCP server for an agent, when hub.url is set and its
 * token is readable. D52: through Den's proxy, with the agent's own Den
 * token; the proxy says who calls (its name and id, its session, the
 * workspace and its repos) from Den's records (hubUpstream).
 */
export async function agentHub(
  d: AgentsResolved,
): Promise<AgentMcp["hub"] | undefined> {
  const h = await d.hub().catch(() => null);
  if (!h) return undefined;
  const proxy = denHubProxy(d);
  return {
    name: HUB_SERVER,
    url: `${proxy}/mcp`,
    allowTools: h.allowTools !== false,
    // D41: the Stop hook's inbox check, through Den's proxy too.
    ...(h.inboxOnStop !== "off" ? { inboxBase: proxy } : {}),
    // D52: the agent's own Den token (Claude Code expands it from the
    // session's env). Den's proxy swaps it for the install's Hub token
    // and says who is calling; the Hub token is never in the agent's files.
    headers: { Authorization: `Bearer \${${ACTOR_TOKEN_ENV}}` },
  };
}

/** D52: Den's proxy to Hub, as an agent reaches it. */
export function denHubProxy(d: Pick<AgentsResolved, "denBase">): string {
  return `${d.denBase().replace(/\/+$/, "")}/hub`;
}

/** Den's web server on this machine (the MCP server's own rule). */
function defaultDenBase(): string {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  return `http://localhost:${port}`;
}

/**
 * D52: Hub as Den's proxy calls it for agent `agentId` (its actor token
 * proved it): Hub's base URL, its MCP endpoint, and the headers Den sets
 * from its own records. The install token is among them; it never leaves
 * Den's server. Null when Hub isn't set up or its token can't be read.
 */
export async function hubUpstream(
  d: AgentsResolved,
  who: { agentId: string; workspace: string; session: string },
): Promise<{
  base: string;
  mcpUrl: string;
  headers: Record<string, string>;
} | null> {
  const h = await d.hub().catch(() => null);
  if (!h) return null;
  const { hubHeaders } = await import("../../shared/hub.js");
  let repos: string[] = [];
  try {
    repos = d.workspaceRepos(who.workspace);
  } catch {
    repos = [];
  }
  let name = who.agentId;
  try {
    name = readRecord(d.stateDir(), who.agentId)?.displayName || name;
  } catch {
    /* the id names it */
  }
  return {
    base: h.url,
    mcpUrl: h.mcpUrl || `${h.url}/mcp`,
    headers: hubHeaders(h.token, {
      agent: name,
      agentId: who.agentId,
      session: who.session,
      workspace: who.workspace,
      repos,
    }),
  };
}

/** The distribution's bin shim (as `mcp connect` registers), else Den's CLI. */
function defaultMcpServer(cli: string): {
  command: string[];
  env: Record<string, string>;
} {
  const s = serverSpec({
    cli,
    distRoot: getDistRoot(),
    nodeBinDir: path.dirname(process.execPath),
    platform: process.platform,
  });
  if (fs.existsSync(s.command)) return { command: [s.command], env: s.env };
  const e = cliEntrypoint();
  return { command: [e.command, ...e.args], env: s.env };
}

export function resolveAgentsDeps(d: AgentsDeps): AgentsResolved {
  const base = resolveDeps(d);
  return withServerScope({
    ...base,
    agentsConfig: d.agentsConfig ?? (() => readAgentsConfig()),
    distRoot: d.distRoot ?? getDistRoot,
    workspaceDir:
      d.workspaceDir ??
      ((ws) => {
        if (!workspaceDirFn) throw new Error("workspaces not loaded");
        return workspaceDirFn(ws);
      }),
    workspaceFolders:
      d.workspaceFolders ??
      ((ws) => {
        // A caller that gives its own folder (a test) gives just it.
        if (d.workspaceDir) return { under: [d.workspaceDir(ws)] };
        if (!foldersFn) throw new Error("workspaces not loaded");
        return foldersFn(ws);
      }),
    mcpServer: d.mcpServer ?? (() => defaultMcpServer(base.cli)),
    exitWatchMs: d.exitWatchMs ?? EXIT_WATCH_MS,
    stopWaitMs: d.stopWaitMs ?? STOP_WAIT_MS,
    runtimeBin: d.runtimeBin ?? ((id) => configuredRuntimeBin(id)),
    workspaceRuntimeBin:
      d.workspaceRuntimeBin ?? ((ws, id) => workspaceRuntimeBin(ws, id)),
    workspacePermission:
      d.workspacePermission ?? ((ws) => workspaceAgentPermission(ws)),
    saveWorkspacePermission:
      d.saveWorkspacePermission ??
      ((ws, intent) => setWorkspaceAgentPermission(ws, intent)),
    userCatalog: d.userCatalog ?? ((taken) => configuredRuntimeCatalog(taken)),
    saveRuntimeBin:
      d.saveRuntimeBin ??
      ((scope, ws, id, bin) =>
        scope === "workspace" && ws
          ? setWorkspaceRuntimeBin(ws, id, bin)
          : setUserRuntimeBin(id, bin)),
    userConfigFile: d.userConfigFile ?? userConfigPath,
    workspaceServices:
      d.workspaceServices ?? ((ws) => (servicesFn ? servicesFn(ws) : [])),
    hub: d.hub ?? defaultHub,
    workspaceRepos: d.workspaceRepos ?? ((ws) => (reposFn ? reposFn(ws) : [])),
    denBase: d.denBase ?? defaultDenBase,
  });
}

/** HUB-1.5: hub.* and the token from this install's store; null without. */
async function defaultHub(): Promise<{
  url: string;
  token: string;
  allowTools: boolean;
  mcpUrl: string;
  inboxOnStop: "nudge" | "off";
} | null> {
  const { readHubConfig, readHubToken } = await import("../../shared/hub.js");
  let cfg;
  try {
    cfg = readHubConfig();
  } catch {
    return null; // a bad hub.* is doctor's and Settings' to say
  }
  if (!cfg) return null;
  const token = await readHubToken(cfg);
  return token
    ? {
        url: cfg.url,
        token,
        allowTools: cfg.allowTools,
        mcpUrl: cfg.mcpUrl,
        inboxOnStop: cfg.inboxOnStop,
      }
    : null;
}

/**
 * ON-6: the server agent's scope is no workspace, but its agent is a
 * normal one: it "exists", and its folder is an empty one under the state
 * dir (serverAgentDir), with no workspace runtime paths.
 */
function withServerScope(r: AgentsResolved): AgentsResolved {
  return {
    ...r,
    workspaceExists: (ws) => isServerScope(ws) || r.workspaceExists(ws),
    workspaceDir: (ws) =>
      isServerScope(ws) ? serverAgentDir(r.stateDir()) : r.workspaceDir(ws),
    workspaceFolders: (ws) =>
      isServerScope(ws)
        ? { under: [serverAgentDir(r.stateDir())] }
        : r.workspaceFolders(ws),
    workspaceRuntimeBin: (ws, id) =>
      isServerScope(ws) ? undefined : r.workspaceRuntimeBin(ws, id),
  };
}

// ── the agent's MCP ─────────────────────────────────────────────────────────

/**
 * Where the distribution is, from the caller's env (DEN_ROOT,
 * `<PREFIX>_ROOT`, `<PREFIX>_HOME`): the agent's env is an allowlist, so
 * its MCP server gets them in its own config instead, and reaches the same
 * distribution and state dir as the CLI that started it. Paths, never
 * secrets.
 */
function distLocationEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of new Set(["DEN_ROOT", envKey("ROOT"), envKey("HOME")])) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

/** `<cli> mcp --workspace <ws> --actor agent:<id> [--grant <g>…]`. */
export function agentMcp(
  d: AgentsResolved,
  ws: string,
  id: string,
  grants: string[],
): AgentMcp {
  const server = d.mcpServer();
  const bin = Array.isArray(server.command) ? server.command : [server.command];
  return {
    name: d.cli,
    command: [
      ...bin,
      "mcp",
      "--workspace",
      ws,
      "--actor",
      `agent:${id}`,
      ...grants.flatMap((g) => ["--grant", g]),
    ],
    env: { ...distLocationEnv(d.env), ...server.env },
    scope: ws,
  };
}

// ── rows ────────────────────────────────────────────────────────────────────

/**
 * One row per agent of a workspace: each session joined to the agent record
 * that started it (by session id), and each record whose session is gone,
 * as stopped (after `agents stop`) or ended. A session without a record is
 * a plain one (`sessions start`), not an agent: `sessions list` shows it.
 */
export interface AgentRow {
  agent: string;
  /** The name a person gave it (AG-4b), when one did. */
  displayName?: string;
  /**
   * den#3: the model its subagents run on ("inherit": the runtime
   * decides), and where that came from; for a runtime that takes one.
   */
  subagentModel?: string;
  subagentModelFrom?: SubagentModelFrom;
  /**
   * The name its session shows (AG-4b): the latest of Den's rename and the
   * runtime's own (Claude Code's /rename), when there is one. 0.4.12 called
   * this sessionName; sessionName is the record's session handle
   * (`<dist>-<ws>:<id>`), as it has been since 0.4.0.
   */
  sessionTitle?: string;
  persona?: string;
  runtime?: string;
  model?: string;
  /** Its model version: "latest" or pinned (AG-12.3). */
  version?: string;
  /** The permission intent it started with (AG-13). */
  permission?: PermissionIntent;
  /** Its extra allowed commands, when set for it (AG-13.4). */
  allow?: string[];
  /** What it overrides of its persona (AG-10.9). */
  overrides?: Override[];
  /** A newer version of its pinned model (AG-12.4). */
  newer?: string;
  workspace?: string;
  cwd?: string;
  /** running, stopping (stopped, its session not yet gone), exited
   * (<code>), stopped or interrupted. */
  state: string;
  /** When its current (or last) session started (ISO 8601). */
  startedAt?: string;
  /**
   * Resume applies: its runtime declares resume, its record has the
   * runtime's resume token, and it isn't running.
   */
  resumable: boolean;
  /**
   * AG-18: Change persona… applies: its runtime can resume and its record
   * has a conversation to continue (running or not), not rotated.
   */
  personaChange?: boolean;
  /**
   * Why Resume doesn't apply to a stopped agent (AG-14.2), e.g. "codex
   * can't resume a conversation": only Start fresh is offered.
   */
  noResume?: string;
  /** When `agents stop` stopped it. */
  stoppedAt?: string;
  /** When its session was seen to end on its own. */
  endedAt?: string;
  /** When Den found it interrupted by a restart. */
  interruptedAt?: string;
  /** Its persona resumes on its own after a restart (AG-14.3). */
  autoResume?: boolean;
  /** D59: this agent's own "Resume after a restart" (unset: its persona's). */
  resumeOnRestart?: boolean;
  /** D59: whether it resumes on its own after a restart, all told. */
  resumesOnRestart?: boolean;
  outcome?: AgentRecord["outcome"];
  usage?: AgentRecord["usage"];
  /**
   * Session rotation (den#4): its compactions, whether a rotation is due
   * and why, and its handoff.md. `ready`: Relaunch from handoff, not Resume.
   */
  rotation?: RotationInfo;
  /** How many times Den relaunched it from a handoff. */
  rotations?: number;
  /** D28: the last one (when, why, the old conversation, by itself or not). */
  lastRotation?: RotationEntry;
  session?: SessionInfo;
  /**
   * D44: a running agent whose MCP servers differ from what it would get
   * now (Hub connected or disconnected since it launched). A restart that
   * keeps its conversation brings them in line.
   */
  mcpStale?: McpStale;
  /**
   * D32/D34: the helpers it started in its own session, less those its
   * last "Clear done" hid: counts by state, and its active ones (running
   * or idle; running first, nested) for the row, at most row_max.
   */
  helpers?: {
    running: number;
    idle: number;
    /** Done, failed or stopped (what "Clear done" would hide). */
    ended: number;
    total: number;
    /** Hidden by its last "Clear done". */
    cleared: number;
    /** Running or idle: how many, and the first row_max of them. */
    activeCount: number;
    active: Helper[];
  };
}

/** Its state as a row shows it (AG-14.1: stopped, exited or interrupted). */
export function rowState(
  rec: AgentRecord | undefined,
  s?: SessionInfo,
): string {
  // Stopped (TERM sent) while its session still runs: on its way out.
  if (s && !s.exited)
    return rec?.stoppedAt && rec.stoppedAt >= s.startedAt
      ? "stopping"
      : "running";
  if (rec?.stoppedAt) return "stopped";
  if (rec?.endedAt)
    return rec.exitCode === undefined ? "exited" : `exited (${rec.exitCode})`;
  // A host sees every exit of its own sessions, with its code. A session
  // listed as ended with no code ended with an earlier host (the host
  // loads them so: AG-3a); one not listed at all, the same. Nobody stopped
  // it and it never exited: the host (Den, or the machine) went down.
  if (s && s.exitCode !== undefined) return state(s);
  return "interrupted";
}

/** A state an agent can be removed or resumed in: not running. */
export function isStoppedState(st: string): boolean {
  return st !== "running" && st !== "stopping";
}

/**
 * Why `rec` can't be resumed (AG-14.2), or null when it can be: its
 * runtime can't resume a conversation, or has no token to resume with.
 */
export function resumeRefusal(rec: AgentRecord): string | null {
  const rt = getRuntime(rec.runtime);
  if (!rt?.resume) return `${rec.runtime} can't resume a conversation`;
  if (!rec.resumeToken) return `${rec.id} has no conversation to resume`;
  return null;
}

/** Whether `rec` may be resumed now, in `rowState`. */
function canResume(rec: AgentRecord, st: string): boolean {
  return isStoppedState(st) && resumeRefusal(rec) === null;
}

/** Why a rotated agent isn't resumed: its conversation ended there (den#4). */
export function rotatedRefusal(rec: AgentRecord, r: RotationInfo): string {
  return `${rec.id} rotated (${reasonText(r.due!, r.compactions)}): relaunch it from its handoff`;
}

export function agentRows(
  sessions: SessionInfo[],
  records: AgentRecord[] = [],
  /** Den's state dir: each agent's rotation is read there (den#4). */
  stateDir?: string,
  /** D28: each agent's effective rotation settings (policyResolver). */
  policyOf?: (rec: AgentRecord) => RotationPolicy | undefined,
): AgentRow[] {
  const bySession = new Map(records.map((r) => [r.session.id, r]));
  const rows: AgentRow[] = [];
  const shown = new Set<string>();
  const row = (rec: AgentRecord, s?: SessionInfo): AgentRow => {
    const st = rowState(rec, s);
    const rot = stateDir ? rotationInfo(stateDir, rec, policyOf?.(rec)) : null;
    // A rotated conversation is not resumed: it relaunches from its handoff.
    // D28: under on_due off, its conversation goes on: Resume stays.
    const resumable =
      canResume(rec, st) && !(rot?.ready && rot.onDue !== "off");
    const why =
      isStoppedState(st) && !resumable
        ? (resumeRefusal(rec) ?? (rot?.ready ? rotatedRefusal(rec, rot) : null))
        : null;
    const named = stateDir ? agentSessionName(rec, stateDir) : undefined;
    return {
      agent: rec.id,
      ...recordFields(rec),
      ...(named ? { sessionTitle: named } : {}),
      state: st,
      startedAt: s?.startedAt ?? rec.startedAt,
      resumable,
      ...(!(rot?.ready && rot.onDue !== "off") && !personaChangeRefusal(rec)
        ? { personaChange: true }
        : {}),
      ...(why ? { noResume: why } : {}),
      ...(rec.stoppedAt ? { stoppedAt: rec.stoppedAt } : {}),
      ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
      ...(rec.interruptedAt ? { interruptedAt: rec.interruptedAt } : {}),
      ...(rec.outcome ? { outcome: rec.outcome } : {}),
      ...(rec.usage ? { usage: rec.usage } : {}),
      ...(rot ? { rotation: rot } : {}),
      ...(rec.rotations?.length
        ? {
            rotations: rec.rotations.length,
            lastRotation: rec.rotations[rec.rotations.length - 1],
          }
        : {}),
      ...(s ? { session: contractInfo(s) } : {}),
    };
  };
  for (const s of sessions) {
    const rec = bySession.get(s.ref.id);
    if (!rec) continue;
    shown.add(rec.id);
    rows.push(row(rec, s));
  }
  for (const rec of records) if (!shown.has(rec.id)) rows.push(row(rec));
  return rows;
}

function recordFields(rec: AgentRecord): Partial<AgentRow> {
  return {
    ...(rec.displayName ? { displayName: rec.displayName } : {}),
    persona: rec.persona,
    runtime: rec.runtime,
    ...(rec.model ? { model: rec.model } : {}),
    ...(rec.subagents
      ? {
          subagentModel: rec.subagents.model ?? INHERIT,
          subagentModelFrom: rec.subagents.from,
        }
      : {}),
    ...(rec.version ? { version: rec.version } : {}),
    ...(rec.permission ? { permission: rec.permission } : {}),
    ...(rec.allow ? { allow: [...rec.allow] } : {}),
    ...(rec.overrides?.length ? { overrides: [...rec.overrides] } : {}),
    ...(rec.resumeOnRestart !== undefined
      ? { resumeOnRestart: rec.resumeOnRestart }
      : {}),
    ...newerOf(rec),
    workspace: rec.workspace,
    cwd: rec.cwd,
  };
}

/**
 * AG-12.4: a pinned version older than its model's newest, as
 * `{ newer: <latest> }`; nothing otherwise.
 */
export function newerOf(
  rec: Pick<AgentRecord, "runtime" | "model" | "version">,
): {
  newer?: string;
} {
  if (!rec.version || rec.version === "latest" || !rec.model) return {};
  const m = getRuntime(rec.runtime)
    ?.models?.()
    .find((x) => x.id === rec.model);
  return m && m.latest !== rec.version ? { newer: m.latest } : {};
}

/**
 * Note in each record whose session the host lists as exited that it
 * ended, with its code (AG-14.1: "Exited (code n)"), so it still says so
 * once the host forgets the session (a restart). Only what the host says.
 */
export function noteEnded(
  stateDir: string,
  sessions: SessionInfo[],
  records: AgentRecord[],
): void {
  const byId = new Map(sessions.map((s) => [s.ref.id, s]));
  for (const rec of records) {
    const s = byId.get(rec.session.id);
    // An exit with no code is a host that went down: interrupted, not ended.
    if (!s?.exited || s.exitCode === undefined) continue;
    if (rec.endedAt || rec.stoppedAt) continue;
    rec.endedAt = new Date().toISOString();
    rec.exitCode = s.exitCode;
    writeRecord(stateDir, rec);
  }
}

/** A workspace name as given, checked (a usage error otherwise). */
export function checkWorkspaceName(where: string, ws: unknown): string {
  if (typeof ws !== "string" || !WORKSPACE_NAME_RE.test(ws))
    throw usage(`${where}: "${String(ws)}" is not a workspace name`);
  return ws;
}

/**
 * The workspace's agents, and only its own: its records joined to its
 * sessions. `startHost: false` (the page) never starts a host to ask:
 * with none running, every agent's session is gone.
 */
export async function listAgents(
  d: AgentsResolved,
  ws: string,
  opts: { startHost?: boolean; stopped?: boolean } = {},
): Promise<AgentRow[]> {
  checkWorkspaceName("agents list", ws);
  agentsConfigValid(d);
  let all: SessionInfo[];
  if (opts.startHost === false) {
    const c = await d.connectExisting();
    try {
      all = c ? await c.list() : [];
    } finally {
      c?.close();
    }
  } else all = await withClient(d, (c) => c.list());
  const sessions = all.filter((s) => inWorkspace(s, d.dist, ws));
  const records = listRecords(d.stateDir()).filter((r) => r.workspace === ws);
  noteEnded(d.stateDir(), sessions, records);
  const rows = agentRows(sessions, records, d.stateDir(), policyResolver(d));
  addHelperCounts(d, rows, records);
  addRestartResume(d, rows, records);
  await addMcpStale(d, rows);
  return opts.stopped ? rows.filter((r) => isStoppedState(r.state)) : rows;
}

/** D59: whether each agent resumes on its own after a restart. */
function addRestartResume(
  d: AgentsResolved,
  rows: AgentRow[],
  records: AgentRecord[],
): void {
  const of = restartResolver(d);
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const row of rows) {
    const rec = byId.get(row.agent);
    if (rec) row.resumesOnRestart = of(rec);
  }
}

/**
 * D59: whether an agent resumes on its own after a restart, the personas
 * read once (one resolver per list).
 */
export function restartResolver(
  d: AgentsResolved,
): (rec: AgentRecord) => boolean {
  let all: Map<string, Persona> | undefined;
  try {
    all = personas(d, agentsConfig(d));
  } catch {
    all = undefined;
  }
  return (rec) => resumesOnRestart(rec, personaOfRecord(rec, all));
}

function personaOfRecord(
  rec: AgentRecord,
  all: Map<string, Persona> | undefined,
): Persona | undefined {
  return isServerScope(rec.workspace) ? serverPersona() : all?.get(rec.persona);
}

/**
 * D59: the agent's own setting, over its persona's (`resume_on_restart`,
 * or a standing persona's). Off by default.
 */
export function resumesOnRestart(rec: AgentRecord, p?: Persona): boolean {
  return rec.resumeOnRestart ?? Boolean(p && (p.standing || p.resumeOnRestart));
}

// ── D44: an agent's MCP servers, as launched and as now ────────────────────

/** Servers a restart would add to a running agent, or take away. */
export interface McpStale {
  adds: string[];
  drops: string[];
}

/** How long what Hub gives agents now is trusted (the token read is slow). */
export const HUB_NOW_TTL_MS = 30_000;
const hubNowCache = new WeakMap<
  AgentsResolved["hub"],
  { at: number; v: Promise<string | null> }
>();

/**
 * The URL of the Hub server an agent would get if it launched now, or null
 * (no Hub, or its token can't be read: agentHub's rule). Cached briefly
 * per Hub source; `fresh` asks again (after Connect or Disconnect).
 */
export function hubNow(
  d: Pick<AgentsResolved, "hub" | "denBase">,
  fresh = false,
): Promise<string | null> {
  const had = hubNowCache.get(d.hub);
  if (!fresh && had && Date.now() - had.at < HUB_NOW_TTL_MS) return had.v;
  // D52: an agent's Hub server is Den's proxy (one launched before it,
  // straight to Hub, is out of date and gets it on restart).
  const v = d
    .hub()
    .then((h) => (h ? `${denHubProxy(d)}/mcp` : null))
    .catch(() => null);
  hubNowCache.set(d.hub, { at: Date.now(), v });
  return v;
}

/** hubNow from this install's own config (the web server's lists). */
export const defaultHubNow = (fresh = false): Promise<string | null> =>
  hubNow({ hub: defaultHub, denBase: defaultDenBase }, fresh);

/**
 * What agent `id`'s MCP config (as it launched) lacks or has extra against
 * Hub now (`hubUrl`, null: none). Undefined: in line, or no config file
 * (a runtime that writes none).
 */
export function mcpStaleOf(
  filesDir: string,
  hubUrl: string | null,
): McpStale | undefined {
  let servers: Record<string, { url?: unknown }>;
  try {
    servers =
      (
        JSON.parse(
          fs.readFileSync(path.join(filesDir, "mcp.json"), "utf-8"),
        ) as { mcpServers?: Record<string, { url?: unknown }> }
      ).mcpServers ?? {};
  } catch {
    return undefined;
  }
  const had = servers[HUB_SERVER];
  const adds: string[] = [];
  const drops: string[] = [];
  if (hubUrl && (!had || had.url !== hubUrl)) adds.push(HUB_SERVER);
  if (!hubUrl && had) drops.push(HUB_SERVER);
  return adds.length || drops.length ? { adds, drops } : undefined;
}

/** D44: each running row whose MCP servers are out of date says so. */
async function addMcpStale(d: AgentsResolved, rows: AgentRow[]): Promise<void> {
  const running = rows.filter((r) => r.state === "running");
  if (!running.length) return;
  const url = await hubNow(d);
  for (const r of running) {
    const st = mcpStaleOf(agentFilesDir(d.stateDir(), r.agent), url);
    if (st) r.mcpStale = st;
  }
}

/** D44: every running agent whose MCP servers are out of date. */
export async function staleAgents(
  d: AgentsResolved,
  opts: { fresh?: boolean } = {},
): Promise<{ id: string; workspace: string; stale: McpStale }[]> {
  const url = await hubNow(d, opts.fresh);
  let live: SessionInfo[] = [];
  const c = await d.connectExisting();
  try {
    live = c ? (await c.list()).filter((s) => !s.exited) : [];
  } finally {
    c?.close();
  }
  const out: { id: string; workspace: string; stale: McpStale }[] = [];
  for (const rec of listRecords(d.stateDir())) {
    if (!live.some((s) => sessionOf([s], rec))) continue;
    const st = mcpStaleOf(agentFilesDir(d.stateDir(), rec.id), url);
    if (st) out.push({ id: rec.id, workspace: rec.workspace, stale: st });
  }
  return out;
}

/** D44: what agent `id` is told of its own tools (MCP whoami, the pane). */
export interface AgentTools {
  agent: string;
  workspace: string;
  hub: {
    /** It would get Hub's tools if it launched now. */
    connected: boolean;
    /** Its running session has them (as it launched). */
    loaded: boolean;
    /** A restart (same conversation) brings them in line. */
    restart: boolean;
  };
  /** One plain line saying so, for the agent to tell the person. */
  note: string;
}

export async function agentTools(
  d: AgentsResolved,
  id: string,
  ws: string,
): Promise<AgentTools> {
  const rec = agentRecord(d, id, ws);
  const url = await hubNow(d);
  const files = agentFilesDir(d.stateDir(), rec.id);
  const st = mcpStaleOf(files, url);
  const connected = url !== null;
  const loaded = connected
    ? !st?.adds.includes(HUB_SERVER)
    : Boolean(st?.drops.includes(HUB_SERVER));
  const restart = Boolean(st);
  const note = !connected
    ? loaded
      ? "Hub was disconnected; its tools go when the person restarts you from Den."
      : "This Den is not connected to Hub. A person connects it in Settings › Agents › Hub."
    : restart
      ? "Hub is connected, but your session started without its tools. Ask the person to restart you from Den (Restart keeps this conversation); no token step is needed."
      : "Hub is connected and its tools (hub_*) are yours.";
  return {
    agent: rec.id,
    workspace: rec.workspace,
    hub: { connected, loaded, restart },
    note,
  };
}

/** D32: agents.helpers, or its defaults when the config can't be read. */
/**
 * A bad `agents:` key (a ConfigError naming it) stops listing agents and
 * reading their helpers, on the CLI as on the web (422), never with
 * defaults. Stopping an agent doesn't read it, so it is never stranded.
 */
function agentsConfigValid(d: AgentsResolved): void {
  d.agentsConfig();
}

function helperSettings(d: AgentsResolved): HelperSettings {
  try {
    return d.agentsConfig().helpers ?? HELPER_DEFAULTS;
  } catch {
    return HELPER_DEFAULTS;
  }
}

/** D32: each row's helper counts and recent helpers (never fails a list). */
function addHelperCounts(
  d: AgentsResolved,
  rows: AgentRow[],
  records: AgentRecord[],
): void {
  const settings = helperSettings(d);
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const row of rows) {
    const rec = byId.get(row.agent);
    if (!rec) continue;
    const h = rowHelpers(
      rec,
      !isStoppedState(row.state),
      settings,
      d.env,
      Date.now(),
      readClearedAt(agentFilesDir(d.stateDir(), rec.id)),
    );
    if (h) row.helpers = h;
  }
}

/**
 * D32/D34: what an agent's row shows of its helpers: its counts by state
 * and its active ones (running or idle; at most row_max, running kept),
 * less those its last "Clear done" hid (`clearedAt`). Done ones are only
 * counted: the Helpers list has them. Undefined: nothing to show (none,
 * or all cleared), or its runtime can't tell. Never throws.
 */
export function rowHelpers(
  rec: AgentRecord,
  live: boolean,
  settings: HelperSettings = HELPER_DEFAULTS,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  clearedAt?: number,
): AgentRow["helpers"] {
  const rt = getRuntime(rec.runtime);
  if (!rt?.helpers) return undefined;
  let all: Helper[] = [];
  try {
    all = rt.helpers(rec, { env, now, settings, agentLive: live });
  } catch {
    return undefined;
  }
  const { shown: hs, cleared } = splitCleared(all, clearedAt);
  if (!hs.length) return undefined;
  const active = hs.filter((h) => !isEnded(h));
  return {
    running: hs.filter((h) => h.status === "running").length,
    idle: hs.filter((h) => h.status === "idle").length,
    ended: hs.filter((h) => isEnded(h)).length,
    total: hs.length,
    cleared: cleared.length,
    activeCount: active.length,
    active: capHelpers(active, settings.rowMax),
  };
}

/** D32: an agent's helpers, read-only, and whether its runtime can tell. */
export async function agentHelpers(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<{
  rec: AgentRecord;
  supported: boolean;
  live: boolean;
  /** D34: without those its last "Clear done" hid. */
  helpers: Helper[];
  /** D34: the ones it hid (read-only, as the rest), and when. */
  cleared: Helper[];
  clearedAt?: number;
  note: string;
}> {
  agentsConfigValid(d);
  const rec = agentRecord(d, id, ws);
  const rt = getRuntime(rec.runtime);
  const live = await agentLive(d, rec);
  const all =
    rt?.helpers?.(rec, {
      env: d.env,
      settings: helperSettings(d),
      agentLive: live,
    }) ?? [];
  const clearedAt = readClearedAt(agentFilesDir(d.stateDir(), rec.id));
  const { shown, cleared } = splitCleared(all, clearedAt);
  return {
    rec,
    supported: !!rt?.helpers,
    live,
    helpers: shown,
    cleared,
    ...(clearedAt !== undefined ? { clearedAt } : {}),
    note: HELPERS_READ_ONLY_NOTE,
  };
}

/** D45: how many characters of a session's last line the details show. */
const LAST_LINE_MAX = 300;

/** D45: a stopped agent's details beyond its row (read-only). */
export interface AgentDetails {
  agent: string;
  workspace: string;
  /** What a person last asked it, one line, and when. */
  lastPrompt: { text: string; at?: string } | null;
  /** Its session ended on its own: the code and its last line (redacted). */
  exitCode?: number;
  lastLine?: string;
}

/**
 * D45: what the stopped agent's details pop-over shows beyond its row:
 * what it was last asked (its runtime's transcript, D39's turn rules) and,
 * when its session ended on its own, the exit code and the last line it
 * printed, secrets redacted. Nothing here starts, stops or sends anything.
 */
export async function agentDetails(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<AgentDetails> {
  const rec = agentRecord(d, id, ws);
  const rt = getRuntime(rec.runtime);
  let readMaxBytes: number | undefined;
  try {
    readMaxBytes = d.agentsConfig().turnReadMaxBytes;
  } catch {
    /* unreadable config: the default */
  }
  const prompt = rec.resumeToken
    ? (rt?.lastPrompt?.(rec.resumeToken, d.env, { readMaxBytes }) ?? null)
    : null;
  const out: AgentDetails = {
    agent: rec.id,
    workspace: rec.workspace,
    lastPrompt: prompt,
  };
  let c: HostClient | null = null;
  try {
    c = await d.connectExisting();
    const s = c ? sessionOf(await c.list(), rec) : undefined;
    if (c && s?.exited) {
      if (s.exitCode !== undefined) out.exitCode = s.exitCode;
      const lines = plainLines(
        (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8"),
      ).filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (last)
        out.lastLine = [...redactSecrets(last.trim())]
          .slice(0, LAST_LINE_MAX)
          .join("");
    }
  } catch {
    /* no session host: no session facts */
  } finally {
    c?.close();
  }
  return out;
}

/**
 * D34 "Clear done": hides every helper of agent `id` that has ended (done,
 * failed, stopped), in this conversation and earlier ones, by setting its
 * cleared-at mark to now. Running and idle ones stay; Claude Code's files
 * are never touched. A person's only (the route refuses an agent).
 */
export function clearAgentHelpers(
  d: AgentsResolved,
  id: string,
  ws?: string,
  now = Date.now(),
): { rec: AgentRecord; clearedAt: number } {
  const rec = agentRecord(d, id, ws);
  writeClearedAt(agentFilesDir(d.stateDir(), rec.id), now);
  return { rec, clearedAt: now };
}

/** D32: one of agent `id`'s helpers' transcript; a 404 when there's none. */
export async function agentHelperTranscript(
  d: AgentsResolved,
  id: string,
  helperId: string,
  ws?: string,
  limit?: number,
): Promise<HelperTranscript & { note: string }> {
  agentsConfigValid(d);
  const rec = agentRecord(d, id, ws);
  const rt = getRuntime(rec.runtime);
  const t = rt?.helperTranscript?.(rec, helperId, {
    env: d.env,
    settings: helperSettings(d),
    agentLive: await agentLive(d, rec),
    ...(limit ? { limit } : {}),
  });
  if (!t) throw refused(`agent ${id} has no helper "${helperId}"`, [], 404);
  return { ...t, note: HELPERS_READ_ONLY_NOTE };
}

/** Whether agent `rec`'s session runs now (an unreachable host: no). */
async function agentLive(
  d: AgentsResolved,
  rec: AgentRecord,
): Promise<boolean> {
  try {
    const c = await d.connectExisting();
    if (!c) return false;
    try {
      const s = sessionOf(await c.list(), rec);
      return Boolean(s && !s.exited);
    } finally {
      c.close();
    }
  } catch {
    return false;
  }
}

// ── personas, runtimes ──────────────────────────────────────────────────────

/** The agents config; an invalid one is a refusal naming the key. */
function agentsConfig(d: AgentsResolved): ResolvedAgentsConfig {
  try {
    return d.agentsConfig();
  } catch (e) {
    throw refused((e as Error).message, [], 422);
  }
}

/** Every persona; a bad pack or persona file is a refusal naming it. */
function personas(
  d: AgentsResolved,
  cfg: ResolvedAgentsConfig,
  /** ON-6: the server scope adds Den's own server persona (only there). */
  ws?: string,
): Map<string, Persona> {
  try {
    const all = loadPersonas(
      resolvePackDirs(cfg.personaPacks, d.distRoot()),
      undefined,
      { defaultPack: cfg.defaultPackGuardrails, packs: cfg.packGuardrails },
      localPersonasDir(d.stateDir()),
    );
    if (isServerScope(ws)) all.set(SERVER_PERSONA_ID, serverPersona());
    return all;
  } catch (e) {
    throw refused((e as Error).message, [], 422);
  }
}

/**
 * D28: the workspace service whose folder holds `cwd` (the deepest), for
 * the service scope; undefined outside every service or on any error.
 */
function serviceAt(
  d: AgentsResolved,
  ws: string,
  cwd: string | undefined,
): string | undefined {
  if (!cwd) return undefined;
  try {
    let best: { address: string; path: string } | undefined;
    for (const svc of d.workspaceServices(ws)) {
      const rel = path.relative(svc.path, cwd);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (!best || svc.path.length > best.path.length) best = svc;
    }
    return best?.address;
  } catch {
    return undefined;
  }
}

/**
 * D28: a resolver of each agent's rotation settings, the config and the
 * personas read once. A config or persona that can't be read: undefined
 * (den#4's own rules), never an error in a list.
 */
export function policyResolver(
  d: AgentsResolved,
): (rec: AgentRecord) => RotationPolicy | undefined {
  let cfg: ResolvedAgentsConfig | null | undefined;
  const byWs = new Map<string, Map<string, Persona> | null>();
  return (rec) => {
    if (cfg === undefined) {
      try {
        cfg = d.agentsConfig();
      } catch {
        cfg = null;
      }
    }
    if (!cfg) return undefined;
    const key = isServerScope(rec.workspace) ? rec.workspace : "";
    if (!byWs.has(key)) {
      try {
        byWs.set(key, personas(d, cfg, rec.workspace));
      } catch {
        byWs.set(key, null);
      }
    }
    const all = byWs.get(key);
    if (!all) return undefined;
    return effectiveRotation(d, cfg, rec, all.get(rec.persona));
  };
}

/** D28: agent `rec`'s rotation under its effective settings. */
export function rotationOf(
  d: AgentsResolved,
  rec: AgentRecord,
): RotationInfo | null {
  return rotationInfo(d.stateDir(), rec, policyResolver(d)(rec));
}

/**
 * D28: agent `id`'s effective rotation settings and where each comes
 * from. `persona` is its persona (standing, and whether Den's hooks count
 * compactions: without them it never rotates).
 */
export function effectiveRotation(
  d: AgentsResolved,
  cfg: ResolvedAgentsConfig,
  who: { id: string; persona: string; workspace: string; cwd?: string },
  persona: Persona | undefined,
): RotationPolicy {
  const r = resolveRotate(
    {
      agent: who.id,
      persona: who.persona,
      workspace: who.workspace,
      ...(serviceAt(d, who.workspace, who.cwd)
        ? { service: serviceAt(d, who.workspace, who.cwd) }
        : {}),
      ...(persona?.standing ? { standing: true } : {}),
    },
    readRotateFile(d.stateDir()),
    cfg.rotateOrg ??
      (cfg.rotate
        ? {
            after_compactions: cfg.rotate.afterCompactions || "never",
            ...(cfg.rotate.standing === false ? { standing: false } : {}),
          }
        : undefined),
  );
  return {
    afterCompactions:
      persona && !persona.guardrails?.hooks ? 0 : r.afterCompactions,
    onDue: r.onDue,
    onPrMerged: r.onPrMerged,
    from: {
      after_compactions: sourceText(r.source.after_compactions),
      on_due: sourceText(r.source.on_due),
      on_pr_merged: sourceText(r.source.on_pr_merged),
    },
  };
}

/** A persona as listed: everything but its role prompt. */
export type ListedPersona = Omit<Persona, "prompt" | "guardrailsSet"> & {
  /** Its permission mode as Den's intent (AG-13), when it is one. */
  permission?: PermissionIntent;
};

function listed(p: Persona): ListedPersona {
  const { prompt: _p, guardrailsSet: _g, ...rest } = p;
  const permission = intentOf(p.permissionMode);
  return { ...rest, ...(permission ? { permission } : {}) };
}

/** Den's default pack, then agents.persona_packs, then local ones, by id. */
export function listPersonas(d: AgentsResolved): ListedPersona[] {
  return [...personas(d, agentsConfig(d)).values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(listed);
}

/** den#3: what agents' subagents run on, for `agents doctor`. */
export interface SubagentsReport {
  /** The org's: a model, or "inherit". */
  model: string;
  from: "org" | "default";
  claudeAiConnectors: boolean;
  /** Personas whose subagent_model overrides it. */
  personas: Array<{ id: string; model: string }>;
  /** Each agent, as it last started (a runtime that takes one). */
  agents: Array<{ id: string; model: string; from: SubagentModelFrom }>;
  /** The personas couldn't be read: why. */
  personasError?: string;
}

export function subagentsReport(d: AgentsResolved): SubagentsReport {
  const s = agentsConfig(d).subagents ?? SUBAGENT_DEFAULTS;
  let personas: SubagentsReport["personas"] = [];
  let personasError: string | undefined;
  try {
    personas = listPersonas(d).flatMap((p) =>
      p.subagentModel ? [{ id: p.id, model: p.subagentModel }] : [],
    );
  } catch (e) {
    personasError = (e as Error).message;
  }
  const agents = listRecords(d.stateDir())
    .flatMap((r) =>
      r.subagents
        ? [
            {
              id: r.id,
              model: r.subagents.model ?? INHERIT,
              from: r.subagents.from,
            },
          ]
        : [],
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    model: s.model,
    from: orgModelFrom(s),
    claudeAiConnectors: s.claudeAiConnectors,
    personas,
    agents,
    ...(personasError ? { personasError } : {}),
  };
}

/** A persona with its instructions (Details, Edit: AG-10.6). */
export function personaDetail(
  d: AgentsResolved,
  id: string,
): ListedPersona & { instructions: string } {
  const p = personas(d, agentsConfig(d)).get(id);
  if (!p) throw refused(`no persona "${id}"`, [], 404);
  return { ...listed(p), instructions: p.prompt };
}

/** The role and category registries (AG-10.5, AG-11.1). */
export function registries(d: AgentsResolved): {
  roles: RoleTemplate[];
  categories: Category[];
} {
  const cfg = agentsConfig(d);
  return {
    roles: roleRegistry(cfg.roles),
    categories: categoryRegistry(cfg.categories),
  };
}

/** What a persona's fields may name (persona-store.ts checks them). */
function personaChoices(d: AgentsResolved) {
  syncCatalog(d);
  const reg = registries(d);
  return {
    roles: reg.roles.map((r) => r.id),
    categories: reg.categories.map((c) => c.id),
    runtimes: runtimeIds()
      .filter((id) => getRuntime(id)?.catalog || id === DEFAULT_RUNTIME_ID)
      .map((id) => ({ id, models: getRuntime(id)?.models?.() ?? [] })),
  };
}

function checkedInput(d: AgentsResolved, body: unknown): PersonaInput {
  try {
    return checkPersonaInput(body, personaChoices(d));
  } catch (e) {
    if (e instanceof PersonaInputError) throw usage(e.message);
    throw e;
  }
}

/**
 * New persona (AG-10.7): a local one, its id from its name (or role),
 * never one any persona has. Returns it as listed.
 */
export function createPersona(d: AgentsResolved, body: unknown): ListedPersona {
  const input = checkedInput(d, body);
  const all = personas(d, agentsConfig(d));
  const id = newPersonaId(input, new Set(all.keys()));
  writeLocalPersona(d.stateDir(), id, input);
  return personaDetail(d, id);
}

/**
 * Edit persona `id` (AG-10.7): only a local one is written. A built-in or
 * a distribution's persona is read-only: 409, and the page duplicates it.
 */
export function updatePersona(
  d: AgentsResolved,
  id: string,
  body: unknown,
): ListedPersona {
  const p = personas(d, agentsConfig(d)).get(id);
  if (!p) throw refused(`no persona "${id}"`, [], 404);
  if (p.origin !== "local" || !localPersonaExists(d.stateDir(), id))
    throw new AgentError(
      `${id} is ${p.origin === "builtin" ? "built in" : `the ${p.origin}'s`}: duplicate it to edit a copy of your own`,
      { status: 409, code: "read_only" },
    );
  writeLocalPersona(d.stateDir(), id, checkedInput(d, body));
  return personaDetail(d, id);
}

/** Delete local persona `id` (never a built-in or a distribution's). */
export function deletePersona(d: AgentsResolved, id: string): void {
  const p = personas(d, agentsConfig(d)).get(id);
  if (!p) throw refused(`no persona "${id}"`, [], 404);
  if (p.origin !== "local" || !deleteLocalPersona(d.stateDir(), id))
    throw new AgentError(
      `${id} isn't yours to delete: only local personas are`,
      {
        status: 409,
        code: "read_only",
      },
    );
}

export interface RuntimeChoice {
  id: string;
  /** Its name for people ("Claude Code"). */
  label?: string;
  /** Who makes it ("Anthropic"): a catalog runtime (AG-0.5). */
  vendor?: string;
  /**
   * false: it runs as its own CLI, without Den's tools yet ("Den tools:
   * coming"). Absent for a runtime that isn't from the catalog.
   */
  denTools?: boolean;
  available: boolean;
  /** Why it is unavailable. */
  why?: string;
  version?: string;
  /** The CLI it runs (AG-0.2). */
  path?: string;
  /**
   * Where that path came from: workspace (its workspaces.yml entry),
   * setting (user.yml), login-shell, PATH, well-known, interactive-shell.
   */
  source?: BinSource;
  /** The directories searched, in order (a runtime with a CLI to find). */
  searched?: string[];
  /** The user.yml key that sets its path (a runtime with a CLI to find). */
  setting?: string;
  /** The workspace's key for it, when listed for a workspace. */
  workspaceSetting?: string;
  /** It declares resume. */
  resume: boolean;
  default: boolean;
  /** Its models (AG-12.3); [] when it takes no model choice from Den. */
  models: RuntimeModel[];
  /** How it expresses permission intents (AG-13.2), when it can. */
  permissions?: RuntimePermissions;
  /** Its Shift+Enter bytes: also how a first instruction's newlines go. */
  softNewline?: string;
}

/**
 * The path set for runtime `id` (AG-0.5): the workspace's (when `ws` is
 * given and it sets one), else user.yml's; null when neither does.
 */
export function runtimeSetting(
  d: AgentsResolved,
  id: string,
  ws?: string,
): BinSetting | null {
  if (ws) {
    const v = d.workspaceRuntimeBin(ws, id);
    if (v !== undefined && v !== null)
      return { value: v, source: "workspace", key: workspaceBinKey(ws, id) };
  }
  const g = d.runtimeBin(id);
  return g === undefined || g === null ? null : { value: g, source: "setting" };
}

/**
 * Whether runtime `rt` can run here (AG-0.1, AG-0.5): a path set for the
 * workspace, else user.yml's (`agents.runtimes.<id>.bin`), else the
 * search. Runs nothing.
 */
export function detectRuntime(
  d: AgentsResolved,
  rt: Runtime,
  ws?: string,
): RuntimeDetect {
  return rt.detect(d.env, { bin: runtimeSetting(d, rt.id, ws) });
}

/**
 * The catalog entries the distribution and user.yml add, registered as
 * runtimes (AG-0.5). A malformed entry is a refusal naming its key.
 */
export function syncCatalog(d: AgentsResolved): void {
  const cfg = agentsConfig(d);
  let extra: CatalogEntry[];
  try {
    extra = [
      ...cfg.runtimeCatalog,
      ...d.userCatalog([
        ...BUILTIN_CATALOG.map((e) => e.id),
        ...cfg.runtimeCatalog.map((e) => e.id),
      ]),
    ];
  } catch (e) {
    throw refused((e as Error).message, [], 422);
  }
  syncConfiguredRuntimes(extra);
}

/**
 * When a catalog runtime is still missing (nothing set, not found on the
 * login PATH, PATH or its install directories), ask the interactive shell
 * for its PATH: once per process, then kept (AG-0.5).
 */
async function fallbackSearch(
  d: AgentsResolved,
  rts: Runtime[],
  ws?: string,
): Promise<void> {
  if (interactivePathAsked()) return;
  const missing = rts.some(
    (rt) =>
      rt.catalog &&
      !runtimeSetting(d, rt.id, ws) &&
      !detectRuntime(d, rt, ws).available,
  );
  if (missing) await ensureInteractivePath({ env: d.env });
}

/**
 * The catalog's installed runtimes first, then the ones not found, then
 * the rest (generic: no CLI of its own to find).
 */
function rank(r: RuntimeChoice): number {
  if (r.denTools === undefined) return 2;
  return r.available ? 0 : 1;
}

/**
 * Every registered runtime, and whether it can run here (for an agent of
 * `ws`, when given: its workspace's path wins), with the path it runs and
 * its version: its version command (`claude --version`), run once under a
 * timeout and kept, else what its install says. Installed ones first.
 */
export async function listRuntimes(
  d: AgentsResolved,
  ws?: string,
): Promise<RuntimeChoice[]> {
  syncCatalog(d);
  const ids = runtimeIds();
  await fallbackSearch(
    d,
    ids.map((id) => getRuntime(id)!),
    ws,
  );
  const rows = await Promise.all(
    ids.map(async (id) => {
      const rt = getRuntime(id)!;
      const det = detectRuntime(d, rt, ws);
      const asked =
        det.available && det.path && rt.find?.versionArgs
          ? await runtimeVersion(det.path, rt.find.versionArgs, d.env)
          : undefined;
      const version = asked ?? det.version;
      return {
        id,
        ...(rt.label ? { label: rt.label } : {}),
        ...(rt.vendor ? { vendor: rt.vendor } : {}),
        ...(rt.catalog ? { denTools: rt.denTools === true } : {}),
        available: det.available,
        ...(det.available ? {} : { why: det.why ?? "unavailable" }),
        ...(version ? { version } : {}),
        ...(det.path ? { path: det.path } : {}),
        ...(det.source ? { source: det.source } : {}),
        ...(rt.find
          ? {
              searched: det.searched ?? [],
              setting: binSettingKey(id),
              ...(ws ? { workspaceSetting: workspaceBinKey(ws, id) } : {}),
            }
          : {}),
        resume: Boolean(rt.resume),
        default: id === DEFAULT_RUNTIME_ID,
        models: rt.models?.() ?? [],
        ...(rt.permissions ? { permissions: rt.permissions } : {}),
      };
    }),
  );
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Set (or, with null, clear) runtime `id`'s path, global or for workspace
 * `ws` (AG-0.5): its version command runs first, and a path that isn't
 * that runtime is refused. Returns its row as listed after.
 */
export async function setRuntimePath(
  d: AgentsResolved,
  req: {
    id: string;
    scope: "global" | "workspace";
    workspace?: string;
    bin: string | null;
  },
): Promise<RuntimeChoice> {
  syncCatalog(d);
  const rt = runtimeFor(req.id);
  if (!rt.catalog)
    throw usage(`${req.id} has no CLI to find: its path can't be set`);
  let ws: string | undefined;
  if (req.scope === "workspace") {
    ws = checkWorkspaceName("runtime path", req.workspace);
    if (!d.workspaceExists(ws))
      throw usage(`workspace "${ws}" does not exist`, 404);
  }
  if (req.bin !== null) {
    const c = await checkRuntimeBin(rt.catalog, req.bin, d.env);
    if (!c.ok) throw refused(c.why, [], 422);
    d.saveRuntimeBin(req.scope, ws, rt.id, c.path);
  } else d.saveRuntimeBin(req.scope, ws, rt.id, null);
  const rows = await listRuntimes(d, ws);
  return rows.find((r) => r.id === rt.id)!;
}

/** Refused unless `rt` can run here; its detect result when it can. */
async function availableOrRefuse(
  d: AgentsResolved,
  rt: Runtime,
  ws?: string,
): Promise<RuntimeDetect> {
  await fallbackSearch(d, [rt], ws);
  const det = detectRuntime(d, rt, ws);
  if (!det.available)
    throw refused(
      `${rt.id} is unavailable: ${det.why ?? "unknown"}`,
      rt.find
        ? [
            `Install it, or set ${binSettingKey(rt.id)} to its absolute path in ${d.userConfigFile()}.`,
            `\`${d.cli} agents doctor\` shows where it looked.`,
          ]
        : [],
      503,
    );
  return det;
}

function runtimeFor(id: string): Runtime {
  const rt = getRuntime(id);
  if (!rt)
    throw usage(`no runtime "${id}" (runtimes: ${runtimeIds().join(", ")})`);
  return rt;
}

/** The running session of `rec`, if any; else its exited one, if listed. */
function sessionOf(
  sessions: SessionInfo[],
  rec: AgentRecord,
): SessionInfo | undefined {
  return sessions.find((s) => s.ref.id === rec.session.id);
}

/**
 * The id a new start gets without --id (AG-10.10): the persona's id while
 * no agent has it; `<persona>-<ws>` when another workspace's agent has it;
 * else the first of `<base>-2`, `<base>-3`… no agent has. A stopped agent's
 * id is never reused by a new start: only its Resume or Start fresh.
 */
/**
 * AG-10.10b: the id a Name gives: its slug while no agent has it; a
 * running agent in the workspace with that id or that title is refused
 * (open it instead); a stopped one, or another workspace's, makes it the
 * next free `<slug>-2`… (Resume continues the stopped one). Null when the
 * Name has no id characters: the persona's default then.
 */
async function namedId(
  d: AgentsResolved,
  name: string,
  ws: string,
): Promise<string | null> {
  const slug = nameSlug(name);
  const sessions = await withClient(d, (c) => c.list());
  const live = (rec: AgentRecord) => {
    const s = sessionOf(sessions, rec);
    return s && !s.exited ? s : undefined;
  };
  // No two live agents in one workspace share a title, or this id.
  for (const rec of listRecords(d.stateDir())) {
    if (rec.workspace !== ws) continue;
    const same =
      rec.id === slug ||
      (rec.displayName ?? "").toLowerCase() === name.toLowerCase();
    const s = same ? live(rec) : undefined;
    if (s)
      throw new AgentError(`agent ${rec.id} is running (${s.name})`, {
        status: 409,
        hints: [`Attach: ${d.cli} sessions attach ${s.name}`],
        running: { id: rec.id, sessionId: s.ref.id },
      });
  }
  if (!slug) return null;
  if (!readRecord(d.stateDir(), slug)) return slug;
  const stem = slug.slice(0, 58);
  for (let n = 2; n < 1000; n++) {
    const id = `${stem}-${n}`;
    if (!readRecord(d.stateDir(), id)) return id;
  }
  throw refused(`no free agent id for ${slug}: give one with --id`);
}

export function defaultId(
  stateDir: string,
  persona: string,
  ws: string,
): string {
  const rec = readRecord(stateDir, persona);
  if (!rec) return persona;
  const base = rec.workspace === ws ? persona : `${persona}-${ws}`.slice(0, 64);
  if (base !== persona && !readRecord(stateDir, base)) return base;
  const stem = base.slice(0, 58);
  for (let n = 2; n < 1000; n++) {
    const id = `${stem}-${n}`;
    if (!readRecord(stateDir, id)) return id;
  }
  throw refused(`no free agent id for ${persona}: give one with --id`);
}

function checkId(where: string, id: string): void {
  if (!AGENT_ID_RE.test(id) || AGENTS_RESERVED_KEYS.includes(id))
    throw usage(
      `${where}: --id "${id}" must be letters, digits, ".", "_" or "-" (1-64), ` +
        `and not ${AGENTS_RESERVED_KEYS.join(" or ")}`,
    );
}

interface Launch {
  rec: Omit<AgentRecord, "session" | "startedAt">;
  argv: string[];
  env: Record<string, string>;
  /** The runtime's envPassthrough. */
  passthrough?: readonly string[];
  /** den#3: Runtime.launchEnv, names its launch env sets past the scrub. */
  launchEnv?: readonly string[];
  /** agents.<id>.grants, recorded with its actor token. */
  grants: readonly string[];
  /** Added to the session's PATH: a configured CLI's own directory. */
  binDir?: string;
}

/**
 * A CLI's directory when the session's PATH wouldn't have it (a path set
 * for it, or found by the interactive shell), for its own tools.
 */
function binDirOf(det: RuntimeDetect): { binDir?: string } {
  return (det.source === "setting" ||
    det.source === "workspace" ||
    det.source === "interactive-shell") &&
    det.path
    ? { binDir: path.dirname(det.path) }
    : {};
}

/** The host's cap refusal as an AgentError (its hint says what to do). */
function capOrThrow(d: AgentsResolved, e: unknown): never {
  if (e instanceof HostError && e.code === "cap")
    throw new AgentError(e.message, {
      status: 429,
      code: "cap",
      hints: [
        `Stop one first (\`${d.cli} agents stop <id>\`), or raise agents.max_concurrent.`,
      ],
    });
  throw e;
}

/**
 * Start `launch` as the agent's session (replacing an exited one) and record
 * it. SEC-1c: a fresh actor token for the session (every earlier one of the
 * agent revoked), bound to the session id once the host has started it, and
 * revoked again when the start fails.
 */
async function startSession(
  d: AgentsResolved,
  c: HostClient,
  launch: Launch,
  old: SessionInfo | undefined,
  extra: Partial<AgentRecord>,
): Promise<{ rec: AgentRecord; info: SessionInfo }> {
  if (old?.exited) await c.forget(old.ref.id);
  const tty = d.stdout.isTTY;
  const minted = mintActorToken(d.stateDir(), {
    agentId: launch.rec.id,
    workspace: launch.rec.workspace,
    grants: launch.grants,
    sessionName: launch.rec.sessionName,
  });
  let info: SessionInfo;
  try {
    info = await c
      .start(
        {
          name: launch.rec.sessionName,
          cwd: launch.rec.cwd,
          argv: launch.argv,
          // Never the caller's whole env: the allowlist, then the runtime's.
          env: agentSessionEnv(
            d.env,
            { envPassthrough: launch.passthrough, launchEnv: launch.launchEnv },
            launch.env,
            launch.rec.id,
            minted.token,
            launch.binDir ? [launch.binDir] : [],
          ),
          cols: (tty && d.stdout.columns) || 80,
          rows: (tty && d.stdout.rows) || 24,
        },
        { limit: d.maxConcurrent(), pool: "agents" },
      )
      .catch((e: unknown) => capOrThrow(d, e));
  } catch (e) {
    revokeActorToken(d.stateDir(), minted.key);
    throw e;
  }
  bindActorSession(d.stateDir(), minted.key, info.ref.id);
  const rec: AgentRecord = {
    ...launch.rec,
    session: { backend: info.ref.backend, id: info.ref.id },
    startedAt: info.startedAt,
    grants: [...launch.grants],
    ...extra,
  };
  // A new session: whatever ended the last one no longer applies.
  delete rec.stoppedAt;
  delete rec.endedAt;
  delete rec.exitCode;
  delete rec.interruptedAt;
  writeRecord(d.stateDir(), rec);
  return { rec, info };
}

/**
 * CSI, OSC (BEL or ST ended), charset designations (`ESC ( B`), and other
 * two-byte escapes, save and restore (`ESC 7`, `ESC 8`) and keypad modes
 * included: Claude Code ends with `ESC ( B ESC 7 ESC 8`.
 */
/* eslint-disable no-control-regex */
const TERMINAL_ESCAPE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+\-./][ -~]|\x1b[0-9:;<=>?@-Z\\-_]/g;
/* eslint-enable no-control-regex */

/** Printable lines of terminal output: escapes and control bytes removed. */
export function plainLines(text: string): string[] {
  return (
    text
      .replace(TERMINAL_ESCAPE, "")
      .split(/\r?\n/)
      // A carriage return redraws the line: what stays is after the last.
      .map((l) => l.slice(l.lastIndexOf("\r") + 1))
      // eslint-disable-next-line no-control-regex
      .map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd())
      .filter((l) => l.trim())
  );
}

/** A new session that exited non-zero at once. */
export interface EarlyExit {
  exitCode?: number;
  /** Its last printed lines, secret-shaped values redacted. */
  tail: string[];
  /** All it printed (the last 64 KB), as plain text, to match against. */
  said: string;
  sessionName: string;
}

/**
 * Watch a new session for an early exit (d.exitWatchMs, polling the host):
 * a non-zero one, with its code and the last lines it printed.
 */
async function exitedAtOnce(
  d: AgentsResolved,
  c: HostClient,
  info: SessionInfo,
): Promise<EarlyExit | null> {
  const deadline = Date.now() + d.exitWatchMs;
  while (Date.now() < deadline) {
    await new Promise((r) =>
      setTimeout(r, Math.min(EXIT_POLL_MS, Math.max(0, deadline - Date.now()))),
    );
    const s = (await c.list()).find((x) => x.ref.id === info.ref.id);
    if (!s) return null;
    if (!s.exited) continue;
    if (s.exitCode === 0) return null;
    const lines = plainLines(
      (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8"),
    );
    const tail = lines.slice(-EXIT_TAIL_LINES).map((l) => redactSecrets(l));
    return {
      ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }),
      tail,
      said: lines.join("\n"),
      sessionName: s.name,
    };
  }
  return null;
}

/**
 * den#3: what an agent's record says its subagents run on, for a runtime
 * that takes a subagent model; nothing for one that doesn't.
 */
function subagentsField(
  rt: Runtime,
  persona: Persona,
  cfg: ResolvedAgentsConfig,
): Pick<AgentRecord, "subagents"> {
  if (!rt.subagentModel) return {};
  const e = effectiveSubagentModel(persona, cfg.subagents);
  return {
    subagents: { ...(e.model ? { model: e.model } : {}), from: e.from },
  };
}

function launchInput(
  d: AgentsResolved,
  cfg: ResolvedAgentsConfig,
  persona: Persona,
  ws: string,
  id: string,
  model: string | undefined,
  bin?: string,
  /** The grants to serve (a resume's, narrowed); default the config's. */
  only?: readonly string[],
  /** AG-13: the intent and the allowed commands (preset and extras). */
  perms: { permission?: PermissionIntent; allow?: string[] } = {},
): LaunchInput {
  const grants = only ? [...only] : (cfg.agents[id]?.grants ?? []);
  for (const g of grants)
    if (!d.workspaceExists(g))
      throw refused(
        `agents.${id}.grants: workspace "${g}" does not exist`,
        [],
        422,
      );
  const dir = d.workspaceDir(ws);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw refused(`workspace ${ws}'s directory ${dir} does not exist`);
  // den#4: only Den's hooks count compactions; without them, no rotation.
  const after = effectiveRotation(
    d,
    cfg,
    { id, persona: persona.id, workspace: ws, cwd: dir },
    persona,
  ).afterCompactions;
  return {
    persona,
    workspace: { name: ws, dir },
    agentId: id,
    worktree: dir,
    ...(model ? { model } : {}),
    mcp: agentMcp(d, ws, id, grants),
    filesDir: agentFilesDir(d.stateDir(), id),
    stateDir: d.stateDir(),
    env: d.env,
    ...(bin ? { bin } : {}),
    // den#3: its subagents' model (the persona's, else the org's), and
    // whether it loads the account's claude.ai connectors.
    ...(() => {
      const sub = effectiveSubagentModel(persona, cfg.subagents);
      return sub.model ? { subagentModel: sub.model } : {};
    })(),
    ...(cfg.subagents?.claudeAiConnectors ? { claudeAiConnectors: true } : {}),
    // D47: services it may reach only through their API.
    ...(() => {
      try {
        const a = writeApiOnlyRules(d.stateDir());
        return a ? { apiOnly: a } : {};
      } catch {
        return {};
      }
    })(),
    rotateAfter: after,
    ...(perms.permission ? { permission: perms.permission } : {}),
    ...(perms.allow?.length ? { allow: [...perms.allow] } : {}),
    // ON-6: the server agent runs Den's own tools without the runtime's
    // prompt; its writes wait for the person's Allow in the browser.
    ...(isServerScope(ws) ? { denToolsAllowed: true } : {}),
  };
}

/** The model a runtime is given: a pinned version, else the model. */
export function launchModel(
  model: string | undefined,
  version: string | undefined,
): string | undefined {
  return version && version !== "latest" ? version : model;
}

/**
 * The commands an agent may run without asking (AG-13.3, 13.4): its
 * persona role's preset, then its extra commands.
 */
function allowedFor(
  d: AgentsResolved,
  persona: Persona,
  extras: readonly string[],
): string[] {
  const preset = rolePreset(registries(d).roles, persona.role);
  return [...new Set([...preset, ...extras])];
}

/** The rotation limit a launch counts against: 0 when its runtime can't relaunch. */
function launchAfter(rt: Runtime, input: LaunchInput): number {
  return rt.firstPrompt ? (input.rotateAfter ?? 0) : 0;
}

function ptyOrRefuse(d: AgentsResolved): void {
  const pty = d.pty();
  if (!pty.available)
    throw refused(
      `${DEN_PTY_ID} is unavailable: ${pty.reason}`,
      [`\`${d.cli} doctor\` shows the session backend's state.`],
      503,
    );
}

/** A runtime's refusal of a launch (a bad persona key) as an AgentError. */
function launchOrThrow<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LaunchError) throw refused(e.message, [], 422);
    throw e;
  }
}

/** A started (or resumed) agent. */
export interface Started {
  rec: AgentRecord;
  info: SessionInfo;
  warnings: string[];
  /** Set when its session exited non-zero at once. */
  early: EarlyExit | null;
}

export interface StartRequest {
  workspace: string;
  persona: string;
  runtime?: string;
  model?: string;
  id?: string;
  /** "latest" or a pinned version of the model (AG-12.3). */
  version?: string;
  /** The permission intent for this launch (AG-13.6). */
  permission?: string;
  /** Extra allowed commands for this launch, instead of the persona's. */
  allow?: unknown;
  /** AG-10.10: a display name for this agent (AG-4b's), to tell two apart. */
  name?: unknown;
  /**
   * 0.4.18, Start agent here: the folder it runs in, the workspace's own
   * or one inside it (a repo's), relative to the workspace's folder or
   * absolute. Default: the workspace's folder.
   */
  folder?: string;
  /**
   * The page's start (AG-10.1): a model must be one the runtime offers,
   * never a free string (the CLI's --model for generic stays free).
   */
  strict?: boolean;
}

/**
 * den#48: workspace `ws`'s default permission mode, checked; undefined when
 * unset. A bad value is refused, naming the key: never quietly "ask".
 */
export function workspacePermissionOf(
  d: AgentsResolved,
  ws: string,
): PermissionIntent | undefined {
  const v = d.workspacePermission(ws);
  if (v === undefined || v === null) return undefined;
  try {
    return checkIntent(v, workspacePermissionKey(ws));
  } catch (e) {
    throw usage(`agents start: ${(e as Error).message}`);
  }
}

/** What a start resolved, checked, before it launches. */
interface Choices {
  model?: string;
  version: string;
  permission?: PermissionIntent;
  extras: string[];
  overrides: Override[];
}

/**
 * The model, version, permission and extra commands a start runs with
 * (AG-10.9, 12.3, 13.6): the request's, else the persona's; each checked
 * against what the runtime offers. What differs from the persona is an
 * override, and the list tags it.
 */
function startChoices(
  req: StartRequest,
  persona: Persona,
  rt: Runtime,
  /** den#48: the workspace's default mode, for a start that names none. */
  wsPermission?: PermissionIntent,
): Choices {
  const where = "agents start";
  const models = rt.models?.() ?? [];
  const overrides: Override[] = [];
  const personaRt = persona.runtime ?? DEFAULT_RUNTIME_ID;
  if (req.runtime && req.runtime !== personaRt) overrides.push("runtime");
  // The persona's model is for its own runtime only.
  const sameRt = rt.id === personaRt;
  const personaModel = sameRt ? persona.model : undefined;
  const personaVersion = (sameRt && persona.version) || "latest";
  let model = req.model ?? personaModel;
  let version =
    req.version ??
    (req.model === undefined || req.model === personaModel
      ? personaVersion
      : "latest");
  if (req.model !== undefined && req.strict && !models.length)
    throw usage(`${where}: ${rt.id} takes no model choice from Den`);
  if (req.version !== undefined && req.version !== "latest" && !models.length)
    throw usage(`${where}: ${rt.id} takes no model version from Den`);
  // The page's choices are checked against the catalog; the CLI's --model
  // stays as given (a full model name), unless a version comes with it.
  if (
    models.length &&
    (req.strict || req.version !== undefined) &&
    (req.model !== undefined || req.version !== undefined)
  )
    try {
      const c = checkModelChoice({ id: rt.id, models }, model, version);
      model = c.model;
      version = c.version;
    } catch (e) {
      throw usage(`${where}: ${(e as Error).message}`);
    }
  if (req.model !== undefined && req.model !== personaModel)
    overrides.push("model");
  if (version !== personaVersion) overrides.push("version");
  let permission: PermissionIntent | undefined;
  if (req.permission !== undefined) {
    try {
      permission = checkIntent(req.permission, "permission");
    } catch (e) {
      throw usage(`${where}: ${(e as Error).message}`);
    }
    if (!rt.permissions)
      throw usage(
        `${where}: ${rt.id} can't take a permission mode from Den yet`,
      );
    if (permission !== intentOf(persona.permissionMode))
      overrides.push("permission");
  } else if (wsPermission !== undefined && rt.permissions) {
    // den#48: the workspace's mode, over the persona's.
    permission = wsPermission;
    if (permission !== intentOf(persona.permissionMode))
      overrides.push("permission");
  } else if (rt.permissions) {
    // den#48: the persona's mode, recorded, so every resume (a click,
    // Resume all, after a restart) runs in the mode it started in, even
    // when the persona or the workspace changes later.
    permission = intentOf(persona.permissionMode);
  }
  let extras = persona.allowedCommands;
  if (req.allow !== undefined) {
    try {
      extras = checkCommands(req.allow, "allow");
    } catch (e) {
      throw usage(`${where}: ${(e as Error).message}`);
    }
    if (extras.length && !rt.permissions)
      throw usage(
        `${where}: ${rt.id} can't take allowed commands from Den yet`,
      );
    const same =
      extras.length === persona.allowedCommands.length &&
      extras.every((c) => persona.allowedCommands.includes(c));
    if (!same) overrides.push("allow");
  }
  return {
    ...(model ? { model } : {}),
    version,
    ...(permission ? { permission } : {}),
    extras: [...extras],
    overrides,
  };
}

/** What a relaunch from handoff adds to a start (den#4). */
interface StartMore {
  firstPrompt?: string;
  rotations?: AgentRecord["rotations"];
  /** Called once the old session is known ended, before the launch. */
  beforeLaunch?: () => void;
  /**
   * AG-17.1, bring in a conversation: launch the runtime's resume of this
   * one (its id, in the folder it ran in) instead of a new conversation.
   */
  bringIn?: { token: string; cwd: string };
}

/**
 * 0.4.18: the folder a start runs in. Relative to the workspace's folder,
 * or absolute; it must be a directory inside the workspace's scope (its
 * folder, or a by-path repo's), never outside it.
 */
export function startFolder(
  d: AgentsResolved,
  ws: string,
  folder: string,
): string {
  const where = "agents start";
  if (typeof folder !== "string" || !folder.trim() || folder.length > 4096)
    throw usage(`${where}: folder must be a path`);
  const dir = path.resolve(d.workspaceDir(ws), folder.trim());
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    throw usage(`${where}: folder ${dir} does not exist`, 404);
  }
  if (!fs.statSync(real).isDirectory())
    throw usage(`${where}: folder ${dir} is not a directory`);
  // The real folder only: a link inside the workspace that points out of
  // it is outside it (the scope's own folders are compared real, too).
  if (!inScope(real, d.workspaceFolders(ws)))
    throw refused(
      `${where}: folder ${dir} is not inside workspace ${ws}`,
      [],
      403,
    );
  return real;
}

export async function startAgent(
  d: AgentsResolved,
  req: StartRequest,
  more: StartMore = {},
): Promise<Started> {
  const where = "agents start";
  const ws = checkWorkspaceName(where, req.workspace);
  if (!d.workspaceExists(ws))
    throw usage(`${where}: workspace "${ws}" does not exist`, 404);
  const cfg = agentsConfig(d);
  const all = personas(d, cfg, ws);
  const persona = all.get(req.persona);
  if (!persona)
    throw usage(
      `${where}: no persona "${req.persona}" (personas: ${[...all.keys()].sort().join(", ")})`,
    );
  let given: string | null = null;
  if (req.name !== undefined)
    try {
      given = checkDisplayName(req.name);
    } catch (e) {
      throw usage(`${where}: ${(e as Error).message}`);
    }
  const id =
    req.id ??
    (given ? await namedId(d, given, ws) : null) ??
    defaultId(d.stateDir(), persona.id, ws);
  checkId(where, id);
  syncCatalog(d);
  const rt = runtimeFor(req.runtime ?? persona.runtime ?? DEFAULT_RUNTIME_ID);
  const det = await availableOrRefuse(d, rt, ws);
  const ch = startChoices(req, persona, rt, workspacePermissionOf(d, ws));
  const model = launchModel(ch.model, ch.version);

  const prev = readRecord(d.stateDir(), id);
  if (prev && prev.workspace !== ws)
    throw refused(
      `agent ${id} belongs to workspace ${prev.workspace}; give this one another --id`,
    );
  ptyOrRefuse(d);
  const allow = allowedFor(d, persona, ch.extras);
  // D24: the name peers see it by, from the name it will have (below).
  const peerName = peerSessionName(d.cli, ws, {
    id,
    displayName: given ?? prev?.displayName ?? persona.displayName,
  });
  const base = launchInput(
    d,
    cfg,
    persona,
    ws,
    id,
    model,
    det.path,
    undefined,
    {
      ...(ch.permission ? { permission: ch.permission } : {}),
      ...(rt.permissions ? { allow } : {}),
    },
  );
  // HUB-1.5: Den Hub's MCP server, when hub.url is set.
  const hub = await agentHub(d);
  const input = {
    ...base,
    ...(hub ? { mcp: { ...base.mcp, hub } } : {}),
    sessionLabel: peerName,
    ...(more.firstPrompt ? { firstPrompt: more.firstPrompt } : {}),
    // 0.4.18: Start agent here: in a folder of the workspace's.
    ...(req.folder !== undefined && !more.bringIn
      ? { worktree: startFolder(d, ws, req.folder) }
      : {}),
    // AG-17.1: the runtime's resume, in the folder the conversation ran in.
    ...(more.bringIn
      ? { worktree: more.bringIn.cwd, resumeToken: more.bringIn.token }
      : {}),
  };
  // AG-13.4: a command a runtime can't express is said, never dropped.
  const unexpressed =
    !rt.permissions && allow.length
      ? [
          `${rt.id} can't take allowed commands from Den yet: ${allow.join(", ")} not applied (it asks as usual)`,
        ]
      : [];

  return withClient(d, async (c) => {
    const sessions = await c.list();
    const old = prev ? sessionOf(sessions, prev) : undefined;
    if (old && !old.exited)
      throw new AgentError(`agent ${id} is running (${old.name})`, {
        status: 409,
        hints: [`Attach: ${d.cli} sessions attach ${old.name}`],
        running: { id, sessionId: old.ref.id },
      });
    const out = more.bringIn
      ? { ...broughtIn(rt, input), resumeToken: more.bringIn.token }
      : launchOrThrow(() => rt.launch(input));
    more.beforeLaunch?.();
    // A new conversation: a handoff left from the last one is kept aside,
    // so the next rotation needs its own (den#4).
    if (fs.existsSync(handoffFile(input.filesDir)))
      archiveHandoff(
        input.filesDir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-unused`,
      );
    writeRuntimeFiles(input.filesDir, out.files);
    // den#4: a new conversation's compactions count from 0.
    launchRotation(input.filesDir, out.resumeToken, launchAfter(rt, input));
    const { rec, info } = await startSession(
      d,
      c,
      {
        rec: {
          id,
          persona: persona.id,
          runtime: rt.id,
          ...(ch.model ? { model: ch.model } : {}),
          ...(ch.model ? { version: ch.version } : {}),
          ...(ch.permission ? { permission: ch.permission } : {}),
          ...(req.allow !== undefined ? { allow: ch.extras } : {}),
          ...(ch.overrides.length ? { overrides: ch.overrides } : {}),
          ...subagentsField(rt, persona, cfg),
          workspace: ws,
          cwd: input.worktree,
          sessionName: sessionName(d.dist, ws, id),
          peerName,
          // AG-4b: a name given to the agent is the agent's, not its
          // conversation's: Start fresh and Relaunch keep it. AG-10.8:
          // else its persona's name ("Rita").
          // AG-10.10: a name given at start wins.
          ...(given
            ? { displayName: given, displayNameAt: new Date().toISOString() }
            : prev?.displayName
              ? {
                  displayName: prev.displayName,
                  ...(prev.displayNameAt
                    ? { displayNameAt: prev.displayNameAt }
                    : {}),
                }
              : persona.displayName
                ? { displayName: persona.displayName }
                : {}),
          // 0.4.8: launched on this token, so a resume continues it.
          ...(out.resumeToken
            ? { resumeToken: out.resumeToken, launched: true }
            : {}),
          ...(more.bringIn ? { broughtInAt: new Date().toISOString() } : {}),
        },
        argv: out.argv,
        env: out.env,
        passthrough: rt.envPassthrough,
        launchEnv: rt.launchEnv,
        grants: cfg.agents[id]?.grants ?? [],
        ...binDirOf(det),
      },
      old,
      more.rotations?.length ? { rotations: more.rotations } : {},
    );
    const early = await exitedAtOnce(d, c, info);
    return {
      rec,
      info,
      warnings: [...(out.warnings ?? []), ...unexpressed],
      early,
    };
  });
}

/** A bring-in's launch: the runtime's resume (AG-17.1), never a new one. */
function broughtIn(
  rt: Runtime,
  input: LaunchInput,
): Omit<LaunchOutput, "resumeToken"> {
  const out = launchOrThrow(() => rt.resume?.(input) ?? null);
  if (!out) throw refused(`${rt.id} can't continue a conversation`);
  return out;
}

// ── AG-17.1: bring in a conversation ────────────────────────────────────────

/** A runtime's conversation as Bring in lists it. */
export interface ListedConversation extends RuntimeConversation {
  runtime: string;
  /** Written in the last minute: still open in another terminal. */
  open: boolean;
  /** The Den agent already continuing it, if one is. */
  agent?: string;
  /**
   * AG-17.1c: the persona Bring in preselects: the one of the latest Den
   * agent that worked in its folder (or one inside it), else the
   * workspace's latest agent's. The person confirms; never submitted.
   */
  suggest?: string;
  /**
   * AG-17.1c: the MCP servers its tools came from that Den won't load (an
   * agent runs with Den's tools only).
   */
  lost?: string[];
}

/** Each runtime, and whether it can bring a conversation in. */
export interface BringInRuntime {
  id: string;
  label: string;
  bringIn: boolean;
  /** Why it can't, for the page. */
  why?: string;
}

function bringInRuntimes(): BringInRuntime[] {
  return runtimeIds().map((id) => {
    const rt = getRuntime(id)!;
    const label = rt.label ?? id;
    return rt.listSessions
      ? { id, label, bringIn: true }
      : {
          id,
          label,
          bringIn: false,
          why: `${label} can't bring in a conversation yet`,
        };
  });
}

/** The conversation id each agent of this state dir continues. */
function agentByToken(d: AgentsResolved): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of listRecords(d.stateDir()))
    if (r.resumeToken) m.set(`${r.runtime} ${r.resumeToken}`, r.id);
  return m;
}

/**
 * The conversations Bring in offers for workspace `ws` (AG-17.1): each
 * runtime's own (only those with listSessions), that ran in the
 * workspace's folder or inside it, newest first. Reading never starts
 * anything; a runtime's history is read only at the ends of each file.
 */
export function listConversations(
  d: AgentsResolved,
  ws: string,
  runtime?: string,
): { runtimes: BringInRuntime[]; conversations: ListedConversation[] } {
  const where = "agents import";
  checkWorkspaceName(where, ws);
  if (!d.workspaceExists(ws))
    throw usage(`${where}: workspace "${ws}" does not exist`, 404);
  syncCatalog(d);
  if (runtime !== undefined) runtimeFor(runtime);
  // Its folder and every repo's; a shared root only exactly (AG-17.1).
  const scope = d.workspaceFolders(ws);
  const taken = agentByToken(d);
  const suggestFor = personaSuggester(d, ws);
  const now = Date.now();
  const conversations: ListedConversation[] = [];
  const seen = new Set<string>();
  for (const id of runtimeIds()) {
    if (runtime !== undefined && id !== runtime) continue;
    const rt = getRuntime(id);
    if (!rt?.listSessions) continue;
    for (const c of rt.listSessions(scope, d.env)) {
      if (seen.has(`${id} ${c.id}`)) continue;
      seen.add(`${id} ${c.id}`);
      const agent = taken.get(`${id} ${c.id}`);
      const lost = (c.mcp ?? []).filter((m) => m !== d.cli);
      const suggest = suggestFor(c.cwd);
      conversations.push({
        ...c,
        runtime: id,
        open: openElsewhere(c.lastAt, now),
        ...(agent ? { agent } : {}),
        ...(suggest ? { suggest } : {}),
        ...(lost.length ? { lost } : {}),
      });
    }
  }
  conversations.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { runtimes: bringInRuntimes(), conversations };
}

/**
 * AG-17.1c: the persona to preselect for a conversation that ran in a
 * folder: the latest agent's of this workspace that worked there (or in a
 * folder inside it), else the workspace's latest agent's; only a persona
 * that still exists. Undefined: none to suggest (the page's first).
 */
function personaSuggester(
  d: AgentsResolved,
  ws: string,
): (cwd: string) => string | undefined {
  let known: Set<string>;
  try {
    known = new Set(personas(d, agentsConfig(d)).keys());
  } catch {
    return () => undefined;
  }
  const recs = listRecords(d.stateDir())
    .filter((r) => r.workspace === ws && known.has(r.persona))
    .sort((a, b) =>
      (b.resumedAt ?? b.startedAt).localeCompare(a.resumedAt ?? a.startedAt),
    );
  const inside = (p: string, dir: string) => {
    const rel = path.relative(dir, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  return (cwd) =>
    (recs.find((r) => inside(r.cwd, cwd) || inside(cwd, r.cwd)) ?? recs[0])
      ?.persona;
}

export interface ImportRequest {
  workspace: string;
  /** The runtime's conversation id. */
  session: string;
  persona: string;
  runtime?: string;
  id?: string;
  /**
   * AG-17.1c: a model for it (Advanced). Absent: the conversation's own
   * (its last answer's), else the persona's.
   */
  model?: string;
  /** With model: "latest" or a pinned version (AG-12.3). */
  version?: string;
}

/** The persona's id, else the first `<persona>-<n>` no agent has. */
function freeId(d: AgentsResolved, persona: string): string {
  if (!readRecord(d.stateDir(), persona)) return persona;
  for (let n = 2; n < 1000; n++) {
    const id = `${persona.slice(0, 58)}-${n}`;
    if (!readRecord(d.stateDir(), id)) return id;
  }
  throw refused(`no free agent id for ${persona}: give one with --id`);
}

/**
 * Bring a conversation in (AG-17.1): the runtime's resume of it, under Den
 * (its token, hooks, guards, the folder it ran in, the audit trail), as a
 * new agent with the persona given. Afterwards it is an agent like any
 * other: stop, resume, rename. Refused while the conversation is open in
 * another terminal (written in the last minute), when an agent already
 * continues it, or when it isn't one of the workspace's.
 */
export async function importAgent(
  d: AgentsResolved,
  req: ImportRequest,
): Promise<Started> {
  const where = "agents import";
  const runtime = req.runtime ?? DEFAULT_RUNTIME_ID;
  const { runtimes, conversations } = listConversations(
    d,
    req.workspace,
    runtime,
  );
  const rt = runtimes.find((r) => r.id === runtime);
  if (!rt?.bringIn)
    throw refused(
      rt?.why ?? `${runtime} can't bring in a conversation`,
      [],
      422,
    );
  const c = conversations.find((x) => x.id === req.session);
  // Another workspace's (or no repo's): say whose, never bring it in.
  const elsewhere = c
    ? null
    : (getRuntime(runtime)?.conversationCwd?.(req.session, d.env) ?? null);
  if (!c && elsewhere && !inScope(elsewhere, d.workspaceFolders(req.workspace)))
    throw refused(
      `This conversation belongs to ${elsewhere}, not to workspace ${req.workspace}`,
      [`List this workspace's: ${d.cli} agents import -w ${req.workspace}`],
      409,
    );
  if (!c)
    throw refused(
      `${where}: no ${rt.label} conversation "${req.session}" in workspace ${req.workspace}'s folder`,
      [`List them: ${d.cli} agents import -w ${req.workspace}`],
      404,
    );
  if (c.agent)
    throw new AgentError(
      `${where}: agent ${c.agent} already continues this conversation`,
      {
        code: "already_agent",
        hints: [
          `Resume it: ${d.cli} agents resume ${c.agent} -w ${req.workspace}`,
        ],
      },
    );
  if (c.open)
    throw new AgentError(OPEN_ELSEWHERE_MESSAGE, { code: "open_elsewhere" });
  if (!fs.statSync(c.cwd, { throwIfNoEntry: false })?.isDirectory())
    throw refused(`${where}: the folder it ran in, ${c.cwd}, is gone`);
  const id = req.id ?? freeId(d, req.persona);
  if (readRecord(d.stateDir(), id))
    throw refused(`${where}: agent ${id} exists; give this one another --id`);
  // AG-17.1c: the conversation keeps its own model unless one is picked.
  const model = req.model ?? c.model;
  return startAgent(
    d,
    {
      workspace: req.workspace,
      persona: req.persona,
      runtime,
      id,
      ...(model ? { model } : {}),
      ...(req.model !== undefined && req.version !== undefined
        ? { version: req.version }
        : {}),
      // A model picked on the page is checked against the catalog; the
      // conversation's own is taken as it ran.
      ...(req.model !== undefined ? { strict: true } : {}),
    },
    { bringIn: { token: c.id, cwd: c.cwd } },
  );
}

// ── stop, resume ────────────────────────────────────────────────────────────

/** The code of a refusal naming another workspace's agent. */
export const NOT_IN_WORKSPACE = "not_in_workspace";

/** Agent `id`'s record; with `ws`, only when it is that workspace's. */
export function agentRecord(
  d: AgentsResolved,
  id: string,
  ws?: string,
): AgentRecord {
  const rec = readRecord(d.stateDir(), id);
  // Another workspace's agent is, from this one, no agent at all.
  if (!rec) throw refused(`no agent "${id}"`, [], 404);
  if (ws && ws !== rec.workspace)
    throw new AgentError(
      `agent ${id} is in workspace ${rec.workspace}, not ${ws}`,
      { status: 404, code: NOT_IN_WORKSPACE },
    );
  return rec;
}

/**
 * Name agent `id` (AG-4b: a person double-clicked its tab): `name` as
 * checkDisplayName takes it; null or blank clears it. The id never
 * changes. A usage error (400) when the name isn't one.
 */
export function renameAgent(
  d: AgentsResolved,
  id: string,
  ws: string,
  name: unknown,
): AgentRecord {
  const rec = agentRecord(d, id, ws);
  let checked: string | null;
  try {
    checked = checkDisplayName(name);
  } catch (e) {
    throw usage((e as Error).message);
  }
  const next: AgentRecord = { ...rec };
  if (checked) {
    next.displayName = checked;
    // AG-4b: the latest rename wins, Den's or the runtime's.
    next.displayNameAt = new Date().toISOString();
  } else {
    delete next.displayName;
    delete next.displayNameAt;
  }
  writeRecord(d.stateDir(), next);
  return next;
}

export interface Stopped {
  rec: AgentRecord;
  /** The session it sent TERM to; undefined when it wasn't running. */
  session?: SessionInfo;
  /** Its session was still running when the wait ran out. */
  stillStopping?: boolean;
}

/**
 * Stop: TERM to the agent's session, then wait (up to d.stopWaitMs) until
 * the session has ended, so a resume right after it never finds the agent
 * still running. Still running at the bound: `stillStopping`. With
 * `wait: false` (or d.stopWaitMs 0) it returns once TERM is sent.
 */
export async function stopAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
  opts: { wait?: boolean } = {},
): Promise<Stopped> {
  const rec = agentRecord(d, id, ws);
  return withClient(d, async (c) => {
    const s = sessionOf(await c.list(), rec);
    // Its token stops working before the session is asked to end.
    revokeAgentTokens(d.stateDir(), rec.id);
    const live = Boolean(s && !s.exited);
    if (live) await c.kill(s!.ref.id, "TERM");
    const next = { ...rec, stoppedAt: new Date().toISOString() };
    writeRecord(d.stateDir(), next);
    let stillStopping = false;
    if (live && opts.wait !== false && d.stopWaitMs > 0) {
      const deadline = Date.now() + d.stopWaitMs;
      for (;;) {
        const now = (await c.list()).find((x) => x.ref.id === s!.ref.id);
        if (!now || now.exited) break;
        if (Date.now() >= deadline) {
          stillStopping = true;
          break;
        }
        await new Promise((r) => setTimeout(r, EXIT_POLL_MS));
      }
    }
    return {
      rec: next,
      ...(live ? { session: s! } : {}),
      ...(stillStopping ? { stillStopping } : {}),
    };
  });
}

export interface Resumed extends Started {
  /** Never prompted: started afresh under the same conversation id. */
  fresh: boolean;
}

/**
 * The grants a resume serves (AG-14): the ones the agent had, never more
 * than agents.<id>.grants gives now (a grant taken out of the config is
 * gone). A record from before 0.4.8 has none noted: the config's.
 */
export function resumeGrants(
  rec: AgentRecord,
  cfg: ResolvedAgentsConfig,
): string[] {
  const now = cfg.agents[rec.id]?.grants ?? [];
  if (!rec.grants) return [...now];
  return rec.grants.filter((g) => now.includes(g));
}

export async function resumeAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<Resumed> {
  const rec = agentRecord(d, id, ws);
  syncCatalog(d);
  const rt = runtimeFor(rec.runtime);
  // AG-14.2: never a resume that would start a new conversation instead.
  const why = resumeRefusal(rec);
  if (why)
    throw refused(why, [
      `Start fresh: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id}`,
    ]);
  // den#4: a rotated conversation ends there; its role relaunches from
  // the handoff, in a fresh one.
  const rot = rotationOf(d, rec);
  // D28: on_due off: nothing happens, its conversation goes on.
  if (rot?.ready && rot.onDue !== "off")
    throw new AgentError(
      `agent ${rec.id} rotated after ${reasonText(rot.due!, rot.compactions)}: its conversation is not resumed`,
      {
        code: "rotated",
        hints: [
          `Relaunch from handoff: ${d.cli} agents relaunch ${rec.id}`,
          `Start fresh: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id}`,
        ],
      },
    );
  const cfg = agentsConfig(d);
  const grants = resumeGrants(rec, cfg);
  const persona = personas(d, cfg, rec.workspace).get(rec.persona);
  if (!persona)
    throw refused(`agent ${rec.id}'s persona "${rec.persona}" is gone`);
  const det = await availableOrRefuse(d, rt, rec.workspace);
  ptyOrRefuse(d);
  return withClient(d, async (c) => {
    const old = sessionOf(await c.list(), rec);
    if (old && !old.exited)
      throw refused(`agent ${rec.id} is running (${old.name})`, [
        `Attach: ${d.cli} sessions attach ${old.name}`,
      ]);
    const input = launchInput(
      d,
      cfg,
      persona,
      rec.workspace,
      rec.id,
      launchModel(rec.model, rec.version),
      det.path,
      grants,
      {
        ...(rec.permission ? { permission: rec.permission } : {}),
        ...(rt.permissions
          ? {
              allow: allowedFor(
                d,
                persona,
                rec.allow ?? persona.allowedCommands,
              ),
            }
          : {}),
      },
    );
    // Resume in the cwd the agent had, wherever the workspace points now.
    // D24 (and D25: a rename since) the name peers see it by.
    const peerName = peerSessionName(d.cli, rec.workspace, rec);
    const hub = await agentHub(d);
    const at = {
      ...input,
      ...(hub ? { mcp: { ...input.mcp, hub } } : {}),
      sessionLabel: peerName,
      worktree: rec.cwd,
      ...(rec.resumeToken ? { resumeToken: rec.resumeToken } : {}),
    };
    // 0.4.8: the runtime's own resume first, whenever this token was
    // launched (the record says so), its conversation is on disk, the last
    // session was prompted, or the host no longer lists it. Only a record
    // from before 0.4.8 whose session nobody prompted starts afresh under
    // the same id.
    const token = rec.resumeToken;
    // A runtime that can tell (den-claude: its transcript) decides before
    // launching: a conversation on disk, or a last session someone typed
    // into, resumes; neither starts fresh at once. Without that, the record
    // decides: launched on this token, or a session the host lost.
    const known = rt.conversationExists
      ? Boolean(token && rt.conversationExists(token, d.env)) ||
        Boolean(old?.prompted)
      : Boolean(rec.launched) || !old || Boolean(old.prompted);
    const launchAs = (asFresh: boolean) => {
      const out = launchOrThrow(() =>
        asFresh ? rt.launch(at) : rt.resume!(at),
      );
      if (!out) throw refused(`agent ${rec.id} has nothing to resume`);
      writeRuntimeFiles(input.filesDir, out.files);
      // den#4: the same conversation keeps its count.
      launchRotation(input.filesDir, token, launchAfter(rt, input));
      return out;
    };
    const { session: _s, startedAt: _t, resumedAt: _r, ...base } = rec;
    const run = async (asFresh: boolean, prior: SessionInfo | undefined) => {
      const out = launchAs(asFresh);
      const { rec: next, info } = await startSession(
        d,
        c,
        {
          rec: {
            ...base,
            ...subagentsField(rt, persona, cfg),
            cwd: rec.cwd,
            peerName,
            ...(token ? { launched: true } : {}),
          },
          argv: out.argv,
          env: out.env,
          passthrough: rt.envPassthrough,
          launchEnv: rt.launchEnv,
          grants,
          ...binDirOf(det),
        },
        prior,
        asFresh ? {} : { resumedAt: new Date().toISOString() },
      );
      const early = await exitedAtOnce(d, c, info);
      return { out, next, info, early };
    };
    let fresh = !known && Boolean(token);
    let r = await run(fresh, old);
    // It exited at once saying the other way was the right one: try that,
    // once. A resume with nothing to continue starts fresh under the same
    // id; a fresh start whose id is taken resumes it.
    const said = r.early?.said ?? "";
    const other = fresh
      ? rt.launchFailures?.idInUse?.test(said)
      : rt.launchFailures?.noConversation?.test(said);
    if (r.early && other && token) {
      const first = r;
      fresh = !fresh;
      // The first try's token goes with its session.
      revokeAgentTokens(d.stateDir(), rec.id);
      r = await run(
        fresh,
        (await c.list()).find((x) => x.ref.id === first.info.ref.id),
      );
      if (r.early)
        throw new AgentError(
          `agent ${rec.id}: conversation ${token} could not be continued or started (${rt.id} exited at once both ways: ${[...first.early!.tail, ...r.early.tail].slice(-4).join(" / ") || "no output"})`,
          {
            status: 502,
            code: "resume_failed",
            hints: [
              `Start fresh: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id} (a new conversation)`,
            ],
          },
        );
    }
    return {
      rec: r.next,
      info: r.info,
      warnings: r.out.warnings ?? [],
      early: r.early,
      fresh,
    };
  });
}

// ── AG-18: change a running agent's persona ─────────────────────────────────

/** The refusal code while its turn is going and no `when` was given. */
export const PERSONA_BUSY = "busy";

export interface PersonaRequest {
  persona: string;
  /** Advanced: another model. Absent: the one it runs (the conversation's). */
  model?: string;
  /** With model: "latest" or a pinned version. */
  version?: string;
  /**
   * Mid-turn: "after-turn" waits until its turn ends, "now" stops it. None:
   * refused (PERSONA_BUSY) while it works, so a turn is never cut silently.
   */
  when?: "now" | "after-turn";
  /** Who asked (a person's sign-in, "cli"), for its record. */
  by?: string;
}

export interface PersonaChanged extends Resumed {
  from: string;
}

/**
 * What a resume with nothing to continue yet says (AG-14, AG-18): the
 * runtime started fresh under the same conversation id.
 */
export const FRESH_NOTE =
  "nothing to resume yet; started fresh (same conversation id, folder and scope)";

/** How often, and how long, "after this turn" checks its turn (AG-18). */
export const TURN_POLL_MS = 1_000;
export const TURN_WAIT_MS = 30 * 60_000;

/**
 * Whether agent `rec` is mid-turn: true or false from its runtime (den-
 * claude: its transcript), null when it can't tell. Not running: false.
 */
async function agentBusy(
  d: AgentsResolved,
  rec: AgentRecord,
): Promise<boolean | null> {
  const live = await withClient(d, async (c) => {
    const s = sessionOf(await c.list(), rec);
    return Boolean(s && !s.exited);
  });
  if (!live) return false;
  const rt = getRuntime(rec.runtime);
  if (!rt?.turnBusy || !rec.resumeToken) return null;
  let readMaxBytes: number | undefined;
  try {
    readMaxBytes = d.agentsConfig().turnReadMaxBytes;
  } catch {
    /* unreadable config: the default */
  }
  return rt.turnBusy(rec.resumeToken, d.env, { readMaxBytes });
}

/** Why agent `rec` can't change persona (it can't resume), or null. */
export function personaChangeRefusal(rec: AgentRecord): string | null {
  const rt = getRuntime(rec.runtime);
  if (!rt?.resume)
    return `${rt?.label ?? rec.runtime} can't continue a conversation, so it can't change persona`;
  return resumeRefusal(rec);
}

/**
 * AG-18, change persona: Den stops the agent's session and resumes the
 * same conversation with the new persona's launch settings (its role
 * prompt, permission mode, allowed commands). The history stays; so do the
 * id, name, workspace, folder and grants, and the model it runs unless
 * one is given. Mid-turn it never stops a turn unasked: refused with
 * PERSONA_BUSY, or `when` says to wait for the turn's end or stop now.
 * Only a runtime that can resume can. The person's only: callers refuse an
 * agent's token before this.
 */
export async function changePersona(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
  req: PersonaRequest,
  opts: { pollMs?: number; maxMs?: number } = {},
): Promise<PersonaChanged> {
  const where = "agents persona";
  const rec = agentRecord(d, id, ws);
  const cfg = agentsConfig(d);
  const all = personas(d, cfg, rec.workspace);
  if (!all.get(req.persona))
    throw usage(
      `${where}: no persona "${req.persona}" (personas: ${[...all.keys()].sort().join(", ")})`,
    );
  if (req.persona === rec.persona && req.model === undefined)
    throw usage(`${where}: agent ${rec.id} is already ${rec.persona}`);
  const why = personaChangeRefusal(rec);
  if (why) throw refused(why, [], 422);
  let busy = await agentBusy(d, rec);
  if (busy !== false && req.when === undefined)
    throw new AgentError(
      busy
        ? `agent ${rec.id} is working. Change after this turn, or stop it now?`
        : `agent ${rec.id} is running and Den can't tell whether it is mid-turn. Change after this turn, or stop it now?`,
      {
        status: 409,
        code: PERSONA_BUSY,
        hints: [
          `After this turn: ${d.cli} agents persona ${rec.id} ${req.persona} --after-turn`,
          `Stop it now: ${d.cli} agents persona ${rec.id} ${req.persona} --now`,
        ],
      },
    );
  if (busy === null && req.when === "after-turn")
    throw refused(
      `${where}: Den can't tell when agent ${rec.id}'s turn ends; stop it now instead (--now)`,
    );
  if (req.when !== "after-turn") return switchPersona(d, rec, req, where);
  // Waiting: marked on the record, so a restart that drops the wait can
  // say so (cancelStalePersonaChanges); cleared however this ends.
  writeRecord(d.stateDir(), {
    ...rec,
    pendingPersona: {
      to: req.persona,
      since: new Date().toISOString(),
      ...(req.by ? { by: req.by } : {}),
    },
  });
  try {
    const deadline = Date.now() + (opts.maxMs ?? TURN_WAIT_MS);
    while (busy) {
      if (Date.now() >= deadline)
        throw refused(
          `${where}: agent ${rec.id} was still working after ${Math.round((opts.maxMs ?? TURN_WAIT_MS) / 60_000)} min; nothing changed`,
        );
      await new Promise((r) => setTimeout(r, opts.pollMs ?? TURN_POLL_MS));
      busy = await agentBusy(d, agentRecord(d, id, ws));
    }
    return await switchPersona(d, rec, req, where);
  } catch (e) {
    clearPendingPersona(d, rec.id);
    throw e;
  }
}

/**
 * D44, Restart: stop agent `id` and resume the same conversation, so it
 * launches with what it gets now (Hub's tools, for one). `after-turn` (the
 * default) waits for its turn to end; `now` stops it at once. Never cuts a
 * turn otherwise: Den that can't tell when a turn ends refuses after-turn.
 * A stopped agent just resumes. The person's only (callers refuse agents).
 */
export async function restartAgent(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
  when: "now" | "after-turn" = "after-turn",
  opts: { pollMs?: number; maxMs?: number } = {},
): Promise<Resumed> {
  const where = "agents restart";
  const rec = agentRecord(d, id, ws);
  const why = personaChangeRefusal(rec);
  if (why)
    throw refused(
      why.replace("change persona", "restart and keep its conversation"),
      [],
      422,
    );
  let busy = await agentBusy(d, rec);
  if (busy === null && when === "after-turn")
    throw refused(
      `${where}: Den can't tell when agent ${rec.id}'s turn ends; restart it now instead (--now)`,
    );
  if (when === "after-turn") {
    const deadline = Date.now() + (opts.maxMs ?? TURN_WAIT_MS);
    while (busy) {
      if (Date.now() >= deadline)
        throw refused(
          `${where}: agent ${rec.id} was still working after ${Math.round((opts.maxMs ?? TURN_WAIT_MS) / 60_000)} min; not restarted`,
        );
      await new Promise((r) => setTimeout(r, opts.pollMs ?? TURN_POLL_MS));
      busy = await agentBusy(d, agentRecord(d, id, ws));
    }
  }
  const stopped = await stopAgent(d, rec.id, rec.workspace);
  if (stopped.stillStopping)
    throw refused(
      `${where}: agent ${rec.id} is still stopping; try again in a moment`,
    );
  return resumeAgent(d, rec.id, rec.workspace);
}

/** Drop agent `id`'s pending persona change mark, if it has one. */
function clearPendingPersona(d: AgentsResolved, id: string): void {
  const cur = readRecord(d.stateDir(), id);
  if (!cur?.pendingPersona) return;
  const { pendingPersona: _pp, ...rest } = cur;
  writeRecord(d.stateDir(), rest);
}

/**
 * At start (AG-18): every persona change still marked pending was dropped
 * when Den stopped, since the wait lived in memory. Clears each mark and
 * returns them, for the audit trail.
 */
export function cancelStalePersonaChanges(d: AgentsResolved): {
  id: string;
  workspace: string;
  from: string;
  to: string;
  by?: string;
}[] {
  const out: ReturnType<typeof cancelStalePersonaChanges> = [];
  for (const rec of listRecords(d.stateDir())) {
    const p = rec.pendingPersona;
    if (!p) continue;
    clearPendingPersona(d, rec.id);
    out.push({
      id: rec.id,
      workspace: rec.workspace,
      from: rec.persona,
      to: p.to,
      ...(p.by ? { by: p.by } : {}),
    });
  }
  return out;
}

/** The switch itself: stop, the new persona's settings, resume. */
async function switchPersona(
  d: AgentsResolved,
  rec: AgentRecord,
  req: PersonaRequest,
  where: string,
): Promise<PersonaChanged> {
  const stopped = await stopAgent(d, rec.id, rec.workspace);
  if (stopped.stillStopping)
    throw refused(
      `${where}: agent ${rec.id} is still stopping; try again in a moment`,
    );
  // The new persona's permissions apply: the old one's choices go. The
  // model stays (the conversation's) unless one is given.
  const {
    permission: _p,
    allow: _a,
    overrides: _o,
    pendingPersona: _pp,
    ...base
  } = stopped.rec;
  const keptOverrides = (rec.overrides ?? []).filter(
    (o) => o === "runtime" || o === "model" || o === "version",
  );
  const next: AgentRecord = {
    ...base,
    persona: req.persona,
    ...(req.model !== undefined
      ? { model: req.model, version: req.version ?? "latest" }
      : {}),
    ...(keptOverrides.length || req.model !== undefined
      ? {
          overrides: [
            ...new Set([
              ...keptOverrides,
              ...(req.model !== undefined ? (["model"] as const) : []),
            ]),
          ],
        }
      : {}),
    personaChanges: [
      ...(rec.personaChanges ?? []),
      {
        from: rec.persona,
        to: req.persona,
        at: new Date().toISOString(),
        ...(req.by ? { by: req.by } : {}),
      },
    ],
  };
  writeRecord(d.stateDir(), next);
  const r = await resumeAgent(d, rec.id, rec.workspace);
  return { ...r, from: rec.persona };
}

// ── AG-14: start fresh, remove, restart ─────────────────────────────────────

/**
 * A new conversation for agent `id` (AG-14.1 Start fresh): the same
 * persona, runtime, model and workspace, under the same id. Its last
 * conversation stays in the runtime's own history.
 */
export async function startFresh(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<Started> {
  const rec = agentRecord(d, id, ws);
  return startAgent(d, {
    workspace: rec.workspace,
    persona: rec.persona,
    runtime: rec.runtime,
    ...keptChoices(rec),
    id: rec.id,
  });
}

/**
 * What a record was started with (AG-10.9), for Start fresh and Relaunch:
 * the same model, version, permission and extra commands.
 */
function keptChoices(rec: AgentRecord): Partial<StartRequest> {
  return {
    ...(rec.model ? { model: rec.model } : {}),
    ...(rec.version ? { version: rec.version } : {}),
    ...(rec.permission ? { permission: rec.permission } : {}),
    ...(rec.allow ? { allow: [...rec.allow] } : {}),
  };
}

// ── den#4: relaunch from handoff ────────────────────────────────────────────

export interface Relaunched extends Started {
  /** Why the last session rotated: "3 compactions", "PR merged". */
  why: string;
  /** Where its handoff was kept. */
  handoff: string;
}

/**
 * Relaunch from handoff (den#4): once agent `id`'s session rotated (a
 * trigger fired and handoff.md passes the check), a fresh conversation
 * with the same persona, runtime, model, workspace, folder and grants,
 * whose first prompt is the handoff. A running session is stopped first.
 * The handoff moves to handoffs/ so the next rotation needs a new one.
 * Missing or failing: refused, saying so, with Start fresh and Resume.
 */
export async function relaunchAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
  /** D28: Den relaunched it by itself (on_due auto). */
  o: { auto?: boolean } = {},
): Promise<Relaunched> {
  const rec = agentRecord(d, id, ws);
  syncCatalog(d);
  const rt = runtimeFor(rec.runtime);
  const files = agentFilesDir(d.stateDir(), rec.id);
  const rot = rotationOf(d, rec);
  const fresh = `Start fresh: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id}`;
  const resume = `Resume: ${d.cli} agents resume ${rec.id}`;
  if (!rt.firstPrompt)
    throw refused(`${rec.runtime} can't start a conversation from a handoff`, [
      fresh,
    ]);
  if (!rot?.due)
    throw refused(`agent ${rec.id} has not rotated: resume it instead`, [
      resume,
    ]);
  const h = readHandoff(files);
  if (h.status !== "ok")
    throw new AgentError(
      h.status === "missing"
        ? `agent ${rec.id} has no handoff.md yet, so it can't relaunch from one`
        : `agent ${rec.id}'s handoff.md is not ready: ${h.problems.join(" ")}`,
      { code: "no_handoff", hints: [fresh, resume] },
    );
  // The rotated session ends here, if it is still open.
  const s = sessionOf(await hostSessions(d), rec);
  if (s && !s.exited) {
    const stopped = await stopAgent(d, rec.id, ws);
    if (stopped.stillStopping)
      throw refused(`agent ${rec.id} is still stopping; try again`);
  }
  const now = new Date().toISOString();
  const why = reasonText(rot.due, rot.compactions);
  const entry = {
    at: now,
    reason: rot.due,
    compactions: rot.compactions,
    ...(rec.resumeToken ? { conversation: rec.resumeToken } : {}),
    ...(o.auto ? { auto: true } : {}),
  };
  let kept = "";
  const before = readRotation(files);
  // The launch failed: the handoff and the rotation are as they were, for
  // the conversation the record now names, so Relaunch is offered again.
  const undo = (conversation?: string) => {
    if (kept && fs.existsSync(kept) && !fs.existsSync(handoffFile(files)))
      fs.renameSync(kept, handoffFile(files));
    if (before)
      writeRotation(files, {
        ...before,
        due: rot.due,
        ...(conversation ? { conversation } : {}),
      });
  };
  const started = await startAgent(
    d,
    {
      workspace: rec.workspace,
      persona: rec.persona,
      runtime: rec.runtime,
      ...keptChoices(rec),
      id: rec.id,
    },
    {
      firstPrompt: handoffPrompt(h.text!, rot.due, rot.compactions),
      rotations: [...(rec.rotations ?? []), entry],
      beforeLaunch: () => {
        kept = archiveHandoff(
          files,
          `${now.replace(/[:.]/g, "-")}-${rec.resumeToken ?? "conversation"}`,
        );
      },
    },
  ).catch((e: unknown) => {
    undo();
    throw e;
  });
  if (started.early) undo(started.rec.resumeToken);
  return { ...started, why, handoff: kept };
}

/** The host's sessions, never starting a host (none running: none). */
async function hostSessions(d: AgentsResolved): Promise<SessionInfo[]> {
  const c = await d.connectExisting();
  try {
    return c ? await c.list() : [];
  } finally {
    c?.close();
  }
}

/** An agent removed (AG-14.1b): what Undo brings back. */
export interface Removed {
  agent: string;
  workspace: string;
}

/**
 * Forget agents `ids` (AG-14.1b): each record moves aside for Undo, its
 * actor tokens are revoked and the host forgets its ended session. A
 * running agent is refused: stop it first. Never asks a host to start.
 */
async function removeRecords(
  d: AgentsResolved,
  recs: AgentRecord[],
): Promise<Removed[]> {
  const c = await d.connectExisting();
  try {
    const sessions = c ? await c.list() : [];
    for (const rec of recs) {
      const s = sessionOf(sessions, rec);
      if (!isStoppedState(rowState(rec, s)))
        throw refused(`agent ${rec.id} is running: stop it first`, [
          `${d.cli} agents stop ${rec.id}`,
        ]);
    }
    const out: Removed[] = [];
    for (const rec of recs) {
      const s = sessionOf(sessions, rec);
      revokeAgentTokens(d.stateDir(), rec.id);
      if (c && s?.exited) await c.forget(s.ref.id).catch(() => undefined);
      if (removeRecord(d.stateDir(), rec.id))
        out.push({ agent: rec.id, workspace: rec.workspace });
    }
    purgeRemoved(d.stateDir());
    return out;
  } finally {
    c?.close();
  }
}

export async function removeAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<Removed[]> {
  return removeRecords(d, [agentRecord(d, id, ws)]);
}

/**
 * Remove every stopped, interrupted or exited agent of `workspaces`
 * (AG-14.1b Clear stopped); running ones stay.
 */
export async function removeStopped(
  d: AgentsResolved,
  workspaces: readonly string[],
): Promise<Removed[]> {
  const sessions = await hostSessions(d);
  const recs = listRecords(d.stateDir()).filter(
    (r) =>
      workspaces.includes(r.workspace) &&
      isStoppedState(rowState(r, sessionOf(sessions, r))),
  );
  return removeRecords(d, recs);
}

/** Undo: bring removed agents back; the ones that came back. */
export function restoreAgents(
  d: AgentsResolved,
  ids: readonly string[],
): string[] {
  return ids.filter((id) => restoreRecord(d.stateDir(), id));
}

/**
 * Forget stopped and exited agents older than `days` (AG-14.1b,
 * agents.remove_stopped_after in user.yml; 0: never). Interrupted ones
 * are never forgotten. Returns the ids forgotten.
 */
export async function pruneStopped(
  d: AgentsResolved,
  days: number,
  now = Date.now(),
): Promise<string[]> {
  if (!(days > 0)) return [];
  const sessions = await hostSessions(d);
  const cutoff = now - days * 86_400_000;
  const old = listRecords(d.stateDir()).filter((r) => {
    const st = rowState(r, sessionOf(sessions, r));
    if (st === "interrupted" || !isStoppedState(st)) return false;
    const at = Date.parse(r.stoppedAt ?? r.endedAt ?? r.startedAt);
    return Number.isFinite(at) && at < cutoff;
  });
  for (const r of old) {
    revokeAgentTokens(d.stateDir(), r.id);
    removeRecord(d.stateDir(), r.id);
  }
  purgeRemoved(d.stateDir(), 0, now);
  return old.map((r) => r.id);
}

/** What a restart found (AG-14.3). */
export interface RestartFound {
  /** Agents newly marked interrupted. */
  interrupted: string[];
  /** Of those, the ones resumed on their own (standing, resume_on_restart). */
  resumed: string[];
  /** Ones that should have resumed but couldn't, with why. */
  failed: { agent: string; why: string }[];
}

/**
 * When the web server starts (AG-14.3): every agent whose session is gone
 * though nobody stopped it and it never exited is marked interrupted. A
 * session host that survived a web-server-only restart still lists its
 * sessions, so nothing is marked. Then the standing personas, and those
 * with `resume_on_restart: true`, resume (when their runtime can); the
 * rest wait for someone to click Resume.
 */
export async function markInterrupted(
  d: AgentsResolved,
  opts: { autoResume?: boolean } = {},
): Promise<RestartFound> {
  const sessions = await hostSessions(d);
  const found: RestartFound = { interrupted: [], resumed: [], failed: [] };
  const now = new Date().toISOString();
  const marked: AgentRecord[] = [];
  for (const rec of listRecords(d.stateDir())) {
    if (rec.interruptedAt) continue;
    if (rowState(rec, sessionOf(sessions, rec)) !== "interrupted") continue;
    const next = { ...rec, interruptedAt: now };
    writeRecord(d.stateDir(), next);
    marked.push(next);
    found.interrupted.push(rec.id);
  }
  if (opts.autoResume === false || !marked.length) return found;
  let all: Map<string, Persona>;
  try {
    all = personas(d, agentsConfig(d));
  } catch {
    return found;
  }
  for (const rec of marked) {
    const p = personaOfRecord(rec, all);
    if (!p || !resumesOnRestart(rec, p)) continue;
    if (resumeRefusal(rec)) continue;
    try {
      // den#4: a rotated one relaunches from its handoff instead.
      const r = rotationOf(d, rec)?.ready
        ? await relaunchAgent(d, rec.id)
        : await resumeAgent(d, rec.id);
      if (r.early) found.failed.push({ agent: rec.id, why: "exited at once" });
      else found.resumed.push(rec.id);
    } catch (e) {
      found.failed.push({ agent: rec.id, why: (e as Error).message });
    }
  }
  return found;
}

/**
 * Resume every interrupted agent of `workspaces` that can resume
 * (AG-14.3 "Resume all", `agents resume --all-interrupted`).
 */
export async function resumeInterrupted(
  d: AgentsResolved,
  workspaces?: readonly string[],
): Promise<{
  resumed: Resumed[];
  failed: { agent: string; why: string }[];
}> {
  const sessions = await hostSessions(d);
  const recs = listRecords(d.stateDir()).filter(
    (r) =>
      (!workspaces || workspaces.includes(r.workspace)) &&
      rowState(r, sessionOf(sessions, r)) === "interrupted",
  );
  const resumed: Resumed[] = [];
  const failed: { agent: string; why: string }[] = [];
  for (const rec of recs) {
    const rot = rotationOf(d, rec);
    const why =
      resumeRefusal(rec) ?? (rot?.ready ? rotatedRefusal(rec, rot) : null);
    if (why) {
      failed.push({ agent: rec.id, why });
      continue;
    }
    try {
      const r = await resumeAgent(d, rec.id);
      if (r.early) failed.push({ agent: rec.id, why: "exited at once" });
      else resumed.push(r);
    } catch (e) {
      failed.push({ agent: rec.id, why: (e as Error).message });
    }
  }
  return { resumed, failed };
}

// ── AG-10.1: the first instruction, a plain session ─────────────────────────

/** The longest first instruction. */
export const MAX_INSTRUCTION = 8000;

/**
 * A first instruction, checked: text of up to MAX_INSTRUCTION characters,
 * newlines and tabs allowed, no other control character (no escape
 * sequence can ride along) and no bidi override. Blank is none (null).
 */
export function checkInstruction(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw usage("instruction must be a string");
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (!t) return null;
  if (t.length > MAX_INSTRUCTION)
    throw usage(`instruction must be at most ${MAX_INSTRUCTION} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(t))
    throw usage("instruction can't have control characters");
  return t;
}

/** How long the session must print nothing before it counts as ready. */
export const READY_QUIET_MS = 800;
/** The longest a first instruction waits for the session to be ready. */
export const READY_MAX_MS = 30_000;
const READY_POLL_MS = 150;
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";

/**
 * The bytes a first instruction is typed as: a bracketed paste when the
 * program turned bracketed paste on (its output has ESC[?2004h, last), so
 * newlines stay newlines; else each newline as the runtime's soft newline
 * (catalog softNewline). Then Enter, separately.
 */
export function instructionBytes(
  text: string,
  said: string,
  softNewline: string,
): { body: string; enter: string } {
  const paste = said.lastIndexOf(PASTE_ON) > said.lastIndexOf(PASTE_OFF);
  return {
    body: paste
      ? `\x1b[200~${text}\x1b[201~`
      : text.split("\n").join(softNewline),
    enter: "\r",
  };
}

/**
 * Send an agent its first instruction once it is ready (AG-10.1): it has
 * printed something and then nothing for READY_QUIET_MS (a TUI drawn and
 * waiting), or READY_MAX_MS passed. Typed into its session over the host's
 * write path (the same as a keystroke from the pane), never as an argument
 * or through a shell. False when the session ended first or there is no
 * host. Never throws.
 */
export async function sendFirstInstruction(
  d: AgentsResolved,
  sessionId: string,
  runtime: string,
  text: string,
  o: { quietMs?: number; maxMs?: number } = {},
): Promise<boolean> {
  const quiet = o.quietMs ?? READY_QUIET_MS;
  const max = o.maxMs ?? READY_MAX_MS;
  let c: HostClient | null = null;
  try {
    c = await d.connectExisting();
    if (!c) return false;
    const deadline = Date.now() + max;
    let last = "";
    let changedAt = Date.now();
    let said = "";
    for (;;) {
      const s = (await c.list()).find((x) => x.ref.id === sessionId);
      if (!s || s.exited) return false;
      said = (await c.scrollback(sessionId, 256 * 1024)).toString("utf-8");
      if (said !== last) {
        last = said;
        changedAt = Date.now();
      } else if (said && Date.now() - changedAt >= quiet) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    const soft = softNewlineSeq(getRuntime(runtime)?.catalog);
    const b = instructionBytes(text, said, soft);
    c.write(sessionId, Buffer.from(b.body, "utf-8"));
    await new Promise((r) => setTimeout(r, 120));
    c.write(sessionId, Buffer.from(b.enter, "utf-8"));
    // Let the host take the bytes before the connection closes.
    await c.list();
    return true;
  } catch {
    return false;
  } finally {
    c?.close();
  }
}

/** A plain session started from the page (AG-10.1 "Plain session"). */
export interface PlainStarted {
  info: SessionInfo;
}

/**
 * Plain session (AG-10.1): the person's login shell ($SHELL when it is an
 * absolute path to an executable, else /bin/sh) in the workspace's folder,
 * named shell, shell-2, … in that workspace. Its env is a plain session's
 * (the allowlist, every runtime's scrubEnv); it counts against
 * sessions.max_concurrent, never the agents' cap.
 */
export async function startPlainSession(
  d: AgentsResolved,
  ws: string,
): Promise<PlainStarted> {
  checkWorkspaceName("sessions start", ws);
  if (!d.workspaceExists(ws))
    throw usage(`workspace "${ws}" does not exist`, 404);
  const dir = d.workspaceDir(ws);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw refused(`workspace ${ws}'s directory ${dir} does not exist`);
  ptyOrRefuse(d);
  const sh = d.env.SHELL;
  let shell = "/bin/sh";
  if (sh && path.isAbsolute(sh))
    try {
      fs.accessSync(sh, fs.constants.X_OK);
      shell = sh;
    } catch {
      /* the default */
    }
  const { plainSessionEnv } = await import("./sessions-command.js");
  return withClient(d, async (c) => {
    const names = new Set((await c.list()).map((s) => s.name));
    let n = 1;
    let name = sessionName(d.dist, ws, "shell");
    while (names.has(name)) name = sessionName(d.dist, ws, `shell-${++n}`);
    const info = await c
      .start(
        {
          name,
          cwd: dir,
          argv: [shell, "-l"],
          env: plainSessionEnv(d.env),
          cols: 80,
          rows: 24,
        },
        { limit: d.maxSessions(), pool: "sessions" },
      )
      .catch((e: unknown) => {
        if (e instanceof HostError && e.code === "cap")
          throw new AgentError(e.message, {
            status: 429,
            code: "cap",
            hints: ["Stop a session first, or raise sessions.max_concurrent."],
          });
        throw e;
      });
    return { info };
  });
}

// ── D28: rotation by itself (on_due auto), and the callout's actions ────────

/** How often the server looks at due agents. */
export const ROTATION_TICK_MS = 15_000;
/** Between two asks for the handoff, at least this long. */
export const ROTATION_ASK_GAP_MS = 120_000;
/** Asks before auto falls back to ask. */
export const ROTATION_MAX_ASKS = 2;

export type RotationEvent =
  | { kind: "asked"; agent: string; workspace: string; asked: number }
  | { kind: "fell-back"; agent: string; workspace: string }
  | {
      kind: "relaunched";
      agent: string;
      workspace: string;
      why: string;
      /** The conversation that ended (kept). */
      old?: string;
    }
  | { kind: "failed"; agent: string; workspace: string; why: string };

/**
 * D28, one look at every running agent whose rotation is due. Each one
 * whose settings say `auto`, at idle (never mid-turn; unknown counts as
 * busy): its handoff passes, so Den relaunches it; or Den asks it for the
 * handoff (at most ROTATION_MAX_ASKS times, ROTATION_ASK_GAP_MS apart),
 * then falls back to ask. The limit the hook counts against follows the
 * settings. Never throws: each agent's failure is an event.
 */
export async function rotationTick(
  d: AgentsResolved,
  now: Date = new Date(),
  o: { askGapMs?: number; send?: typeof sendFirstInstruction } = {},
): Promise<RotationEvent[]> {
  const events: RotationEvent[] = [];
  let sessions: SessionInfo[];
  try {
    sessions = await hostSessions(d);
  } catch {
    return events;
  }
  const policyOf = policyResolver(d);
  const gap = o.askGapMs ?? ROTATION_ASK_GAP_MS;
  const send = o.send ?? sendFirstInstruction;
  for (const rec of listRecords(d.stateDir())) {
    const who = { agent: rec.id, workspace: rec.workspace };
    try {
      const s = rec.session ? sessionOf(sessions, rec) : undefined;
      if (!s || s.exited) continue;
      const pol = policyOf(rec);
      if (!pol) continue;
      const files = agentFilesDir(d.stateDir(), rec.id);
      const st = readRotation(files);
      if (!st) continue;
      if (
        st.conversation &&
        rec.resumeToken &&
        st.conversation !== rec.resumeToken
      )
        continue;
      syncAfter(files, pol.afterCompactions);
      const rot = rotationInfo(d.stateDir(), rec, pol);
      if (!rot?.due) continue;
      // Relaunch now, asked before the handoff, relaunches whatever on_due says.
      const wanted = rot.relaunchWanted === true;
      if (!wanted && (pol.onDue !== "auto" || rot.fellBack)) continue;
      if ((await agentBusy(d, rec)) !== false) continue;
      if (rot.handoff === "ok") {
        const r = await relaunchAgent(d, rec.id, rec.workspace, {
          auto: true,
        });
        events.push({
          kind: "relaunched",
          ...who,
          why: r.why,
          ...(rec.resumeToken ? { old: rec.resumeToken } : {}),
        });
        continue;
      }
      const last = st.askedAt ? Date.parse(st.askedAt) : 0;
      if (now.getTime() - last < gap) continue;
      if (wanted) continue; // asked once, by the person: no more asks
      if ((st.asked ?? 0) >= ROTATION_MAX_ASKS) {
        noteFellBack(files);
        events.push({ kind: "fell-back", ...who });
        continue;
      }
      const text = rotationInstruction(files, rot.due, rot.compactions);
      if (
        await send(d, s.ref.id, rec.runtime, text, {
          quietMs: 500,
          maxMs: 5000,
        })
      ) {
        const n = noteAsked(files, now);
        events.push({ kind: "asked", ...who, asked: n?.asked ?? 1 });
      }
    } catch (e) {
      events.push({ kind: "failed", ...who, why: (e as Error).message });
    }
  }
  return events;
}

/**
 * D28 "Keep this conversation": its count starts again, nothing is due.
 * `never`: also this agent's override after_compactions never ("don't ask
 * again for this agent").
 */
/**
 * D59: whether agent `id` resumes on its own after a restart: on, off, or
 * null for its persona's (`resume_on_restart`, `standing`).
 */
export function setAgentResumeOnRestart(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
  value: boolean | null,
): AgentRecord {
  const rec = agentRecord(d, id, ws);
  const next = { ...rec };
  if (value === null) delete next.resumeOnRestart;
  else next.resumeOnRestart = value;
  writeRecord(d.stateDir(), next);
  return next;
}

export function keepAgentConversation(
  d: AgentsResolved,
  id: string,
  ws?: string,
  o: { never?: boolean } = {},
): AgentRecord {
  const rec = agentRecord(d, id, ws);
  if (!keepConversation(agentFilesDir(d.stateDir(), rec.id)))
    throw refused(`agent ${rec.id} has no rotation to reset`);
  if (o.never)
    setRotateValue(d.stateDir(), "agent", rec.id, "after_compactions", "never");
  return rec;
}

/**
 * D28 "Write handoff": types the handoff instruction into agent `id`'s
 * running session, at idle. Refused while it is mid-turn or not running.
 */
export async function askForHandoff(
  d: AgentsResolved,
  id: string,
  ws?: string,
  send: typeof sendFirstInstruction = sendFirstInstruction,
  /** Relaunch now: Den relaunches it once the handoff passes. */
  o: { relaunch?: boolean } = {},
): Promise<AgentRecord & { resumed?: boolean }> {
  const rec = agentRecord(d, id, ws);
  const s = sessionOf(await hostSessions(d), rec);
  if (!s || s.exited) {
    // Stopped, no handoff yet: its conversation resumes to write one (the
    // resume hook gives it the instruction), then Den relaunches it.
    const files = agentFilesDir(d.stateDir(), rec.id);
    if (!o.relaunch)
      throw refused(
        `agent ${rec.id} is not running: resume it to write its handoff`,
        [`Resume: ${d.cli} agents resume ${rec.id}`],
      );
    const r = await resumeAgent(d, rec.id, ws);
    noteAsked(files, new Date(), true);
    return { ...r.rec, resumed: true };
  }
  if ((await agentBusy(d, rec)) === true)
    throw refused(`agent ${rec.id} is mid-turn: ask again when its turn ends`);
  const rot = rotationOf(d, rec);
  const files = agentFilesDir(d.stateDir(), rec.id);
  const text = rotationInstruction(
    files,
    rot?.due ?? "compactions",
    rot?.compactions ?? readRotation(files)?.compactions ?? 0,
  );
  if (
    !(await send(d, s.ref.id, rec.runtime, text, { quietMs: 500, maxMs: 5000 }))
  )
    throw refused(`agent ${rec.id}'s session did not take the prompt`);
  noteAsked(files, new Date(), o.relaunch === true);
  return rec;
}

/**
 * D28: Resume (or Start) on an agent follows its on_due: a due agent whose
 * handoff passes relaunches from it under auto; ask refuses with the
 * callout's choices (code "rotated"); off, or nothing due, resumes.
 */
export async function resumeOrRelaunch(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<
  { kind: "resumed"; s: Resumed } | { kind: "relaunched"; s: Relaunched }
> {
  const rec = agentRecord(d, id, ws);
  const rot = rotationOf(d, rec);
  if (rot?.ready && rot.onDue === "auto")
    return {
      kind: "relaunched",
      s: await relaunchAgent(d, id, ws, { auto: true }),
    };
  return { kind: "resumed", s: await resumeAgent(d, id, ws) };
}

/** D28: the rotation settings, and agent `agent`'s effective values. */
/** D30: what the rotation overrides can name, with names to show. */
export interface RotationChoices {
  agents: { id: string; name: string; workspace?: string; state: string }[];
  personas: { id: string; name: string; category: string }[];
  workspaces: { id: string; name: string }[];
  services: { id: string; name: string; workspace: string }[];
}

/**
 * D30: the overrides form's pickers: every agent (its name, workspace and
 * state), persona (name and category), workspace and workspace service.
 * Never starts a session host to ask (a stopped one: agents from their
 * records). A part that can't be read is empty, not an error.
 */
export async function rotationChoices(
  d: AgentsResolved,
  workspaces: string[],
): Promise<RotationChoices> {
  let sessions: SessionInfo[] = [];
  try {
    const c = await d.connectExisting();
    try {
      sessions = c ? await c.list() : [];
    } finally {
      c?.close();
    }
  } catch {
    sessions = [];
  }
  const records = listRecords(d.stateDir());
  const agents = agentRows(sessions, records, d.stateDir())
    .filter((r) => r.agent)
    .map((r) => ({
      id: r.agent,
      name: r.displayName || r.sessionTitle || r.agent,
      ...(r.workspace ? { workspace: r.workspace } : {}),
      state: r.state,
    }));
  let personaList: RotationChoices["personas"] = [];
  try {
    personaList = listPersonas(d).map((p) => ({
      id: p.id,
      name: p.displayName ? `${p.displayName} (${p.id})` : p.id,
      category: p.category,
    }));
  } catch {
    personaList = [];
  }
  const services: RotationChoices["services"] = [];
  for (const ws of workspaces)
    try {
      for (const sv of d.workspaceServices(ws))
        if (!services.some((x) => x.id === sv.address))
          services.push({ id: sv.address, name: sv.address, workspace: ws });
    } catch {
      /* a workspace whose services can't be read: none */
    }
  return {
    agents,
    personas: personaList,
    workspaces: workspaces.map((w) => ({ id: w, name: w })),
    services,
  };
}

export function rotationSettings(
  d: AgentsResolved,
  agent?: string,
  ws?: string,
): {
  defaults: typeof ROTATE_DEFAULTS;
  org: OrgRotate;
  install: RotateValues;
  overrides: NonNullable<RotateFile["overrides"]>;
  effective?: RotationPolicy & { agent: string };
} {
  const f = readRotateFile(d.stateDir());
  let org: OrgRotate = {};
  try {
    org = d.agentsConfig().rotateOrg ?? {};
  } catch {
    org = {};
  }
  let effective: (RotationPolicy & { agent: string }) | undefined;
  if (agent) {
    const rec = agentRecord(d, agent, ws);
    const pol = policyResolver(d)(rec);
    if (pol) effective = { agent: rec.id, ...pol };
  }
  return {
    defaults: ROTATE_DEFAULTS,
    org,
    install: f.install ?? {},
    overrides: f.overrides ?? {},
    ...(effective ? { effective } : {}),
  };
}

/**
 * D28: set one rotation setting from a request body `{ scope, target?,
 * key, value }` (value null: cleared). A target is checked to be a name
 * (persona-workspace: `<persona>@<workspace>`).
 */
export function setRotationSetting(
  d: AgentsResolved,
  body: Record<string, unknown>,
): { file: RotateFile } {
  const scope = body.scope;
  if (
    scope !== "install" &&
    !(OVERRIDE_SCOPES as readonly unknown[]).includes(scope)
  )
    throw usage(
      `scope: one of install, ${OVERRIDE_SCOPES.join(", ")} (got ${JSON.stringify(scope)})`,
    );
  const target = body.target;
  if (scope !== "install") {
    const ok =
      typeof target === "string" &&
      (scope === "persona-workspace"
        ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
            target,
          )
        : scope === "service"
          ? /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(target)
          : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target));
    if (!ok)
      throw usage(
        scope === "persona-workspace"
          ? "target: <persona>@<workspace>"
          : `target: the ${String(scope)} it is for`,
      );
  } else if (target !== undefined && target !== null)
    throw usage("target: install takes none");
  if (typeof body.key !== "string") throw usage("key is required");
  try {
    return {
      file: setRotateValue(
        d.stateDir(),
        scope as OverrideScope | "install",
        scope === "install" ? undefined : (target as string),
        body.key,
        body.value === null ? undefined : body.value,
      ),
    };
  } catch (e) {
    throw usage((e as Error).message);
  }
}
