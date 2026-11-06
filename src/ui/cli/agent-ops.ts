/**
 * What an agent operation does (AG-2a, AG spec §5c), once, for both of its
 * fronts: `<cli> agents` (agents-command.ts) and the Workspaces page's
 * Agents section (server/agent-routes.ts, AG-4a). Neither front keeps state
 * of its own: the agent record (shared/agents/records.ts) and the session
 * host are the whole of it. Nothing here prints: each operation returns
 * what happened, or throws an AgentError saying why it didn't.
 *
 *   start   resolves the persona (Den's default pack, then
 *           agents.persona_packs) and the runtime, asks the runtime for argv,
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
 *   resume  only when its runtime declares resume and its session is not
 *           running: a new session, in the same cwd, continuing the last run;
 *           when that session was never prompted, a fresh start under the
 *           same conversation id (there is nothing to continue). A fresh
 *           actor token; the old one stops working.
 *
 * Nothing here takes a grant: grants come from the org config only. The
 * host enforces agents.max_concurrent on every start, counting agents only.
 */
import * as fs from "fs";
import * as path from "path";
import {
  AGENTS_RESERVED_KEYS,
  readAgentsConfig,
  type ResolvedAgentsConfig,
} from "../../shared/den-config.js";
import { cliEntrypoint } from "../../shared/engine.js";
import { getDistRoot } from "../../shared/paths.js";
import { envKey } from "../../shared/product.js";
import { redactSecrets } from "../../shared/redact.js";
import {
  loadPersonas,
  resolvePackDirs,
  type Persona,
} from "../../shared/agents/personas.js";
import {
  AGENT_ID_RE,
  agentFilesDir,
  listRecords,
  readRecord,
  writeRecord,
  writeRuntimeFiles,
  type AgentRecord,
} from "../../shared/agents/records.js";
import {
  agentSessionEnv,
  DEFAULT_RUNTIME_ID,
  getRuntime,
  LaunchError,
  runtimeIds,
  type AgentMcp,
  type LaunchInput,
  type Runtime,
} from "../../shared/agents/runtimes.js";
import { WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";
import {
  bindActorSession,
  mintActorToken,
  revokeActorToken,
  revokeAgentTokens,
} from "../../shared/actor-token.js";
import { HostError, type HostClient } from "../../shared/sessions/client.js";
import { DEN_PTY_ID } from "../../shared/sessions/den-pty.js";
import { inWorkspace, sessionName } from "../../shared/sessions/names.js";
import type { SessionInfo } from "../../shared/sessions/types.js";
import { serverSpec } from "../mcp/connect.js";
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
  /** The MCP server binary and its env; Den adds the scoped args. */
  mcpServer?: () => { command: string[] | string; env: Record<string, string> };
  /**
   * How long start and resume watch a new session for an early non-zero
   * exit (default 3000 ms; 0: not at all).
   */
  exitWatchMs?: number;
}

export interface AgentsResolved extends Resolved {
  agentsConfig: () => ResolvedAgentsConfig;
  distRoot: () => string;
  workspaceDir: (ws: string) => string;
  mcpServer: () => { command: string[] | string; env: Record<string, string> };
  exitWatchMs: number;
}

/** The early-exit watch: at most this long, polling the host. */
export const EXIT_WATCH_MS = 3000;
const EXIT_POLL_MS = 100;
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
  constructor(
    message: string,
    o: {
      status?: number;
      usage?: boolean;
      code?: string;
      hints?: string[];
    } = {},
  ) {
    super(message);
    this.name = "AgentError";
    this.status = o.status ?? (o.usage ? 400 : 409);
    this.usage = o.usage ?? false;
    this.code = o.code;
    this.hints = o.hints ?? [];
  }
}

/** A request that was wrong as asked (CLI exit 2; HTTP 400 unless given). */
const usage = (message: string, status = 400) =>
  new AgentError(message, { usage: true, status });
/** A refusal (CLI exit 1; HTTP 409 unless given). */
const refused = (message: string, hints: string[] = [], status = 409) =>
  new AgentError(message, { status, hints });

let workspaceDirFn: ((ws: string) => string) | null = null;
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
  return {
    ...base,
    agentsConfig: d.agentsConfig ?? (() => readAgentsConfig()),
    distRoot: d.distRoot ?? getDistRoot,
    workspaceDir:
      d.workspaceDir ??
      ((ws) => {
        if (!workspaceDirFn) throw new Error("workspaces not loaded");
        return workspaceDirFn(ws);
      }),
    mcpServer: d.mcpServer ?? (() => defaultMcpServer(base.cli)),
    exitWatchMs: d.exitWatchMs ?? EXIT_WATCH_MS,
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
  persona?: string;
  runtime?: string;
  model?: string;
  workspace?: string;
  cwd?: string;
  /** running, stopping (stopped, its session not yet gone), exited
   * (<code>), stopped or ended. */
  state: string;
  /** When its current (or last) session started (ISO 8601). */
  startedAt?: string;
  /** Resume applies: its runtime declares resume and it isn't running. */
  resumable: boolean;
  session?: SessionInfo;
}

