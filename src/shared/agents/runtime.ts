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
  unregisterStrategy,
  type StrategyEntry,
} from "../strategies/registry.js";
import type { CatalogEntry } from "./catalog.js";
import type { Persona } from "./personas.js";
import type { BinSource, RuntimeFind } from "./runtime-search.js";

export const RUNTIME_KIND = "runtime";

/** The runtime an agent gets when neither it nor its persona names one. */
export const DEFAULT_RUNTIME_ID = "den-claude";

export interface RuntimeDetect {
  available: boolean;
  version?: string;
  /** Why it is unavailable. */
  why?: string;
  /** The CLI it runs, when found (AG-0.1). */
  path?: string;
  /** Where that path came from. */
  source?: BinSource;
  /** The directories searched, in order (names only, never values). */
  searched?: string[];
}

export interface DetectOptions {
  /**
   * `agents.runtimes.<id>.bin` as configured in user.yml (undefined:
   * read it there; null: none), or a BinSetting (runtime-search.ts) that
   * says where it was set (the workspace's, or global).
   */
  bin?: unknown;
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
  /**
   * Den's own state dir (web.secret, the session records). A runtime adds
   * deny rules for it to the agent's own permission config (SEC-1 §6c.1):
   * that binds a cooperating agent only, since an agent runs as the same OS
   * user and could read the files itself.
   */
  stateDir?: string;
  /**
   * The caller's environment, for finding the runtime's CLI on PATH. The
   * agent does not get it: it starts from an allowlist (sessions/env.ts),
   * plus envPassthrough and LaunchOutput.env.
   */
  env: NodeJS.ProcessEnv;
  /**
   * A conversation id to start under instead of a new one: a resume of a
   * run that was never prompted starts afresh with the id it had.
   */
  resumeToken?: string;
  /** The CLI detect found (a setting, the login PATH, …); else searched again. */
  bin?: string;
  /**
   * Session rotation (den#4): the compactions after which this agent's
   * session rotates (0: never). Den's hooks count them. Default 3.
   */
  rotateAfter?: number;
  /**
   * The new conversation's first prompt (a relaunch from handoff.md).
   * Only a runtime with `firstPrompt: true` is given one.
   */
  firstPrompt?: string;
}

export interface LaunchOutput {
  argv: string[];
  /** Added to the session's environment (after the allowlist). */
  env: Record<string, string>;
  /** Absolute path (inside filesDir) → content; Den writes each 0600. */
  files?: Record<string, string>;
  /** What resume needs to continue this run (kept in the agent record). */
  resumeToken?: string;
  /** One line each, printed when the agent starts (never secret). */
  warnings?: string[];
}

export type ResumeInput = LaunchInput;

export interface Runtime {
  /** "den-claude", "generic". */
  id: string;
  /** Its name for people ("Claude Code"), in the Start agent form. */
  label?: string;
  /** Who makes it ("Anthropic"): a catalog runtime's vendor (AG-0.5). */
  vendor?: string;
  /** Its catalog entry (catalog.ts), when it is one. */
  catalog?: CatalogEntry;
  /**
   * Whether it runs with Den's tools (its MCP config and guards). false:
   * it runs as its own CLI, tagged "Den tools: coming" (AG-0.5).
   */
  denTools?: boolean;
  /**
   * How its CLI is found and its version asked (AG-0.1): the search's
   * binary names and install directories, per runtime, so a catalog can
   * supply them (AG-0.5). None: nothing to find (generic).
   */
  find?: RuntimeFind;
  detect(env?: NodeJS.ProcessEnv, opts?: DetectOptions): RuntimeDetect;
  /**
   * It can start a conversation with a first prompt (LaunchInput
   * firstPrompt): Relaunch from handoff needs it (den#4).
   */
  firstPrompt?: boolean;
  /** Throws LaunchError when this persona or this machine can't run it. */
  launch(input: LaunchInput): LaunchOutput;
  /** A new run that continues the last one; null when there is nothing to resume. */
  resume?(input: ResumeInput): Omit<LaunchOutput, "resumeToken"> | null;
  /**
   * Whether the runtime has a conversation for `token` on this machine
   * (den-claude: its transcript file). Only ever a fast path: false may
   * just mean it isn't written yet.
   */
  conversationExists?(token: string, env?: NodeJS.ProcessEnv): boolean;
  /**
   * What the runtime prints when it exits at once (0.4.8): `noConversation`
   * when a resume finds nothing to continue, `idInUse` when a new
   * conversation's id is taken. Den then tries the other way, once.
   */
  launchFailures?: { noConversation?: RegExp; idInUse?: RegExp };
  /** Where permission prompts surface (Q-AG-2). */
  approvals?: "terminal" | "hook";
  /**
   * Caller variables this runtime needs beyond the allowlist (PATH, HOME,
   * USER, LOGNAME, SHELL, TERM, COLORTERM, LANG, LC_*, TZ, TMPDIR). Named
   * one by one; Claude Code's session plumbing never passes.
   */
  envPassthrough?: readonly string[];
  /**
   * Names this runtime owns that must never reach a session Den starts
   * (an exact name, or a prefix ending in `*`): den-claude's CLAUDECODE and
   * CLAUDE_CODE_*. Den removes them after building any session's env,
   * whatever put them there (sessions/env.ts).
   */
  scrubEnv: readonly string[];
}

/** A runtime cannot launch this agent here: a refusal, not a crash. */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

/** Remove a runtime (a configured catalog entry that is gone). */
export function unregisterRuntime(id: string): void {
  unregisterStrategy(RUNTIME_KIND, id);
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

/** Every registered runtime's scrubEnv: applied to every session Den starts. */
export function allScrubEnv(): string[] {
  return [
    ...new Set(runtimeIds().flatMap((id) => getRuntime(id)?.scrubEnv ?? [])),
  ];
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
