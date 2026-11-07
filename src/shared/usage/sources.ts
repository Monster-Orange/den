/**
 * Usage sources (den#6): plugin kind `usage`, strategy kind `usage`. A
 * source reads one runtime's own transcripts on this machine: which files
 * belong to an agent (by the agent record's resumeToken, the runtime's
 * conversation id), and every file touched in a window (the weekly
 * report). Den's built-in reads Claude Code's (den-claude); a plugin adds
 * one for another runtime the same way, by registering here.
 *
 * A source reads locally and never sends what it reads anywhere.
 */
import * as fs from "fs";
import * as path from "path";
import {
  getStrategy,
  registerStrategy,
  strategyIds,
  type StrategyEntry,
} from "../strategies/registry.js";
import { mineTranscript, type TranscriptStats } from "./transcript.js";

export const USAGE_KIND = "usage";

export interface UsageSource {
  id: string;
  /** The runtimes whose agents it reads (den-claude). */
  runtimes: readonly string[];
  /** Where it reads (for doctor and the report's header). */
  root(env?: NodeJS.ProcessEnv): string;
  /** An agent's transcripts: its conversation's file, then its subagents'. */
  agentFiles(resumeToken: string, env?: NodeJS.ProcessEnv): string[];
  /** Every transcript changed since `since` (ms since the epoch). */
  files(since: number, env?: NodeJS.ProcessEnv): string[];
  mine(file: string, opts?: { since?: number }): Promise<TranscriptStats>;
}

/** A conversation id as Claude Code names its files: never a path. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

import { claudeProjectsDir } from "./paths.js";
export { claudeProjectsDir };

function dirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(p, e.name));
  } catch {
    return [];
  }
}

function jsonl(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(p, e.name));
  } catch {
    return [];
  }
}

/** Claude Code: <projects>/<cwd slug>/<session id>.jsonl, and <session id>/subagents/*.jsonl. */
export const claudeCodeSource: UsageSource = {
  id: "claude-code",
  runtimes: ["den-claude"],
  root: claudeProjectsDir,
  agentFiles(token, env) {
    if (!TOKEN_RE.test(token)) return [];
    const out: string[] = [];
    for (const proj of dirs(claudeProjectsDir(env))) {
      const f = path.join(proj, `${token}.jsonl`);
      if (fs.existsSync(f)) out.push(f);
      out.push(...jsonl(path.join(proj, token, "subagents")));
    }
    return out;
  },
  files(since, env) {
    const out: string[] = [];
    const walk = (p: string, depth: number) => {
      for (const f of jsonl(p)) {
        try {
          if (fs.statSync(f).mtimeMs >= since) out.push(f);
        } catch {
          /* gone */
        }
      }
      if (depth < 3) for (const d of dirs(p)) walk(d, depth + 1);
    };
    walk(claudeProjectsDir(env), 0);
    return out.sort();
  },
  mine: (file, opts) => mineTranscript(file, opts),
};

/** Register a usage source (Den's built-in, or a `usage` plugin's). */
export function registerUsageSource(src: UsageSource): void {
  const entry: StrategyEntry<typeof USAGE_KIND, UsageSource> = {
    id: src.id,
    kind: USAGE_KIND,
    detect(env) {
      return fs.existsSync(src.root(env))
        ? { available: true }
        : { available: false, reason: `no transcripts at ${src.root(env)}` };
    },
    capabilities: src,
  };
  registerStrategy(entry);
}

export function usageSources(): UsageSource[] {
  return strategyIds(USAGE_KIND)
    .map(
      (id) =>
        getStrategy<typeof USAGE_KIND, UsageSource>(USAGE_KIND, id)
          ?.capabilities,
    )
    .filter((s): s is UsageSource => Boolean(s));
}

/** The source that reads `runtime`'s agents, if any. */
export function sourceFor(runtime: string): UsageSource | undefined {
  return usageSources().find((s) => s.runtimes.includes(runtime));
}

registerUsageSource(claudeCodeSource);
