/**
 * `<cli> agents list|start|stop|resume|personas` (AG-2a, AG spec §5c):
 * an agent is a persona and a workspace, run by a runtime in a session of
 * the AG-3a host.
 *
 *   start   resolves the persona (Den's default pack, then
 *           agents.persona_packs) and the runtime, asks the runtime for argv,
 *           env and files (its MCP config: `<cli> mcp --workspace <ws>
 *           --actor agent:<id>`, plus a `--grant` per agents.<id>.grants),
 *           starts `<dist>-<ws>:<id>` in the workspace's dir, and writes the
 *           agent record (<stateDir>/agents/<id>.json, 0600; no env, no argv).
 *           The agent's env is an allowlist plus what its runtime declares,
 *           less every runtime's scrubEnv (sessions/env.ts), never the
 *           caller's whole environment; no --keep-env. A
 *           session that exits non-zero in its first moments (exitWatchMs)
 *           is reported with its last lines, exit 1.
 *   list    the workspace's agents (sessions with an agent record), with
 *           persona, runtime and model; a record whose session is gone is
 *           listed as stopped or ended. A plain session is not an agent.
 *   stop    ends its session (TERM) and marks the record stopped.
 *   resume  only when its runtime declares resume and its session is not
 *           running: a new session, in the same cwd, continuing the last run;
 *           when that session was never prompted, a fresh start under the
 *           same conversation id (there is nothing to continue).
 *
 * Nothing here takes a grant: grants come from the org config only. The
 * host enforces agents.max_concurrent on every start.
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
import { HostError, type HostClient } from "../../shared/sessions/client.js";
import { DEN_PTY_ID } from "../../shared/sessions/den-pty.js";
import { inWorkspace, sessionName } from "../../shared/sessions/names.js";
import type { SessionInfo } from "../../shared/sessions/types.js";
import { serverSpec } from "../mcp/connect.js";
import {
  columns,
  contractInfo,
  guarded,
  loadWorkspaces,
  noExtra,
  parseArgs,
  resolveDeps,
  state,
  UsageError,
  withClient,
  workspaceFlag,
  type Resolved,
  type SessionsDeps,
} from "./sessions-command.js";

export const AGENTS_HELP = {
  usage: "agents <list|start|stop|resume|personas> ...",
  lines: [
    "Agents: a persona and a workspace, run by a runtime in a session that",
    "outlives the web server (see `{cli} sessions`).",
    "",
    "{cli} agents list -w <ws> [--json]",
    "{cli} agents start -w <ws> --persona <p> [--runtime <r>] [--model <m>] [--id <id>]",
    "    runs in the workspace's dir as <dist>-<ws>:<id>; its MCP is pinned to <ws>",
    "    (plus agents.<id>.grants); capped by agents.max_concurrent",
    "{cli} agents stop <id> [-w <ws>]",
    "{cli} agents resume <id> [-w <ws>]",
    "    only when its runtime declares resume and its session has ended;",
    "    a session never prompted starts fresh under the same conversation id",
    "{cli} agents personas [--json]",
    "    Den's default pack, then agents.persona_packs (a later pack wins by id)",
    "",
    "Runtimes: den-claude (default; needs claude on PATH) and generic (the",
    "persona's argv template). Attach with `{cli} sessions attach <ws>:<id>`.",
    "An agent's env is PATH, HOME, USER, LOGNAME, SHELL, TERM, COLORTERM, LANG,",
    "LC_*, TZ and TMPDIR, plus what its runtime declares: nothing else of yours.",
  ],
};

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

interface AgentsResolved extends Resolved {
  agentsConfig: () => ResolvedAgentsConfig;
  distRoot: () => string;
  workspaceDir: (ws: string) => string;
  mcpServer: () => { command: string[] | string; env: Record<string, string> };
  exitWatchMs: number;
}

/** The early-exit watch: at most this long, polling the host. */
export const EXIT_WATCH_MS = 3000;
const EXIT_POLL_MS = 100;
/** The most lines of an early exit's scrollback printed. */
const EXIT_TAIL_LINES = 10;

