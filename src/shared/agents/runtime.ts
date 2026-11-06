/**
 * The runtime contract (strategy kind `runtime`, AG spec §4): which CLI an
 * agent runs. A runtime turns a persona and a workspace into argv, env and
 * files (a per-agent MCP config), and says how to resume. It knows nothing
 * about sessions, tmux or the browser; Den joins it to a session backend.
 *
 * Built-ins register here exactly as a runtime plugin would (AG-8a):
 * den-claude and generic.
 */
import * as fs from "fs";
import * as path from "path";
import {
  getStrategy,
  registerStrategy,
  strategyIds,
  type StrategyEntry,
} from "../strategies/registry.js";
import type { Persona } from "./personas.js";

export const RUNTIME_KIND = "runtime";

/** The runtime an agent gets when neither it nor its persona names one. */
export const DEFAULT_RUNTIME_ID = "den-claude";

export interface RuntimeDetect {
  available: boolean;
  version?: string;
  /** Why it is unavailable. */
  why?: string;
}

/** The MCP server an agent acts through: Den's, scoped to its workspace. */
export interface AgentMcp {
  /** The server's name in an MCP config (the distribution's CLI). */
  name: string;
  /** `<cli> mcp --workspace <ws> --actor agent:<id> [--grant <ws>…]`. */
  command: string[];
  /** The server's own environment (PATH pinned), never a secret. */
  env: Record<string, string>;
  /** The workspace it is pinned to. */
  scope: string;
}

export interface LaunchInput {
  persona: Persona;
  workspace: { name: string; dir: string };
  agentId: string;
  /** Where the agent works: the workspace's dir (a worktree from AG-9a). */
  worktree: string;
  model?: string;
  mcp: AgentMcp;
  /** A directory of this agent's own (0700) for the files a runtime writes. */
  filesDir: string;
  /** The environment the agent will run with (for finding its CLI on PATH). */
  env: NodeJS.ProcessEnv;
}

export interface LaunchOutput {
  argv: string[];
  /** Added to the session's environment. */
  env: Record<string, string>;
  /** Absolute path (inside filesDir) → content; Den writes each 0600. */
  files?: Record<string, string>;
  /** What resume needs to continue this run (kept in the agent record). */
  resumeToken?: string;
}

export interface ResumeInput extends LaunchInput {
  resumeToken?: string;
}

export interface Runtime {
  /** "den-claude", "generic". */
  id: string;
  detect(env?: NodeJS.ProcessEnv): RuntimeDetect;
  /** Throws LaunchError when this persona or this machine can't run it. */
  launch(input: LaunchInput): LaunchOutput;
  /** A new run that continues the last one; null when there is nothing to resume. */
  resume?(input: ResumeInput): Omit<LaunchOutput, "resumeToken"> | null;
  /** Where permission prompts surface (Q-AG-2). */
  approvals?: "terminal" | "hook";
}

/** A runtime cannot launch this agent here: a refusal, not a crash. */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

/** Register a runtime as strategy kind `runtime` (doctor lists it). */
export function registerRuntime(rt: Runtime): void {
  const entry: StrategyEntry<typeof RUNTIME_KIND, Runtime> = {
    id: rt.id,
    kind: RUNTIME_KIND,
    detect(env) {
      const d = rt.detect(env);
      if (!d.available)
        return { available: false, reason: d.why ?? "unavailable" };
      return d.version
        ? { available: true, reason: `version ${d.version}` }
        : { available: true };
    },
    capabilities: rt,
  };
  registerStrategy(entry);
}

export function getRuntime(id: string): Runtime | undefined {
  return getStrategy<typeof RUNTIME_KIND, Runtime>(RUNTIME_KIND, id)
    ?.capabilities;
}

export function runtimeIds(): string[] {
  return strategyIds(RUNTIME_KIND);
}

/** The first executable `bin` on `env.PATH`, or null. Runs nothing. */
export function whichBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, bin);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * A standard MCP config (`mcpServers`, the shape most MCP clients read)
 * with Den's server as the only entry.
 */
export function mcpConfigJson(mcp: AgentMcp): string {
  const [command, ...args] = mcp.command;
  return (
    JSON.stringify(
      {
        mcpServers: {
          [mcp.name]: {
            command,
            args,
            ...(Object.keys(mcp.env).length ? { env: mcp.env } : {}),
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** Where a runtime puts an agent's MCP config. */
export function mcpConfigPath(input: Pick<LaunchInput, "filesDir">): string {
  return path.join(input.filesDir, "mcp.json");
}
