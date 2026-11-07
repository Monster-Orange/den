/**
 * The usage report (den#6, ported from the agent-usage report): per agent,
 * its tokens and its outcome, joined on the agent record's resumeToken; and
 * per week, the numbers to move, diffed against the last report.
 *
 * An agent session is "attributed" when its transcripts were found and
 * counted (tokens) and its outcome is known (at least its wall-clock). The
 * share of attributed sessions is the scorecard metric: before this, no
 * agent's tokens or outcome were joined to it (~0).
 *
 * Session rotation (den#4) adds, per agent, its compactions (this
 * conversation's) and its rotations (how many times Den relaunched it from
 * a handoff); and per week, two numbers to move:
 *   - long_session_context_k: the highest average context per call (input,
 *     cache reads and cache writes, over calls) of any main session in the
 *     window, in thousands of tokens;
 *   - never_ending_reread_pct: the share of context re-reads (cache reads)
 *     that came from never-ending sessions: main sessions that compacted
 *     more often than the rotation limit (agents.rotate.after_compactions,
 *     default 3).
 *
 * Everything is read and written on this machine; nothing is sent.
 */
import type {
  AgentOutcome,
  AgentRecord,
  AgentUsage,
} from "../agents/records.js";
import { sourceFor, type UsageSource } from "./sources.js";
import type { TranscriptStats } from "./transcript.js";

export interface AgentUsageRow {
  agent: string;
  workspace: string;
  persona: string;
  runtime: string;
  /** No source reads its runtime, or it has no resume token. */
  why?: string;
  /** How many transcripts were found (its own and its subagents'). */
  transcripts: number;
  usage?: AgentUsage;
  outcome?: AgentOutcome;
  attributed: boolean;
  /** Its current conversation's compactions (den#4), when counted. */
  compactions?: number;
  /** How many times Den relaunched it from a handoff (den#4). */
  rotations: number;
}

/** The sum of transcripts' counts, as the record keeps them. */
export function sumUsage(stats: readonly TranscriptStats[]): AgentUsage {
  const u: AgentUsage = {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    compactions: 0,
  };
  for (const s of stats) {
    u.calls += s.calls;
    u.input += s.tokens.input;
    u.output += s.tokens.output;
    u.cacheRead += s.tokens.cacheRead;
    u.cacheWrite += s.tokens.cacheWrite;
    u.compactions += s.compactions;
  }
  return u;
}

/** An agent's outcome from its transcripts and its record. */
export function outcomeOf(
  rec: AgentRecord,
  stats: readonly TranscriptStats[],
): AgentOutcome {
  const own = stats.filter((s) => !s.subagent);
  const all = own.length ? own : stats;
  const firsts = all
    .map((s) => s.first)
    .filter((x): x is number => x !== undefined);
  const lasts = all
    .map((s) => s.last)
    .filter((x): x is number => x !== undefined);
  const out: AgentOutcome = {};
  if (firsts.length && lasts.length)
    out.wallClockMs = Math.max(...lasts) - Math.min(...firsts);
  else {
    const start = Date.parse(rec.startedAt);
    const end = Date.parse(
      rec.stoppedAt ?? rec.endedAt ?? rec.interruptedAt ?? "",
    );
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
      out.wallClockMs = end - start;
  }
  const pr = [...all].reverse().find((s) => s.prOpened)?.prOpened;
  if (pr) out.prOpened = pr;
  // The last test run: of the transcript that ended last and ran tests.
  const tested = all
    .filter((s) => s.testsGreen !== undefined)
    .sort((a, b) => (a.last ?? 0) - (b.last ?? 0));
  if (tested.length) out.testsGreen = tested[tested.length - 1].testsGreen;
  return out;
}

/**
 * Whether one of the transcripts' `gh pr merge` claims is a pull request
 * gh says is MERGED. A bare `gh pr merge` (the branch's PR) is checked by
 * the PR the agent opened, else in its folder.
 */