let workspaceDirFn: ((ws: string) => string) | null = null;
async function loadWorkspaceDir(d: AgentsDeps): Promise<void> {
  if (d.workspaceDir || workspaceDirFn) return;
  const ws = await import("../../shared/environment-manager/workspaces.js");
  const { getReposRoot } = await import("../../shared/den-config.js");
  workspaceDirFn = (name) => {
    const cfg = ws.readWorkspacesFile().workspaces[name];
    if (!cfg) throw new UsageError(`workspace "${name}" does not exist`);
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

function resolveAgentsDeps(d: AgentsDeps): AgentsResolved {
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
  /** running, exited (<code>), stopped or ended. */
  state: string;
  session?: SessionInfo;
}

function rowState(rec: AgentRecord | undefined, s?: SessionInfo): string {
  if (s && !s.exited) return "running";
  if (rec?.stoppedAt) return "stopped";
  return s ? state(s) : "ended";
}

export function agentRows(
  sessions: SessionInfo[],
  records: AgentRecord[] = [],
): AgentRow[] {
  const bySession = new Map(records.map((r) => [r.session.id, r]));
  const rows: AgentRow[] = [];
  const shown = new Set<string>();
  for (const s of sessions) {
    const rec = bySession.get(s.ref.id);
    if (!rec) continue;
    shown.add(rec.id);
    rows.push({
      agent: rec.id,
      ...recordFields(rec),
      state: rowState(rec, s),
      session: contractInfo(s),
    });
  }
  for (const rec of records)
    if (!shown.has(rec.id))
      rows.push({ agent: rec.id, ...recordFields(rec), state: rowState(rec) });
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

async function list(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents list";
  const p = parseArgs(where, args, { "--workspace": true, "--json": false });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  if (!ws) throw new UsageError(`${where} needs -w <workspace>`);
  const sessions = (await withClient(d, (c) => c.list())).filter((s) =>
    inWorkspace(s, d.dist, ws),
  );
  const records = listRecords(d.stateDir()).filter((r) => r.workspace === ws);
  const rows = agentRows(sessions, records);
  if (p.flags["--json"]) {
    d.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    d.out(`no agents in ${ws}`);
    return 0;
  }
  for (const l of columns([
    [
      "AGENT",
      "PERSONA",
      "RUNTIME",
      "STATE",
      "MODEL",
      "PID",
      "STARTED",
      "SESSION",
    ],
    ...rows.map((r) => [
      r.agent,
      r.persona ?? "-",
      r.runtime ?? "-",
      r.state,
      r.model ?? "-",
      r.session && !r.session.exited ? String(r.session.pid) : "-",
      r.session?.startedAt ?? "-",
      r.session?.name ?? "-",
    ]),
  ]))
    d.out(l);
  return 0;
}

// ── start ───────────────────────────────────────────────────────────────────

/** The agents config; an invalid one is a refusal naming the key. */
function agentsConfig(d: AgentsResolved): ResolvedAgentsConfig {
  try {
    return d.agentsConfig();
  } catch (e) {
    throw new Refused((e as Error).message);
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
    throw new Refused((e as Error).message);
  }
}

function runtimeFor(id: string): Runtime {
  const rt = getRuntime(id);
  if (!rt)
    throw new UsageError(
      `no runtime "${id}" (runtimes: ${runtimeIds().join(", ")})`,
    );
  return rt;
}

/** The running session of `rec`, if any; else its exited one, if listed. */
function sessionOf(
  sessions: SessionInfo[],
  rec: AgentRecord,
): SessionInfo | undefined {
  return sessions.find((s) => s.ref.id === rec.session.id);
}

/** Refuse: exit 1 with the message (and hints). */
class Refused extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
  }
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
    throw new UsageError(
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
  warnings?: string[];
}

/** Start `launch` as the agent's session (replacing an exited one) and record it. */
async function startSession(
  d: AgentsResolved,
  c: HostClient,
  launch: Launch,
  old: SessionInfo | undefined,
  extra: Partial<AgentRecord>,
): Promise<{ rec: AgentRecord; info: SessionInfo }> {
  if (old?.exited) await c.forget(old.ref.id);
  const tty = d.stdout.isTTY;
  const info = await c.start(
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
      ),
      cols: (tty && d.stdout.columns) || 80,
      rows: (tty && d.stdout.rows) || 24,
    },
    { limit: d.maxConcurrent() },
  );
  const rec: AgentRecord = {
    ...launch.rec,
    session: { backend: info.ref.backend, id: info.ref.id },
    startedAt: info.startedAt,
    ...extra,
  };
  delete rec.stoppedAt;
  writeRecord(d.stateDir(), rec);
  for (const w of launch.warnings ?? []) d.err(w);
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

/**
 * Watch a new session for an early exit (d.exitWatchMs, polling the host).
 * A non-zero exit is reported with its code and the last lines it printed
 * (secret-shaped values redacted); true when it did.
 */
async function exitedAtOnce(
  d: AgentsResolved,
  c: HostClient,
  id: string,
  info: SessionInfo,
): Promise<boolean> {
  const deadline = Date.now() + d.exitWatchMs;
  while (Date.now() < deadline) {
    await new Promise((r) =>
      setTimeout(r, Math.min(EXIT_POLL_MS, Math.max(0, deadline - Date.now()))),
    );
    const s = (await c.list()).find((x) => x.ref.id === info.ref.id);
    if (!s) return false;
    if (!s.exited) continue;
    if (s.exitCode === 0) return false;
    const code = s.exitCode === undefined ? "" : ` (exit ${s.exitCode})`;
    d.err(`✗ agent ${id} exited at once${code}`);
    const tail = plainLines(
      (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8"),
    ).slice(-EXIT_TAIL_LINES);
    if (tail.length) {
      d.err(`  its last ${tail.length === 1 ? "line" : "lines"}:`);
      for (const l of tail) d.err(`  | ${redactSecrets(l)}`);
    }
    d.err(`  All of it: ${d.cli} sessions attach ${s.name}`);
    return true;
  }
  return false;
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
      throw new Refused(`agents.${id}.grants: workspace "${g}" does not exist`);
  const dir = d.workspaceDir(ws);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Refused(`workspace ${ws}'s directory ${dir} does not exist`);
  return {
    persona,
    workspace: { name: ws, dir },
    agentId: id,
    worktree: dir,
    ...(model ? { model } : {}),
    mcp: agentMcp(d, ws, id, grants),
    filesDir: agentFilesDir(d.stateDir(), id),
    env: d.env,
  };
}

function ptyOrRefuse(d: AgentsResolved): void {
  const pty = d.pty();
  if (!pty.available)
    throw new Refused(`${DEN_PTY_ID} is unavailable: ${pty.reason}`, [
      `\`${d.cli} doctor\` shows the session backend's state.`,
    ]);
}

async function start(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents start";
  const p = parseArgs(where, args, {
    "--workspace": true,
    "--persona": true,
    "--runtime": true,
    "--model": true,
    "--id": true,
  });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  if (!ws) throw new UsageError(`${where} needs -w <workspace>`);
  const personaId = p.flags["--persona"];
  if (typeof personaId !== "string")
    throw new UsageError(`${where} needs --persona <p>`);
  if (!d.workspaceExists(ws))
    throw new UsageError(`${where}: workspace "${ws}" does not exist`);
  const cfg = agentsConfig(d);
  const all = personas(d, cfg);
  const persona = all.get(personaId);
  if (!persona)
    throw new UsageError(
      `${where}: no persona "${personaId}" (personas: ${[...all.keys()].sort().join(", ")})`,
    );
  const idFlag = p.flags["--id"];
  const id =
    typeof idFlag === "string"
      ? idFlag
      : defaultId(d.stateDir(), persona.id, ws);
  checkId(where, id);
  const rtFlag = p.flags["--runtime"];
  const rt = runtimeFor(
    typeof rtFlag === "string"
      ? rtFlag
      : (persona.runtime ?? DEFAULT_RUNTIME_ID),
  );
  const det = rt.detect(d.env);
  if (!det.available)
    throw new Refused(`${rt.id} is unavailable: ${det.why ?? "unknown"}`);
  const modelFlag = p.flags["--model"];
  const model = typeof modelFlag === "string" ? modelFlag : persona.model;

  const prev = readRecord(d.stateDir(), id);
  if (prev && prev.workspace !== ws)
    throw new Refused(
      `agent ${id} belongs to workspace ${prev.workspace}; give this one another --id`,
    );
  ptyOrRefuse(d);
  const input = launchInput(d, cfg, persona, ws, id, model);

  return withClient(d, async (c) => {
    const sessions = await c.list();
    const old = prev ? sessionOf(sessions, prev) : undefined;
    if (old && !old.exited)
      throw new Refused(`agent ${id} is running (${old.name})`, [
        `Attach: ${d.cli} sessions attach ${old.name}`,
      ]);
    const out = rt.launch(input);
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
        warnings: out.warnings,
      },
      old,
      {},
    );
    if (await exitedAtOnce(d, c, id, info)) return 1;
    d.out(
      `started agent ${id} (${persona.id}, ${rt.id}) as ${rec.sessionName} in ${rec.cwd}`,
    );
    d.out(`  attach: ${d.cli} sessions attach ${rec.sessionName}`);
    return 0;
  });
}

