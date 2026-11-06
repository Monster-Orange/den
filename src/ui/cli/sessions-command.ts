/**
 * `<cli> sessions start|list|attach|kill|host` (AG-3a): terminals that
 * outlive the web server, from the CLI. `<cli> agents` (agents-command.ts)
 * builds on the helpers exported here.
 *
 * Every command but `host` is a client of the distribution's session host
 * (src/shared/sessions/host.ts) and starts it on demand. The host is a
 * detached process of its own (its own session and process group), so it
 * survives the web server and the CLI that started it.
 *
 * Usage errors exit 2; a refusal (the cap, a name in use, den-pty
 * unavailable, an unknown session) exits 1.
 *
 * The R8 lock is the web UI's (an in-memory admin password in the web
 * server); CLI service actions (up, down) do not consult it, so neither do
 * these. agents.max_concurrent caps every start.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readAgentsConfig } from "../../shared/den-config.js";
import { cliEntrypoint } from "../../shared/engine.js";
import { getDistRoot, getInvokeCwd, getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { ENV_NAME_RE, isCredentialShaped } from "../../shared/secret-env.js";
import { allScrubEnv } from "../../shared/agents/runtimes.js";
import {
  ensureHost,
  connectHost,
  HostError,
  noHost,
  type HostClient,
} from "../../shared/sessions/client.js";
import { DEN_PTY_ID } from "../../shared/sessions/den-pty.js";
import { AGENT_ACTOR_ENV, buildSessionEnv } from "../../shared/sessions/env.js";
import { runSessionHost } from "../../shared/sessions/host.js";
import {
  inWorkspace,
  resolveSession,
  SESSION_NAME_RE,
  sessionName,
} from "../../shared/sessions/names.js";
import { sessionPaths } from "../../shared/sessions/paths.js";
import { loadPty, type PtyLoad } from "../../shared/sessions/pty.js";
import {
  SESSION_SIGNALS,
  type SessionInfo,
  type SessionSignal,
} from "../../shared/sessions/types.js";
import * as os from "os";
import { AGENT_ACTOR_RE, WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";

/** ctrl-]: leaves the session running (as telnet's escape does). */
export const DETACH_KEY = 0x1d;

export const SESSIONS_HELP = {
  usage: "sessions <start|list|attach|kill|host> ...",
  lines: [
    "Terminals that keep running when the web server restarts, owned by a",
    "session host (one per distribution, started on demand).",
    "",
    "{cli} sessions start --workspace <ws> --name <n> [--cwd <dir>] [--keep-env NAME…] -- <argv…>",
    "    run argv in a PTY as <dist>-<ws>:<n> (cwd: here); capped by agents.max_concurrent",
    "    env: PATH, HOME, USER, LOGNAME, SHELL, TERM, COLORTERM, LANG, LC_*, TZ,",
    "    TMPDIR only; --keep-env NAME (exact, repeatable; audited) adds one",
    "{cli} sessions list [-w <ws>] [--json]",
    "{cli} sessions attach <name|id>",
    "    raw terminal; ctrl-] detaches and leaves it running",
    "{cli} sessions kill <name|id> [--signal INT|TERM|KILL]",
    "    default TERM; on an exited session, removes it and its scrollback",
    "{cli} sessions host [--stop]",
    "    run the host in the foreground, or stop it (its sessions end)",
    "",
    "A name is the full <dist>-<ws>:<n>, <ws>:<n>, a bare <n> only one session has, or the id.",
    "Needs the optional PTY module: `{cli} doctor` says whether den-pty can run here.",
  ],
};

/** A usage error: exit 2, with the command's usage line. */
export class UsageError extends Error {}