async function mergeVerified(
  rec: AgentRecord,
  stats: readonly TranscriptStats[],
  outcome: AgentOutcome,
  prState?: (
    ref: string,
    o: { repo?: string; cwd: string },
  ) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (!prState) return undefined;
  const seen = new Set<string>();
  for (const c of stats.flatMap((s) => s.prMerges)) {
    const ref = c.ref || outcome.prOpened || "";
    const key = `${c.repo ?? ""} ${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const st = await prState(ref, {
        ...(c.repo ? { repo: c.repo } : {}),
        cwd: rec.cwd,
      });
      if (st?.trim().toUpperCase() === "MERGED") return ref;
    } catch {
      // Not checked: not marked.
    }
  }
  return undefined;
}

/**
 * Each record's usage and outcome, from its runtime's transcripts (by its
 * resumeToken). `source` picks the reader (default: the one for its runtime).
 */
export async function agentUsage(
  records: readonly AgentRecord[],
  opts: {
    env?: NodeJS.ProcessEnv;
    source?: (runtime: string) => UsageSource | undefined;
    /**
     * A pull request's state (`gh pr view <ref> --json state`), run in the
     * agent's folder: "MERGED" marks the outcome merged. Without it, or on
     * any error, nothing is marked: a merge is never taken from text.
     */
    prState?: (
      ref: string,
      o: { repo?: string; cwd: string },
    ) => Promise<string | undefined>;
  } = {},
): Promise<AgentUsageRow[]> {
  const pick = opts.source ?? sourceFor;
  const rows: AgentUsageRow[] = [];
  for (const rec of records) {
    const base = {
      agent: rec.id,
      workspace: rec.workspace,
      persona: rec.persona,
      runtime: rec.runtime,
      rotations: rec.rotations?.length ?? 0,
    };
    const src = pick(rec.runtime);
    if (!src) {
      rows.push({
        ...base,
        why: `no usage source reads ${rec.runtime}`,
        transcripts: 0,
        attributed: false,
      });
      continue;
    }
    if (!rec.resumeToken) {
      rows.push({
        ...base,
        why: "no conversation id to join on",
        transcripts: 0,
        attributed: false,
      });
      continue;
    }
    const files = src.agentFiles(rec.resumeToken, opts.env);
    const stats = await Promise.all(files.map((f) => src.mine(f)));
    if (!stats.length) {
      rows.push({
        ...base,
        why: "no transcript found",
        transcripts: 0,
        attributed: false,
      });
      continue;
    }
    const usage = sumUsage(stats);
    const outcome = outcomeOf(rec, stats);
    // Confirmed once, kept: GitHub is not asked again.
    const confirmed =
      rec.outcome?.prMerged && rec.outcome.prMergeConfirmed
        ? rec.outcome.prMergeConfirmed
        : await mergeVerified(rec, stats, outcome, opts.prState);
    if (confirmed) {
      outcome.prMerged = true;
      outcome.prMergeConfirmed = confirmed;
    }
    rows.push({
      ...base,
      transcripts: files.length,
      usage,
      outcome,
      compactions: usage.compactions,
      attributed: usage.calls > 0 && outcome.wallClockMs !== undefined,
    });
  }
  return rows;
}

/** The share of agent sessions attributed, in percent (0 with none). */
export function attributedPct(rows: readonly AgentUsageRow[]): number {
  if (!rows.length) return 0;
  return Math.round(
    (100 * rows.filter((r) => r.attributed).length) / rows.length,
  );
}

/** The week's numbers (lower is better for all but calls, output, prompts). */
export interface UsageMetrics {
  calls: number;
  cache_read_B: number;
  output_M: number;
  avg_context_k_main: number;
  top15_share_pct: number;
  reread_share_pct: number;
  compactions: number;
  polls: number;
  denials: number;
  tool_error_pct: number;
  prompts: number;
  correction_pct: number;
  subagent_opus_pct: number;
  /** den#6: the share of agent sessions with attributed tokens and outcome. */
  attributed_pct?: number;
  /** den#4: the highest average context per call of a main session (k tokens). */
  long_session_context_k: number;
  /** den#4: the share of cache reads from never-ending main sessions. */
  never_ending_reread_pct: number;
  /** den#4: relaunches from a handoff, over the agents listed. */
  rotations?: number;
}

/** A main session's average context per call, in tokens. */
export function contextPerCall(s: TranscriptStats): number {
  const t = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite;
  return s.calls ? t / s.calls : 0;
}

/** Never-ending: a main session that compacted more often than the limit. */
export function isNeverEnding(s: TranscriptStats, after: number): boolean {
  return !s.subagent && s.compactions > after;
}

const round = (n: number, d = 0) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export function weeklyMetrics(
  stats: readonly TranscriptStats[],
  agents?: readonly AgentUsageRow[],
  /** The rotation limit (agents.rotate.after_compactions, default 3). */
  after = 3,
): UsageMetrics {
  const sum = (
    xs: readonly TranscriptStats[],
    f: (s: TranscriptStats) => number,
  ) => xs.reduce((a, s) => a + f(s), 0);
  const calls = sum(stats, (s) => s.calls);
  const reads = sum(stats, (s) => s.tokens.cacheRead);
  const writes = sum(stats, (s) => s.tokens.cacheWrite);
  const out = sum(stats, (s) => s.tokens.output);
  const main = stats.filter((s) => !s.subagent);
  const mainCalls = sum(main, (s) => s.calls);
  const top15 = [...main]
    .sort((a, b) => b.tokens.cacheRead - a.tokens.cacheRead)
    .slice(0, 15);
  const tools = sum(stats, (s) =>
    Object.values(s.tools).reduce((a, b) => a + b, 0),
  );
  const errors = sum(stats, (s) =>
    Object.values(s.toolErrors).reduce((a, b) => a + b, 0),
  );
  let subTotal = 0;
  let subOpus = 0;
  for (const s of stats)
    if (s.subagent)
      for (const [m, n] of Object.entries(s.models)) {
        subTotal += n;
        if (m.includes("opus")) subOpus += n;
      }
  const prompts = sum(stats, (s) => s.prompts);
  const m: UsageMetrics = {
    calls,
    cache_read_B: round(reads / 1e9, 2),
    output_M: round(out / 1e6, 1),
    avg_context_k_main: round(
      sum(main, (s) => s.tokens.cacheRead) / Math.max(1, mainCalls) / 1e3,
    ),
    top15_share_pct: round(
      (100 * sum(top15, (s) => s.tokens.cacheRead)) / Math.max(1, reads),
    ),
    // The usual price ratios: a cache read a tenth of input, a write 1.25x, output 5x.
    reread_share_pct: round(
      (100 * reads * 0.1) / Math.max(1, reads * 0.1 + writes * 1.25 + out * 5),
    ),
    compactions: sum(stats, (s) => s.compactions),
    polls: sum(stats, (s) => s.polls),
    denials: sum(stats, (s) => s.denials),
    tool_error_pct: round((100 * errors) / Math.max(1, tools), 1),
    prompts,
    correction_pct: round(
      (100 * sum(stats, (s) => s.corrections)) / Math.max(1, prompts),
      1,
    ),
    subagent_opus_pct: round((100 * subOpus) / Math.max(1, subTotal)),
    long_session_context_k: round(
      Math.max(0, ...main.map(contextPerCall)) / 1e3,
    ),
    never_ending_reread_pct: round(
      (100 *
        sum(
          main.filter((s) => isNeverEnding(s, after)),
          (s) => s.tokens.cacheRead,
        )) /
        Math.max(1, reads),
    ),
  };
  if (agents) {
    m.attributed_pct = attributedPct(agents);
    m.rotations = agents.reduce((a, r) => a + r.rotations, 0);
  }
  return m;
}

/** Higher is better for these; context only for calls, output and prompts. */
const BETTER_HIGH = new Set(["attributed_pct"]);
const CONTEXT = new Set(["calls", "output_M", "prompts", "rotations"]);

/** The report as markdown: this week, last week, and the change. */
export function renderReport(
  m: UsageMetrics,
  date: string,
  prev?: { date: string; metrics: Partial<UsageMetrics> },
): string {
  const lines = [`# Agent usage, week to ${date}`, ""];
  if (prev) lines.push(`Compared with ${prev.date}.`, "");
  lines.push(
    "| Metric | This week | Last | Change |",
    "| --- | --- | --- | --- |",
  );
  for (const [k, v] of Object.entries(m) as [keyof UsageMetrics, number][]) {
    const p = prev?.metrics[k];
    let change = "";
    if (typeof p === "number" && p) {
      const d = round(v - p, 2);
      const mark =
        !d || CONTEXT.has(k)
          ? ""
          : (BETTER_HIGH.has(k) ? d > 0 : d < 0)
            ? "better"
            : "worse";
      change = `${d > 0 ? "+" : ""}${d} ${mark}`.trim();
    }
    lines.push(`| ${k} | ${v} | ${p ?? ""} | ${change} |`);
  }
  lines.push(
    "",
    "Read from this machine's transcripts; none of this was sent anywhere.",
  );
  return lines.join("\n") + "\n";
}
