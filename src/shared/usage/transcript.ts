/**
 * One Claude Code transcript, read for what it cost and what it came to
 * (den#6). Ported from the agent-usage miner: per file, inside a time
 * window, it counts tokens by kind (once per message id), model calls by
 * model, tool calls and tool errors, permission denials, polling loops and
 * their sleeps, compactions, people's prompts and the ones that read as
 * corrections, and interrupts. It also finds the outcome: a pull request
 * opened or merged, whether the last test run passed, and the wall-clock
 * from the first message to the last.
 *
 * It reads the file on this machine and keeps counts only: never a
 * prompt's text, a command's output or a file's contents, and it sends
 * nothing anywhere (this module imports no network code).
 */
import * as fs from "fs";
import * as readline from "readline";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TranscriptStats {
  file: string;
  /** Under a session's subagents/ directory. */
  subagent: boolean;
  /** Its title (custom, agent name or the runtime's own), when it has one. */
  title?: string;
  /** First and last message inside the window (ms since the epoch). */
  first?: number;
  last?: number;
  /** Model calls: assistant messages, once per message id. */
  calls: number;
  tokens: TokenCounts;
  models: Record<string, number>;
  tools: Record<string, number>;
  toolErrors: Record<string, number>;
  denials: number;
  polls: number;
  sleepSeconds: number;
  compactions: number;
  prompts: number;
  corrections: number;
  interrupts: number;
  agentSpawns: number;
  /** Time between messages less than 5 minutes apart (seconds). */
  activeSeconds: number;
  /** The last pull request URL it opened. */
  prOpened?: string;
  /**
   * `gh pr merge` commands that exited 0: claims, which `usage` checks
   * with `gh pr view` before it marks the pull request merged.
   */
  prMerges: PrMergeClaim[];
  /** The last test run's result; undefined when it ran none. */
  testsGreen?: boolean;
}

/** A `gh pr merge` that ran: its PR (number, URL, or "" for the branch's). */
export interface PrMergeClaim {
  ref: string;
  repo?: string;
}

/** Words of one simple command, with quotes removed (no expansion). */
function words(part: string): string[] {
  const out: string[] = [];
  for (const m of part.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * The merge a shell command runs: one of its parts (split on `&&`, `||`,
 * `;`, `|`, newlines), after `VAR=value` words, `env` or `command`, starts
 * with `gh pr merge`, and is not asking for help. Null otherwise:
 * `echo gh pr merge 1`, a grep for it, or a comment are not merges.
 */
export function ghPrMergeRef(cmd: string): PrMergeClaim | null {
  for (const part of cmd.split(/&&|\|\||;|\||\n/)) {
    const w = words(part.trim());
    let i = 0;
    while (
      i < w.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) ||
        w[i] === "env" ||
        w[i] === "command")
    )
      i++;
    if (w[i] !== "gh" || w[i + 1] !== "pr" || w[i + 2] !== "merge") continue;
    const rest = w.slice(i + 3);
    if (rest.includes("--help") || rest.includes("-h")) return null;
    const claim: PrMergeClaim = { ref: "" };
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      if (a === "-R" || a === "--repo") {
        if (rest[j + 1]) claim.repo = rest[++j];
      } else if (a.startsWith("--repo=")) claim.repo = a.slice(7);
      else if (
        !claim.ref &&
        /^(\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)$/.test(a)
      )
        claim.ref = a;
    }
    return claim;
  }
  return null;
}

/** A correction, as the miner reads one (emphatic ones; polite ones slip by). */
const CORRECTION =
  /\b(wtf|fuck|shit|damn|not what i (said|asked)|that('s| is) wrong|you (missed|forgot|broke)|again\??$|still (not|broken|failing|404)|where (is|the)|why (did|didn't|are|is)|i told you|stop|no,|nope|ugh|boo)\b/i;
/** A polling loop in a shell command. */
const POLL = /\bsleep\s+\d|for i in \$\(seq|until |while .*sleep|watch /;
/** A test run in a shell command. */
const TEST_RUN =
  /\b(jest|vitest|pytest|playwright test|go test|cargo test|(npm|pnpm|yarn)( run)? test\w*|make (test|check|gate)\w*)\b/;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
/** Entries with nothing to count (checked on the line's head, before JSON). */
const SKIP = [
  "api-",
  "file-history",
  "queue-",
  "bridge",
  "last-prompt",
  "mode",
  "permission-mode",
  "tools-used",
];

function ts(s: unknown): number | undefined {
  if (typeof s !== "string") return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: unknown }).type === "text"
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .join("\n");
  return "";
}

const bump = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

/** The line's `"type"`, read from its head without parsing it. */
function headType(line: string): string | null {
  const m = /^\{\s*"type"\s*:\s*"([^"]+)"/.exec(line.slice(0, 120));
  return m ? m[1] : null;
}

/**
 * Mine `file`. `since`: only messages at or after it count (a session that
 * runs for weeks contributes its recent calls). Lines it can't parse are
 * skipped.
 */
