/**
 * Issue 936, slice 1: Den's state is read-only to an agent's session.
 *
 * An agent runs as the person's OS user, so without this a session in
 * bypass mode could rewrite its own record (its mode), the gate store or
 * the settings file, and read the person's credentials. The session's
 * argv is wrapped in the OS sandbox when it starts:
 *
 *   macOS   /usr/bin/sandbox-exec -p <profile> <argv…>
 *   Linux   bwrap --dev-bind / / <binds…> -- <argv…>
 *
 * What the policy says, for agent <id>:
 *   readOnly   <state dir>, <install root>/config/local (user.yml). On
 *              macOS their folders up to the home folder can't be renamed
 *              either (a rename would move them away).
 *   writable   <state>/agent-files/<id>: handoff.md, its notes, the hooks'
 *              counts. The gate store: its slot queue (slots/, its lock,
 *              the slot log), which `gate run` and the MCP slot tools
 *              write from inside the session.
 *   locked     inside those: the launch files Den writes in the agent's
 *              folder (its Claude settings, its MCP config, the compaction
 *              hold), and the gate store's settings (with its test boxes).
 *   hidden     the person's credentials (web.secret, the web sessions,
 *              Hub's token, the runner tokens, the embed keys) and every
 *              other agent's actor token: not readable at all.
 *   sockets    the session host's socket: a session started there would
 *              run outside the sandbox.
 *
 * Den's server does the writing an agent asks for (its MCP server is an
 * HTTP client of it). AGENT_SANDBOX_ENV tells Den's CLI it runs inside.
 *
 * Where no sandbox can apply (Linux without bwrap, Windows) the session
 * starts unsandboxed and `reason` says why: the start line and doctor
 * show it. agents.sandbox: off (or agents.<id>.sandbox: off) in user.yml
 * turns it off; user.yml is read-only to agents, so none can turn off its
 * own.
 *
 * Known limits of slice 1: the hooks' rotation count is in the agent's own
 * folder, which it can write; the gate's slot queue is written from the
 * session. Slot writes move to the server with issue 621; slice 2 (agents
 * as a second OS user, issue 988) closes the rest.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Set in a sandboxed session's env: Den's CLI inside asks the server. */
export const AGENT_SANDBOX_ENV = "DEN_AGENT_SANDBOX";

/** The files Den writes in an agent's folder at launch: read-only to it. */
export const LAUNCH_FILES = [
  "settings.json",
  "mcp.json",
  "hub-mcp.json",
  "instructions.json",
  "compacting.json",
] as const;

/**
 * The gate store's file only a person changes: the machine's gate settings
 * and its test boxes. (boxes-state.json, the last box checks, is written by
 * `gate run --box` from the session: it moves to the server with 621.)
 */
export const GATE_LOCKED_FILES = ["settings.json"] as const;

/** Files in the state dir no agent's session reads, relative to it. */
export const HIDDEN_FILES = [
  "web.secret",
  "web-sessions.json",
  path.join("hub", "token"),
  path.join("gate", "runner-tokens.json"),
  path.join("embed", "server-keys.json"),
] as const;

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface AgentSandboxInput {
  stateDir: string;
  /** The install's root: its config/local holds user.yml. */
  distRoot: string;
  /** The gate store (gates/store.ts gateDir). */
  gateDir: string;
  agentId: string;
}

export interface SandboxPolicy {
  readOnly: string[];
  writable: string[];
  /** The gate store (in `writable`; its settings in `locked`). */
  gateDir: string;
  locked: string[];
  hidden: string[];
  /** Every agent's actor-token folder: hidden but for `ownTokenDir`. */
  tokensDir: string;
  ownTokenDir: string;
  sockets: string[];
  /** The home folder: renames are refused below it (macOS). */
  home: string;
}

/**
 * The real path, as the kernel sees it (macOS: /var is /private/var): of
 * the path, or of its nearest existing folder with the rest added.
 */
export function realPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(realPath(parent), path.basename(abs));
  }
}

