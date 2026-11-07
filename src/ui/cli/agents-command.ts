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
 *   resume  only when its runtime declares resume, its record holds the
 *           runtime's resume token, and its session is not running: a new
 *           session, in the same cwd and workspace with the grants it had,
 *           continuing the last conversation (den-claude: --resume <token>);
 *           when that session was never prompted, a fresh start under the
 *           same conversation id (there is nothing to continue).
 *           --all-interrupted (AG-14.3): every agent interrupted when Den or
 *           the machine restarted that can resume.
 *   rm      (AG-14.1b) forgets a stopped, interrupted or exited agent (never
 *           a running one); --stopped forgets every one of -w <ws> (or of
 *           every workspace). The runtime's own history stays.
 *   doctor  (AG-0.3, AG-0.5) each runtime of the catalog, installed
 *           first: its status, the CLI it runs and where that came from
 *           (workspace or user.yml setting, login shell, PATH, install
 *           directory, interactive shell), its
 *           version (its version command, once, under a timeout), the
 *           directories searched (names only, never an env value), and the
 *           fix when it is missing. Exit 1 when the default runtime is
 *           unavailable. It resolves the login shell's PATH first, as the
 *           web server does at start.
 *   handback-check <file|->  (den#5) the hand-back check (handback.ts) on a
 *           file or stdin: each problem on its own line, exit 1 when there
 *           is one, 0 when the hand-back is complete and plain.
 *   relaunch (den#4, session rotation) once an agent's session rotated
 *           (after agents.rotate.after_compactions compactions, or its pull
 *           request merged) and its handoff.md passes the check: a fresh
 *           conversation, same persona, workspace, folder and grants, whose
 *           first prompt is the handoff. `resume` on a rotated agent
 *           refuses (exit 1) and names relaunch.
 *   handoff-check <file|->  (den#4) the handoff check (handoff.ts), like
 *           handback-check.
 *
 * Nothing here takes a grant: grants come from the org config only. The
 * host enforces agents.max_concurrent on every start, counting agents only.
 */
import * as fs from "fs";
import { DEFAULT_RUNTIME_ID } from "../../shared/agents/runtimes.js";
import { initLoginPath } from "../../shared/agents/runtime-search.js";
import { HostError } from "../../shared/sessions/client.js";
import { checkHandback } from "../../shared/agents/handback.js";
import { checkHandoff } from "../../shared/agents/handoff.js";
import { reasonText } from "../../shared/agents/rotation.js";
import { listRecords } from "../../shared/agents/records.js";
import {
  AgentError,
  listAgents,
  listPersonas as personaList,
  listRuntimes,
  loadAgentWorkspaces,
  relaunchAgent,
  removeAgent,
  removeStopped,
  resolveAgentsDeps,
  resumeAgent,
  resumeInterrupted,
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
  usage:
    "agents <list|start|stop|resume|relaunch|rm|personas|doctor|handback-check|handoff-check> ...",
  lines: [
    "Agents: a persona and a workspace, run by a runtime in a session that",
    "outlives the web server (see `{cli} sessions`).",
    "",
    "{cli} agents list -w <ws> [--stopped] [--json]",
    "    --stopped: only the stopped, interrupted and exited ones",
    "{cli} agents start -w <ws> --persona <p> [--runtime <r>] [--model <m>] [--id <id>]",
    "    runs in the workspace's dir as <dist>-<ws>:<id>; its MCP is pinned to <ws>",
    "    (plus agents.<id>.grants); capped by agents.max_concurrent",
    "{cli} agents stop <id> [-w <ws>] [--no-wait]",
    "    waits up to 5 s for the session to end (else: still stopping, exit 1);",
    "    --no-wait: return once TERM is sent",
    "{cli} agents resume <id> [-w <ws>]",
    "{cli} agents resume --all-interrupted [-w <ws>]",
    "    the same conversation, persona, workspace and folder, when its runtime",
    "    can resume one and its session has ended; with nothing to resume yet,",
    "    it starts fresh under the same conversation id. --all-interrupted: every",
    "    agent interrupted when Den or the machine restarted. A rotated agent",
    "    is not resumed: relaunch it",
    "{cli} agents relaunch <id> [-w <ws>]",
    "    session rotation: once a session ended after agents.rotate.after_compactions",
    "    compactions (default 3) or its pull request merged, and its handoff.md",
    "    passes the check, a fresh conversation (same persona, workspace, folder,",
    "    grants) whose first prompt is the handoff",
    "{cli} agents rm <id> [-w <ws>]",
    "{cli} agents rm --stopped [-w <ws>]",
    "    forget a stopped, interrupted or exited agent (never a running one);",
    "    the runtime keeps its own history. agents.remove_stopped_after in",
    "    user.yml (never, 1d, 7d) forgets stopped ones on its own",
    "{cli} agents personas [--json]",
    "    Den's default pack, then agents.persona_packs (a later pack wins by id)",
    "{cli} agents doctor [-w <ws>] [--json]",
    "    each runtime, installed first: status, the CLI it runs and where it came",
    "    from, its version, the directories searched, and the fix; exit 1 when the",
    "    default is missing. -w: as that workspace's agents find them",
    "{cli} agents handback-check <file|-> [--json]",
    "    checks a hand-back to a person: URL, machine, branch, what changed, what",
    "    to click and decisions are all there, every ID is explained, and each",
    "    decision is a numbered yes/no question; exit 1 with what to fix",
    "{cli} agents handoff-check <file|-> [--json]",
    "    checks a handoff.md: Objective, State, Open items, How to QA and Next step",
    "    are all there and filled in, and every ID is explained; exit 1 with what",
    "    to fix",
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
  const p = parseArgs(where, args, {
    "--workspace": true,
    "--json": false,
    "--stopped": false,
  });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  if (!ws) throw new UsageError(`${where} needs -w <workspace>`);
  const rows = await listAgents(d, ws, {
    stopped: p.flags["--stopped"] === true,
  });
  if (p.flags["--json"]) {
    d.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    d.out(
      p.flags["--stopped"]
        ? `no stopped agents in ${ws}`
        : `no agents in ${ws}`,
    );
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
      r.rotation?.due
        ? `${r.state}, ${r.rotation.ready ? "ready to relaunch" : "handoff due"} (${reasonText(r.rotation.due, r.rotation.compactions)})`
        : r.state,
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
  // --no-wait: return once TERM is sent (before 0.4.8, always).
  const wait = !args.includes("--no-wait");
  const { id, ws } = idAndWorkspace(
    "agents stop",
    args.filter((a) => a !== "--no-wait"),
  );
  const {
    rec,
    session: s,
    stillStopping,
  } = await stopAgent(d, id, ws, {
    wait,
  });
  if (stillStopping) {
    d.err(
      `${rec.id} is still stopping (sent TERM to ${s!.name}, pid ${s!.pid}; not ended after ${d.stopWaitMs / 1000} s)`,
    );
    return 1;
  }
  d.out(
    s
      ? `stopped agent ${rec.id} (sent TERM to ${s.name}, pid ${s.pid}${wait && d.stopWaitMs > 0 ? "; it has ended" : ""})`
      : `agent ${rec.id} was not running; marked stopped`,
  );
  return 0;
}

async function resume(args: string[], d: AgentsResolved): Promise<number> {
  if (args.includes("--all-interrupted")) return resumeAll(args, d);
  const { id, ws } = idAndWorkspace("agents resume", args);
  const s = await resumeAgent(d, id, ws);
  if (s.fresh)
    d.out(
      `agent ${s.rec.id}: nothing to resume yet; started fresh (same conversation id, folder and scope)`,
    );
  return report(
    d,
    s,
    `${s.fresh ? "started" : "resumed"} agent ${s.rec.id} as ${s.rec.sessionName} in ${s.rec.cwd}`,
  );
}

/** `agents relaunch <id> [-w <ws>]` (den#4). */
async function relaunch(args: string[], d: AgentsResolved): Promise<number> {
  const { id, ws } = idAndWorkspace("agents relaunch", args);
  const s = await relaunchAgent(d, id, ws);
  return report(
    d,
    s,
    `relaunched agent ${s.rec.id} from its handoff (the last session ended after ${s.why}) as ${s.rec.sessionName} in ${s.rec.cwd}`,
  );
}

/** `agents resume --all-interrupted [-w <ws>]` (AG-14.3). */
async function resumeAll(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents resume";
  const p = parseArgs(where, args, {
    "--workspace": true,
    "--all-interrupted": false,
  });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  const r = await resumeInterrupted(d, ws ? [ws] : undefined);
  if (!r.resumed.length && !r.failed.length) {
    d.out(`no interrupted agents${ws ? ` in ${ws}` : ""}`);
    return 0;
  }
  for (const x of r.resumed)
    d.out(
      `${x.fresh ? "started" : "resumed"} agent ${x.rec.id} as ${x.rec.sessionName} in ${x.rec.cwd}`,
    );
  for (const f of r.failed) d.err(`✗ agent ${f.agent}: ${f.why}`);
  return r.failed.length ? 1 : 0;
}

/** `agents rm <id> [-w <ws>]`, `agents rm --stopped [-w <ws>]` (AG-14.1b). */
async function rm(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents rm";
  const p = parseArgs(where, args, { "--workspace": true, "--stopped": false });
  noExtra(where, p, 1);
  const ws = workspaceFlag(where, p);
  const id = p.positional[0];
  if (p.flags["--stopped"]) {
    if (id) throw new UsageError(`${where}: give <id> or --stopped, not both`);
    if (ws && !d.workspaceExists(ws))
      throw new UsageError(`${where}: workspace "${ws}" does not exist`);
    const wss = ws
      ? [ws]
      : [...new Set(listRecords(d.stateDir()).map((r) => r.workspace))];
    const gone = await removeStopped(d, wss);
    d.out(
      gone.length
        ? `removed ${gone.length} stopped ${gone.length === 1 ? "agent" : "agents"}: ${gone.map((g) => g.agent).join(", ")}`
        : `no stopped agents${ws ? ` in ${ws}` : ""}`,
    );
    return 0;
  }
  if (!id) throw new UsageError(`${where} needs <id> or --stopped`);
  const [gone] = await removeAgent(d, id, ws);
  d.out(
    `removed agent ${gone?.agent ?? id}; its conversation stays in the runtime's own history`,
  );
  return 0;
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
  /** Read a hand-back: a file path, or "-" for stdin (handback-check). */
  readHandback?: (src: string) => Promise<string>;
}

async function readFileOrStdin(src: string): Promise<string> {
  if (src !== "-") return fs.promises.readFile(src, "utf-8");
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

/** `agents handback-check <file|-> [--json]`, or handoff-check (den#4). */
async function handbackCheck(
  args: string[],
  d: AgentsResolved,
  deps: AgentsDoctorDeps,
  kind: "handback" | "handoff" = "handback",
): Promise<number> {
  const where = `agents ${kind}-check`;
  const p = parseArgs(where, args, { "--json": false });
  if (p.positional.length !== 1 || p.rest)
    throw new UsageError(`${where} takes one file, or - for stdin`);
  const src = p.positional[0];
  let text: string;
  try {
    text = await (deps.readHandback ?? readFileOrStdin)(src);
  } catch (e) {
    d.err(
      `✗ ${where}: can't read ${src} (${(e as NodeJS.ErrnoException).code ?? "error"})`,
    );
    return 1;
  }
  const r = kind === "handoff" ? checkHandoff(text) : checkHandback(text);
  const what = kind === "handoff" ? "handoff" : "hand-back";
  if (p.flags["--json"]) d.out(JSON.stringify(r, null, 2));
  else if (r.ok) d.out(`✓ the ${what} is complete and plain`);
  else {
    d.out(`✗ the ${what} is not ready:`);
    for (const l of r.problems) d.out(`  - ${l}`);
  }
  return r.ok ? 0 : 1;
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
        case "relaunch":
          await loadAgentWorkspaces(deps);
          return await relaunch(rest, d);
        case "rm":
          await loadAgentWorkspaces(deps);
          return await rm(rest, d);
        case "personas":
          return await listPersonas(rest, d);
        case "doctor":
          // -w checks the workspace exists, and reads its runtime paths.
          await loadAgentWorkspaces(deps);
          return await doctor(rest, d, deps);
        case "handback-check":
          return await handbackCheck(rest, d, deps);
        case "handoff-check":
          return await handbackCheck(rest, d, deps, "handoff");
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
