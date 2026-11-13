/**
 * den-claude: Den's built-in runtime for Claude Code (AG spec §4).
 *
 *   claude --session-id <uuid> --mcp-config <filesDir>/mcp.json
 *          --strict-mcp-config --permission-mode <mode> [--model <m>]
 *          --append-system-prompt <role prompt>
 *
 * - The MCP config (0600) holds one server, Den's, scoped to the agent's
 *   workspace; --strict-mcp-config keeps any other MCP server out, so the
 *   agent acts only through Den (§1).
 * - The role prompt is appended to Claude Code's own system prompt.
 * - Den's state dir is denied to the agent (SEC-1 §6c.1): a settings file
 *   (--settings, 0600) whose `permissions.deny` lists Read and Bash rules
 *   (any command naming the path) for `<state>/web.secret` and
 *   `<state>/sessions/**`. It binds a
 *   cooperating agent only: the agent runs as the same OS user, so nothing
 *   stops one that ignores its permission config from reading them.
 * - Den's guardrail hooks (den#5, guardrails.ts), when the persona's
 *   guardrails include them: the same settings file carries
 *   guardrails/hooks.json's `hooks` (PreToolUse on Bash and Read, and Stop),
 *   alongside any hooks the user has; Den never writes ~/.claude.
 * - Each launch picks a fresh conversation id (--session-id); resume
 *   continues it with --resume <id>, in the same cwd, with the same MCP.
 *   A relaunch from handoff (den#4) is a launch whose first prompt, the
 *   last argument, is the handoff.
 * - Session rotation (den#4): the hooks include PreCompact and
 *   SessionStart (rotation-hook.ts) with the agent's files dir and its
 *   limit (LaunchInput rotateAfter), so its compactions are counted there.
 * - Permission prompts stay in the terminal (approvals: "terminal"):
 *   --permission-mode default, unless the persona's `permission_mode` sets
 *   one of Claude Code's modes; bypassPermissions warns at every start. The
 *   Notification hook comes with agent states (AG-6a).
 * - Its environment is the allowlist (sessions/env.ts) plus
 *   CLAUDE_CONFIG_DIR, where a user keeps Claude Code's config when not in
 *   HOME. Claude Code reads its own credentials from there; no token is
 *   passed. Its scrubEnv, CLAUDECODE and CLAUDE_CODE_*, never reaches any
 *   session Den starts (an agent is not a child of the session that
 *   started it).
 *
 * detect runs nothing (AG-0.1, runtime-search.ts): agents.runtimes.den-claude.bin
 * in user.yml when set, else `claude` on the login shell's PATH, the
 * caller's PATH, then its install directories (~/.local/bin, the native
 * installer's; ~/.claude/local; /opt/homebrew/bin; /usr/local/bin; npm's
 * global bin). Its version is read from where it is installed (a native
 * install's versions/<version>, or the npm package's package.json); the
 * Start dialog and `agents doctor` ask `claude --version` once as well.
 */
import {
  readClaudeHelperTranscript,
  readClaudeHelpers,
} from "./claude-helpers.js";
import { sortHelpers, type Helper } from "./helpers.js";
import type { AgentRecord } from "./records.js";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MCP_ACTIONS, configuredRuntimeBin } from "../den-config.js";
import { rolePrompt } from "./personas.js";
import { HUB_PROMPT_LINE } from "../hub.js";
import {
  apiOnlyHooks,
  GUARDRAILS_DIR,
  guardrailHooks,
  hookCommands,
} from "./guardrails.js";
import { DEFAULT_ROTATE } from "./rotation.js";
import { idsInNames } from "./handback.js";
import { isServerScope } from "./server-agent.js";
import { product } from "../product.js";
import {
  LaunchError,
  mcpConfigJson,
  mcpConfigPath,
  type DetectOptions,
  type LaunchInput,
  type LaunchOutput,
  type Runtime,
  type RuntimeDetect,
  type RuntimeModel,
  type RuntimePermissions,
} from "./runtime.js";
import { PERMISSION_INTENTS, type PermissionIntent } from "./permissions.js";
import { builtinEntry } from "./catalog.js";
import { catalogFind } from "./catalog-runtime.js";
import { locateRuntime, type RuntimeFind } from "./runtime-search.js";
import { claudeProjectsDir } from "../usage/paths.js";
import { cleanName, transcriptTitle } from "./transcript-follow.js";
import {
  claudeConversations,
  claudeConversationsWhere,
  transcriptBusy,
  lastPrompt,
  transcriptSummary,
} from "./conversations.js";
import { claudeOpenPid } from "./open-check.js";