export function agentSandboxPolicy(i: AgentSandboxInput): SandboxPolicy {
  if (!SAFE_ID.test(i.agentId) || i.agentId === "." || i.agentId === "..")
    throw new Error(`sandbox: agent id "${i.agentId}" is not a plain name`);
  const state = realPath(i.stateDir);
  const own = path.join(state, "agent-files", i.agentId);
  const tokensDir = path.join(state, "actor-token");
  const gate = realPath(i.gateDir);
  return {
    readOnly: [state, realPath(path.join(i.distRoot, "config", "local"))],
    writable: [own, gate],
    locked: [
      ...LAUNCH_FILES.map((f) => path.join(own, f)),
      ...GATE_LOCKED_FILES.map((f) => path.join(gate, f)),
    ],
    gateDir: gate,
    hidden: HIDDEN_FILES.map((f) => path.join(state, f)),
    tokensDir,
    ownTokenDir: path.join(tokensDir, i.agentId),
    sockets: [path.join(state, "sessions.sock")],
    home: realPath(os.homedir()),
  };
}

/** A string in a sandbox profile: backslash and quote escaped. */
function sbString(s: string): string {
  if (/[\0\n\r]/.test(s)) throw new Error("sandbox: a path has a control byte");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The folders above `p`, below `home` (outside it: above, from `p`'s root). */
function ancestors(p: string, home: string): string[] {
  const out: string[] = [];
  const inHome = p.startsWith(home + path.sep);
  let d = path.dirname(p);
  while (d !== path.dirname(d) && (inHome ? d !== home : true)) {
    out.push(d);
    d = path.dirname(d);
  }
  return out;
}

/** The macOS sandbox profile (SBPL): later rules win over earlier ones. */
export function macProfile(p: SandboxPolicy): string {
  const lit = (x: string) => `(literal ${sbString(x)})`;
  const sub = (x: string) => `(subpath ${sbString(x)})`;
  const above = [
    ...new Set(p.readOnly.flatMap((r) => ancestors(r, p.home))),
  ].filter((a) => !p.readOnly.some((r) => a.startsWith(r + path.sep)));
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* ${p.readOnly.map(sub).join(" ")})`,
    ...(above.length ? [`(deny file-write* ${above.map(lit).join(" ")})`] : []),
    `(allow file-write* ${p.writable.map(sub).join(" ")})`,
    `(deny file-write* ${p.locked.map(lit).join(" ")})`,
    `(deny file-read* ${p.hidden.map(lit).join(" ")} ${sub(p.tokensDir)})`,
    `(allow file-read* ${lit(p.tokensDir)} ${sub(p.ownTokenDir)})`,
    `(deny network-outbound ${p.sockets.map((s) => `(remote unix-socket (path-literal ${sbString(s)}))`).join(" ")})`,
    "",
  ].join("\n");
}

/**
 * bwrap binds only what exists: a locked gate file not made yet is made
 * now, as "{}" (what the store reads as unset), so the bind covers it.
 * macOS needs none of this (its rule names the path).
 */
export function ensureLockedGateFiles(p: SandboxPolicy): void {
  for (const f of GATE_LOCKED_FILES) {
    const file = path.join(p.gateDir, f);
    try {
      fs.mkdirSync(p.gateDir, { recursive: true });
      fs.writeFileSync(file, "{}\n", { flag: "wx", mode: 0o644 });
    } catch {
      /* there already (or no gate store: nothing to cover) */
    }
  }
}

/** bwrap's arguments, up to and with "--": later mounts cover earlier. */
export function bwrapArgs(
  p: SandboxPolicy,
  exists: (f: string) => boolean = fs.existsSync,
): string[] {
  const a = ["--dev-bind", "/", "/"];
  for (const r of p.readOnly) if (exists(r)) a.push("--ro-bind", r, r);
  for (const w of p.writable) if (exists(w)) a.push("--bind", w, w);
  for (const l of p.locked) if (exists(l)) a.push("--ro-bind", l, l);
  for (const h of [...p.hidden, ...p.sockets])
    if (exists(h)) a.push("--ro-bind", "/dev/null", h);
  if (exists(p.tokensDir)) {
    a.push("--tmpfs", p.tokensDir);
    if (exists(p.ownTokenDir))
      a.push("--ro-bind", p.ownTokenDir, p.ownTokenDir);
  }
  a.push("--");
  return a;
}

/**
 * agents.sandbox and agents.<id>.sandbox, as den-config resolves them: on
 * unless the person set off for all, or for this agent (its own wins).
 */
export function sandboxSetting(
  cfg: { sandbox?: boolean; agents?: Record<string, { sandbox?: boolean }> },
  agentId: string,
): boolean {
  const mine = cfg.agents?.[agentId]?.sandbox;
  if (mine !== undefined) return mine;
  return cfg.sandbox !== false;
}

export interface SandboxWrap {
  applied: boolean;
  argv: string[];
  /** Added to the session's env. */
  env: Record<string, string>;
  /** Which tool, when applied. */
  tool?: "sandbox-exec" | "bwrap";
  /** Why not, when not applied. */
  reason?: string;
}

/** Where `bin` is on PATH, or undefined. */
function whichBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, bin);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

export interface SandboxOptions {
  platform?: NodeJS.Platform;
  /** The person's setting (sandboxSetting). */
  on: boolean;
  which?: (bin: string) => string | undefined;
}

/** `argv` wrapped in the agent's sandbox, or unwrapped with the reason. */
export function sandboxFor(
  argv: string[],
  i: AgentSandboxInput,
  o: SandboxOptions,
): SandboxWrap {
  const platform = o.platform ?? process.platform;
  const which = o.which ?? ((b: string) => whichBin(b));
  if (!o.on)
    return {
      applied: false,
      argv,
      env: {},
      reason: "the sandbox is off for this agent in user.yml",
    };
  const policy = agentSandboxPolicy(i);
  if (platform === "darwin") {
    const exe = fs.existsSync("/usr/bin/sandbox-exec")
      ? "/usr/bin/sandbox-exec"
      : which("sandbox-exec");
    if (!exe)
      return {
        applied: false,
        argv,
        env: {},
        reason: "sandbox-exec is missing",
      };
    return {
      applied: true,
      tool: "sandbox-exec",
      argv: [exe, "-p", macProfile(policy), ...argv],
      env: { [AGENT_SANDBOX_ENV]: "1" },
    };
  }
  if (platform === "linux") {
    const exe = which("bwrap");
    if (!exe)
      return {
        applied: false,
        argv,
        env: {},
        reason: "bwrap (bubblewrap) is not installed",
      };
    ensureLockedGateFiles(policy);
    return {
      applied: true,
      tool: "bwrap",
      argv: [exe, ...bwrapArgs(policy), ...argv],
      env: { [AGENT_SANDBOX_ENV]: "1" },
    };
  }
  return {
    applied: false,
    argv,
    env: {},
    reason: `no agent sandbox on ${platform} yet`,
  };
}

/**
 * The MCP tool or held write an agent uses for a CLI verb that writes
 * Den's state, by `<cli> <command> <sub>`; a default for the rest.
 */
const INSTEAD: Record<string, string> = {
  "agents start":
    "start an agent with the agent_create tool (a held write: the person allows it)",
  "agents mode":
    "ask for a mode with the agent_mode tool (a held write: the person allows it)",
  "agents list": "read the agents with the status and org_summary tools",
  "agents import":
    "bring an agent in with the agent_import tool (a held write)",
};
const INSTEAD_DEFAULT =
  "use Den's MCP tools: status and org_summary read; agent_create, agent_mode and the other held writes change things on the person's Allow";

/**
 * What the CLI adds to an error inside an agent's sandbox, when the OS
 * refused a write or a connection there (EPERM, EACCES, EROFS): what
 * happened, and the tool or held write to use instead (never a chore for
 * the person). Null outside the sandbox, or for any other error.
 */
export function sandboxErrorHint(
  error: unknown,
  env: NodeJS.ProcessEnv,
  cli: string,
  /** The command line's words after the CLI's name. */
  args: readonly string[] = [],
): string | null {
  if (env[AGENT_SANDBOX_ENV] !== "1") return null;
  const code = (error as { code?: unknown } | null)?.code;
  const msg = String((error as Error | null)?.message ?? "");
  const refused =
    ["EPERM", "EACCES", "EROFS"].includes(String(code)) ||
    /\b(EPERM|EACCES|EROFS)\b|operation not permitted/i.test(msg);
  if (!refused) return null;
  const words = args.filter((a) => !a.startsWith("-"));
  const verb = `${words[0] ?? ""} ${words[1] ?? ""}`.trim();
  const instead = INSTEAD[verb] ?? INSTEAD_DEFAULT;
  return (
    `\`${cli}${verb ? ` ${verb}` : ""}\` writes Den's state, which is read-only inside an agent's sandbox (issue 936). ` +
    `Instead, ${instead}.`
  );
}
