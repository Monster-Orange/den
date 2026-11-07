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
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { configuredRuntimeBin } from "../den-config.js";
import { rolePrompt } from "./personas.js";
import { GUARDRAILS_DIR, guardrailHooks, hookCommands } from "./guardrails.js";
import { DEFAULT_ROTATE } from "./rotation.js";
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
import { claudeConversations } from "./conversations.js";

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
  "plan",
  "bypassPermissions",
] as const;
export const DEFAULT_PERMISSION_MODE = "default";

/**
 * Den's permission intents (AG-13) as Claude Code's modes:
 * https://code.claude.com/docs/en/iam (permission modes): `default` asks
 * on first use of each tool, `acceptEdits` accepts file edits for the
 * session, `bypassPermissions` skips every prompt.
 */
export const INTENT_MODE: Record<PermissionIntent, string> = {
  ask: "default",
  edits: "acceptEdits",
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
    all: "--permission-mode bypassPermissions: nothing asks",
  },
  commandRules: COMMAND_RULES,
};

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
      `${input.persona.source}: permission_mode "${m.replace(/[^\x20-\x7e]/g, "?").slice(0, 40)}" must be one of ${[...PERMISSION_INTENTS, ...PERMISSION_MODES].join(", ")}`,
    );
  return m;
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
  // den#4: the rotation hooks count this agent's compactions in its files dir.
  const hooks = input.persona.guardrails?.hooks
    ? guardrailHooks(
        GUARDRAILS_DIR,
        hookCommands(GUARDRAILS_DIR, process.execPath, {
          files: input.filesDir,
          after: input.rotateAfter ?? DEFAULT_ROTATE.afterCompactions,
        }),
      )
    : null;
  const allow = allowRules(input.allow ?? []);
  const settings =
    input.stateDir || hooks || allow.length ? settingsPath(input) : null;
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
      ),
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

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
    // A relaunch from handoff (den#4): the handoff is the first prompt,
    // the last argument (firstPromptArg: never read as a flag).
    return {
      argv: [
        bin,
        "--session-id",
        id,
        ...c.argv,
        ...firstPromptArg(input.firstPrompt),
      ],
      env: {},
      files: c.files,
      resumeToken: id,
      warnings: c.warnings,
    };
  },
  resume(input) {
    if (!input.resumeToken) return null;
    const bin = binFor(input);
    const c = common(input);
    return {
      argv: [bin, "--resume", input.resumeToken, ...c.argv],
      env: {},
      files: c.files,
      warnings: c.warnings,
    };
  },
  // Its transcript, <token>.jsonl in any project under its projects dir.
  conversationExists(token, env = process.env) {
    return transcriptFile(token, env) !== null;
  },
  // AG-17.1: its transcripts for the folder (conversations.ts).
  listSessions(cwd, env = process.env) {
    try {
      return claudeConversations(cwd, env);
    } catch {
      return [];
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
};