/**
 * `/rename "x"` keeps the quotes in customTitle: one matching pair around
 * the whole name goes, for display only (0.4.13). Nothing inside: null.
 */
export function unquoteTitle(name: string | null): string | null {
  if (!name || name.length < 2) return name;
  const q = name[0];
  if ((q !== '"' && q !== "'") || name[name.length - 1] !== q) return name;
  return cleanName(name.slice(1, -1));
}

export const DEN_CLAUDE_ID = "den-claude";
const BIN = "claude";

/**
 * Where Claude Code is found, and how its version is asked: its catalog
 * entry (catalog.ts): the native installer's ~/.local/bin, the older
 * local install's ~/.claude/local, Homebrew's, /usr/local/bin, npm's.
 */
export const DEN_CLAUDE_CATALOG = builtinEntry(DEN_CLAUDE_ID)!;
export const DEN_CLAUDE_FIND: RuntimeFind = catalogFind(DEN_CLAUDE_CATALOG);
const PACKAGE = "@anthropic-ai/claude-code";
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Claude Code's permission modes (`claude --permission-mode`). */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "plan",
  "bypassPermissions",
] as const;
export const DEFAULT_PERMISSION_MODE = "default";

/**
 * Den's permission intents (AG-13) as Claude Code's modes:
 * https://code.claude.com/docs/en/iam (permission modes): `default` asks
 * on first use of each tool, `acceptEdits` accepts file edits for the
 * session, `auto` lets Claude Code's own check approve routine actions
 * and block risky ones (den#48: so a Den agent can run in the same mode
 * as peers that do; Claude Code holds a message from a session in another
 * mode), `bypassPermissions` skips every prompt.
 */
export const INTENT_MODE: Record<PermissionIntent, string> = {
  ask: "default",
  edits: "acceptEdits",
  auto: "auto",
  all: "bypassPermissions",
};

/**
 * One plain command prefix as Claude Code allow rules (the same docs,
 * Bash rules): the command alone, and the command with arguments (`*`
 * matches any run of characters). Deny rules (Den's state dir) still win:
 * Claude Code checks deny before allow.
 */
export const COMMAND_RULES = ["Bash({c})", "Bash({c} *)"];

/** How den-claude expresses permission intents (AG-13.2). */
export const DEN_CLAUDE_PERMISSIONS: RuntimePermissions = {
  modes: {
    ask: "--permission-mode default: asks before edits and commands",
    edits:
      "--permission-mode acceptEdits: file edits run without asking; commands ask",
    auto: "--permission-mode auto: Claude Code's own check runs routine actions and blocks risky ones, without asking",
    all: "--permission-mode bypassPermissions: nothing asks",
  },
  commandRules: COMMAND_RULES,
};

/**
 * ON-6, the server agent: Den's own MCP server's tools as Claude Code
 * permission rules (https://code.claude.com/docs/en/iam, MCP rules:
 * `mcp__<server>` matches every tool of that server, `mcp__<server>__*`
 * the same with a wildcard). `ask` keeps the org's immediate actions
 * (mcp.actions: they run at once, with no browser Allow) asking in the
 * terminal: Claude Code checks ask before allow. `server` is the name in
 * the --mcp-config file.
 */
export function denToolRules(server: string): {
  allow: string[];
  ask: string[];
} {
  return {
    allow: [`mcp__${server}`, `mcp__${server}__*`],
    ask: MCP_ACTIONS.map((a) => `mcp__${server}__${a}`),
  };
}

/** A command prefix's allow rules (permissions.ts checked it). */
export function allowRules(commands: readonly string[]): string[] {
  return commands.flatMap((c) =>
    COMMAND_RULES.map((r) => r.split("{c}").join(c)),
  );
}

