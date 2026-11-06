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
 *   list    the workspace's sessions, with each agent's persona, runtime and
 *           model from its record; a record whose session is gone is listed
 *           as stopped or ended.
 *   stop    ends its session (TERM) and marks the record stopped.
 *   resume  only when its runtime declares resume and its session is not
 *           running: a new session, in the same cwd, continuing the last run.
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
import {
  inWorkspace,
  parseSessionName,
  sessionName,
} from "../../shared/sessions/names.js";
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
  sessionEnv,
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
    "    only when its runtime declares resume and its session has ended",
    "{cli} agents personas [--json]",
    "    Den's default pack, then agents.persona_packs (a later pack wins by id)",
    "",
    "Runtimes: den-claude (default; needs claude on PATH) and generic (the",
    "persona's argv template). Attach with `{cli} sessions attach <ws>:<id>`.",
  ],
};

export interface AgentsDeps extends SessionsDeps {
  agentsConfig?: () => ResolvedAgentsConfig;
  distRoot?: () => string;
  /** A workspace's checkout directory: where its agents run. */
  workspaceDir?: (ws: string) => string;
  /** The MCP server binary and its env; Den adds the scoped args. */
  mcpServer?: () => { command: string[] | string; env: Record<string, string> };
}

interface AgentsResolved extends Resolved {
  agentsConfig: () => ResolvedAgentsConfig;
  distRoot: () => string;
  workspaceDir: (ws: string) => string;
  mcpServer: () => { command: string[] | string; env: Record<string, string> };
}

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
  };
}

// ── the agent's MCP ─────────────────────────────────────────────────────────

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
    env: server.env,
    scope: ws,
  };
}

// ── rows ────────────────────────────────────────────────────────────────────

/**
 * One row per agent of a workspace: each session, joined to the agent
 * record that started it (by session id); a session without one is listed
 * with persona and runtime blank, a record without its session as stopped
 * (after `agents stop`) or ended.
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
  dist: string,
  records: AgentRecord[] = [],
): AgentRow[] {
  const bySession = new Map(records.map((r) => [r.session.id, r]));
  const rows: AgentRow[] = [];
  const shown = new Set<string>();
  for (const s of sessions) {
    const rec = bySession.get(s.ref.id);
    if (rec) shown.add(rec.id);
    rows.push({
      agent: rec?.id ?? parseSessionName(s.name, dist)?.name ?? s.name,
      ...(rec ? recordFields(rec) : {}),
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
  const rows = agentRows(sessions, d.dist, records);
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
}

/** Start `launch` as the agent's session (replacing an exited one) and record it. */
async function startSession(
  d: AgentsResolved,
  c: HostClient,
  launch: Launch,
  old: SessionInfo | undefined,
  extra: Partial<AgentRecord>,
): Promise<AgentRecord> {
  if (old?.exited) await c.forget(old.ref.id);
  const tty = d.stdout.isTTY;
  const info = await c.start(
    {
      name: launch.rec.sessionName,
      cwd: launch.rec.cwd,
      argv: launch.argv,
      env: { ...sessionEnv(d.env), ...launch.env },
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
  return rec;
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
    const rec = await startSession(
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
      },
      old,
      {},
    );
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
    const out = rt.resume!({
      ...input,
      worktree: rec.cwd,
      ...(rec.resumeToken ? { resumeToken: rec.resumeToken } : {}),
    });
    if (!out) throw new Refused(`agent ${rec.id} has nothing to resume`);
    writeRuntimeFiles(input.filesDir, out.files);
    const { session: _s, startedAt: _t, ...base } = rec;
    const next = await startSession(
      d,
      c,
      { rec: { ...base, cwd: rec.cwd }, argv: out.argv, env: out.env },
      old,
      { resumedAt: new Date().toISOString() },
    );
    d.out(`resumed agent ${rec.id} as ${next.sessionName} in ${next.cwd}`);
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
