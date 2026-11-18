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
 *   import  (AG-17.1) bring in a conversation started outside Den: with
 *           no --session, the runtime's own conversations in the
 *           workspace's folder (newest first); with --session <id> and
 *           --persona <p>, the runtime's resume of it (den-claude:
 *           --resume <id>) in the folder it ran in, as a new agent under
 *           Den's token, hooks and guards. Refused while it is still open
 *           in another terminal (written in the last minute).
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
 *   handoff-check <id|file|->  (den#4) the handoff check (handoff.ts), like
 *           handback-check.
 *
 * Nothing here takes a grant: grants come from the org config only. The
 * host enforces agents.max_concurrent on every start, counting agents only.
 */
import {
  gatherApiOnly,
  readApiOnlyAudit,
  type ApiOnlyRules,
} from "../../shared/agents/api-only.js";
import * as fs from "fs";
import * as path from "path";
import { readAgentsConfig } from "../../shared/den-config.js";
import {
  listUploads,
  uploadsRoot,
  UPLOAD_DEFAULTS,
} from "../../shared/agents/uploads.js";
import { DEFAULT_RUNTIME_ID } from "../../shared/agents/runtimes.js";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import { initLoginPath } from "../../shared/agents/runtime-search.js";
import { HostError } from "../../shared/sessions/client.js";
import { checkHandback } from "../../shared/agents/handback.js";
import { checkHandoff } from "../../shared/agents/handoff.js";
import { handoffFile, reasonText } from "../../shared/agents/rotation.js";
import { shownDepths, sortHelpers } from "../../shared/agents/helpers.js";
import { isConfigError } from "../../shared/config-error.js";
import { auditConfig } from "../../shared/config-audit.js";
import {
  parseRotateValue,
  type OverrideScope,
} from "../../shared/agents/rotate-settings.js";
import {
  agentFilesDir,
  listRecords,
  readRecord,
} from "../../shared/agents/records.js";
import {
  AgentError,
  importAgent,
  changePersona,
  restartAgent,
  staleAgents,
  type McpStale,
  listAgents,
  agentHelpers,
  agentHelperTranscript,
  listConversations,
  listPersonas as personaList,
  listRuntimes,
  loadAgentWorkspaces,
  relaunchAgent,
  resumeOrRelaunch,
  keepAgentConversation,
  setAgentResumeOnRestart,
  askForHandoff,
  rotationSettings,
  setRotationSetting,
  removeAgent,
  removeStopped,
  renameAgent,
  moveAgent,
  setAgentPermission,
  setAgentFolder,
  setAgentRepo,
  checkRepoName,
  agentLinkReport,
  workspaceRepoFolders,
  resolveAgentsDeps,
  resumeInterrupted,
  startAgent,
  stopAgent,
  type AgentsDeps,
  type AgentsResolved,
  type EarlyExit,
  FRESH_NOTE,
  type RuntimeChoice,
  type Started,
  subagentsReport,
  type SubagentsReport,
  workspacePermissionOf,
} from "./agent-ops.js";
import {
  checkIntent,
  PERMISSION_INTENTS,
  type PermissionIntent,
} from "../../shared/agents/permissions.js";
import {
  DEN_CLAUDE_PERMISSIONS,
  permissionModesOf,
} from "../../shared/agents/den-claude.js";
import { workspacePermissionKey } from "../../shared/environment-manager/workspaces.js";
import {
  INHERIT,
  SUBAGENT_FORCE_MIN,
  forcesSubagentModel,
} from "../../shared/agents/subagents.js";
import { peerSessionName } from "../../shared/agents/session-name.js";
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
import {
  isServerScope,
  SERVER_AGENT_ID,
} from "../../shared/agents/server-agent.js";
import { localDateTime } from "../../shared/local-time.js";

export const AGENTS_HELP = {
  usage:
    "agents <list|start|stop|resume|relaunch|rotate|keep|set|handoff|import|persona|restart|helpers|rename|move|link|unlink|files|rm|permission|personas|doctor|handback-check|handoff-check|token|accounts> ...",
  lines: [
    "Agents: a persona and a project, run by a runtime in a session that",
    "outlives the web server (see `{cli} sessions`).",
    "",
    "{cli} agents list -w <ws> [--stopped] [--json]",
    "    --stopped: only the stopped, interrupted and exited ones",
    "{cli} agents start -w <ws> --persona <p> [--runtime <r>] [--model <m>] [--name <name>] [--id <id>] [--repo <repo> | --folder <path>]",
    "    runs in the project's repo (--repo, else its first) as <dist>-<ws>:<id>,",
    "    or in --folder (a folder of the project's, a worktree); MCP pinned to <ws>",
    "    (plus agents.<id>.grants); capped by agents.max_concurrent",
    "{cli} agents stop <id> [-w <ws>] [--no-wait]",
    "    waits up to 5 s for the session to end (else: still stopping, exit 1);",
    "    --no-wait: return once TERM is sent",
    "{cli} agents resume <id> [-w <ws>]",
    "{cli} agents resume --all-interrupted [-w <ws>]",
    "    the same conversation, persona, project and folder, when its runtime",
    "    can resume one and its session has ended; with nothing to resume yet,",
    "    it starts fresh under the same conversation id. --all-interrupted: every",
    "    agent interrupted when Den or the machine restarted. A rotated agent",
    "    is not resumed: relaunch it",
    "{cli} agents relaunch <id> [-w <ws>]",
    "    session rotation: once a session ended after agents.rotate.after_compactions",
    "    compactions (default 3) or its pull request merged, and its handoff.md",
    "    passes the check, a fresh conversation (same persona, project, folder,",
    "    grants) whose first prompt is the handoff",
    "{cli} agents rotate [--agent|--persona|--workspace|--service <x>] [-w <ws>] <key> <value>",
    "{cli} agents rotate [scope] --unset <key>   ·   {cli} agents rotate   ·   {cli} agents rotate <id> --show",
    "    rotation settings: after_compactions <n>|never (default 3), on_due",
    "    auto|ask|off (default auto: Den asks for the handoff at idle and",
    "    relaunches by itself), on_pr_merged true|false. No scope: this install.",
    "    --persona <p> -w <ws>: the persona in that project. The most specific",
    "    wins: agent, persona in a project, persona, project, service,",
    "    install, org config. --show: an agent's values and where each comes from",
    "{cli} agents keep <id> [-w <ws>] [--never]",
    "    keep its conversation: the compaction count starts again; --never: this",
    "    agent never rotates. A person's only",
    "{cli} agents set <id> [-w <ws>] resume_on_restart on|off|default",
    "    whether it resumes on its own after a restart (default: its persona's;",
    "    a standing persona's is on). A person's only",
    "{cli} agents handoff <id> [-w <ws>]",
    "    ask a running agent, at idle, to write its handoff",
    "{cli} agents helpers <id> [-w <ws>] [--all] [--json]",
    "    the helpers it started in its own session (Claude Code's Agent and",
    "    Workflow subagents): what each does, its type, model, branch, state and",
    "    times; running first. --all: its earlier conversations' too, and those",
    "    a person cleared (Clear done on the Agents page). Read-only:",
    "    they belong to the agent's session, so Den can't stop or steer them",
    "{cli} agents helpers <id> <helper> [-w <ws>] [--limit <n>] [--json]",
    "    one helper's transcript, tool calls summarized (the last 500 lines)",
    "{cli} agents import -w <ws> [--runtime <r>] [--json]",
    "{cli} agents import -w <ws> --session <id> --persona <p> [--runtime <r>] [--id <id>] [--model <m>] [--outside <folder>]",
    "    bring in a conversation started outside Den: the first lists the runtime's",
    "    own (default den-claude) in the project's folder; the second continues",
    "    one as a Den agent (its resume, in the folder it ran in). Refused while it",
    "    is still open in another terminal: close it there first. It keeps the",
    "    conversation's own model unless --model gives one",
    "{cli} agents persona <id> <persona> [-w <ws>] [--model <m>] [--now | --after-turn]",
    "    change an agent's persona: the same conversation resumes with the new",
    "    persona's role, permissions and commands; id, name, folder and model stay.",
    "    Mid-turn it asks: --after-turn waits for the turn to end, --now stops it.",
    "    A person's only (refused in an agent's session)",
    "{cli} agents restart <id> [-w <ws>] [--now]",
    "    stop a running agent and resume the same conversation, so it gets the",
    "    tools it would get now (Hub's, after Connect). It waits for its turn",
    "    to end; --now stops it at once. A person's only",
    "{cli} agents move <id> -w <ws> [--now]",
    "    move an agent to another project; same conversation, folder and name.",
    "    A running one waits for its turn to end (--now: at once), then resumes",
    "    there, with that project's tools. A person's only",
    "{cli} agents rename <id> <name> [-w <ws>]",
    "{cli} agents rename <id> --clear [-w <ws>]",
    "    name an agent (its tab, row and pane header); the id never changes.",
    "    Other sessions see it as {cli}-<ws>:<name> from its next start or resume.",
    "{cli} agents folder <id> (--repo <repo> | --folder <path>) [-w <ws>]",
    "    move a stopped agent to another folder of its project; its next start",
    "    is a new conversation there. A person's only",
    "{cli} agents link <id> --repo <repo> [-w <ws>]",
    "{cli} agents unlink <id> [-w <ws>]",
    "    the repo of its project it works on: that repo's service cards list it,",
    "    through every restart. Unlinked, it shows under Also in <project>.",
    "    --clear: back to its id",
    "{cli} agents files <id> [-w <ws>] [--json]",
    "    the files dropped, pasted or attached onto the agent's terminal (its",
    "    uploads), newest first: when, size and path. agents.uploads sets the",
    "    cap, how long they're kept and where",
    "{cli} agents rm <id> [-w <ws>]",
    "{cli} agents rm --stopped [-w <ws>]",
    "    forget a stopped, interrupted or exited agent (never a running one);",
    "    the runtime keeps its own history. agents.remove_stopped_after in",
    "    user.yml (never, 1d, 7d) forgets stopped ones on its own",
    "{cli} agents permission <id> [ask|edits|auto|all|--clear]",
    "    one agent's mode: given, it stays through every restart; cleared, it",
    "    follows its project's mode, else its persona's. A running agent",
    "    restarts at its next idle, on the same conversation, to take it.",
    "    A person's only",
    "{cli} agents permission -w <ws> [ask|edits|auto|all|--clear]",
    "    the permission mode the project's agents start with when the start",
    "    names none (over their persona's); none given: shows it. auto: Claude",
    "    Code's own check runs routine actions and blocks risky ones, without",
    "    asking (needs a Claude Code that lists it: see doctor). A person's only",
    "{cli} agents personas [--json]",
    "    Den's default pack, then agents.persona_packs (a later pack wins by id)",
    "{cli} agents doctor [-w <ws>] [--json]",
    "    each runtime, installed first: status, the CLI it runs and where it came",
    "    from, its version, the directories searched, and the fix; exit 1 when the",
    "    default is missing. -w: as that project's agents find them. Also the",
    "    running agents whose tools are out of date (Hub changed since they started)",
    "{cli} agents handback-check <file|-> [--json]",
    "    checks a hand-back to a person: URL, machine, branch, what changed, what",
    "    to click and decisions are all there, every ID is explained, and each",
    "    decision is a numbered yes/no question; exit 1 with what to fix",
    "{cli} agents token set   ·   {cli} agents token status   ·   {cli} agents token clear [--yes]",
    "    the long-lived sign-in token agents use under Keep agents running after",
    "    logout (make it once with claude setup-token): set reads it from stdin or",
    "    a prompt that doesn't show it, never the command line, and saves it in",
    "    the install's secrets store. status: whether it is there and when it was",
    "    set. clear: removes it from the store, the way set kept it (asks first",
    "    unless --yes). set and clear are a person's only",
    "{cli} `agents accounts` list | add [--name <n>] | set-token <n> | order <n>... | remove <n> [--yes]   [--runtime <id>]",
    "    Claude accounts for agents (Claude account A, B, ... unless named); each token",
    "    its own item in the install's secrets store; set-token reads it like",
    "    token set. Agents sign in with the first in the order. The token that",
    "    exists today is Claude account A. Changes are a person's only",
    "{cli} agents handoff-check <id|file|-> [--json]",
    "    checks an agent's handoff.md (or a file, or stdin): Objective, State, Open items, How to QA and Next step",
    "    are all there and filled in, and every ID is explained; exit 1 with what",
    "    to fix",
    "",
    "Runtimes: den-claude (default; Claude Code's claude), codex (OpenAI's Codex",
    "CLI), gemini (Google's Gemini CLI), grok (xAI's Grok Build), and generic (the",
    "persona's argv template). codex, gemini and grok run as their own CLI in the",
    "project, without Den's tools yet. Attach with `{cli} sessions attach <ws>:<id>`.",
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
  if (!ws) throw new UsageError(`${where} needs -w <project>`);
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
    "--name": true,
    "--id": true,
    // Gap 7: the repo it works in, or a folder of the project's (a worktree).
    "--repo": true,
    "--folder": true,
  });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  if (!ws) throw new UsageError(`${where} needs -w <project>`);
  const persona = str(p, "--persona");
  const name = str(p, "--name");
  if (!persona) throw new UsageError(`${where} needs --persona <p>`);
  const repo = str(p, "--repo");
  const folder = str(p, "--folder");
  const s = await startAgent(d, {
    workspace: ws,
    persona,
    runtime: str(p, "--runtime"),
    model: str(p, "--model"),
    id: str(p, "--id"),
    ...(name !== undefined ? { name } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(folder !== undefined ? { folder } : {}),
  });
  return report(
    d,
    s,
    `started agent ${s.rec.id} (${s.rec.persona}, ${s.rec.runtime}) as ${s.rec.sessionName} in ${s.rec.cwd}`,
  );
}

/** `agents import` (AG-17.1): list, or bring one in. */
async function bringIn(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents import";
  const p = parseArgs(where, args, {
    "--workspace": true,
    "--runtime": true,
    "--session": true,
    "--persona": true,
    "--id": true,
    "--model": true,
    "--version": true,
    "--outside": true,
    "--json": false,
  });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  if (!ws) throw new UsageError(`${where} needs -w <project>`);
  const runtime = str(p, "--runtime");
  const session = str(p, "--session");
  const outside = str(p, "--outside");
  // D56: bringing in from outside the project is a person's ask only.
  if (outside !== undefined && isAgentTokenEnv(d.env))
    throw new AgentError(
      `${where}: only a person can bring in a conversation from outside the project (this is an agent)`,
    );
  if (!session) {
    if (str(p, "--persona") || str(p, "--id"))
      throw new UsageError(`${where}: --persona and --id need --session <id>`);
    const {
      runtimes,
      conversations,
      outside: away,
    } = listConversations(d, ws, runtime);
    if (p.flags["--json"]) {
      d.out(
        JSON.stringify(
          { workspace: ws, runtimes, conversations, outside: away },
          null,
          2,
        ),
      );
      return 0;
    }
    for (const r of runtimes)
      if (!r.bringIn && (!runtime || runtime === r.id)) d.err(`${r.why}`);
    if (!conversations.length && !away.length) {
      d.out(`no conversations to bring in for project ${ws}`);
      return 0;
    }
    d.out(
      columns([
        ["ID", "RUNTIME", "LAST", "TITLE", "FOLDER", "NOTE"],
        ...conversations.map((c) => [
          c.id,
          c.runtime,
          localDateTime(c.lastAt),
          c.title ?? "(untitled)",
          c.cwd,
          c.agent ? `agent ${c.agent}` : c.open ? "open elsewhere" : "",
        ]),
      ]).join("\n"),
    );
    d.out(
      `bring one in: ${d.cli} agents import -w ${ws} --session <id> --persona <p>`,
    );
    // D56: started outside every project: each comes in by naming its folder.
    if (away.length) {
      d.out("");
      d.out("started outside any project:");
      d.out(
        columns([
          ["ID", "RUNTIME", "LAST", "TITLE", "FOLDER", "NOTE"],
          ...away.map((c) => [
            c.id,
            c.runtime,
            localDateTime(c.lastAt),
            c.title ?? "(untitled)",
            c.cwd,
            c.agent ? `agent ${c.agent}` : c.open ? "open elsewhere" : "",
          ]),
        ]).join("\n"),
      );
      d.out(
        `bring one in from its folder: ${d.cli} agents import -w ${ws} --session <id> --persona <p> --outside <folder>`,
      );
    }
    return 0;
  }
  const persona = str(p, "--persona");
  if (!persona) throw new UsageError(`${where} needs --persona <p>`);
  const s = await importAgent(d, {
    workspace: ws,
    session,
    persona,
    runtime,
    id: str(p, "--id"),
    // AG-17.1c: the conversation's own model unless one is given.
    ...(str(p, "--model") !== undefined ? { model: str(p, "--model") } : {}),
    ...(str(p, "--version") !== undefined
      ? { version: str(p, "--version") }
      : {}),
    ...(outside !== undefined ? { outside } : {}),
  });
  return report(
    d,
    s,
    `brought in ${session} as agent ${s.rec.id} (${s.rec.persona}, ${s.rec.runtime}) as ${s.rec.sessionName} in ${s.rec.cwd}`,
  );
}

/**
 * `agents persona <id> <persona> [-w <ws>] [--model <m>] [--version <v>]
 * [--now | --after-turn]` (AG-18). A person's only: refused inside an
 * agent's session (its DEN_ACTOR_TOKEN), so an agent can't widen its own
 * permissions.
 */
async function persona(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents persona";
  if (isAgentTokenEnv(d.env))
    throw new AgentError(
      `${where}: only a person can change an agent's persona (this is an agent)`,
    );
  const p = parseArgs(where, args, {
    "--workspace": true,
    "--model": true,
    "--version": true,
    "--now": false,
    "--after-turn": false,
  });
  noExtra(where, p, 2);
  const [id, to] = p.positional;
  if (!id || !to) throw new UsageError(`${where} needs <id> <persona>`);
  if (p.flags["--now"] && p.flags["--after-turn"])
    throw new UsageError(`${where}: --now or --after-turn, not both`);
  const when = p.flags["--now"]
    ? "now"
    : p.flags["--after-turn"]
      ? "after-turn"
      : undefined;
  mustBeAgent(d, id, workspaceFlag(where, p));
  if (when === "after-turn") d.out(`waiting for agent ${id}'s turn to end…`);
  const s = await changePersona(d, id, workspaceFlag(where, p), {
    persona: to,
    ...(str(p, "--model") !== undefined ? { model: str(p, "--model") } : {}),
    ...(str(p, "--version") !== undefined
      ? { version: str(p, "--version") }
      : {}),
    ...(when ? { when } : {}),
    by: "cli",
  });
  return report(
    d,
    s,
    s.fresh
      ? `agent ${s.rec.id} is now ${s.rec.persona} (was ${s.from}); ${FRESH_NOTE}, as ${s.rec.sessionName} in ${s.rec.cwd}`
      : `agent ${s.rec.id} is now ${s.rec.persona} (was ${s.from}); same conversation, as ${s.rec.sessionName} in ${s.rec.cwd}`,
  );
}

/** Edit distance, bounded (a name a person mistyped). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[n];
}

/**
 * Agent `id` (in `ws` when given) exists, before anything waits on it: else
 * "no agent", with the closest agent's id in that project when one is near
 * (its id, or its name as people see it).
 */
export function mustBeAgent(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
): void {
  const rec = readRecord(d.stateDir(), id);
  if (rec && (!ws || rec.workspace === ws)) return;
  const all = listRecords(d.stateDir()).filter(
    (r) => !ws || r.workspace === ws,
  );
  const t = id.toLowerCase();
  const score = (r: (typeof all)[number]) =>
    Math.min(
      editDistance(t, r.id.toLowerCase()),
      r.displayName ? editDistance(t, r.displayName.toLowerCase()) : 99,
      r.id.toLowerCase().includes(t) || t.includes(r.id.toLowerCase()) ? 1 : 99,
    );
  const near = all
    .map((r) => ({ r, s: score(r) }))
    .filter((x) => x.s <= Math.max(2, Math.floor(t.length / 3)))
    .sort((a, b) => a.s - b.s || a.r.id.localeCompare(b.r.id))[0]?.r;
  throw new AgentError(`no agent "${id}"${ws ? ` in ${ws}` : ""}`, {
    hints: [
      ...(near ? [`did you mean ${near.id}?`] : []),
      `\`${d.cli} agents list${ws ? ` -w ${ws}` : ""}\` lists them`,
    ],
  });
}

/**
 * Issue 216: every restart, stop and resume from the CLI leaves one audit
 * row (the web server's audit.jsonl, as the page's and MCP's do): who (the
 * person running this), which agent, which project, and what came of it.
 * `run` answers the exit code and the outcome's words; a throw is recorded
 * as refused (or still busy) with why, then thrown on.
 */
async function audited(
  d: AgentsResolved,
  verb: "restart" | "stop" | "resume",
  id: string,
  ws: string | undefined,
  run: () => Promise<{ code: number; outcome: string; reason?: string }>,
  how = "",
): Promise<number> {
  const project = () => ws ?? readRecord(d.stateDir(), id)?.workspace ?? "?";
  const row = (outcome: string, reason?: string) =>
    auditConfig(
      {
        verb: "agents",
        detail: `${verb} ${id} in ${project()}${how}: ${outcome}${isAgentTokenEnv(d.env) ? " · from an agent's terminal" : ""}`,
        ...(reason ? { outcome: "refused" as const, reason } : {}),
      },
      d.stateDir(),
    );
  try {
    const r = await run();
    row(r.outcome, r.reason);
    return r.code;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    row(
      e instanceof AgentError && e.code === "still_busy"
        ? "still busy"
        : "refused",
      why,
    );
    throw e;
  }
}

/**
 * D44: `agents restart <id> [-w <ws>] [--now]`: the same conversation,
 * launched again with what it gets now. A person's only.
 */
async function restart(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents restart";
  if (isAgentTokenEnv(d.env))
    throw new AgentError(
      `${where}: only a person can restart an agent (this is an agent)`,
    );
  const p = parseArgs(where, args, { "--workspace": true, "--now": false });
  noExtra(where, p, 1);
  const [id] = p.positional;
  if (!id) throw new UsageError(`${where} needs <id>`);
  const now = p.flags["--now"] === true;
  const ws = workspaceFlag(where, p);
  return audited(
    d,
    "restart",
    id,
    ws,
    async () => {
      mustBeAgent(d, id, ws);
      if (!now) d.out(`waiting for agent ${id}'s turn to end…`);
      const s = await restartAgent(d, id, ws, now ? "now" : "after-turn", {
        askIfJob: true,
      });
      if (s.already) {
        d.out(`agent ${s.rec.id} was ${s.already.note}`);
        return {
          code: 0,
          outcome: `already restarted by another request at ${s.already.at}`,
        };
      }
      const code = report(
        d,
        s,
        s.fresh
          ? `restarted agent ${s.rec.id}; ${FRESH_NOTE}, as ${s.rec.sessionName} in ${s.rec.cwd}`
          : `restarted agent ${s.rec.id}; same conversation, as ${s.rec.sessionName} in ${s.rec.cwd}`,
      );
      return {
        code,
        outcome: s.early ? "exited at once" : "restarted",
        ...(s.early ? { reason: "exited at once" } : {}),
      };
    },
    now ? " (now)" : " (at its next idle)",
  );
}

/**
 * D72: `agents move <id> -w <ws> [--now]`: to another workspace, same
 * conversation. A running agent waits for its turn to end. A person's only.
 */
async function move(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents move";
  if (isAgentTokenEnv(d.env))
    throw new AgentError(
      `${where}: only a person can move an agent (this is an agent)`,
    );
  const p = parseArgs(where, args, { "--workspace": true, "--now": false });
  noExtra(where, p, 1);
  const [id] = p.positional;
  const to = workspaceFlag(where, p);
  if (!id || !to)
    throw new UsageError(`${where} needs <id> and -w <project to move it to>`);
  const now = p.flags["--now"] === true;
  const m = await moveAgent(d, id, undefined, to, now ? "now" : "after-turn");
  if (!m.resumed) {
    d.out(`moved agent ${m.rec.id} from ${m.from} to ${to}; it was stopped`);
    return 0;
  }
  return report(
    d,
    m.resumed,
    `moved agent ${m.rec.id} from ${m.from} to ${to}; same conversation, restarted ${now ? "now (mid-turn if it was working)" : "at its idle"} so its tools are ${to}'s, as ${m.rec.sessionName} in ${m.rec.cwd}`,
  );
}

/** D44: doctor's lines for the running agents with out-of-date tools. */
export function staleLines(
  stale: { id: string; workspace: string; stale: McpStale }[],
  cli: string,
): string[] {
  if (!stale.length) return ["Agents' tools     all current"];
  const say = (x: McpStale) =>
    x.adds.length
      ? `${x.adds.join(", ")} tools arrive on restart`
      : `${x.drops.join(", ")} tools go on restart`;
  return [
    `Agents' tools     ${stale.length} running ${stale.length === 1 ? "agent started" : "agents started"} before the change:`,
    ...stale.map((a) => `  ${a.id} (${a.workspace}): ${say(a.stale)}`),
    `  \`${cli} agents restart <id>\` restarts one at its next idle, same conversation`,
  ];
}

/** `<id> [-w <ws>]`. */
/** D32: `agents helpers <id> [<helper>]`, read-only. */
async function helpers(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents helpers";
  const p = parseArgs(where, args, {
    "--workspace": true,
    "--json": false,
    "--all": false,
    "--limit": true,
  });
  noExtra(where, p, 2);
  const [id, helperId] = p.positional;
  if (!id) throw new UsageError(`${where} needs <id>`);
  const ws = workspaceFlag(where, p);
  const ago = (ms?: number) =>
    ms === undefined ? "-" : `${duration(Date.now() - ms)} ago`;
  if (helperId) {
    const raw = p.flags["--limit"];
    const limit = raw === undefined ? undefined : Number(raw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
      throw new UsageError(
        `${where}: --limit must be a whole number of at least 1`,
      );
    const t = await agentHelperTranscript(d, id, helperId, ws, limit);
    if (p.flags["--json"]) {
      d.out(JSON.stringify(t, null, 2));
      return 0;
    }
    d.out(
      `${t.helper.description ?? t.helper.id} (${t.helper.status}, ${t.helper.type ?? "helper"})`,
    );
    if (t.omitted) d.out(`… ${t.omitted} earlier lines`);
    for (const i of t.items) {
      const lead =
        i.kind === "tool"
          ? `→ ${i.tool}: `
          : i.kind === "result"
            ? i.error
              ? "  ✗ "
              : "  ← "
            : i.kind === "prompt"
              ? "asked: "
              : i.kind === "note"
                ? "… "
                : "";
      d.out(`${lead}${i.text}`);
    }
    d.out("");
    d.out(t.note);
    return 0;
  }
  const r = await agentHelpers(d, id, ws);
  // D34: --all lists those a person cleared too, marked.
  const clearedIds = new Set(r.cleared.map((h) => h.id));
  const shown = p.flags["--all"]
    ? sortHelpers([...r.helpers, ...r.cleared])
    : r.helpers.filter((h) => !h.earlier);
  if (p.flags["--json"]) {
    d.out(
      JSON.stringify(
        {
          agent: r.rec.id,
          supported: r.supported,
          live: r.live,
          helpers: shown.filter((h) => !clearedIds.has(h.id)),
          clearedCount: r.cleared.length,
          ...(p.flags["--all"] ? { cleared: r.cleared } : {}),
          note: r.note,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (!r.supported) {
    d.out(`${r.rec.runtime} can't tell which helpers ${r.rec.id} started`);
    return 0;
  }
  const earlier = r.helpers.length - r.helpers.filter((h) => !h.earlier).length;
  const hidden = p.flags["--all"] ? 0 : earlier + r.cleared.length;
  if (!shown.length) {
    d.out(
      r.cleared.length && !p.flags["--all"]
        ? `${r.rec.id} has no helpers to show (${hidden} cleared or earlier: --all)`
        : `${r.rec.id} has started no helpers${earlier && !p.flags["--all"] ? ` in this conversation (${earlier} earlier: --all)` : ""}`,
    );
    return 0;
  }
  const depth = shownDepths(shown);
  for (const l of columns([
    ["HELPER", "WHAT", "TYPE", "MODEL", "STATE", "STARTED", "FOR", "BRANCH"],
    ...shown.map((h) => [
      `${"  ".repeat(depth.get(h.id) ?? 0)}${h.id}`,
      (h.description ?? "-").slice(0, 48),
      h.workflow
        ? `${h.type ?? "-"} (${h.workflow.name ?? "workflow"})`
        : (h.type ?? "-"),
      h.model ?? "-",
      `${h.status}${clearedIds.has(h.id) ? " (cleared)" : h.earlier ? " (earlier)" : ""}`,
      ago(h.startedAt),
      h.durationMs === undefined ? "-" : duration(h.durationMs),
      h.branch ?? "-",
    ]),
  ]))
    d.out(l);
  if (earlier && !p.flags["--all"])
    d.out(`${earlier} more from earlier conversations: --all`);
  if (r.cleared.length && !p.flags["--all"])
    d.out(`${r.cleared.length} cleared: --all`);
  d.out("");
  d.out(r.note);
  return 0;
}

/** 65 s → "1m 5s"; 2 h → "2h 0m". */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

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
  return audited(d, "stop", id, ws, async () => {
    const {
      rec,
      session: s,
      stillStopping,
    } = await stopAgent(d, id, ws, {
      wait,
    });
    if (stillStopping) {
      const why = `not ended after ${d.stopWaitMs / 1000} s`;
      d.err(
        `${rec.id} is still stopping (sent TERM to ${s!.name}, pid ${s!.pid}; ${why})`,
      );
      return { code: 1, outcome: "still stopping", reason: why };
    }
    d.out(
      s
        ? `stopped agent ${rec.id} (sent TERM to ${s.name}, pid ${s.pid}${wait && d.stopWaitMs > 0 ? "; it has ended" : ""})`
        : `agent ${rec.id} was not running; marked stopped`,
    );
    return { code: 0, outcome: s ? "stopped" : "stopped (was not running)" };
  });
}

async function resume(args: string[], d: AgentsResolved): Promise<number> {
  if (args.includes("--all-interrupted")) return resumeAll(args, d);
  const { id, ws } = idAndWorkspace("agents resume", args);
  return audited(d, "resume", id, ws, async () => {
    // D28: a due agent under auto relaunches from its handoff instead.
    const r = await resumeOrRelaunch(d, id, ws);
    const early = r.s.early ? { reason: "exited at once" } : {};
    if (r.kind === "relaunched")
      return {
        code: report(
          d,
          r.s,
          `relaunched agent ${r.s.rec.id} from its handoff (the last session ended after ${r.s.why}) as ${r.s.rec.sessionName} in ${r.s.rec.cwd}`,
        ),
        outcome: "relaunched from its handoff",
        ...early,
      };
    const s = r.s;
    if (s.fresh) d.out(`agent ${s.rec.id}: ${FRESH_NOTE}`);
    return {
      code: report(
        d,
        s,
        `${s.fresh ? "started" : "resumed"} agent ${s.rec.id} as ${s.rec.sessionName} in ${s.rec.cwd}`,
      ),
      outcome: s.fresh ? "started fresh, same id" : "resumed",
      ...early,
    };
  });
}

/** `agents relaunch <id> [-w <ws>]` (den#4). */
/** D28: refused in an agent's session (an agent could stop its own rotation). */
function personOnly(where: string, d: AgentsResolved, what = "rotation"): void {
  if (isAgentTokenEnv(d.env))
    throw new AgentError(
      `${where}: only a person can change ${what} (this is an agent)`,
    );
}

const ROTATE_SCOPE_FLAGS: Record<string, OverrideScope> = {
  "--agent": "agent",
  "--persona": "persona",
  "--workspace": "workspace",
  "--service": "service",
};

/**
 * `agents rotate` (D28): with no arguments, the settings and overrides;
 * `[--agent|--persona|--workspace|--service <x>] [-w <ws>] <key> <value>`
 * sets one (no scope flag: this install's), `--unset` clears it. `--persona
 * <p> -w <ws>`: the persona in that workspace. `agents rotate <id> --show`:
 * that agent's effective values and where each comes from.
 */
async function rotate(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents rotate";
  if (args.includes("--show")) {
    const { id, ws } = idAndWorkspace(
      where,
      args.filter((a) => a !== "--show"),
    );
    const r = rotationSettings(d, id, ws);
    if (!r.effective) {
      d.err(`✗ ${where}: ${id}'s persona or the config can't be read`);
      return 1;
    }
    const e = r.effective;
    d.out(`agent ${e.agent}:`);
    d.out(
      `  after_compactions  ${e.afterCompactions === 0 ? "never" : e.afterCompactions}  (from ${e.from?.after_compactions})`,
    );
    d.out(`  on_due             ${e.onDue}  (from ${e.from?.on_due})`);
    d.out(
      `  on_pr_merged       ${e.onPrMerged}  (from ${e.from?.on_pr_merged})`,
    );
    return 0;
  }
  if (!args.length) {
    const r = rotationSettings(d);
    const vals = (v: object) =>
      Object.entries(v)
        .map(([k, x]) => `${k}=${String(x)}`)
        .join(" ") || "(none)";
    d.out(`default: ${vals(r.defaults)}`);
    d.out(`org config: ${vals(r.org)}`);
    d.out(`this install: ${vals(r.install)}`);
    for (const [scope, byTarget] of Object.entries(r.overrides))
      for (const [target, v] of Object.entries(byTarget ?? {}))
        d.out(`${scope} ${target}: ${vals(v)}`);
    return 0;
  }
  personOnly(where, d);
  const unset = args.includes("--unset");
  const rest = args.filter((a) => a !== "--unset");
  let scope: OverrideScope | "install" = "install";
  let target: string | undefined;
  let ws: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-w" || a === "--ws") {
      ws = rest[++i];
      if (!ws) throw new UsageError(`${where}: ${a} needs a project`);
    } else if (a in ROTATE_SCOPE_FLAGS) {
      if (scope !== "install")
        throw new UsageError(`${where}: one scope at a time`);
      scope = ROTATE_SCOPE_FLAGS[a];
      target = rest[++i];
      if (!target) throw new UsageError(`${where}: ${a} needs a name`);
    } else if (a.startsWith("--"))
      throw new UsageError(`${where}: unknown flag ${a}`);
    else pos.push(a);
  }
  if (ws) {
    if (scope !== "persona")
      throw new UsageError(
        `${where}: -w goes with --persona (the persona in that project); use --workspace <ws> for a project`,
      );
    scope = "persona-workspace";
    target = `${target}@${ws}`;
  }
  const [key, raw] = pos;
  if (!key || (unset ? pos.length !== 1 : pos.length !== 2))
    throw new UsageError(
      `${where} [--agent|--persona|--workspace|--service <x>] <key> <value> (or --unset <key>)`,
    );
  setRotationSetting(d, {
    scope,
    ...(target !== undefined ? { target } : {}),
    key,
    value: unset ? null : parseRotateValue(key, raw!),
  });
  const at = scope === "install" ? "this install" : `${scope} ${target}`;
  d.out(unset ? `${key} cleared at ${at}` : `${key} = ${raw} at ${at}`);
  return 0;
}

/** `agents keep <id> [-w <ws>] [--never]` (D28 Keep this conversation). */
function keep(args: string[], d: AgentsResolved): number {
  const where = "agents keep";
  personOnly(where, d);
  const never = args.includes("--never");
  const { id, ws } = idAndWorkspace(
    where,
    args.filter((a) => a !== "--never"),
  );
  const rec = keepAgentConversation(d, id, ws, { never });
  d.out(
    `kept ${rec.id}'s conversation: its compaction count starts again${never ? "; it never rotates (agents rotate --agent " + rec.id + " --unset after_compactions to undo)" : ""}`,
  );
  return 0;
}

/** `agents set <id> [-w <ws>] resume_on_restart on|off|default` (D59). */
function setAgent(args: string[], d: AgentsResolved): number {
  const where = "agents set";
  personOnly(where, d, "whether an agent resumes after a restart");
  const at = args.indexOf("resume_on_restart");
  const raw = at >= 0 ? args[at + 1] : undefined;
  if (at < 0 || !raw || !["on", "off", "default"].includes(raw))
    throw new AgentError(`${where}: takes resume_on_restart on|off|default`, {
      usage: true,
    });
  const { id, ws } = idAndWorkspace(where, [
    ...args.slice(0, at),
    ...args.slice(at + 2),
  ]);
  const value = raw === "default" ? null : raw === "on";
  const rec = setAgentResumeOnRestart(d, id, ws, value);
  d.out(
    value === null
      ? `${rec.id} resumes after a restart as its persona says`
      : `${rec.id} ${value ? "resumes" : "doesn't resume"} on its own after a restart`,
  );
  return 0;
}

/** `agents handoff <id> [-w <ws>]` (D28 Write handoff). */
async function handoff(args: string[], d: AgentsResolved): Promise<number> {
  const { id, ws } = idAndWorkspace("agents handoff", args);
  const rec = await askForHandoff(d, id, ws);
  d.out(`asked ${rec.id} to write its handoff; Den relaunches it from it`);
  return 0;
}

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

/** AG-DROP-2: `agents files <id> [-w <ws>] [--json]`: its uploads. */
function files(args: string[], d: AgentsResolved): number {
  const where = "agents files";
  const p = parseArgs(where, args, { "--workspace": true, "--json": false });
  noExtra(where, p, 1);
  const id = p.positional[0];
  if (!id) throw new UsageError(`${where} needs <id>`);
  const rec = readRecord(d.stateDir(), id);
  const ws = workspaceFlag(where, p);
  if (!rec || (ws && rec.workspace !== ws))
    throw new AgentError(`no agent "${id}"${ws ? ` in ${ws}` : ""}`, {
      hints: [`\`${d.cli} agents list\` lists them`],
    });
  const set = readAgentsConfig().uploads ?? UPLOAD_DEFAULTS;
  const root = uploadsRoot(set, d.stateDir());
  const list = listUploads(root, rec.session.id);
  if (p.flags["--json"]) {
    d.out(
      JSON.stringify(
        {
          agent: rec.id,
          workspace: rec.workspace,
          folder: path.join(root, rec.session.id),
          keepDays: set.keepDays,
          files: list.map((f) => ({
            path: f.path,
            bytes: f.bytes,
            at: new Date(f.at).toISOString(),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (!list.length) {
    d.out(
      `no files for ${rec.id} yet: drop, paste or attach one onto its terminal on the Agents page`,
    );
    return 0;
  }
  const size = (n: number) =>
    n >= 1024 * 1024
      ? `${(n / (1024 * 1024)).toFixed(1)} MB`
      : n >= 1024
        ? `${Math.ceil(n / 1024)} KB`
        : `${n} B`;
  for (const f of list)
    d.out(
      `${duration(Date.now() - f.at)} ago  ${size(f.bytes).padStart(8)}  ${f.path}`,
    );
  d.out(
    `${list.length} ${list.length === 1 ? "file" : "files"}; each is removed ${set.keepDays} ${set.keepDays === 1 ? "day" : "days"} after it came (agents.uploads.keep_days)`,
  );
  return 0;
}

/** `agents rm <id> [-w <ws>]`, `agents rm --stopped [-w <ws>]` (AG-14.1b). */
/** D25: `agents rename <id> <name>|--clear [-w <ws>]`. */
/**
 * `agents permission -w <ws> [<mode>|--clear]` (den#48): the mode the
 * workspace's agents start with when the start names none.
 */
function permission(args: string[], d: AgentsResolved): number {
  const where = "agents permission";
  const p = parseArgs(where, args, { "--workspace": true, "--clear": false });
  const ws = workspaceFlag(where, p);
  // Without -w: one agent's (`agents permission <id> [<mode>|--clear]`).
  if (!ws) return agentPermission(where, p, d);
  // With -w, an agent's id first is still that agent's: -w only says
  // which project it is in.
  const first = p.positional[0];
  if (
    first !== undefined &&
    !isIntent(first) &&
    readRecord(d.stateDir(), first)
  ) {
    const rec = readRecord(d.stateDir(), first)!;
    if (rec.workspace !== ws)
      throw new UsageError(
        `${where}: ${first} is in project ${rec.workspace}, not ${ws}`,
      );
    return agentPermission(where, p, d);
  }
  noExtra(where, p, 1);
  // The Den agent's own place is no project: its mode is the agent's.
  if (isServerScope(ws))
    throw new UsageError(
      `${where}: ${ws} is the Den agent's own place, not a project: set its mode with \`agents permission ${SERVER_AGENT_ID} -w ${ws} <mode>\` (or Settings › Agents › Agents' mode: Den-wide default)`,
    );
  if (!d.workspaceExists(ws))
    throw new UsageError(`${where}: project "${ws}" does not exist`);
  const given = p.positional[0];
  if (given === undefined && !p.flags["--clear"]) {
    const now = workspacePermissionOf(d, ws);
    d.out(
      now
        ? `${ws}: agents start in ${now} unless the start names a mode (${workspacePermissionKey(ws)})`
        : `${ws}: no default; agents start in their persona's mode (ask unless it says)`,
    );
    return 0;
  }
  personOnly(where, d, "a project's permission mode");
  if (given !== undefined && p.flags["--clear"])
    throw new UsageError(`${where}: give a mode or --clear, not both`);
  let intent: PermissionIntent | null = null;
  if (given !== undefined)
    try {
      intent = checkIntent(given, where);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  d.saveWorkspacePermission(ws, intent);
  d.out(
    intent
      ? `${ws}: agents now start in ${intent} unless the start names a mode; running agents switch after their current turn`
      : `${ws}: no default now; agents start in their persona's mode`,
  );
  return 0;
}

/** Whether `s` names a permission mode (ask, edits, auto, all). */
function isIntent(s: string): boolean {
  try {
    checkIntent(s, "mode");
    return true;
  } catch {
    return false;
  }
}

/**
 * `agents permission <id> [<mode>|--clear]` (den#48, Vision 11-13): the
 * mode one agent runs with. Given, it stays through every restart; cleared,
 * the agent follows its project's mode, else its persona's. Issue 252: a
 * running agent takes either at its next idle (Den's mode check).
 */
function agentPermission(
  where: string,
  p: ReturnType<typeof parseArgs>,
  d: AgentsResolved,
): number {
  noExtra(where, p, 2);
  const [id, given] = p.positional;
  if (!id)
    throw new UsageError(
      `${where} needs -w <ws> (a project's mode) or <id> (one agent's)`,
    );
  const rec = readRecord(d.stateDir(), id);
  if (!rec) throw new UsageError(`${where}: no agent "${id}"`);
  if (given === undefined && !p.flags["--clear"]) {
    const chosen = rec.overrides?.includes("permission") && rec.permission;
    const proj = workspacePermissionOf(d, rec.workspace);
    d.out(
      chosen
        ? `${id}: ${chosen}, chosen for it; it stays until cleared (${d.cli} agents permission ${id} --clear)`
        : proj
          ? `${id}: follows its project's mode, ${proj} (${workspacePermissionKey(rec.workspace)})`
          : `${id}: follows its persona's mode${rec.permission ? ` (${rec.permission} when it last started)` : ""}`,
    );
    return 0;
  }
  personOnly(where, d, "an agent's permission mode");
  if (given !== undefined && p.flags["--clear"])
    throw new UsageError(`${where}: give a mode or --clear, not both`);
  let intent: PermissionIntent | null = null;
  if (given !== undefined)
    try {
      intent = checkIntent(given, where);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  const next = setAgentPermission(d, id, rec.workspace, intent);
  // Issue 252: a running agent takes it at its next idle: the web
  // server's mode check restarts it on the same conversation.
  const when = next.stoppedAt
    ? "It takes it at its next start or resume."
    : "Den restarts it at its next idle, on the same conversation, to take it.";
  const proj = intent ? undefined : workspacePermissionOf(d, rec.workspace);
  d.out(
    intent
      ? `${id}: ${intent}, its own setting. ${when}`
      : proj
        ? `${id}: follows its project's mode, ${proj}. ${when}`
        : `${id}: follows the Den-wide default, else its persona's mode. ${when}`,
  );
  return 0;
}

/** den#48: `agents doctor`'s permission modes, for den-claude. */
export function permissionLines(
  claude: { available: boolean; path?: string; version?: string } | undefined,
  modes: string[] | null,
  ws?: { name: string; mode?: PermissionIntent; error?: string },
): string[] {
  const text = (m: PermissionIntent) =>
    DEN_CLAUDE_PERMISSIONS.modes[m]?.replace(/^--permission-mode \S+: /, "") ??
    "";
  const lines = ["permission modes (den-claude)"];
  for (const m of PERMISSION_INTENTS) {
    let mark = "";
    if (m === "auto")
      mark = !claude?.available
        ? ""
        : modes === null
          ? "  ? couldn't read the modes this Claude Code takes"
          : modes.includes("auto")
            ? "  ✓ this Claude Code takes it"
            : `  ✗ this Claude Code${claude.version ? ` (${claude.version})` : ""} doesn't: update it to use auto`;
    lines.push(`  ${m.padEnd(6)}${text(m)}${mark}`);
  }
  if (ws)
    lines.push(
      ws.error
        ? `  ${ws.name}: ${ws.error}`
        : ws.mode
          ? `  ${ws.name}: agents start in ${ws.mode}  (${workspacePermissionKey(ws.name)})`
          : `  ${ws.name}: no default (each persona's own mode)`,
    );
  return lines;
}

function rename(args: string[], d: AgentsResolved): number {
  const where = "agents rename";
  const p = parseArgs(where, args, { "--workspace": true, "--clear": false });
  const [id, ...words] = p.positional;
  if (!id) throw new UsageError(`${where} needs <id> and a name, or --clear`);
  const name = words.join(" ").trim();
  if (p.flags["--clear"] && name)
    throw new UsageError(`${where}: give a name or --clear, not both`);
  if (!p.flags["--clear"] && !name)
    throw new UsageError(`${where} needs a name (or --clear)`);
  const ws =
    workspaceFlag(where, p) ?? readRecord(d.stateDir(), id)?.workspace ?? "";
  const rec = renameAgent(d, id, ws, p.flags["--clear"] ? null : name);
  d.out(
    rec.displayName
      ? `renamed agent ${id} to "${rec.displayName}"; others see it as ${peerSessionName(d.cli, rec.workspace, rec)} from its next start or resume`
      : `agent ${id} has no name now; others see it as ${peerSessionName(d.cli, rec.workspace, rec)} from its next start or resume`,
  );
  return 0;
}

/**
 * Gap 7 (0.4.48): `agents folder <id> (--repo <repo> | --folder <path>)`:
 * a stopped agent's folder, a repo of its project or a folder in it. A
 * conversation belongs to its folder, so its next start is a new one.
 */
function folder(args: string[], d: AgentsResolved): number {
  const where = "agents folder";
  personOnly(where, d, "an agent's folder");
  const p = parseArgs(where, args, {
    "--workspace": true,
    "--repo": true,
    "--folder": true,
  });
  noExtra(where, p, 1);
  const [id] = p.positional;
  if (!id) throw new UsageError(`${where} needs <id>`);
  const repo = str(p, "--repo");
  const dir = str(p, "--folder");
  if ((repo === undefined) === (dir === undefined))
    throw new UsageError(`${where} needs --repo <repo> or --folder <path>`);
  const rec = setAgentFolder(d, id, workspaceFlag(where, p), {
    ...(repo !== undefined ? { repo: checkRepoName(repo) } : {}),
    ...(dir !== undefined ? { folder: dir } : {}),
  });
  d.out(
    `agent ${id} now works in ${rec.cwd}${rec.repo ? ` (${rec.project} › ${rec.repo})` : ""}; its next start is a new conversation there`,
  );
  return 0;
}

/**
 * D65 v2: `agents link <id> --repo <repo>` / `agents unlink <id>`: the
 * repo of its project it works on. Its service cards list it under "On
 * this repo"; unlinked, under "Also in <project>". Kept through every
 * restart.
 */
function link(
  args: string[],
  d: AgentsResolved,
  how: "add" | "remove",
): number {
  const where = how === "add" ? "agents link" : "agents unlink";
  const p = parseArgs(where, args, { "--workspace": true, "--repo": true });
  const [id, positional] = p.positional;
  if (!id) throw new UsageError(`${where} needs <id>`);
  const ws =
    workspaceFlag(where, p) ?? readRecord(d.stateDir(), id)?.workspace ?? "";
  let repo: string | null = null;
  if (how === "add") {
    const given = p.flags["--repo"] ?? positional;
    if (typeof given !== "string" || !given)
      throw new UsageError(`${where} needs --repo <repo>`);
    repo = checkRepoName(given);
    const repos = workspaceRepoFolders(d, ws);
    if (!repos.has(repo))
      throw new UsageError(
        `${where}: project ${ws} has no repo "${repo}"${repos.size ? ` (it has ${[...repos.keys()].join(", ")})` : ""}`,
      );
  }
  const rec = setAgentRepo(d, id, ws, repo);
  d.out(
    rec.repo
      ? `agent ${id} works on ${rec.project} › ${rec.repo}`
      : `agent ${id} is in ${rec.project}, on no one repo`,
  );
  return 0;
}

async function rm(args: string[], d: AgentsResolved): Promise<number> {
  const where = "agents rm";
  const p = parseArgs(where, args, { "--workspace": true, "--stopped": false });
  noExtra(where, p, 1);
  const ws = workspaceFlag(where, p);
  const id = p.positional[0];
  if (p.flags["--stopped"]) {
    if (id) throw new UsageError(`${where}: give <id> or --stopped, not both`);
    if (ws && !d.workspaceExists(ws))
      throw new UsageError(`${where}: project "${ws}" does not exist`);
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
    [
      "PERSONA",
      "SOURCE",
      "STANDING",
      "RUNTIME",
      "MODEL",
      "ROLE",
      "DESCRIPTION",
    ],
    ...all.map((x) => [
      x.id,
      x.origin,
      x.standing ? "yes" : "-",
      x.runtime ?? DEFAULT_RUNTIME_ID,
      x.model ?? "-",
      x.role ?? "-",
      x.description,
    ]),
  ]))
    d.out(l);
  return 0;
}

/** Issue 163 (b): `agents token set`'s input and store. */
export interface AgentsTokenDeps {
  /** The token, from stdin or a hidden prompt (default: readTokenInput). */
  tokenInput?: () => Promise<string>;
  /** Write it to the install's secrets store (default: saveAgentToken). */
  tokenSave?: (
    token: string,
  ) => Promise<{ ref: "configured" | "created"; store: string }>;
  /** Remove it from the store (default: clearAgentToken). */
  tokenClear?: () => Promise<
    import("../../shared/agents/signin-token.js").TokenClearResult
  >;
  /** `agents token clear`'s y/N (default: a terminal prompt; none off one). */
  tokenConfirm?: (question: string) => Promise<boolean | null>;
  /**
   * Issue 339: `agents accounts`' store (tests): the provider, its status,
   * each named ref, and where a new ref goes (default: the install's).
   */
  accountDeps?: AccountsCliDeps;
  /** The store, its ref and status for `token status` (tests). */
  tokenDeps?: Partial<
    Pick<
      import("../../shared/agents/signin-token.js").TokenStatusDeps,
      "ref" | "provider" | "status" | "credSource" | "warnDays" | "now"
    >
  >;
}

/**
 * The token from stdin (piped), or a prompt that doesn't echo it (a
 * terminal). Never from argv.
 */
export async function readTokenInput(
  stdin: NodeJS.ReadStream = process.stdin,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += String(chunk);
    return text;
  }
  stderr.write("Paste the token (it isn't shown), then Enter: ");
  return new Promise((resolve) => {
    let text = "";
    const raw = typeof stdin.setRawMode === "function";
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    const done = (v: string) => {
      stdin.off("data", onData);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      resolve(v);
    };
    const onData = (b: Buffer) => {
      for (const ch of b.toString("utf-8")) {
        if (ch === "\r" || ch === "\n") return done(text);
        if (ch === "\u0003") return done("");
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * `agents token set` (issue 163 b): the CLI's long-lived sign-in token
 * (den-claude: made once with `claude setup-token`), into the install's
 * secrets store, for agents under the always-on service. Read from stdin
 * or a hidden prompt, never argv; a person's only; nothing printed carries
 * it. `agents token status`: what doctor says about it.
 */
async function tokenCmd(
  args: string[],
  d: AgentsResolved,
  deps: AgentsTokenDeps,
): Promise<number> {
  const [sub, ...rest] = args;
  const where = `agents token ${sub ?? ""}`.trim();
  if (sub !== "set" && sub !== "status" && sub !== "clear")
    throw new UsageError(`${where}: use agents token set | status | clear`);
  if (sub === "clear") return tokenClearCmd(rest, d, deps);
  if (rest.length)
    // Never echo what was given: it may be the token itself.
    throw new UsageError(
      `${where} takes no arguments: the token is read from stdin or a prompt, never on the command line (it would stay in your shell history and the process list)`,
    );
  const {
    agentTokenStatus,
    ENV_SET_OUTSIDE_DEN,
    NO_TOKEN_NOT_NEEDED,
    saveAgentToken,
    tokenShapeError,
    tokenStatusLine,
    TOKEN_MAKE_HINT,
  } = await import("../../shared/agents/signin-token.js");
  if (sub === "status") {
    // The mode in effect (the web job's env, or the host job file): not
    // under the always-on service, no token is no warning.
    const st = await agentTokenStatus({
      env: d.env,
      stateDir: d.stateDir(),
      probe: true,
      ...deps.tokenDeps,
    });
    const l = tokenStatusLine(st, d.cli);
    if (l.text === NO_TOKEN_NOT_NEEDED) d.out(l.text);
    else
      (l.status === "ok" ? d.out : d.err)(
        `${l.status === "ok" ? "✓" : "⚠"} ${l.text}`,
      );
    return l.status === "ok" ? 0 : 1;
  }
  if (isAgentTokenEnv(d.env)) {
    d.err(
      `✗ ${where}: only a person sets the agents' sign-in token (this is an agent)`,
    );
    return 1;
  }
  // With env the value would live only in this CLI process: refuse before
  // reading it (Settings saves it inside Den's own process).
  const { secretsStatus } = await import("../../shared/secrets/index.js");
  const backend = (
    deps.tokenDeps?.status ??
    (() => secretsStatus(undefined, d.env, { detect: false }))
  )().backend;
  if (backend === "env") {
    d.err(`✗ ${where}: ${ENV_SET_OUTSIDE_DEN}`);
    return 1;
  }
  const input = await (deps.tokenInput ?? (() => readTokenInput()))();
  const bad = tokenShapeError(input);
  if (bad) {
    d.err(
      `✗ ${where}: ${bad}. Make one with ${TOKEN_MAKE_HINT}, then pipe it in: ${d.cli} agents token set < file, or paste it at the prompt`,
    );
    return 1;
  }
  let res: { ref: "configured" | "created"; store: string };
  try {
    res = await (
      deps.tokenSave ??
      ((t: string) => saveAgentToken(t, { stateDir: d.stateDir() }))
    )(input.trim());
  } catch (e) {
    const msg = String((e as Error).message ?? e)
      .split(input.trim())
      .join("***");
    d.err(`✗ ${where}: ${msg}`);
    return 1;
  }
  d.out(
    `✓ the agents' sign-in token is saved in ${res.store}${res.ref === "created" ? ` (a new item; secrets.refs.agent_signin_token is in your user.yml)` : ""}. ` +
      `Agents started under Keep agents running after logout use it from their next start.`,
  );
  return 0;
}

/** y/N on a terminal; null off one (nothing to ask). */
async function askYesNo(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY) return null;
  const rl = (await import("readline")).createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const a = await new Promise<string>((r) => rl.question(question, r));
    return /^y(es)?$/i.test(a.trim());
  } finally {
    rl.close();
  }
}

/**
 * `agents token clear [--yes]` (issue 163): removes the agents' sign-in
 * token from the install's secrets store, the way set kept it. A person's
 * only; asks y/N first unless --yes. Never reads or prints the value.
 */
async function tokenClearCmd(
  args: string[],
  d: AgentsResolved,
  deps: AgentsTokenDeps,
): Promise<number> {
  const where = "agents token clear";
  const yes = args.includes("--yes") || args.includes("-y");
  const other = args.filter((a) => a !== "--yes" && a !== "-y");
  if (other.length) throw new UsageError(`${where} takes only --yes`);
  if (isAgentTokenEnv(d.env)) {
    d.err(
      `✗ ${where}: only a person clears the agents' sign-in token (this is an agent)`,
    );
    return 1;
  }
  if (!yes) {
    const ok = await (deps.tokenConfirm ?? askYesNo)(
      "Remove the agents' sign-in token from the secrets store? Agents under Keep agents running after logout can't sign in until a new one is set. [y/N] ",
    );
    if (ok === null) {
      d.err(`✗ ${where}: not a terminal, so nothing to ask: add --yes`);
      return 1;
    }
    if (!ok) {
      d.out("Nothing removed.");
      return 0;
    }
  }
  const { clearAgentToken } =
    await import("../../shared/agents/signin-token.js");
  try {
    const r = await (
      deps.tokenClear ?? (() => clearAgentToken({ stateDir: d.stateDir() }))
    )();
    if (!r.cleared) {
      d.out("no sign-in token set: nothing to remove");
      return 0;
    }
    d.out(
      r.how === "process"
        ? r.inProcess
          ? `✓ removed the sign-in token from this process's environment (the env secrets backend keeps it only there)`
          : `✓ removed Den's record of the sign-in token; the env secrets backend kept the value only in Den's running process, until Den restarts`
        : `✓ removed the agents' sign-in token from ${r.store}` +
            (r.how === "item" ? " (Den's own item, deleted)" : "") +
            (r.refDropped
              ? `; secrets.refs.agent_signin_token is gone from your user.yml`
              : ""),
    );
    return 0;
  } catch (e) {
    d.err(`✗ ${where}: ${String((e as Error)?.message ?? e)}`);
    return 1;
  }
}

/** Issue 339: the store `agents accounts` writes to (tests inject one). */
export interface AccountsCliDeps {
  provider?: () => import("../../shared/secrets/types.js").SecretsProvider;
  status?: () => ReturnType<
    typeof import("../../shared/secrets/index.js").secretsStatus
  >;
  /** The named ref (default: secrets.refs.<name>, the distribution's first). */
  ref?: (
    name: string,
  ) => import("../../shared/secrets/types.js").SecretRef | null;
  /** Write a new ref to user.yml (default: writeUserConfig). */
  saveRefAs?: (
    name: string,
    ref: Partial<import("../../shared/secrets/types.js").SecretRef>,
  ) => void;
  /** user.yml's ref under the name (default: read it). */
  userRef?: (
    name: string,
  ) => Partial<import("../../shared/secrets/types.js").SecretRef> | undefined;
  /** Remove the name from user.yml (default: writeUserConfig). */
  dropRef?: (name: string) => void;
}

/** `--runtime <id>` out of args (default den-claude), and the rest. */
function runtimeArg(args: string[]): { runtimeId: string; rest: string[] } {
  const rest: string[] = [];
  let runtimeId = "den-claude";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--runtime") {
      const v = args[++i];
      if (!v) throw new UsageError("--runtime takes a runtime id");
      runtimeId = v;
    } else if (a.startsWith("--runtime=")) runtimeId = a.slice(10);
    else rest.push(a);
  }
  return { runtimeId, rest };
}

/**
 * `agents accounts <list|add|set-token|order|remove>` (issue 339): a
 * vendor's sign-in accounts. Tokens come from stdin or a hidden prompt,
 * never argv, and nothing printed or kept in a file carries one. Changes
 * are a person's only. `--runtime <id>` names the vendor (default Claude
 * Code).
 */
async function accountsCmd(
  args: string[],
  d: AgentsResolved,
  deps: AgentsTokenDeps,
): Promise<number> {
  const A = await import("../../shared/agents/signin-accounts.js");
  const T = await import("../../shared/agents/signin-token.js");
  const [sub, ...more] = args;
  const subs = ["list", "add", "set-token", "order", "remove"];
  // Never echo an unknown word: it may be a token pasted in the wrong place.
  const where = "`agents accounts{sub}`".replace(
    "{sub}",
    sub && subs.includes(sub) ? ` ${sub}` : "",
  );
  if (!sub || !subs.includes(sub))
    throw new UsageError(
      `${where}: use \`agents accounts ${subs.join(" | ")}\` [--runtime <id>]`,
    );
  const ad = deps.accountDeps ?? {};
  const stateDir = d.stateDir();
  const refOf = (name: string) =>
    ad.ref ? ad.ref(name) : T.agentTokenRef(undefined, undefined, name);
  try {
    // Only --runtime's value is ever echoed here, never a positional word.
    const { runtimeId, rest } = runtimeArg(more);
    const rt = A.signInRuntime(runtimeId);
    const label = (a: { id: string; name?: string }) =>
      A.accountLabel(a, rt.account);
    // set-token: a second word may be the token itself, so it's checked
    // before anything echoes an argument.
    if (sub === "set-token" && rest.length !== 1)
      throw new UsageError(
        `${where} takes one ${rt.account} account (its number or name): the token is read from stdin or a prompt, never on the command line (it would stay in your shell history and the process list)`,
      );
    const flag = runtimeId === "den-claude" ? "" : ` --runtime ${runtimeId}`;
    if (sub === "list") {
      if (rest.length) throw new UsageError(`${where} takes only --runtime`);
      d.out(`${rt.name} (${runtimeId}):`);
      for (const v of A.accountsView(stateDir, runtimeId, refOf)) {
        const st = v.configured
          ? v.setAt
            ? `token set ${v.setAt.slice(0, 10)}${v.store ? ` (in ${v.store})` : ""}`
            : "token set (when is not known)"
          : "no token";
        d.out(
          `  ${v.id}  ${v.label}  ${st}${v.first ? "  ← agents sign in with this one" : ""}`,
        );
      }
      return 0;
    }
    if (isAgentTokenEnv(d.env)) {
      d.err(
        `✗ ${where}: only a person changes ${rt.account} accounts for agents (this is an agent)`,
      );
      return 1;
    }
    if (sub === "add") {
      let name: string | undefined;
      const left: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--name") name = rest[++i] ?? "";
        else left.push(rest[i]!);
      }
      if (left.length) throw new UsageError(`${where} takes only --name`);
      const a = A.addAccount(stateDir, runtimeId, name);
      d.out(
        `✓ added ${rt.account} account ${a.id}${a.name ? ` (${a.name})` : ""}. Set its token: \`${d.cli} agents accounts set-token ${a.id}${flag}\``,
      );
      return 0;
    }
    if (sub === "order") {
      if (!rest.length)
        throw new UsageError(
          `${where} takes every ${rt.account} account, in order`,
        );
      const ids = rest.map((w) => A.findAccount(stateDir, runtimeId, w).id);
      const list = A.setAccountOrder(stateDir, runtimeId, ids);
      d.out(
        `✓ ${rt.account} accounts, in order: ${list.map(label).join(", ")}. Agents sign in with ${label(list[0]!)} from their next start.`,
      );
      return 0;
    }
    if (sub === "remove") {
      const yes = rest.includes("--yes") || rest.includes("-y");
      const which = rest.filter((a) => a !== "--yes" && a !== "-y");
      if (which.length !== 1)
        throw new UsageError(
          `${where} takes one ${rt.account} account, and --yes`,
        );
      const acct = A.findAccount(stateDir, runtimeId, which[0]!);
      if (!yes) {
        const ok = await (deps.tokenConfirm ?? askYesNo)(
          `Remove ${label(acct)} and its sign-in token from the secrets store? [y/N] `,
        );
        if (ok === null) {
          d.err(`✗ ${where}: not a terminal, so nothing to ask: add --yes`);
          return 1;
        }
        if (!ok) {
          d.out("Nothing removed.");
          return 0;
        }
      }
      const name = A.accountRefName(runtimeId, acct.id);
      const r = await A.removeAccount({
        runtimeId,
        accountId: acct.id,
        stateDir,
        env: d.env,
        ref: () => refOf(name),
        ...(ad.provider ? { provider: ad.provider } : {}),
        ...(ad.status ? { status: ad.status } : {}),
        ...(ad.userRef ? { userRef: () => ad.userRef!(name) } : {}),
        ...(ad.dropRef ? { dropRef: () => ad.dropRef!(name) } : {}),
      });
      d.out(
        `✓ removed ${label(r.removed)}` +
          (r.cleared.cleared
            ? `; its token is gone from ${r.cleared.store}`
            : ""),
      );
      return 0;
    }
    // set-token
    const acct = A.findAccount(stateDir, runtimeId, rest[0]!);
    const backend = (
      ad.status ??
      (await import("../../shared/secrets/index.js")).secretsStatus.bind(
        null,
        undefined,
        d.env,
        { detect: false },
      )
    )().backend;
    if (backend === "env") {
      d.err(`✗ ${where}: ${T.ENV_SET_OUTSIDE_DEN}`);
      return 1;
    }
    const input = await (deps.tokenInput ?? (() => readTokenInput()))();
    const value = input.trim();
    const bad = T.tokenShapeError(input);
    if (bad) {
      d.err(
        `✗ ${where}: ${bad}. Make one with ${rt.id === "den-claude" ? T.TOKEN_MAKE_HINT : "its sign-in command"}, then pipe it in: \`${d.cli} agents accounts set-token ${acct.id}${flag} < file\`, or paste it at the prompt`,
      );
      return 1;
    }
    const name = A.accountRefName(runtimeId, acct.id);
    let res: { ref: "configured" | "created"; store: string };
    try {
      res = await A.saveAccountToken(value, {
        runtimeId,
        accountId: acct.id,
        stateDir,
        ...(ad.ref ? { ref: () => ad.ref!(name) } : {}),
        ...(ad.provider ? { provider: ad.provider } : {}),
        ...(ad.status ? { status: ad.status } : {}),
        ...(ad.saveRefAs ? { saveRefAs: ad.saveRefAs } : {}),
      });
    } catch (e) {
      d.err(
        `✗ ${where}: ${T.withoutSecret(String((e as Error)?.message ?? e), value) || "the secrets store refused it"}`,
      );
      return 1;
    }
    d.out(
      `✓ the sign-in token of ${label(acct)} is saved in ${res.store}${res.ref === "created" ? ` (a new item; secrets.refs.${name} is in your user.yml)` : ""}.`,
    );
    return 0;
  } catch (e) {
    if (e instanceof A.AccountsError) throw new UsageError(e.message);
    throw e;
  }
}

export interface AgentsDoctorDeps {
  /** Resolve the login shell's PATH first (default: initLoginPath). */
  loginPath?: () => Promise<void>;
  /** Read a hand-back: a file path, or "-" for stdin (handback-check). */
  readHandback?: (src: string) => Promise<string>;
  /** D47: the api_only services (default: every workspace's manifests). */
  apiOnly?: () => ApiOnlyRules;
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
    throw new UsageError(
      kind === "handoff"
        ? `${where} takes an agent id, a file, or - for stdin`
        : `${where} takes one file, or - for stdin`,
    );
  let src = p.positional[0];
  // handoff-check <id>: that agent's handoff.md, when no such file is here.
  if (
    kind === "handoff" &&
    src !== "-" &&
    !fs.existsSync(src) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(src) &&
    readRecord(d.stateDir(), src)
  ) {
    const file = handoffFile(agentFilesDir(d.stateDir(), src));
    if (!fs.existsSync(file)) {
      d.err(`✗ ${where}: no handoff.md yet for agent ${src} (${file})`);
      return 1;
    }
    src = file;
  }
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
  workspace: "the project's agents.runtimes setting",
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
    lines.push(
      `  version   ${r.version ?? "unknown"}${r.quarantined ? " (quarantined, not run)" : ""}`,
    );
  // Issue 456: the other copies found, never run; one is pinned by its path.
  (r.others ?? []).forEach((o, i) =>
    lines.push(
      `  ${i === 0 ? "also      " : "          "}${o.path} (${o.version ?? "version unknown"}, ${SOURCE_WORD[o.source] ?? o.source}${o.quarantined ? ", quarantined, not run" : ""})`,
    ),
  );
  if (r.others?.length && r.setting)
    lines.push(`            to use one, set ${r.setting} to its path`);
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

const modelWord = (m: string) =>
  m === INHERIT ? "inherit (the runtime decides)" : m;

/** den#3: `agents doctor`'s subagents section. */
export function subagentLines(
  s: SubagentsReport,
  /** den-claude's version (`claude --version`), when it was read. */
  claudeVersion?: string,
): string[] {
  const lines = [
    "subagents (den-claude: every subagent, Explore too)",
    `  model       ${modelWord(s.model)}  (${s.from === "default" ? "Den's default; " : ""}agents.subagents.model)`,
  ];
  // Forced needs Claude Code 2.1.257+; older takes it as a fallback only,
  // so a subagent's own definition (Explore's) still wins there.
  if (s.model !== INHERIT && forcesSubagentModel(claudeVersion) === false)
    lines.push(
      `  ⚠ forced    no: Claude Code ${claudeVersion} takes it only as a fallback (Explore may still use the agent's model); forcing it needs ${SUBAGENT_FORCE_MIN} or later`,
    );
  lines.push(
    `  connectors  ${s.claudeAiConnectors ? "on" : "off"}  (agents.claude_ai_connectors: the account's claude.ai connectors)`,
  );
  if (s.personasError)
    lines.push(`  personas    couldn't read: ${s.personasError}`);
  s.personas.forEach((p, i) =>
    lines.push(
      `  ${i === 0 ? "personas    " : "            "}${p.id}: ${modelWord(p.model)}  (subagent_model)`,
    ),
  );
  s.agents.forEach((a, i) =>
    lines.push(
      `  ${i === 0 ? "agents      " : "            "}${a.id}: ${modelWord(a.model)}  (${a.from}, when it last started)`,
    ),
  );
  return lines;
}

/** The runtimes that enforce D47 (a PreToolUse hook): den-claude only. */
const API_ONLY_RUNTIMES = new Set(["den-claude"]);

/** D47: `agents doctor`'s API-only section. */
export function apiOnlyLines(
  rules: ApiOnlyRules,
  runtimes: readonly { id: string; available?: boolean }[],
  denied: readonly Record<string, unknown>[],
): string[] {
  if (!rules.services.length)
    return [
      "API-only services  none declared (a service's manifest says `agents: api_only`)",
    ];
  const lines = [
    "API-only services (agents reach them only through their API)",
  ];
  for (const s of rules.services) {
    const svc = s.composeServices.length
      ? [`${s.project}-{${s.composeServices.join(",")}}-N`]
      : s.composeVolumes.length
        ? []
        : [`${s.project}-*`];
    const vol = s.composeVolumes.length
      ? [`${s.project}_{${s.composeVolumes.join(",")}}`]
      : s.composeServices.length
        ? []
        : [`${s.project}_*`];
    const parts = [
      `project ${s.project}`,
      ...([...svc, ...s.containers].length
        ? [`containers ${[...svc, ...s.containers].join(", ")}`]
        : []),
      ...([...vol, ...s.volumes].length
        ? [`volumes ${[...vol, ...s.volumes].join(", ")}`]
        : []),
      ...(s.paths.length ? [`data ${s.paths.join(", ")}`] : []),
      ...(s.machine
        ? [`machine ${s.machine} (and ~/OrbStack, ~/.orbstack)`]
        : []),
    ];
    lines.push(`  ${s.name}: ${parts.join("; ")}`);
  }
  const on = runtimes
    .filter((r) => API_ONLY_RUNTIMES.has(r.id))
    .map((r) => r.id);
  const off = runtimes
    .filter((r) => !API_ONLY_RUNTIMES.has(r.id) && r.available !== false)
    .map((r) => r.id);
  lines.push(
    `  enforced      ${on.join(", ") || "none"}: a guardrail, not a boundary. An agent that can reach the Docker engine can still get around it with a program of its own.`,
  );
  if (off.length)
    lines.push(
      `  not enforced  ${off.join(", ")}: API-only isn't enforced for this runtime (it has no hook Den can use)`,
    );
  if (denied.length) {
    const last = denied[denied.length - 1];
    lines.push(
      `  denied        ${denied.length} recently; the last at ${last.at ? localDateTime(String(last.at)) : "?"}: ${String(last.agent ?? "an agent")}, ${String(last.what ?? "")} (${String(last.service ?? "")})`,
    );
  } else lines.push("  denied        none recently");
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
    throw new UsageError(`${where}: project "${ws}" does not exist`);
  await (deps.loginPath ?? (() => initLoginPath({ env: d.env })))();
  const rts = await listRuntimes(d, ws);
  const def = rts.find((r) => r.default);
  const code = def?.available ? 0 : 1;
  // den#48: whether this Claude Code takes auto, and the workspace's mode.
  const claude = rts.find((r) => r.id === "den-claude");
  const modes =
    claude?.available && claude.path
      ? permissionModesOf(claude.path, d.env)
      : null;
  let wsMode:
    | { name: string; mode?: PermissionIntent; error?: string }
    | undefined;
  if (ws)
    try {
      wsMode = { name: ws, mode: workspacePermissionOf(d, ws) };
    } catch (e) {
      wsMode = { name: ws, error: (e as Error).message };
    }
  let apiOnly: ApiOnlyRules = { services: [] };
  try {
    apiOnly = (deps.apiOnly ?? gatherApiOnly)();
  } catch {
    /* none readable: none shown */
  }
  const denied = readApiOnlyAudit(d.stateDir(), 50);
  // D44: never fails doctor (no host: none running).
  const stale = await staleAgents(d).catch(() => []);
  // D65 v2: never fails doctor.
  let links: ReturnType<typeof agentLinkReport> | null = null;
  try {
    links = agentLinkReport(d);
  } catch {
    /* records unreadable: nothing to say */
  }
  if (p.flags["--json"]) {
    d.out(
      JSON.stringify(
        {
          runtimes: rts,
          subagents: {
            ...subagentsReport(d),
            // den#3: forced needs Claude Code 2.1.257+ (null: unknown).
            forced: forcesSubagentModel(
              rts.find((r) => r.id === "den-claude")?.version,
            ),
          },
          permissionModes: {
            auto: claude?.available
              ? modes === null
                ? null
                : modes.includes("auto")
              : false,
            ...(wsMode
              ? {
                  workspace: wsMode.mode ?? null,
                  ...(wsMode.error ? { workspaceError: wsMode.error } : {}),
                }
              : {}),
          },
          apiOnly: {
            ...apiOnly,
            enforcedBy: rts
              .filter((r) => API_ONLY_RUNTIMES.has(r.id))
              .map((r) => r.id),
            notEnforcedBy: rts
              .filter((r) => !API_ONLY_RUNTIMES.has(r.id) && r.available)
              .map((r) => r.id),
            guardrail: true,
            denied,
          },
          staleTools: stale,
          ...(links ? { links } : {}),
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
  const claudeVersion = rts.find((r) => r.id === "den-claude")?.version;
  for (const l of subagentLines(subagentsReport(d), claudeVersion)) d.out(l);
  d.out("");
  for (const l of permissionLines(claude, modes, wsMode)) d.out(l);
  d.out("");
  for (const l of apiOnlyLines(apiOnly, rts, denied)) d.out(l);
  d.out("");
  for (const l of staleLines(stale, d.cli)) d.out(l);
  d.out("");
  if (links) {
    for (const l of linkLines(links, d.cli)) d.out(l);
    d.out("");
  }
  d.out(
    `\`${d.cli} doctor --probe\` checks the env each runtime's session gets.`,
  );
  return code;
}

/** D65 v2: doctor's lines on which repo each agent works on. */
export function linkLines(
  r: ReturnType<typeof agentLinkReport>,
  cli: string,
): string[] {
  const out = ["Agents and their repos"];
  if (r.migrated.length)
    out.push(`  linked from their folder (once): ${r.migrated.join(", ")}`);
  if (!r.noRepo.length && !r.missing.length) {
    out.push("  every agent is linked to a repo");
    return out;
  }
  for (const x of r.missing)
    out.push(
      `  ${x.id} (${x.project}): repo missing: ${x.repo} · re-link: ${cli} agents link ${x.id} --repo <repo>`,
    );
  for (const x of r.noRepo)
    out.push(
      `  ${x.id} (${x.project}): on no one repo (shows under Also in ${x.project}) · link: ${cli} agents link ${x.id} --repo <repo>`,
    );
  return out;
}

/** `<cli> agents ...`; returns the exit code. */
export async function cmdAgents(
  args: string[],
  deps: AgentsDeps & AgentsDoctorDeps & AgentsTokenDeps = {},
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
        case "rotate":
          await loadAgentWorkspaces(deps);
          return await rotate(rest, d);
        case "keep":
          return keep(rest, d);
        case "set":
          return setAgent(rest, d);
        case "handoff":
          await loadAgentWorkspaces(deps);
          return await handoff(rest, d);
        case "import":
          await loadAgentWorkspaces(deps);
          return await bringIn(rest, d);
        case "persona":
          await loadAgentWorkspaces(deps);
          return await persona(rest, d);
        case "restart":
          await loadAgentWorkspaces(deps);
          return await restart(rest, d);
        case "helpers":
          return await helpers(rest, d);
        case "rename":
          return rename(rest, d);
        case "move":
          await loadAgentWorkspaces(deps);
          return await move(rest, d);
        case "link":
          // D65: the project's repos come from its services, loaded here.
          await loadAgentWorkspaces(deps);
          return link(rest, d, "add");
        case "folder":
          await loadAgentWorkspaces(deps);
          return folder(rest, d);
        case "unlink":
          await loadAgentWorkspaces(deps);
          return link(rest, d, "remove");
        case "files":
          return files(rest, d);
        case "rm":
          await loadAgentWorkspaces(deps);
          return await rm(rest, d);
        case "permission":
          await loadAgentWorkspaces(deps);
          return permission(rest, d);
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
        case "token":
          return await tokenCmd(rest, d, deps);
        case "accounts":
          return await accountsCmd(rest, d, deps);
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
      if (e instanceof HostError || isConfigError(e)) {
        d.err(`✗ ${e.message}`);
        return 1;
      }
      throw e;
    }
  });
}
