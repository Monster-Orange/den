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
 * - Each launch picks a fresh conversation id (--session-id); resume
 *   continues it with --resume <id>, in the same cwd, with the same MCP.
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
 * detect runs nothing: `claude` on PATH, and its version read from where it
 * is installed (a native install's versions/<version>, or the npm package's
 * package.json).
 */
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { rolePrompt } from "./personas.js";
import {
  LaunchError,
  mcpConfigJson,
  mcpConfigPath,
  whichBin,
  type LaunchInput,
  type LaunchOutput,
  type Runtime,
  type RuntimeDetect,
} from "./runtime.js";

export const DEN_CLAUDE_ID = "den-claude";
const BIN = "claude";
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

/** The persona's permission mode, checked; a bad one names the key. */
function permissionMode(input: LaunchInput): string {
  const m = input.persona.permissionMode ?? DEFAULT_PERMISSION_MODE;
  if (!(PERMISSION_MODES as readonly string[]).includes(m))
    throw new LaunchError(
      `${input.persona.source}: permission_mode "${m.replace(/[^\x20-\x7e]/g, "?").slice(0, 40)}" must be one of ${PERMISSION_MODES.join(", ")}`,
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

function detect(env: NodeJS.ProcessEnv = process.env): RuntimeDetect {
  const bin = whichBin(BIN, env);
  if (!bin) return { available: false, why: `${BIN} is not on PATH` };
  const version = installedVersion(bin);
  return version ? { available: true, version } : { available: true };
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
  const settings = input.stateDir ? settingsPath(input) : null;
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
      ...(settings && input.stateDir
        ? {
            [settings]: `${JSON.stringify(
              {
                permissions: {
                  deny: stateDirDenyRules(input.stateDir, input.env?.HOME),
                },
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
            `⚠ persona ${input.persona.id} sets permission_mode: bypassPermissions: Claude Code will not ask before running any tool`,
          ]
        : [],
  };
}

function binFor(input: LaunchInput): string {
  const bin = whichBin(BIN, input.env);
  if (!bin) throw new LaunchError(`${DEN_CLAUDE_ID}: ${BIN} is not on PATH`);
  return bin;
}

export const denClaude: Runtime = {
  id: DEN_CLAUDE_ID,
  detect,
  launch(input): LaunchOutput {
    const bin = binFor(input);
    const id = input.resumeToken ?? randomUUID();
    const c = common(input);
    return {
      argv: [bin, "--session-id", id, ...c.argv],
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
  approvals: "terminal",
  envPassthrough: ["CLAUDE_CONFIG_DIR"],
  // Claude Code's session plumbing: the session id, its messaging socket and
  // token, the child-session marker (which turns transcripts off). An agent
  // is not part of the session that started it.
  scrubEnv: ["CLAUDECODE", "CLAUDE_CODE_*"],
};