/**
 * Claude Code's models (AG-12.3): the aliases `claude --model` takes,
 * each "latest" (the alias tracks its newest model) or pinned to one full
 * model id. Claude Code has no command that lists models, so the list
 * ships with each Den release (https://code.claude.com/docs/en/model-config:
 * aliases opus, sonnet, haiku, or a full model name). Newest first.
 */
export const DEN_CLAUDE_MODELS: readonly RuntimeModel[] = [
  {
    id: "opus",
    label: "Opus",
    versions: [
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
    ],
    latest: "claude-opus-5-5",
  },
  {
    id: "sonnet",
    label: "Sonnet",
    versions: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6"],
    latest: "claude-sonnet-5-5",
  },
  {
    id: "haiku",
    label: "Haiku",
    versions: ["claude-haiku-5-5", "claude-haiku-4-5"],
    latest: "claude-haiku-5-5",
  },
];

/**
 * The mode to launch with: the agent's intent (Start › Advanced), else the
 * persona's `permission_mode`: one of Den's intents, or one of Claude
 * Code's own modes (as before AG-13). A bad one names the key.
 */
function permissionMode(input: LaunchInput): string {
  if (input.permission) return INTENT_MODE[input.permission];
  const m = input.persona.permissionMode ?? DEFAULT_PERMISSION_MODE;
  if ((PERMISSION_INTENTS as readonly string[]).includes(m))
    return INTENT_MODE[m as PermissionIntent];
  if (!(PERMISSION_MODES as readonly string[]).includes(m))
    throw new LaunchError(
      `${input.persona.source}: permission_mode "${m.replace(/[^\x20-\x7e]/g, "?").slice(0, 40)}" must be one of ${[...new Set([...PERMISSION_INTENTS, ...PERMISSION_MODES])].join(", ")}`,
    );
  return m;
}

/**
 * den#48: the modes `--permission-mode` takes, as `<bin> --help` lists
 * them ("(choices: "acceptEdits", "auto", …)"); null when they can't be
 * read (no such line, a failed or slow run). Kept per binary (its real
 * path, size and time), so an update is asked again.
 */
export function permissionModesOf(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  let key: string;
  try {
    const real = fs.realpathSync(bin);
    const st = fs.statSync(real);
    key = `${real}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = helpModes.get(key);
  if (hit !== undefined) return hit;
  let modes: string[] | null = null;
  try {
    const r = spawnSync(bin, ["--help"], {
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: HELP_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    if (r.status === 0) modes = parseModes(r.stdout ?? "");
  } catch {
    modes = null;
  }
  helpModes.set(key, modes);
  return modes;
}

const HELP_TIMEOUT_MS = 10_000;
const helpModes = new Map<string, string[] | null>();

/** Forget the modes asked (tests). */
export function clearPermissionModesCache(): void {
  helpModes.clear();
}

/** The choices on `--help`'s --permission-mode entry, or null. */
export function parseModes(help: string): string[] | null {
  const at = help.indexOf("--permission-mode");
  if (at < 0) return null;
  // The entry runs to the next option's line.
  const rest = help.slice(at);
  const next = rest.slice(1).search(/\n\s*-/);
  const entry = next < 0 ? rest : rest.slice(0, next + 1);
  const m = /choices:\s*([^)]*)\)/.exec(entry);
  if (!m) return null;
  const modes = [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]);
  return modes.length ? modes : null;
}

/**
 * den#48: refuse auto where this Claude Code doesn't list it, naming its
 * modes. Where they can't be read, it goes ahead with a warning: Claude
 * Code itself refuses a mode it doesn't take.
 */
function modeCheck(input: LaunchInput, bin: string): string[] {
  if (permissionMode(input) !== "auto") return [];
  const modes = permissionModesOf(bin, input.env ?? process.env);
  if (modes === null)
    return [
      `⚠ couldn't read the permission modes ${bin} takes: if it has no auto mode, it will refuse to start`,
    ];
  if (!modes.includes("auto")) {
    const v = installedVersion(bin);
    throw new LaunchError(
      `${DEN_CLAUDE_ID}: this Claude Code${v ? ` (${v})` : ""} has no auto permission mode (it takes ${modes.join(", ")}). Update Claude Code, or start the agent with another mode.`,
    );
  }
  return [];
}

