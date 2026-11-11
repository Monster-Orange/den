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
  /**
   * Deprecated (0.4.29): accepted and ignored. The row no longer folds
   * finished helpers by time; a person clears them (D34).
   */
  collapseDoneMinutes: number;
  /** D34: at most this many active helpers under the selected agent's row. */
  rowMax: number;
}

export const HELPER_DEFAULTS: HelperSettings = {
  activeMinutes: 10,
  collapseDoneMinutes: 30,
  rowMax: 4,
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

/**
 * Running helpers first, then the newest; a helper's own helpers right
 * under it, in the same order (a tree, depth first). One whose parent
 * isn't in the list sits at the top level.
 */
export function sortHelpers(hs: Helper[]): Helper[] {
  const ids = new Set(hs.map((h) => h.id));
  const kids = new Map<string, Helper[]>();
  const roots: Helper[] = [];
  for (const h of hs)
    if (h.parentId && h.parentId !== h.id && ids.has(h.parentId))
      kids.set(h.parentId, [...(kids.get(h.parentId) ?? []), h]);
    else roots.push(h);
  // Running counts for the whole branch: a done helper with a running
  // helper under it sorts with the running ones (0.4.28-dev.1's gate).
  const busy = new Map<string, boolean>();
  const runs = (h: Helper, path = new Set<string>()): boolean => {
    const known = busy.get(h.id);
    if (known !== undefined) return known;
    if (path.has(h.id)) return h.status === "running";
    path.add(h.id);
    const r =
      h.status === "running" ||
      (kids.get(h.id) ?? []).some((k) => runs(k, path));
    path.delete(h.id);
    busy.set(h.id, r);
    return r;
  };
  const live = (h: Helper) => (runs(h) ? 0 : 1);
  const order = (a: Helper, b: Helper) =>
    live(a) - live(b) ||
    (b.startedAt ?? b.lastActivityAt ?? 0) -
      (a.startedAt ?? a.lastActivityAt ?? 0) ||
    a.id.localeCompare(b.id);
  const out: Helper[] = [];
  const seen = new Set<string>();
  const walk = (h: Helper) => {
    if (seen.has(h.id)) return;
    seen.add(h.id);
    out.push(h);
    for (const k of (kids.get(h.id) ?? []).sort(order)) walk(k);
  };
  for (const r of roots.sort(order)) walk(r);
  // A loop of parents (never from Claude Code): still listed, flat.
  for (const h of [...hs].sort(order)) if (!seen.has(h.id)) out.push(h);
  return out;
}

/**
 * At most `n` of `list`, in its order: the running ones first to stay,
 * then the rest (a running helper is never cut for a done one).
 */
export function capHelpers(list: readonly Helper[], n: number): Helper[] {
  const kept = new Set(
    [
      ...list.filter((h) => h.status === "running"),
      ...list.filter((h) => h.status !== "running"),
    ].slice(0, Math.max(0, n)),
  );
  return list.filter((h) => kept.has(h));
}

/**
 * How far each helper of `list` (in sortHelpers' order) is indented: one
 * step under a parent shown above it, none when its parent isn't in the
 * list. The page's twin is agent-helpers.js shownDepths.
 */
export function shownDepths(list: readonly Helper[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const h of list)
    at.set(
      h.id,
      h.parentId && at.has(h.parentId) ? at.get(h.parentId)! + 1 : 0,
    );
  return at;
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