// ── stop, resume ────────────────────────────────────────────────────────────

function recordFor(
  where: string,
  p: ReturnType<typeof parseArgs>,
  d: AgentsResolved,
): AgentRecord {
  const id = p.positional[0];
  if (!id) throw new UsageError(`${where} needs <id>`);
  const rec = readRecord(d.stateDir(), id);
  if (!rec) throw new Refused(`no agent "${id}"`);
  const ws = workspaceFlag(where, p);
  if (ws && ws !== rec.workspace)
    throw new Refused(
      `agent ${id} is in workspace ${rec.workspace}, not ${ws}`,
    );
  return rec;
}

async function stop(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents stop";
  const p = parseArgs(where, args, { "--workspace": true });
  noExtra(where, p, 1);
  const rec = recordFor(where, p, d);
  return withClient(d, async (c) => {
    const s = sessionOf(await c.list(), rec);
    if (s && !s.exited) await c.kill(s.ref.id, "TERM");
    writeRecord(d.stateDir(), { ...rec, stoppedAt: new Date().toISOString() });
    d.out(
      s && !s.exited
        ? `stopped agent ${rec.id} (sent TERM to ${s.name}, pid ${s.pid})`
        : `agent ${rec.id} was not running; marked stopped`,
    );
    return 0;
  });
}

