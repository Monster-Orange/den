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
import { spawnSync } from "child_process";
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

/**
 * What a session reads in the state dir, relative to it: the rest of it
 * can't be read or listed. Each entry holds no secret; a test keeps
 * secret-looking names out of it. Den's CLI inside a session needs these
 * to find the web server and run `gate run`, `doctor` and `mcp --call`.
 */
export const SESSION_READ_DIRS: readonly string[] = [
  // Agents' records and the personas (`agents list`, doctor).
  "agents",
  "personas",
];
export const SESSION_READ_FILES: readonly string[] = [
  // Where the web server is, and what runs (every CLI call to it).
  "web.json",
  "daemons.json",
  "sessions-host-job.json",
  "web-owner.json",
  "address-proof.json",
  // The actor tokens' hashes and what each proves (the MCP server checks
  // its own is live): hashes only, never a token.
  "actor-tokens.json",
  // The api_only guardrail's rules (the PreToolUse hook reads them).
  path.join("guardrails", "api-only.json"),
  // Status doctor shows.
  path.join("server-agent", "update", "check.json"),
  path.join("server-agent", "update", "state.json"),
  path.join("github", "watch-status.json"),
  path.join("github", "watches.json"),
  path.join("hub", "bound.json"),
  path.join("hub", "links-seen.json"),
  path.join("hub", "deliveries.jsonl"),
  path.join("hub", "deliveries-seen.json"),
  path.join("hub", "deliveries-health.json"),
  path.join("hub", "inbox-watch.json"),
  path.join("hub", "tools-seen.json"),
];
/** Folders whose names a session lists (not their files). */
export const SESSION_LIST_DIRS: readonly string[] = ["agent-files"];
/**
 * Written from the session: the api_only guardrail's audit (its hook runs
 * there). So an agent can rewrite its own audit lines in this slice; slice
 * 2 (issue 988) moves the audit to the server, out of its reach.
 */
export const SESSION_WRITE_DIRS: readonly string[] = ["audit"];

/** Never readable inside a session, whatever SESSION_READS says. */
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
  /** More folders no session reads (a machine-wide secret's folder). */
  deniedDirs?: string[];
  /** More unix-socket folders a session may connect to (user.yml). */
  socketsAllowed?: string[];
  /** The env the session starts from (its SSH agent, its runtime dir). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The unix sockets every session may reach: the system's own daemons (DNS,
 * the log), and the agents' own messages to each other (Claude Code's
 * peer sockets). The SSH agent's, when the env names one.
 */
export function defaultSocketsAllowed(env: NodeJS.ProcessEnv): string[] {
  const out = ["/private/var/run", "/var/run", "/run/systemd/resolve"];
  out.push(realPath(path.join("/tmp", "cc-socks")));
  const ssh = env.SSH_AUTH_SOCK?.trim();
  if (ssh) out.push(realPath(path.dirname(ssh)));
  return [...new Set(out)];
}

export interface SandboxPolicy {
  readOnly: string[];
  writable: string[];
  /** The gate store (in `writable`; its settings in `locked`). */
  gateDir: string;
  locked: string[];
  /**
   * Not readable: the state dir as a whole (a path can be stat'd, never
   * listed or read), and `deniedDirs` (other private folders). What a
   * session reads in the state dir is `readable`, allowed back.
   */
  unreadable: string[];
  /** Read back inside `unreadable`: folders (with all inside them). */
  readable: string[];
  /** Read back inside `unreadable`: single files. */
  readableFiles: string[];
  /** Listed (names only) inside `unreadable`. */
  listable: string[];
  /** Belt and braces: never readable, even if `readable` names them. */
  hidden: string[];
  ownTokenDir: string;
  sockets: string[];
  /**
   * Unix sockets a session may connect to (folders); every other one is
   * refused (macOS). A process listening on one runs outside the sandbox.
   */
  socketsAllowed: string[];
  /** Linux: folders of the person's own sockets, covered by a tmpfs. */
  socketDirsHidden: string[];
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
    // The denied folders can't be written either: a file planted there
    // would be trusted as the machine's own.
    readOnly: [
      state,
      realPath(path.join(i.distRoot, "config", "local")),
      ...(i.deniedDirs ?? []).map(realPath),
    ],
    writable: [
      own,
      gate,
      ...SESSION_WRITE_DIRS.map((f) => path.join(state, f)),
    ],
    locked: [
      ...LAUNCH_FILES.map((f) => path.join(own, f)),
      ...GATE_LOCKED_FILES.map((f) => path.join(gate, f)),
    ],
    gateDir: gate,
    unreadable: [state, ...(i.deniedDirs ?? []).map(realPath)],
    readable: [
      own,
      path.join(tokensDir, i.agentId),
      ...SESSION_READ_DIRS.map((f) => path.join(state, f)),
      ...SESSION_WRITE_DIRS.map((f) => path.join(state, f)),
    ],
    readableFiles: SESSION_READ_FILES.map((f) => path.join(state, f)),
    listable: SESSION_LIST_DIRS.map((f) => path.join(state, f)),
    hidden: HIDDEN_FILES.map((f) => path.join(state, f)),
    ownTokenDir: path.join(tokensDir, i.agentId),
    sockets: [path.join(state, "sessions.sock")],
    socketsAllowed: [
      ...defaultSocketsAllowed(i.env ?? process.env),
      ...(i.socketsAllowed ?? []).map(realPath),
    ],
    socketDirsHidden: linuxSocketDirs(i.env ?? process.env),
    home: realPath(os.homedir()),
  };
}