/** The installed version, from the install's own files; undefined when unknown. */
export function installedVersion(bin: string): string | undefined {
  let real: string;
  try {
    real = fs.realpathSync(bin);
  } catch {
    return undefined;
  }
  if (SEMVER.test(path.basename(real))) return path.basename(real);
  for (let dir = path.dirname(real), i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
      ) as { name?: unknown; version?: unknown };
      if (pkg.name === PACKAGE && typeof pkg.version === "string")
        return pkg.version;
    } catch {
      /* not here */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function detect(
  env: NodeJS.ProcessEnv = process.env,
  opts: DetectOptions = {},
): RuntimeDetect {
  const setting =
    opts.bin === undefined ? configuredRuntimeBin(DEN_CLAUDE_ID) : opts.bin;
  const found = locateRuntime(DEN_CLAUDE_ID, DEN_CLAUDE_FIND, env, setting);
  if (!found.available || !found.path)
    return {
      available: false,
      why: found.why ?? `${BIN} not found`,
      // "setting": a bad agents.runtimes.<id>.bin is the reason, not the search.
      ...(found.source ? { source: found.source } : {}),
      searched: found.searched,
    };
  const version = installedVersion(found.path);
  return {
    available: true,
    ...(version ? { version } : {}),
    path: found.path,
    ...(found.source ? { source: found.source } : {}),
    searched: found.searched,
  };
}

/**
 * Claude Code `permissions.deny` rules that keep a cooperating agent out of
 * Den's credentials (SEC-1 §6c.1): web.secret and the session host's
 * records.
 *
 * - Read: absolute paths (`//…` in Claude Code's rule syntax).
 * - Bash, in Claude Code's documented wildcard form: `*` matches any run of
 *   characters, at any position, and a rule matches a command (each part
 *   of a compound one) whole. `Bash(*<path>*)` denies any command that names
 *   the path, whatever the program (cat, head, cp, base64) and whether it is
 *   quoted ("…" or '…' still contain it). The legacy prefix form,
 *   `Bash(cat <path>:*)`, didn't match a bare `cat <path>` on Claude Code
 *   2.1.x (it asked for approval instead of denying: a dogfood finding), so
 *   it is kept only for older versions, after the wildcard rules.
 * - The readers in BASH_READERS (cat, head, tail, …) by name as well. This
 *   binds a cooperating agent only, and no list names every reader: the
 *   boundary is the server's token rules (SEC-1 §5), never these.
 * - The same path as a shell writes it from `home`: `~/…` and `$HOME/…`,
 *   `${HOME}/…`, and, when the path has a space, with each space
 *   backslash-escaped.
 */
export function stateDirDenyRules(stateDir: string, home?: string): string[] {
  const abs = path.resolve(stateDir);
  const secret = path.join(abs, "web.secret");
  const sessions = path.join(abs, "sessions");
  const spellings = (p: string): string[] => {
    const out = [p];
    if (home) {
      const h = path.resolve(home);
      if (p.startsWith(h + path.sep)) {
        const rel = p.slice(h.length + 1);
        out.push(`~/${rel}`, `$HOME/${rel}`, "${HOME}/" + rel);
      }
    }
    for (const x of [...out])
      if (x.includes(" ")) out.push(x.replace(/ /g, "\\ "));
    return [...new Set(out)];
  };
  const targets = [
    ...spellings(secret).map((p) => `${p}*`),
    ...spellings(sessions).map((p) => `${p}/*`),
  ];
  return [
    `Read(/${secret})`,
    `Read(/${sessions}/**)`,
    // Any command naming the path, whatever the program.
    ...targets.map((t) => `Bash(*${t})`),
    // The common readers by name too, should a version match a leading
    // wildcard differently. A deny list can't name every reader: the
    // boundary is the server's token rules (SEC-1 §5), not these.
    ...BASH_READERS.flatMap((r) => targets.map((t) => `Bash(${r} *${t})`)),
    `Bash(cat ${secret}:*)`,
    `Bash(cat ${sessions}/:*)`,
  ];
}

/** The readers named in the Bash deny rules (stateDirDenyRules). */
export const BASH_READERS = [
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "xxd",
  "od",
  "strings",
  "base64",
  "cp",
] as const;

/** The settings file den-claude passes with --settings. */
export function settingsPath(input: Pick<LaunchInput, "filesDir">): string {
  return path.join(input.filesDir, "settings.json");
}

/** The flags every run shares: Den's MCP only, the model, the role prompt. */
function common(input: LaunchInput): {
  argv: string[];
  files: Record<string, string>;
  warnings: string[];
} {
  const file = mcpConfigPath(input);
  const mode = permissionMode(input);
  // D41: the Stop hook asks Hub for comments waiting on this agent.
  const inboxBase = input.mcp.hub?.inboxBase;
  const inbox = inboxBase ? { base: inboxBase } : undefined;
  // den#4: the rotation hooks count this agent's compactions in its files dir.
  const hooks = input.persona.guardrails?.hooks
    ? guardrailHooks(
        GUARDRAILS_DIR,
        hookCommands(
          GUARDRAILS_DIR,
          process.execPath,
          {
            files: input.filesDir,
            after: input.rotateAfter ?? DEFAULT_ROTATE.afterCompactions,
          },
          // A Den named "den-t2" says "Den T2": a name, not an ID.
          idsInNames([product().title, input.workspace.name]),
          // ON-6: the server agent talks with the person; it hands nothing
          // back, so its messages get the plain-writing check only.
          !isServerScope(input.workspace.name),
          input.apiOnly,
          inbox,
        ),
        !!input.apiOnly,
      )
    : input.apiOnly || inbox
      ? apiOnlyHooks(
          input.apiOnly,
          GUARDRAILS_DIR,
          process.execPath,
          inbox && { ...inbox, files: input.filesDir },
        )
      : null;
  const den = input.denToolsAllowed ? denToolRules(input.mcp.name) : null;
  // HUB-1.5: Hub's tools without asking, when hub.allow_tools is on (the
  // default). Claude Code checks deny before allow: an install's deny wins.
  const hubAllow =
    input.mcp.hub?.allowTools === true
      ? [`mcp__${input.mcp.hub.name}`, `mcp__${input.mcp.hub.name}__*`]
      : [];
  const allow = [
    ...allowRules(input.allow ?? []),
    ...(den?.allow ?? []),
    ...hubAllow,
  ];
  const ask = den?.ask ?? [];
  // den#3: no claude.ai connectors unless the org lets them in.
  const noConnectors = input.claudeAiConnectors !== true;
  const settings =
    input.stateDir || hooks || allow.length || noConnectors
      ? settingsPath(input)
      : null;
  return {
    argv: [
      "--mcp-config",
      file,
      "--strict-mcp-config",
      ...(settings ? ["--settings", settings] : []),
      "--permission-mode",
      mode,
      ...(input.model ? ["--model", input.model] : []),
      "--append-system-prompt",
      rolePrompt(
        input.persona,
        input.agentId,
        input.workspace.name,
        input.mcp.name,
      ) + (input.mcp.hub ? `\n\n${HUB_PROMPT_LINE}` : ""),
    ],
    files: {
      [file]: mcpConfigJson(input.mcp),
      ...(settings
        ? {
            [settings]: `${JSON.stringify(
              {
                ...(input.stateDir || allow.length
                  ? {
                      permissions: {
                        ...(allow.length ? { allow } : {}),
                        ...(ask.length ? { ask } : {}),
                        ...(input.stateDir
                          ? {
                              deny: stateDirDenyRules(
                                input.stateDir,
                                input.env?.HOME,
                              ),
                            }
                          : {}),
                      },
                    }
                  : {}),
                ...(hooks ? { hooks } : {}),
                ...(noConnectors ? { disableClaudeAiConnectors: true } : {}),
              },
              null,
              2,
            )}\n`,
          }
        : {}),
    },
    warnings:
      mode === "bypassPermissions"
        ? [
            input.permission === "all"
              ? `⚠ agent ${input.agentId} starts with auto-approve all (bypassPermissions): Claude Code will not ask before running any tool`
              : `⚠ persona ${input.persona.id} sets permission_mode: bypassPermissions: Claude Code will not ask before running any tool`,
          ]
        : [],
  };
}

/**
 * den#3: its subagents' model, forced: every subagent (Explore and
 * general-purpose too, whatever their definition or the call says) runs
 * on it. Claude Code 2.1.257 or later; an older one takes the model as a
 * fallback only.
 */
export function subagentEnv(input: LaunchInput): Record<string, string> {
  return input.subagentModel
    ? {
        CLAUDE_CODE_SUBAGENT_MODEL: input.subagentModel,
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      }
    : {};
}

function binFor(input: LaunchInput): string {
  if (input.bin) return input.bin;
  const d = detect(input.env);
  if (!d.available || !d.path)
    throw new LaunchError(`${DEN_CLAUDE_ID}: ${d.why ?? `${BIN} not found`}`);
  return d.path;
}

/**
 * The first prompt as claude's last argument, or nothing. An agent wrote
 * the text (its handoff), so it is never allowed to start with "-": that
 * would be read as a flag. One that does gets a word in front.
 */
export function firstPromptArg(text: string | undefined): string[] {
  const t = text?.trim();
  if (!t) return [];
  return [t.startsWith("-") ? `Prompt: ${t}` : t];
}

/** D24: `--name <label>`, so peers tell Den's agents apart; or nothing. */
function nameArg(label: string | undefined): string[] {
  return label ? ["--name", label] : [];
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** D32: an agent's conversations: those before each relaunch, then its current one. */
function conversationsOf(
  rec: AgentRecord,
): { token: string; current: boolean }[] {
  const seen = new Set<string>();
  const out: { token: string; current: boolean }[] = [];
  for (const r of rec.rotations ?? [])
    if (
      r.conversation &&
      r.conversation !== rec.resumeToken &&
      !seen.has(r.conversation)
    ) {
      seen.add(r.conversation);
      out.push({ token: r.conversation, current: false });
    }
  if (rec.resumeToken) out.push({ token: rec.resumeToken, current: true });
  return out;
}

/**
 * Claude Code's transcript for conversation `token`: <token>.jsonl in any
 * project under its projects dir, or null (a bad token, none written yet).
 */
export function transcriptFile(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!token || !TOKEN_RE.test(token)) return null;
  const root = claudeProjectsDir(env);
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const p of projects) {
    const file = path.join(root, p, `${token}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export const denClaude: Runtime = {
  id: DEN_CLAUDE_ID,
  label: DEN_CLAUDE_CATALOG.name,
  vendor: DEN_CLAUDE_CATALOG.vendor,
  catalog: DEN_CLAUDE_CATALOG,
  denTools: true,
  firstPrompt: true,
  find: DEN_CLAUDE_FIND,
  models: () =>
    DEN_CLAUDE_MODELS.map((m) => ({ ...m, versions: [...m.versions] })),
  permissions: DEN_CLAUDE_PERMISSIONS,
  detect,
  launch(input): LaunchOutput {
    const bin = binFor(input);
    const id = input.resumeToken ?? randomUUID();
    const c = common(input);
    const modeWarnings = modeCheck(input, bin);
    // A relaunch from handoff (den#4): the handoff is the first prompt,
    // the last argument (firstPromptArg: never read as a flag).
    return {
      argv: [
        bin,
        "--session-id",
        id,
        ...nameArg(input.sessionLabel),
        ...c.argv,
        ...firstPromptArg(input.firstPrompt),
      ],
      env: subagentEnv(input),
      files: c.files,
      resumeToken: id,
      warnings: [...c.warnings, ...modeWarnings],
    };
  },
  resume(input) {
    if (!input.resumeToken) return null;
    const bin = binFor(input);
    const c = common(input);
    const modeWarnings = modeCheck(input, bin);
    return {
      argv: [
        bin,
        "--resume",
        input.resumeToken,
        ...nameArg(input.sessionLabel),
        ...c.argv,
      ],
      env: subagentEnv(input),
      files: c.files,
      warnings: [...c.warnings, ...modeWarnings],
    };
  },
  // Its transcript, <token>.jsonl in any project under its projects dir.
  conversationExists(token, env = process.env) {
    return transcriptFile(token, env) !== null;
  },
  // AG-17.1: its transcripts for the folder (conversations.ts).
  listSessions(scope, env = process.env) {
    try {
      return claudeConversations(scope, env);
    } catch {
      return [];
    }
  },
  // D56: its conversations started outside every project.
  listSessionsWhere(accept, env = process.env) {
    try {
      return claudeConversationsWhere(accept, env);
    } catch {
      return [];
    }
  },
  // D56 item 8: another process holding the conversation (its records).
  openPid(token, env = process.env, exclude = []) {
    return claudeOpenPid(token, env, exclude);
  },
  // AG-17.1: the folder a conversation ran in (only the ends of its file),
  // so a foreign one is refused by name.
  conversationCwd(token, env = process.env) {
    try {
      const file = transcriptFile(token, env);
      return file ? transcriptSummary(file).cwd : null;
    } catch {
      return null;
    }
  },
  // AG-18: mid-turn, from its transcript's tail (never the whole file).
  // No transcript Den can read is "can't tell" (null), never "idle": a
  // move or restart that waits for the turn's end refuses rather than cut it.
  turnBusy(token, env = process.env, opts = {}) {
    try {
      const file = transcriptFile(token, env);
      if (!file) return null;
      return transcriptBusy(file, Date.now(), undefined, opts.readMaxBytes);
    } catch {
      return null;
    }
  },
  // D45: what it was last asked, by D39's rules (never a summary or a `!`).
  lastPrompt(token, env = process.env, opts = {}) {
    try {
      return lastPrompt(
        transcriptFile(token, env),
        undefined,
        opts.readMaxBytes,
      );
    } catch {
      return null;
    }
  },
  // AG-4b, unofficial (catalog sessionName): `/rename` appends a
  // {"type":"custom-title","customTitle":…} record to the transcript; the
  // latest one, read on from the last ask (never the whole file), less one
  // pair of surrounding quotes. Null on any failure: it must never break a
  // pane.
  sessionName(rec, env = process.env) {
    try {
      const file = transcriptFile(rec.resumeToken, env);
      return file ? unquoteTitle(transcriptTitle(file)) : null;
    } catch {
      return null;
    }
  },
  // D32: its helpers, from Claude Code's subagent files beside each of its
  // conversations' transcripts (the current one and those before a
  // relaunch). Read-only; never throws.
  helpers(rec, opts = {}) {
    const out: Helper[] = [];
    for (const c of conversationsOf(rec)) {
      const file = transcriptFile(c.token, opts.env);
      if (!file) continue;
      for (const h of readClaudeHelpers(file, {
        ...opts,
        agentLive: c.current ? opts.agentLive : false,
      }))
        out.push(c.current ? h : { ...h, earlier: true });
    }
    return sortHelpers(out);
  },
  helperTranscript(rec, id, opts = {}) {
    for (const c of conversationsOf(rec)) {
      const file = transcriptFile(c.token, opts.env);
      if (!file) continue;
      const t = readClaudeHelperTranscript(file, id, {
        ...opts,
        agentLive: c.current ? opts.agentLive : false,
      });
      if (t)
        return c.current ? t : { ...t, helper: { ...t.helper, earlier: true } };
    }
    return null;
  },
  launchFailures: {
    noConversation: /no conversation found/i,
    idInUse: /already in use/i,
  },
  approvals: "terminal",
  envPassthrough: ["CLAUDE_CONFIG_DIR"],
  // Claude Code's session plumbing: the session id, its messaging socket and
  // token, the child-session marker (which turns transcripts off). An agent
  // is not part of the session that started it.
  scrubEnv: ["CLAUDECODE", "CLAUDE_CODE_*"],
  // den#3: its own launch env's subagent model (subagentEnv), past the scrub.
  subagentModel: true,
  launchEnv: ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"],
};
