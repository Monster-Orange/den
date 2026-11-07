/**
 * `<cli> agents list|start|stop|resume|personas` (AG-2a, AG spec §5c):
 * an agent is a persona and a workspace, run by a runtime in a session of
 * the AG-3a host. This is the CLI's front: it parses the arguments and
 * prints; what each operation does is agent-ops.ts, which the Workspaces
 * page's routes (server/agent-routes.ts) call too.
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
 *   doctor  (AG-0.3, AG-0.5) each runtime of the catalog, installed
 *           first: its status, the CLI it runs and where that came from
 *           (workspace or user.yml setting, login shell, PATH, install
 *           directory, interactive shell), its
 *           version (its version command, once, under a timeout), the
 *           directories searched (names only, never an env value), and the
 *           fix when it is missing. Exit 1 when the default runtime is
 *           unavailable. It resolves the login shell's PATH first, as the
 *           web server does at start.
 *
 * Nothing here takes a grant: grants come from the org config only. The
 * host enforces agents.max_concurrent on every start, counting agents only.
 */
import { DEFAULT_RUNTIME_ID } from "../../shared/agents/runtimes.js";
import { initLoginPath } from "../../shared/agents/runtime-search.js";
import { HostError } from "../../shared/sessions/client.js";
import {
  AgentError,
  listAgents,
  listPersonas as personaList,
  listRuntimes,
  loadAgentWorkspaces,
  resolveAgentsDeps,
  resumeAgent,
  startAgent,
  stopAgent,
  type AgentsDeps,
  type AgentsResolved,
  type EarlyExit,
  type RuntimeChoice,
  type Started,
} from "./agent-ops.js";
import {
  columns,
  guarded,
  noExtra,
  parseArgs,
  UsageError,
  workspaceFlag,
} from "./sessions-command.js";

export {
  agentMcp,
  agentRows,
  EXIT_WATCH_MS,
  plainLines,
  type AgentRow,
  type AgentsDeps,
} from "./agent-ops.js";

export const AGENTS_HELP = {
  usage: "agents <list|start|stop|resume|personas|doctor> ...",
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
    "{cli} agents doctor [-w <ws>] [--json]",
    "    each runtime, installed first: status, the CLI it runs and where it came",
    "    from, its version, the directories searched, and the fix; exit 1 when the",
    "    default is missing. -w: as that workspace's agents find them",
    "",
    "Runtimes: den-claude (default; Claude Code's claude), codex (OpenAI's Codex",
    "CLI), gemini (Google's Gemini CLI), grok (xAI's Grok Build), and generic (the",
    "persona's argv template). codex, gemini and grok run as their own CLI in the",
    "workspace, without Den's tools yet. Attach with `{cli} sessions attach <ws>:<id>`.",
    "A runtime's CLI is found as your terminal finds it: <ws>.agents.runtimes.<id>.bin",
    "in config/local/workspaces.yml, then agents.runtimes.<id>.bin in",
    "config/local/user.yml (absolute paths), then the login shell's PATH, this PATH,",
    "its install directories (~/.local/bin, /opt/homebrew/bin, /usr/local/bin, npm's",
    "global bin, the vendor's own), and last the interactive shell's PATH.",
    "An agent's env is PATH, HOME, USER, LOGNAME, SHELL, TERM, COLORTERM, LANG,",
    "LC_*, TZ and TMPDIR, plus what its runtime declares: nothing else of yours.",
  ],
};