function rowState(rec: AgentRecord | undefined, s?: SessionInfo): string {
  // Stopped (TERM sent) while its session still runs: on its way out.
  if (s && !s.exited)
    return rec?.stoppedAt && rec.stoppedAt >= s.startedAt
      ? "stopping"
      : "running";
  if (rec?.stoppedAt) return "stopped";
  return s ? state(s) : "ended";
}

/** Whether `rec` may be resumed now, in `rowState`. */
function canResume(rec: AgentRecord, st: string): boolean {
  return (
    st !== "running" &&
    st !== "stopping" &&
    Boolean(getRuntime(rec.runtime)?.resume)
  );
}

export function agentRows(
  sessions: SessionInfo[],
  records: AgentRecord[] = [],
): AgentRow[] {
  const bySession = new Map(records.map((r) => [r.session.id, r]));
  const rows: AgentRow[] = [];
  const shown = new Set<string>();
  const row = (rec: AgentRecord, s?: SessionInfo): AgentRow => {
    const st = rowState(rec, s);
    return {
      agent: rec.id,
      ...recordFields(rec),
      state: st,
      startedAt: s?.startedAt ?? rec.startedAt,
      resumable: canResume(rec, st),
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
    persona: rec.persona,
    runtime: rec.runtime,
    ...(rec.model ? { model: rec.model } : {}),
    workspace: rec.workspace,
    cwd: rec.cwd,
  };
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
  opts: { startHost?: boolean } = {},
): Promise<AgentRow[]> {
  checkWorkspaceName("agents list", ws);
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
  return agentRows(sessions, records);
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
): Map<string, Persona> {
  try {
    return loadPersonas(resolvePackDirs(cfg.personaPacks, d.distRoot()));
  } catch (e) {
    throw refused((e as Error).message, [], 422);
  }
}

/** A persona as listed: everything but its role prompt. */
export type ListedPersona = Omit<Persona, "prompt">;

/** Den's default pack, then agents.persona_packs, by id. */
export function listPersonas(d: AgentsResolved): ListedPersona[] {
  return [...personas(d, agentsConfig(d)).values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ prompt: _p, ...rest }) => rest);
}

export interface RuntimeChoice {
  id: string;
  available: boolean;
  /** Why it is unavailable. */
  why?: string;
  version?: string;
  /** It declares resume. */
  resume: boolean;
  default: boolean;
}

/** Every registered runtime, and whether it can run here (detect runs nothing). */
export function listRuntimes(d: AgentsResolved): RuntimeChoice[] {
  return runtimeIds().map((id) => {
    const rt = getRuntime(id)!;
    const det = rt.detect(d.env);
    return {
      id,
      available: det.available,
      ...(det.available ? {} : { why: det.why ?? "unavailable" }),
      ...(det.version ? { version: det.version } : {}),
      resume: Boolean(rt.resume),
      default: id === DEFAULT_RUNTIME_ID,
    };
  });
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
 * The id an agent gets: --id, else the persona's id while it is free (or
 * this workspace's), else `<persona>-<ws>`.
 */
function defaultId(stateDir: string, persona: string, ws: string): string {
  const rec = readRecord(stateDir, persona);
  if (!rec || rec.workspace === ws) return persona;
  return `${persona}-${ws}`.slice(0, 64);
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
  /** agents.<id>.grants, recorded with its actor token. */
  grants: readonly string[];
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
            { envPassthrough: launch.passthrough },
            launch.env,
            launch.rec.id,
            minted.token,
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
    ...extra,
  };
  delete rec.stoppedAt;
  writeRecord(d.stateDir(), rec);
  return { rec, info };
}

/** CSI, OSC (BEL or ST ended), and other two-byte escapes. */
/* eslint-disable no-control-regex */
const TERMINAL_ESCAPE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
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
    const tail = plainLines(
      (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8"),
    )
      .slice(-EXIT_TAIL_LINES)
      .map((l) => redactSecrets(l));
    return {
      ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }),
      tail,
      sessionName: s.name,
    };
  }
  return null;
}

function launchInput(
  d: AgentsResolved,
  cfg: ResolvedAgentsConfig,
  persona: Persona,
  ws: string,
  id: string,
  model: string | undefined,
): LaunchInput {
  const grants = cfg.agents[id]?.grants ?? [];
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
  };
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
}

