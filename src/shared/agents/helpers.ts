/**
 * D32: the helpers an agent starts inside its own session (Claude Code's
 * Agent and Workflow subagents). They belong to the agent's session, not
 * to Den: Den shows them, read-only, and never stops or steers them.
 *
 * Runtime-neutral shapes; a runtime that can read its helpers implements
 * Runtime.helpers / Runtime.helperTranscript (den-claude: claude-helpers.ts).
 */

/** running: working now. idle: no activity for a while, not known done. */
export type HelperStatus = "running" | "idle" | "done" | "failed" | "stopped";

export interface Helper {
  /** The runtime's id for it (Claude Code: agent-<id>'s <id>). */
  id: string;
  /** What the agent asked it to do, in a few words. Missing: show the id. */
  description?: string;
  /** Its kind (general-purpose, Explore, a plugin's agent, …). */
  type?: string;
  model?: string;
  /** The worktree it works in, when it has its own. */
  branch?: string;
  worktree?: string;
  /** Started in the background (the agent kept going meanwhile). */
  background?: boolean;
  /** 1: started by the agent; 2+: started by another helper (parentId). */
  depth: number;
  parentId?: string;
  /** When it ran inside a workflow. */
  workflow?: { runId: string; name?: string; phase?: string; label?: string };
  /** It ran in one of the agent's earlier conversations (before a relaunch). */
  earlier?: true;
  status: HelperStatus;
  /** How the status was told, for "why does it say that". */
  statusFrom: string;
  /** Epoch ms. */
  startedAt?: number;
  lastActivityAt?: number;
  durationMs?: number;
  /** The tool it used last, when known. */
  lastTool?: string;
}

/** One line of a helper's transcript, tool calls summarized. */
export interface HelperTranscriptItem {
  at?: number;
  kind: "prompt" | "text" | "tool" | "result" | "note";
  /** For a tool call: its name. */
  tool?: string;
  text: string;
  error?: boolean;
}

export interface HelperTranscript {
  helper: Helper;
  items: HelperTranscriptItem[];
  /** Earlier lines left out (only the last ones are shown). */
  omitted: number;
}

/** Read-only, and why: shown wherever helpers are. */
export const HELPERS_READ_ONLY_NOTE =
  "Helpers run inside this agent's own session, so Den shows them but can't stop or steer them. To change what they do, tell the agent.";

/** D32 settings (agents.helpers.*), permissive defaults. */
export interface HelperSettings {
  /** No activity for this long and not known done: idle, not running. */
  activeMinutes: number;
  /** Done, failed and stopped helpers fold away after this long. */
  collapseDoneMinutes: number;
}

export const HELPER_DEFAULTS: HelperSettings = {
  activeMinutes: 10,
  collapseDoneMinutes: 30,
};

/** What a runtime's helpers hooks are given. */
export interface HelperReadOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  settings?: Partial<HelperSettings>;
  /** Whether the agent itself is running now. */
  agentLive?: boolean;
  /** A transcript's last lines (default 500). */
  limit?: number;
}

/** Running helpers first, then the newest. */
export function sortHelpers(hs: Helper[]): Helper[] {
  const live = (h: Helper) => (h.status === "running" ? 0 : 1);
  return [...hs].sort(
    (a, b) =>
      live(a) - live(b) ||
      (b.startedAt ?? b.lastActivityAt ?? 0) -
        (a.startedAt ?? a.lastActivityAt ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/** {running, total}: what a badge shows. */
export function helperCounts(hs: readonly Helper[]): {
  running: number;
  total: number;
} {
  return {
    running: hs.filter((h) => h.status === "running").length,
    total: hs.length,
  };
}