export interface SessionsDeps {
  /** The distribution's state dir (getStateDir). */
  stateDir?: () => string;
  /** The distribution's name: the `<dist>` of a session name. */
  dist?: string;
  /** The distribution's CLI, for messages. */
  cli?: string;
  /** A client of the running host, started when none answers. */
  connect?: () => Promise<HostClient>;
  /** A client of the host if one is running, else null (never starts one). */
  connectExisting?: () => Promise<HostClient | null>;
  pty?: () => PtyLoad;
  workspaceExists?: (ws: string) => boolean;
  maxConcurrent?: () => number;
  invokeCwd?: () => string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface Resolved {
  stateDir: () => string;
  dist: string;
  cli: string;
  connect: () => Promise<HostClient>;
  connectExisting: () => Promise<HostClient | null>;
  pty: () => PtyLoad;
  workspaceExists: (ws: string) => boolean;
  maxConcurrent: () => number;
  invokeCwd: () => string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/** Start `<cli> sessions host` in the background, detached, logging to the state dir. */
function spawnHost(stateDir: string): void {
  const cmd = cliEntrypoint();
  const logDir = path.join(stateDir, "logs", product().cli);
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, "sessions-host.log"), "a");
  try {
    const env = { ...process.env };
    delete env.DEN_WORKSPACE_OVERRIDE;
    const child = spawn(cmd.command, [...cmd.args, "sessions", "host"], {
      cwd: getDistRoot(),
      // Its own session and process group: a web server's or a terminal's
      // end (and `down`'s group signals) never reach it.
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveDeps(d: SessionsDeps): Resolved {
  const stateDir = d.stateDir ?? (() => getStateDir());
  return {
    stateDir,
    dist: d.dist ?? product().name,
    cli: d.cli ?? product().cli,
    connect:
      d.connect ??
      (() =>
        ensureHost({
          socket: sessionPaths(stateDir()).socket,
          spawnHost: () => spawnHost(stateDir()),
          logHint: path.join(
            stateDir(),
            "logs",
            product().cli,
            "sessions-host.log",
          ),
        })),
    connectExisting:
      d.connectExisting ??
      (d.connect
        ? d.connect
        : async () => {
            try {
              return await connectHost(sessionPaths(stateDir()).socket);
            } catch (e) {
              if (noHost(e)) return null;
              throw e;
            }
          }),
    pty: d.pty ?? (() => loadPty()),
    workspaceExists: d.workspaceExists ?? defaultWorkspaceExists,
    maxConcurrent: d.maxConcurrent ?? (() => readAgentsConfig().maxConcurrent),
    invokeCwd: d.invokeCwd ?? getInvokeCwd,
    env: d.env ?? process.env,
    out: d.out ?? ((l) => console.log(l)),
    err: d.err ?? ((l) => console.error(l)),
    stdin: d.stdin ?? process.stdin,
    stdout: d.stdout ?? process.stdout,
  };
}

let workspacesModule:
  | typeof import("../../shared/environment-manager/workspaces.js")
  | null = null;
function defaultWorkspaceExists(ws: string): boolean {
  if (!workspacesModule) throw new Error("workspaces not loaded");
  return Boolean(workspacesModule.readWorkspacesFile().workspaces[ws]);
}
export async function loadWorkspaces(d: SessionsDeps): Promise<void> {
  if (!d.workspaceExists && !workspacesModule)
    workspacesModule =
      await import("../../shared/environment-manager/workspaces.js");
}

// ── argument parsing ──────────────────────────────────────────────────────────

export interface FlagSpec {
  /** Canonical name → takes a value ("repeat": a value, any number of times). */
  [flag: string]: boolean | "repeat";
}

export interface Parsed {
  flags: Record<string, string | true>;
  /** Each "repeat" flag's values, in order. */
  repeated: Record<string, string[]>;
  positional: string[];
  /** After `--`, or null when there was none. */
  rest: string[] | null;
}

const ALIASES: Record<string, string> = { "-w": "--workspace" };

export function parseArgs(
  where: string,
  args: string[],
  spec: FlagSpec,
): Parsed {
  const out: Parsed = { flags: {}, repeated: {}, positional: [], rest: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.rest = args.slice(i + 1);
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const raw = eq === -1 ? a : a.slice(0, eq);
    const flag = ALIASES[raw] ?? raw;
    if (!(flag in spec)) throw new UsageError(`${where}: unknown flag ${raw}`);
    if (!spec[flag]) {
      if (eq !== -1) throw new UsageError(`${where}: ${raw} takes no value`);
      out.flags[flag] = true;
      continue;
    }
    const value = eq !== -1 ? a.slice(eq + 1) : args[++i];
    if (
      value === undefined ||
      value === "" ||
      (eq === -1 && value.startsWith("-"))
    )
      throw new UsageError(`${where}: ${raw} needs a value`);
    if (spec[flag] === "repeat") (out.repeated[flag] ??= []).push(value);
    else out.flags[flag] = value;
  }
  return out;
}

export function noExtra(where: string, p: Parsed, maxPositional = 0): void {
  if (p.positional.length > maxPositional)
    throw new UsageError(
      `${where}: unexpected argument ${p.positional[maxPositional]}`,
    );
  if (p.rest !== null) throw new UsageError(`${where}: takes nothing after --`);
}

export function workspaceFlag(where: string, p: Parsed): string | undefined {
  const ws = p.flags["--workspace"];
  if (ws === undefined) return undefined;
  const name = String(ws);
  if (!WORKSPACE_NAME_RE.test(name))
    throw new UsageError(`${where}: "${name}" is not a workspace name`);
  return name;
}

// ── output ────────────────────────────────────────────────────────────────────

export function state(s: SessionInfo): string {
  if (!s.exited) return "running";
  return s.exitCode === undefined ? "exited" : `exited (${s.exitCode})`;
}

export function columns(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => r[i].length)),
  );
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd(),
  );
}

