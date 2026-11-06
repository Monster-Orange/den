/**
 * den-claude: Den's built-in runtime for Claude Code (AG spec §4).
 *
 *   claude --session-id <uuid> --mcp-config <filesDir>/mcp.json
 *          --strict-mcp-config [--model <m>] --append-system-prompt <role prompt>
 *
 * - The MCP config (0600) holds one server, Den's, scoped to the agent's
 *   workspace; --strict-mcp-config keeps any other MCP server out, so the
 *   agent acts only through Den (§1).
 * - The role prompt is appended to Claude Code's own system prompt.
 * - Each launch picks a fresh conversation id (--session-id); resume
 *   continues it with --resume <id>, in the same cwd, with the same MCP.
 * - Permission prompts stay in the terminal (approvals: "terminal"); the
 *   Notification hook comes with agent states (AG-6a).
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

/** The flags every run shares: Den's MCP only, the model, the role prompt. */
function common(input: LaunchInput): {
  argv: string[];
  files: Record<string, string>;
} {
  const file = mcpConfigPath(input);
  return {
    argv: [
      "--mcp-config",
      file,
      "--strict-mcp-config",
      ...(input.model ? ["--model", input.model] : []),
      "--append-system-prompt",
      rolePrompt(
        input.persona,
        input.agentId,
        input.workspace.name,
        input.mcp.name,
      ),
    ],
    files: { [file]: mcpConfigJson(input.mcp) },
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
    const id = randomUUID();
    const c = common(input);
    return {
      argv: [bin, "--session-id", id, ...c.argv],
      env: {},
      files: c.files,
      resumeToken: id,
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
    };
  },
  approvals: "terminal",
};