/**
 * The folders of the machine's local proof (the loopback check's secret,
 * per user and machine; its files per install): the OS's app folder for
 * Den, and the folder the env moves it to. No session reads them: an
 * agent's CLI and MCP use its actor token.
 */
export function localProofDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  prefixedEnv?: string,
): string[] {
  const out: string[] = [];
  if (platform === "darwin")
    out.push(
      path.join(home, "Library", "Application Support", "den", "local-proof"),
    );
  else if (platform === "linux")
    out.push(
      path.join(
        env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state"),
        "den",
        "local-proof",
      ),
    );
  for (const k of ["DEN_LOCAL_PROOF_DIR", prefixedEnv])
    if (k && env[k]?.trim()) out.push(path.resolve(env[k]!.trim()));
  return [...new Set(out)];
}

/** Linux: the person's own socket folders (tmux, the user runtime dir). */
function linuxSocketDirs(env: NodeJS.ProcessEnv): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const out: string[] = [];
  if (uid >= 0)
    out.push(path.join(env.TMUX_TMPDIR?.trim() || "/tmp", `tmux-${uid}`));
  const run = env.XDG_RUNTIME_DIR?.trim();
  if (run) out.push(path.resolve(run));
  return out;
}

/** A regex that matches `dir` and everything under it, for SBPL. */
function underRegex(dir: string): string {
  if (/["\0\n\r]/.test(dir))
    throw new Error(`sandbox: a socket folder can't hold a quote: ${dir}`);
  const esc = dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return `#"^${esc}(/|$)"`;
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
  const guarded = [
    ...new Set(p.writable.flatMap((w) => [w, ...ancestors(w, p.home)])),
  ];
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* ${p.readOnly.map(sub).join(" ")})`,
    ...(above.length ? [`(deny file-write* ${above.map(lit).join(" ")})`] : []),
    `(allow file-write* ${p.writable.map(sub).join(" ")})`,
    `(deny file-write* ${p.locked.map(lit).join(" ")})`,
    // The writable folders themselves, and those above them, can't be
    // moved away (and a forged one moved in): renames refused.
    `(deny file-write* ${guarded.map(lit).join(" ")})`,
    `(deny file-read* ${p.unreadable.map(sub).join(" ")})`,
    // Stat'd only: never listed or read (listing needs file-read-data).
    `(allow file-read-metadata ${p.unreadable.map(sub).join(" ")})`,
    `(allow file-read* ${[...p.readable.map(sub), ...p.readableFiles.map(lit), ...p.listable.map(lit)].join(" ")})`,
    `(deny file-read* ${p.hidden.map(lit).join(" ")})`,
    // A program started through LaunchServices (open, an app's script)
    // runs outside the sandbox.
    "(deny lsopen)",
    "(deny appleevent-send)",
    // Unix sockets: none but the allowed (a listener runs outside it).
    "(deny network-outbound (remote unix-socket))",
    `(allow network-outbound ${p.socketsAllowed.map((d) => `(remote unix-socket (path-regex ${underRegex(d)}))`).join(" ")})`,
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
  for (const w of p.writable)
    try {
      fs.mkdirSync(w, { recursive: true, mode: 0o700 });
    } catch {
      /* made by Den as it starts the agent, or not makeable here */
    }
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
/** Linux: container engines' sockets, masked in every session. */
export const CONTAINER_SOCKETS: readonly string[] = [
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/containerd/containerd.sock",
  "/run/podman/podman.sock",
];

export function bwrapArgs(
  p: SandboxPolicy,
  exists: (f: string) => boolean = fs.existsSync,
  real: (f: string) => string = (f) => {
    try {
      return fs.realpathSync(f);
    } catch {
      return f;
    }
  },
): string[] {
  // Its own pid namespace and /proc: no other process's env or files;
  // and it ends with the session.
  const a = [
    "--dev-bind",
    "/",
    "/",
    "--unshare-pid",
    "--proc",
    "/proc",
    "--die-with-parent",
  ];
  // The folders above the protected ones, each bound onto itself first: a
  // mount point can't be renamed, so none of them can be moved aside and
  // a forged copy put in its place. Outer ones first, so a pin never
  // covers what is bound inside it.
  const pins = [
    ...new Set(
      [...p.readOnly, ...p.writable].flatMap((x) => ancestors(x, p.home)),
    ),
  ]
    .filter((d) => !p.readOnly.some((r) => d.startsWith(r + path.sep)))
    .filter((d) => exists(d))
    .sort((x, y) => x.split(path.sep).length - y.split(path.sep).length);
  for (const d of pins) a.push("--bind", d, d);
  for (const r of p.readOnly) if (exists(r)) a.push("--ro-bind", r, r);
  // An unreadable folder: an empty tmpfs over it, what it may read bound
  // back (read-only), then the writable folders inside it.
  const inside = (x: string) =>
    p.unreadable.some((u) => x === u || x.startsWith(u + path.sep));
  for (const u of p.unreadable) if (exists(u)) a.push("--tmpfs", u);
  // The person's own sockets (tmux, the user runtime dir): a tmpfs, then
  // the allowed ones bound back.
  for (const d of p.socketDirsHidden) if (exists(d)) a.push("--tmpfs", d);
  for (const ok of p.socketsAllowed)
    if (
      exists(ok) &&
      p.socketDirsHidden.some((d) => ok === d || ok.startsWith(d + path.sep))
    )
      a.push("--bind", ok, ok);
  for (const r of [...p.readable, ...p.readableFiles])
    if (inside(r) && exists(r) && !p.writable.includes(r))
      a.push("--ro-bind", r, r);
  for (const w of p.writable) if (exists(w)) a.push("--bind", w, w);
  for (const l of p.locked) if (exists(l)) a.push("--ro-bind", l, l);
  for (const h of [...p.hidden, ...p.sockets])
    if (exists(h) && !inside(h)) a.push("--ro-bind", "/dev/null", h);
  // A container engine's socket runs anything as root on this machine.
  // Once each, at its real path: bwrap can't bind at a path through a
  // link (/var/run is a link to /run on most Linux systems).
  const engines = new Set(CONTAINER_SOCKETS.filter(exists).map(real));
  for (const c of engines) a.push("--ro-bind", "/dev/null", c);
  for (const u of p.unreadable) if (exists(u)) a.push("--remount-ro", u);
  a.push("--");
  return a;
}

/**
 * agents.sandbox and agents.<id>.sandbox, as den-config resolves them: on
 * unless the person set off for all, or for this agent (its own wins).
 */
export function sandboxRequired(
  cfg: {
    sandboxRequired?: boolean;
    agents?: Record<string, { sandboxRequired?: boolean }>;
  },
  agentId: string,
): boolean {
  return cfg.agents?.[agentId]?.sandboxRequired ?? cfg.sandboxRequired ?? false;
}

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
  tool?: string;
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
  /** Linux: whether bwrap starts here (default: runs it once, cached). */
  bwrapWorks?: (exe: string) => string | null;
}

const bwrapChecked = new Map<string, string | null>();
/** Runs bwrap once: null when it starts, else why not (its first line). */
export function bwrapStarts(
  exe: string,
  run: (
    exe: string,
    args: string[],
  ) => { status: number | null; stderr?: string; error?: Error } = (e, a) =>
    spawnSync(e, a, { encoding: "utf-8", timeout: 10_000 }),
): string | null {
  const known = bwrapChecked.get(exe);
  if (known !== undefined) return known;
  // The flags a session's bwrap uses: a host without pid namespaces fails.
  const r = run(exe, [
    "--ro-bind",
    "/",
    "/",
    "--unshare-pid",
    "--proc",
    "/proc",
    "--die-with-parent",
    "true",
  ]);
  const why =
    r.status === 0
      ? null
      : (String(r.stderr || r.error?.message || `exit ${r.status}`)
          .split("\n")[0]
          ?.trim() ?? "it did not start");
  bwrapChecked.set(exe, why);
  return why;
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
    const why = (o.bwrapWorks ?? bwrapStarts)(exe);
    if (why)
      return {
        applied: false,
        argv,
        env: {},
        reason: `bwrap can't start a sandbox here: ${why}`,
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