export async function mineTranscript(
  file: string,
  opts: { since?: number } = {},
): Promise<TranscriptStats> {
  const r: TranscriptStats = {
    file,
    subagent: /[\\/]subagents[\\/]/.test(file),
    calls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    models: {},
    tools: {},
    toolErrors: {},
    denials: 0,
    polls: 0,
    sleepSeconds: 0,
    compactions: 0,
    prompts: 0,
    corrections: 0,
    interrupts: 0,
    agentSpawns: 0,
    activeSeconds: 0,
    prMerges: [],
  };
  const seen = new Set<string>();
  const toolNames = new Map<string, string>();
  /** Tool-use ids of the commands whose result decides an outcome. */
  const tests = new Map<string, number>();
  const merges = new Map<string, PrMergeClaim>();
  const creates = new Set<string>();
  let order = 0;
  let lastTest: { at: number; green: boolean } | undefined;
  let lastAt: number | undefined;
  const since = opts.since ?? -Infinity;
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const head = headType(line);
    if (head && SKIP.some((p) => head.startsWith(p))) continue;
    if (head === "pr-link") {
      const m = PR_URL.exec(line);
      if (m) r.prOpened = m[0];
      continue;
    }
    let d: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      d = v as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = d.type;
    if (
      type === "ai-title" ||
      type === "custom-title" ||
      type === "agent-name"
    ) {
      const t = d.customTitle ?? d.agentName ?? d.aiTitle;
      if (typeof t === "string" && t) r.title = t.slice(0, 200);
      continue;
    }
    const at = ts(d.timestamp);
    if (at !== undefined && at < since) continue;
    if (at !== undefined) {
      r.first ??= at;
      r.last = at;
      if (lastAt !== undefined && at - lastAt > 0 && at - lastAt < 300_000)
        r.activeSeconds += (at - lastAt) / 1000;
      lastAt = at;
    }
    if (type === "system") {
      if (String(d.subtype ?? "").includes("compact")) r.compactions++;
      continue;
    }
    const m = (d.message ?? {}) as Record<string, unknown>;
    if (type === "assistant") {
      const id = typeof m.id === "string" ? m.id : undefined;
      if (id && !seen.has(id)) {
        seen.add(id);
        r.calls++;
        const u = (m.usage ?? {}) as Record<string, unknown>;
        const n = (k: string) =>
          typeof u[k] === "number" ? (u[k] as number) : 0;
        r.tokens.input += n("input_tokens");
        r.tokens.output += n("output_tokens");
        r.tokens.cacheRead += n("cache_read_input_tokens");
        r.tokens.cacheWrite += n("cache_creation_input_tokens");
        bump(r.models, typeof m.model === "string" ? m.model : "?");
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!c || typeof c !== "object") continue;
        const tu = c as Record<string, unknown>;
        if (tu.type !== "tool_use") continue;
        const name = typeof tu.name === "string" ? tu.name : "?";
        const useId = typeof tu.id === "string" ? tu.id : "";
        toolNames.set(useId, name);
        bump(r.tools, name);
        if (name === "Agent" || name === "Task") r.agentSpawns++;
        if (name !== "Bash") continue;
        const cmd = String(
          ((tu.input ?? {}) as Record<string, unknown>).command ?? "",
        );
        if (POLL.test(cmd)) r.polls++;
        for (const s of cmd.matchAll(/\bsleep\s+(\d+)/g))
          r.sleepSeconds += Number(s[1]);
        if (TEST_RUN.test(cmd)) tests.set(useId, order++);
        const merge = ghPrMergeRef(cmd);
        if (merge) merges.set(useId, merge);
        if (/\bgh pr create\b/.test(cmd)) creates.add(useId);
      }
      continue;
    }
    if (type !== "user") continue;
    const content = m.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        const tr = c as Record<string, unknown>;
        if (tr.type !== "tool_result") continue;
        const useId = typeof tr.tool_use_id === "string" ? tr.tool_use_id : "";
        const err = tr.is_error === true;
        if (err) {
          bump(r.toolErrors, toolNames.get(useId) ?? "?");
          const low = textOf(tr.content).toLowerCase();
          if (/doesn't want to proceed|denied|rejected|blocked/.test(low))
            r.denials++;
        }
        const t = tests.get(useId);
        if (t !== undefined && (!lastTest || t >= lastTest.at))
          lastTest = { at: t, green: !err };
        const merge = merges.get(useId);
        if (merge && !err) r.prMerges.push(merge);
        if (creates.has(useId) && !err) {
          const u = PR_URL.exec(textOf(tr.content));
          if (u) r.prOpened = u[0];
        }
      }
    }
    if (d.isMeta || d.isSidechain || r.subagent) continue;
    // D39: a compaction's summary is no prompt (nor a correction).
    if (d.isCompactSummary || d.isVisibleInTranscriptOnly) continue;
    const text = textOf(content).trim();
    if (text.includes("[Request interrupted")) {
      r.interrupts++;
      continue;
    }
    if (!text || text.startsWith("<") || text.startsWith("Caveat:")) continue;
    r.prompts++;
    if (CORRECTION.test(text.slice(0, 600))) r.corrections++;
  }
  if (lastTest) r.testsGreen = lastTest.green;
  return r;
}