/** A record as the contract defines it: nothing more goes into --json. */
export function contractInfo(s: SessionInfo): SessionInfo {
  return {
    ref: { backend: s.ref.backend, id: s.ref.id },
    name: s.name,
    pid: s.pid,
    startedAt: s.startedAt,
    ...(s.exited ? { exited: true } : {}),
    ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
  };
}

// ── subcommands ───────────────────────────────────────────────────────────────

/**
 * A plain session's env (AG spec §5a-env): the allowlist, the names the
 * user kept, then every runtime's scrubEnv. `doctor --probe` checks it.
 */
export function plainSessionEnv(
  caller: NodeJS.ProcessEnv,
  keep: readonly string[] = [],
): Record<string, string> {
  return buildSessionEnv({ caller, keep, scrub: allScrubEnv() });
}

/** Who ran the CLI, for an audit line: a login name, printable. */
function cliUser(env: NodeJS.ProcessEnv): string {
  let name = env.USER ?? env.LOGNAME ?? "";
  if (!name)
    try {
      name = os.userInfo().username;
    } catch {
      /* none */
    }
  return name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "unknown";
}

export async function withClient<T>(
  d: Resolved,
  fn: (c: HostClient) => Promise<T>,
): Promise<T> {
  const c = await d.connect();
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

async function start(args: string[], d: Resolved): Promise<number> {
  const where = "sessions start";
  const p = parseArgs(where, args, {
    "--workspace": true,
    "--name": true,
    "--cwd": true,
    "--keep-env": "repeat",
  });
  if (p.positional.length)
    throw new UsageError(
      `${where}: unexpected argument ${p.positional[0]} (put the command after --)`,
    );
  const ws = workspaceFlag(where, p);
  if (!ws) throw new UsageError(`${where} needs --workspace <ws>`);
  const name = p.flags["--name"];
  if (typeof name !== "string")
    throw new UsageError(`${where} needs --name <n>`);
  if (!SESSION_NAME_RE.test(name))
    throw new UsageError(
      `${where}: --name "${name}" must be letters, digits, ".", "_" or "-" (1-64, no ":")`,
    );
  if (!p.rest || !p.rest.length)
    throw new UsageError(
      `${where}: give the command to run after --: -- <argv…>`,
    );
  if (!d.workspaceExists(ws))
    throw new UsageError(`${where}: workspace "${ws}" does not exist`);
  const cwdFlag = p.flags["--cwd"];
  const cwd =
    typeof cwdFlag === "string"
      ? path.resolve(d.invokeCwd(), cwdFlag)
      : d.invokeCwd();
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
    throw new UsageError(`${where}: --cwd ${cwd} is not a directory`);
  const keep = [...new Set(p.repeated["--keep-env"] ?? [])];
  for (const k of keep)
    if (!ENV_NAME_RE.test(k))
      throw new UsageError(
        `${where}: --keep-env "${k}" is not an environment variable name (one exact name per flag)`,
      );
  // An agent's env is its allowlist and its runtime's, never widened by
  // the agent itself (`agents start` has no --keep-env).
  const actor = d.env[AGENT_ACTOR_ENV];
  if (keep.length && actor !== undefined) {
    d.err(
      `✗ --keep-env is refused for an agent (${AGENT_ACTOR_RE.test(actor) ? actor : "agent"}): its env is the allowlist and its runtime's`,
    );
    return 1;
  }
  const env = plainSessionEnv(d.env, keep);
  // Names only, never values: what was left out, so it can be asked for.
  const dropped = Object.keys(d.env)
    .filter((k) => d.env[k] !== undefined && !(k in env))
    .sort();
  const kept = keep
    .filter((k) => k in env)
    .map((name) => ({
      name,
      credentialShaped: isCredentialShaped(name, d.env[name]),
    }));

  const pty = d.pty();
  if (!pty.available) {
    d.err(`✗ ${DEN_PTY_ID} is unavailable: ${pty.reason}`);
    d.err(`  \`${d.cli} doctor\` shows the session backend's state.`);
    return 1;
  }
  const limit = d.maxConcurrent();
  const full = sessionName(d.dist, ws, name);
  const tty = d.stdout.isTTY;
  return withClient(d, async (c) => {
    try {
      const info = await c.start(
        {
          name: full,
          cwd,
          argv: p.rest!,
          env,
          cols: (tty && d.stdout.columns) || 80,
          rows: (tty && d.stdout.rows) || 24,
        },
        {
          limit,
          // Audited by the host: each name, and whether it is
          // credential-shaped; never a value.
          ...(kept.length
            ? { keptEnv: kept, actor: `user ${cliUser(d.env)}` }
            : {}),
        },
      );
      d.out(`started ${info.name} (id ${info.ref.id}, pid ${info.pid})`);
      // With an allowlist nearly everything is left out: the first few
      // names, then a count, so the line stays readable.
      if (dropped.length)
        d.out(
          `  dropped from its environment: ${dropped.slice(0, 8).join(", ")}` +
            (dropped.length > 8 ? ` and ${dropped.length - 8} more` : "") +
            " (keep one with --keep-env NAME)",
        );
      for (const k of kept.filter((x) => x.credentialShaped))
        d.err(
          `  ⚠ --keep-env ${k.name}: credential-shaped; passed because you named it`,
        );
      d.out(`  attach: ${d.cli} sessions attach ${info.name}`);
      return 0;
    } catch (e) {
      if (!(e instanceof HostError)) throw e;
      d.err(`✗ ${e.message}`);
      if (e.code === "cap")
        d.err(
          `  Stop one first (\`${d.cli} sessions kill <name>\`), or raise agents.max_concurrent.`,
        );
      if (e.code === "exists")
        d.err(
          `  Attach to it (\`${d.cli} sessions attach ${full}\`) or pick another --name.`,
        );
      return 1;
    }
  });
}

export async function listSessions(
  d: Resolved,
  ws?: string,
): Promise<SessionInfo[]> {
  const all = await withClient(d, (c) => c.list());
  return ws ? all.filter((s) => inWorkspace(s, d.dist, ws)) : all;
}

async function list(args: string[], d: Resolved): Promise<number> {
  const where = "sessions list";
  const p = parseArgs(where, args, { "--workspace": true, "--json": false });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  const sessions = await listSessions(d, ws);
  if (p.flags["--json"]) {
    d.out(JSON.stringify(sessions.map(contractInfo), null, 2));
    return 0;
  }
  if (!sessions.length) {
    d.out(ws ? `no sessions in ${ws}` : "no sessions");
    return 0;
  }
  for (const l of columns([
    ["NAME", "ID", "STATE", "PID", "STARTED"],
    ...sessions.map((s) => [
      s.name,
      s.ref.id,
      state(s),
      String(s.pid),
      s.startedAt,
    ]),
  ]))
    d.out(l);
  return 0;
}

async function target(
  where: string,
  p: Parsed,
  d: Resolved,
  c: HostClient,
): Promise<SessionInfo | null> {
  const ws = workspaceFlag(where, p);
  try {
    return resolveSession(await c.list(), d.dist, p.positional[0], ws);
  } catch (e) {
    d.err(`✗ ${(e as Error).message}`);
    return null;
  }
}

async function kill(args: string[], d: Resolved): Promise<number> {
  const where = "sessions kill";
  const p = parseArgs(where, args, { "--workspace": true, "--signal": true });
  if (!p.positional.length) throw new UsageError(`${where} needs <name|id>`);
  noExtra(where, p, 1);
  const raw = p.flags["--signal"];
  const sig = (
    typeof raw === "string" ? raw.toUpperCase().replace(/^SIG/, "") : "TERM"
  ) as SessionSignal;
  if (!SESSION_SIGNALS.includes(sig))
    throw new UsageError(
      `${where}: --signal takes ${SESSION_SIGNALS.join("|")}`,
    );
  return withClient(d, async (c) => {
    const s = await target(where, p, d, c);
    if (!s) return 1;
    if (s.exited) {
      await c.forget(s.ref.id);
      d.out(`removed ${s.name} (it had exited) and its scrollback`);
      return 0;
    }
    try {
      await c.kill(s.ref.id, sig);
    } catch (e) {
      if (!(e instanceof HostError)) throw e;
      d.err(`✗ ${e.message}`);
      return 1;
    }
    d.out(`sent ${sig} to ${s.name} (pid ${s.pid})`);
    return 0;
  });
}

async function attach(args: string[], d: Resolved): Promise<number> {
  const where = "sessions attach";
  const p = parseArgs(where, args, { "--workspace": true });
  if (!p.positional.length) throw new UsageError(`${where} needs <name|id>`);
  noExtra(where, p, 1);
  const c = await d.connect();
  const s = await target(where, p, d, c);
  if (!s) {
    c.close();
    return 1;
  }
  return attachTerminal(c, s, d);
}

/**
 * Raw passthrough between this terminal and the session: keys go in as
 * typed, output comes out as sent, SIGWINCH resizes, ctrl-] detaches.
 */
function attachTerminal(
  c: HostClient,
  s: SessionInfo,
  d: Resolved,
): Promise<number> {
  const { stdin, stdout } = d;
  const id = s.ref.id;
  return new Promise((resolve) => {
    let done = false;
    const raw = Boolean(stdin.isTTY && typeof stdin.setRawMode === "function");
    const resize = () => {
      if (stdout.isTTY && stdout.columns && stdout.rows)
        c.resize(id, stdout.columns, stdout.rows);
    };
    const finish = (code: number, message: string) => {
      if (done) return;
      done = true;
      stdin.off("data", onInput);
      stdin.off("end", onEnd);
      process.off("SIGWINCH", resize);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      // A paused pipe still holds the event loop open: let go of it.
      (stdin as { unref?: () => void }).unref?.();
      d.err(message);
      c.close();
      resolve(code);
    };
    // The banner comes first: the replay that follows is the session's own.
    if (!s.exited) d.err(`[attached to ${s.name}; detach: ctrl-]]`);
    const att = c.attach(id, {
      onData: (data) => stdout.write(data),
      onExit: (code) =>
        finish(
          0,
          `\r\n[${s.name} exited${code === undefined ? "" : ` (${code})`}]`,
        ),
    });
    const onInput = (chunk: Buffer) => {
      const at = chunk.indexOf(DETACH_KEY);
      if (at === -1) return c.write(id, chunk);
      if (at > 0) c.write(id, chunk.subarray(0, at));
      att.detach();
      finish(0, `\r\n[detached from ${s.name}; it keeps running]`);
    };
    const onEnd = () => {
      att.detach();
      finish(0, `\r\n[detached from ${s.name}; it keeps running]`);
    };
    c.once("close", () => finish(1, `\r\n[the session host went away]`));
    att.ready.then(
      () => {
        if (done) return;
        resize();
      },
      (e: Error) => finish(1, `✗ ${e.message}`),
    );
    if (raw) stdin.setRawMode(true);
    stdin.on("data", onInput);
    stdin.on("end", onEnd);
    stdin.resume();
    process.on("SIGWINCH", resize);
  });
}

async function host(args: string[], d: Resolved): Promise<number> {
  const where = "sessions host";
  const p = parseArgs(where, args, { "--stop": false });
  noExtra(where, p);
  if (!p.flags["--stop"])
    return runSessionHost({ stateDir: d.stateDir(), pty: () => loadPty() });
  const c = await d.connectExisting();
  if (!c) {
    d.out("no session host is running");
    return 0;
  }
  const pid = c.hostPid;
  const running = (await c.list().catch(() => [])).filter(
    (s) => !s.exited,
  ).length;
  const closed = new Promise<void>((r) => c.once("close", () => r()));
  await c.shutdown();
  // The host drops every connection, then removes its socket.
  const sock = sessionPaths(d.stateDir()).socket;
  const deadline = Date.now() + 5000;
  await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
  while (fs.existsSync(sock) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  c.close();
  d.out(
    `stopped the session host (pid ${pid})` +
      (running
        ? `; ${running} running session${running === 1 ? "" : "s"} ended`
        : ""),
  );
  return 0;
}

export function usageLine(
  cli: string,
  help: { usage: string },
  cmd: string,
): string {
  return `Usage: ${cli} ${help.usage}  (\`${cli} ${cmd} --help\`)`;
}

export async function guarded(
  d: Resolved,
  help: { usage: string },
  cmd: string,
  fn: () => Promise<number>,
): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UsageError) {
      d.err(`✗ ${e.message}`);
      d.err(usageLine(d.cli, help, cmd));
      return 2;
    }
    if (e instanceof HostError) {
      d.err(`✗ ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** `<cli> sessions ...`; returns the exit code. */
export async function cmdSessions(
  args: string[],
  deps: SessionsDeps = {},
): Promise<number> {
  const d = resolveDeps(deps);
  const [sub, ...rest] = args;
  return guarded(d, SESSIONS_HELP, "sessions", async () => {
    switch (sub) {
      case "start":
        await loadWorkspaces(deps);
        return start(rest, d);
      case "list":
        return list(rest, d);
      case "attach":
        return attach(rest, d);
      case "kill":
        return kill(rest, d);
      case "host":
        return host(rest, d);
      case undefined:
        throw new UsageError("sessions needs a subcommand");
      default:
        throw new UsageError(`unknown sessions command "${sub}"`);
    }
  });
}