async function resume(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents resume";
  const p = parseArgs(where, args, { "--workspace": true });
  noExtra(where, p, 1);
  const rec = recordFor(where, p, d);
  const rt = runtimeFor(rec.runtime);
  if (!rt.resume)
    throw new Refused(`runtime ${rt.id} does not declare resume`, [
      `Start it again: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id}`,
    ]);
  const cfg = agentsConfig(d);
  const persona = personas(d, cfg).get(rec.persona);
  if (!persona)
    throw new Refused(`agent ${rec.id}'s persona "${rec.persona}" is gone`);
  ptyOrRefuse(d);
  return withClient(d, async (c) => {
    const old = sessionOf(await c.list(), rec);
    if (old && !old.exited)
      throw new Refused(`agent ${rec.id} is running (${old.name})`, [
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
    const out = fresh ? rt.launch(at) : rt.resume!(at);
    if (!out) throw new Refused(`agent ${rec.id} has nothing to resume`);
    writeRuntimeFiles(input.filesDir, out.files);
    const { session: _s, startedAt: _t, resumedAt: _r, ...base } = rec;
    if (fresh)
      d.out(
        `agent ${rec.id}: starting fresh: it was never prompted, so there is no conversation to resume`,
      );
    const { rec: next, info } = await startSession(
      d,
      c,
      {
        rec: { ...base, cwd: rec.cwd },
        argv: out.argv,
        env: out.env,
        passthrough: rt.envPassthrough,
        warnings: out.warnings,
      },
      old,
      fresh ? {} : { resumedAt: new Date().toISOString() },
    );
    if (await exitedAtOnce(d, c, rec.id, info)) return 1;
    d.out(
      `${fresh ? "started" : "resumed"} agent ${rec.id} as ${next.sessionName} in ${next.cwd}`,
    );
    d.out(`  attach: ${d.cli} sessions attach ${next.sessionName}`);
    return 0;
  });
}

async function listPersonas(
  args: string[],
  d: AgentsResolved,
): Promise<number> {
  const where = "agents personas";
  const p = parseArgs(where, args, { "--json": false });
  noExtra(where, p);
  const all = [...personas(d, agentsConfig(d)).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (p.flags["--json"]) {
    d.out(
      JSON.stringify(
        all.map(({ prompt: _p, ...rest }) => rest),
        null,
        2,
      ),
    );
    return 0;
  }
  for (const l of columns([
    ["PERSONA", "STANDING", "RUNTIME", "MODEL", "ROLE"],
    ...all.map((x) => [
      x.id,
      x.standing ? "yes" : "-",
      x.runtime ?? DEFAULT_RUNTIME_ID,
      x.model ?? "-",
      x.role,
    ]),
  ]))
    d.out(l);
  return 0;
}

/** `<cli> agents ...`; returns the exit code. */
export async function cmdAgents(
  args: string[],
  deps: AgentsDeps = {},
): Promise<number> {
  const d = resolveAgentsDeps(deps);
  const sub =
    args[0] === undefined || args[0].startsWith("-") ? "list" : args[0];
  const rest = sub === args[0] ? args.slice(1) : args;
  return guarded(d, AGENTS_HELP, "agents", async () => {
    try {
      switch (sub) {
        case "list":
          return await list(rest, d);
        case "start":
          await loadWorkspaces(deps);
          await loadWorkspaceDir(deps);
          return await start(rest, d);
        case "stop":
          return await stop(rest, d);
        case "resume":
          await loadWorkspaces(deps);
          await loadWorkspaceDir(deps);
          return await resume(rest, d);
        case "personas":
          return await listPersonas(rest, d);
        default:
          throw new UsageError(`unknown agents command "${sub}"`);
      }
    } catch (e) {
      if (e instanceof Refused || e instanceof LaunchError) {
        d.err(`✗ ${e.message}`);
        for (const h of e instanceof Refused ? e.hints : []) d.err(`  ${h}`);
        return 1;
      }
      if (e instanceof HostError) {
        d.err(`✗ ${e.message}`);
        if (e.code === "cap")
          d.err(
            `  Stop one first (\`${d.cli} agents stop <id>\`), or raise agents.max_concurrent.`,
          );
        return 1;
      }
      throw e;
    }
  });
}