export async function startAgent(
  d: AgentsResolved,
  req: StartRequest,
): Promise<Started> {
  const where = "agents start";
  const ws = checkWorkspaceName(where, req.workspace);
  if (!d.workspaceExists(ws))
    throw usage(`${where}: workspace "${ws}" does not exist`, 404);
  const cfg = agentsConfig(d);
  const all = personas(d, cfg);
  const persona = all.get(req.persona);
  if (!persona)
    throw usage(
      `${where}: no persona "${req.persona}" (personas: ${[...all.keys()].sort().join(", ")})`,
    );
  const id = req.id ?? defaultId(d.stateDir(), persona.id, ws);
  checkId(where, id);
  const rt = runtimeFor(req.runtime ?? persona.runtime ?? DEFAULT_RUNTIME_ID);
  const det = rt.detect(d.env);
  if (!det.available)
    throw refused(`${rt.id} is unavailable: ${det.why ?? "unknown"}`, [], 503);
  const model = req.model ?? persona.model;

  const prev = readRecord(d.stateDir(), id);
  if (prev && prev.workspace !== ws)
    throw refused(
      `agent ${id} belongs to workspace ${prev.workspace}; give this one another --id`,
    );
  ptyOrRefuse(d);
  const input = launchInput(d, cfg, persona, ws, id, model);

  return withClient(d, async (c) => {
    const sessions = await c.list();
    const old = prev ? sessionOf(sessions, prev) : undefined;
    if (old && !old.exited)
      throw refused(`agent ${id} is running (${old.name})`, [
        `Attach: ${d.cli} sessions attach ${old.name}`,
      ]);
    const out = launchOrThrow(() => rt.launch(input));
    writeRuntimeFiles(input.filesDir, out.files);
    const { rec, info } = await startSession(
      d,
      c,
      {
        rec: {
          id,
          persona: persona.id,
          runtime: rt.id,
          ...(model ? { model } : {}),
          workspace: ws,
          cwd: input.worktree,
          sessionName: sessionName(d.dist, ws, id),
          ...(out.resumeToken ? { resumeToken: out.resumeToken } : {}),
        },
        argv: out.argv,
        env: out.env,
        passthrough: rt.envPassthrough,
        grants: cfg.agents[id]?.grants ?? [],
      },
      old,
      {},
    );
    const early = await exitedAtOnce(d, c, info);
    return { rec, info, warnings: out.warnings ?? [], early };
  });
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

export interface Stopped {
  rec: AgentRecord;
  /** The session it sent TERM to; undefined when it wasn't running. */
  session?: SessionInfo;
}

export async function stopAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<Stopped> {
  const rec = agentRecord(d, id, ws);
  return withClient(d, async (c) => {
    const s = sessionOf(await c.list(), rec);
    // Its token stops working before the session is asked to end.
    revokeAgentTokens(d.stateDir(), rec.id);
    if (s && !s.exited) await c.kill(s.ref.id, "TERM");
    const next = { ...rec, stoppedAt: new Date().toISOString() };
    writeRecord(d.stateDir(), next);
    return { rec: next, ...(s && !s.exited ? { session: s } : {}) };
  });
}

export interface Resumed extends Started {
  /** Never prompted: started afresh under the same conversation id. */
  fresh: boolean;
}

export async function resumeAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<Resumed> {
  const rec = agentRecord(d, id, ws);
  const rt = runtimeFor(rec.runtime);
  if (!rt.resume)
    throw refused(`runtime ${rt.id} does not declare resume`, [
      `Start it again: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id}`,
    ]);
  const cfg = agentsConfig(d);
  const persona = personas(d, cfg).get(rec.persona);
  if (!persona)
    throw refused(`agent ${rec.id}'s persona "${rec.persona}" is gone`);
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
      rec.model,
    );
    // Resume in the cwd the agent had, wherever the workspace points now.
    const at = {
      ...input,
      worktree: rec.cwd,
      ...(rec.resumeToken ? { resumeToken: rec.resumeToken } : {}),
    };
    // A session nobody prompted left no conversation: continuing it fails,
    // so it starts afresh under the same id. A session the host no longer
    // lists is assumed prompted.
    const fresh = Boolean(old && !old.prompted && rec.resumeToken);
    const out = launchOrThrow(() => (fresh ? rt.launch(at) : rt.resume!(at)));
    if (!out) throw refused(`agent ${rec.id} has nothing to resume`);
    writeRuntimeFiles(input.filesDir, out.files);
    const { session: _s, startedAt: _t, resumedAt: _r, ...base } = rec;
    const { rec: next, info } = await startSession(
      d,
      c,
      {
        rec: { ...base, cwd: rec.cwd },
        argv: out.argv,
        env: out.env,
        passthrough: rt.envPassthrough,
        grants: cfg.agents[rec.id]?.grants ?? [],
      },
      old,
      fresh ? {} : { resumedAt: new Date().toISOString() },
    );
    const early = await exitedAtOnce(d, c, info);
    return { rec: next, info, warnings: out.warnings ?? [], early, fresh };
  });
}