async function list(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents list";
  const p = parseArgs(where, args, { "--workspace": true, "--json": false });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  if (!ws) throw new UsageError(`${where} needs -w <workspace>`);
  const rows = await listAgents(d, ws);
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

/** An early exit, as the terminal shows it: its code and last lines. */
function printEarlyExit(d: AgentsResolved, id: string, e: EarlyExit): void {
  const code = e.exitCode === undefined ? "" : ` (exit ${e.exitCode})`;
  d.err(`✗ agent ${id} exited at once${code}`);
  if (e.tail.length) {
    d.err(`  its last ${e.tail.length === 1 ? "line" : "lines"}:`);
    for (const l of e.tail) d.err(`  | ${l}`);
  }
  d.err(`  All of it: ${d.cli} sessions attach ${e.sessionName}`);
}

/** A start's or resume's warnings and outcome; its exit code. */
function report(d: AgentsResolved, s: Started, line: string): number {
  for (const w of s.warnings) d.err(w);
  if (s.early) {
    printEarlyExit(d, s.rec.id, s.early);
    return 1;
  }
  d.out(line);
  d.out(`  attach: ${d.cli} sessions attach ${s.rec.sessionName}`);
  return 0;
}

/** A flag's string value, or undefined. */
function str(
  p: ReturnType<typeof parseArgs>,
  flag: string,
): string | undefined {
  const v = p.flags[flag];
  return typeof v === "string" ? v : undefined;
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
  const persona = str(p, "--persona");
  if (!persona) throw new UsageError(`${where} needs --persona <p>`);
  const s = await startAgent(d, {
    workspace: ws,
    persona,
    runtime: str(p, "--runtime"),
    model: str(p, "--model"),
    id: str(p, "--id"),
  });
  return report(
    d,
    s,
    `started agent ${s.rec.id} (${s.rec.persona}, ${s.rec.runtime}) as ${s.rec.sessionName} in ${s.rec.cwd}`,
  );
}

/** `<id> [-w <ws>]`. */
function idAndWorkspace(
  where: string,
  args: string[],
): { id: string; ws?: string } {
  const p = parseArgs(where, args, { "--workspace": true });
  noExtra(where, p, 1);
  const id = p.positional[0];
  if (!id) throw new UsageError(`${where} needs <id>`);
  return { id, ws: workspaceFlag(where, p) };
}

async function stop(args: string[], d: AgentsResolved): Promise<number> {
  const { id, ws } = idAndWorkspace("agents stop", args);
  const { rec, session: s } = await stopAgent(d, id, ws);
  d.out(
    s
      ? `stopped agent ${rec.id} (sent TERM to ${s.name}, pid ${s.pid})`
      : `agent ${rec.id} was not running; marked stopped`,
  );
  return 0;
}

async function resume(args: string[], d: AgentsResolved): Promise<number> {
  const { id, ws } = idAndWorkspace("agents resume", args);
  const s = await resumeAgent(d, id, ws);
  if (s.fresh)
    d.out(
      `agent ${s.rec.id}: starting fresh: it was never prompted, so there is no conversation to resume`,
    );
  return report(
    d,
    s,
    `${s.fresh ? "started" : "resumed"} agent ${s.rec.id} as ${s.rec.sessionName} in ${s.rec.cwd}`,
  );
}

async function listPersonas(
  args: string[],
  d: AgentsResolved,
): Promise<number> {
  const where = "agents personas";
  const p = parseArgs(where, args, { "--json": false });
  noExtra(where, p);
  const all = personaList(d);
  if (p.flags["--json"]) {
    d.out(JSON.stringify(all, null, 2));
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

export interface AgentsDoctorDeps {
  /** Resolve the login shell's PATH first (default: initLoginPath). */
  loginPath?: () => Promise<void>;
}

const SOURCE_WORD: Record<string, string> = {
  workspace: "the workspace's agents.runtimes setting",
  setting: "agents.runtimes setting",
  "login-shell": "login shell PATH",
  PATH: "PATH",
  "well-known": "install directory",
  "interactive-shell": "interactive shell PATH",
};

/** `agents doctor`'s lines for one runtime (names and paths, never env values). */
export function doctorLines(
  r: RuntimeChoice,
  cli: string,
  userConfig: string,
  /** Directory lists already printed (a repeat is counted, not listed). */
  printed: string[] = [],
): string[] {
  const lines = [
    `${r.id}${r.label ? ` (${r.label}${r.vendor ? `, ${r.vendor}` : ""})` : ""}${r.default ? "  [default]" : ""}${r.denTools === false ? "  [Den tools: coming]" : ""}`,
    r.available
      ? "  status    ✓ available"
      : `  status    ✗ unavailable: ${r.why ?? "unknown"}`,
  ];
  if (r.path)
    lines.push(
      `  path      ${r.path}${r.source ? ` (${SOURCE_WORD[r.source] ?? r.source})` : ""}`,
    );
  if (r.available && r.setting)
    lines.push(`  version   ${r.version ?? "unknown"}`);
  if (!r.setting) lines.push("  path      none to find (the persona's argv)");
  else if (r.searched?.length) {
    const key = r.searched.join("\0");
    if (printed.includes(key))
      lines.push(
        `  searched  the same ${r.searched.length} ${r.searched.length === 1 ? "directory" : "directories"} as above`,
      );
    else {
      printed.push(key);
      r.searched.forEach((dir, i) =>
        lines.push(`  ${i === 0 ? "searched  " : "          "}${dir}`),
      );
    }
  } else if (r.source !== "setting") lines.push("  searched  (no directories)");
  if (!r.available && r.setting)
    lines.push(
      `  fix       install ${r.label ?? r.id}, or set ${r.setting} to its absolute path in ${userConfig}`,
      `            then run \`${cli} agents doctor\` again`,
    );
  return lines;
}

async function doctor(
  args: string[],
  d: AgentsResolved,
  deps: AgentsDoctorDeps,
): Promise<number> {
  const where = "agents doctor";
  const p = parseArgs(where, args, { "--workspace": true, "--json": false });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  if (ws && !d.workspaceExists(ws))
    throw new UsageError(`${where}: workspace "${ws}" does not exist`);
  await (deps.loginPath ?? (() => initLoginPath({ env: d.env })))();
  const rts = await listRuntimes(d, ws);
  const def = rts.find((r) => r.default);
  const code = def?.available ? 0 : 1;
  if (p.flags["--json"]) {
    d.out(
      JSON.stringify(
        {
          runtimes: rts,
          ...(ws ? { workspace: ws } : {}),
          userConfig: d.userConfigFile(),
        },
        null,
        2,
      ),
    );
    return code;
  }
  const printed: string[] = [];
  rts.forEach((r, i) => {
    if (i) d.out("");
    for (const l of doctorLines(r, d.cli, d.userConfigFile(), printed))
      d.out(l);
  });
  d.out("");
  d.out(
    `\`${d.cli} doctor --probe\` checks the env each runtime's session gets.`,
  );
  return code;
}

/** `<cli> agents ...`; returns the exit code. */
export async function cmdAgents(
  args: string[],
  deps: AgentsDeps & AgentsDoctorDeps = {},
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
          await loadAgentWorkspaces(deps);
          return await start(rest, d);
        case "stop":
          return await stop(rest, d);
        case "resume":
          await loadAgentWorkspaces(deps);
          return await resume(rest, d);
        case "personas":
          return await listPersonas(rest, d);
        case "doctor":
          return await doctor(rest, d, deps);
        default:
          throw new UsageError(`unknown agents command "${sub}"`);
      }
    } catch (e) {
      if (e instanceof AgentError) {
        if (e.usage) throw new UsageError(e.message);
        d.err(`✗ ${e.message}`);
        for (const h of e.hints) d.err(`  ${h}`);
        return 1;
      }
      if (e instanceof HostError) {
        d.err(`✗ ${e.message}`);
        return 1;
      }
      throw e;
    }
  });
}
