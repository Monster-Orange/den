/**
 * Issue 52, Coach slice T-a (TUNE-1): the per-agent breakdown, read-only.
 *
 * For each of this Den's own agents (its records: a session Den didn't
 * launch or bring in is never read), every conversation it had in the
 * window (conversation-history.ts), mined by its runtime's usage source
 * from that window's start. The numbers use the weekly report's metric
 * names (usage/report.ts weeklyMetrics), so history carries over, and
 * each count has a `_per_day` form: two runs whose windows differ are
 * compared per day only. Every run names its window.
 *
 * It keeps counts only: never a file name, a title, a prompt or a
 * command. The one exception is slice T-c's evidence (asks.ts): an
 * agent's own asks and messages, each cut to 300 characters with secrets
 * taken out, so a person can check a finding. It reads files on this machine and sends nothing anywhere. A
 * counted run calls no model, and its cost says so.
 */
import * as fs from "fs";
import type { AgentRecord } from "../agents/records.js";
import { agentFilesDir, readConversations } from "../agents/records.js";
import { readRotation } from "../agents/rotation.js";
import { weeklyMetrics, type UsageMetrics } from "../usage/report.js";
import { sourceFor, type UsageSource } from "../usage/sources.js";
import type { TranscriptStats } from "../usage/transcript.js";
import type { CoachFinding } from "./findings.js";
import { askMetrics, type AskMetrics, type AskStats } from "./asks.js";
import type { ConversationWhy } from "../agents/conversation-history.js";
import { mapLimited } from "../map-limited.js";

const DAY_MS = 86_400_000;

export interface CoachWindow {
  /** ISO 8601. */
  from: string;
  to: string;
  days: number;
}

/** The `days` up to `now`. */
export function coachWindow(now: number, days: number): CoachWindow {
  return {
    from: new Date(now - days * DAY_MS).toISOString(),
    to: new Date(now).toISOString(),
    days,
  };
}

/** The counts that also get a `_per_day` form. */
export const PER_DAY_METRICS = [
  "calls",
  "cache_read_B",
  "output_M",
  "compactions",
  "polls",
  "denials",
  "prompts",
  "rotations",
] as const;

export type PerDay = Partial<
  Record<`${(typeof PER_DAY_METRICS)[number]}_per_day`, number>
>;

export interface CoachAgentRow {
  agent: string;
  workspace: string;
  persona: string;
  runtime: string;
  /** Why it has no numbers (no source reads its runtime, nothing in the window). */
  why?: string;
  conversations: {
    /** Its conversations that were current at some point in the window. */
    inWindow: number;
    /** Every conversation it has had. */
    total: number;
    /** The window's, by why each began. */
    byWhy: Partial<Record<ConversationWhy, number>>;
    /**
     * The window's, newest first, at most 50, for the Coach tab's row
     * detail: when each began and ended, and why. No conversation ids.
     */
    list?: CoachConversation[];
  };
  /** Transcripts read (its conversations' own and their subagents'). */
  transcripts: number;
  metrics?: UsageMetrics;
  perDay?: PerDay;
  /** Model calls by model, for main and subagent calls. */
  models?: { main: Record<string, number>; subagent: Record<string, number> };
  /**
   * Its current conversation's compactions and its rotation limit (0:
   * never rotates), from Den's own rotation count; unset when Den has no
   * count for that conversation.
   */
  current?: { compactions: number; after: number };
  /** The size on disk of the window's transcripts, in bytes. */
  transcriptBytes?: number;
  /**
   * Slice T-c: its asks to a person and its messages to other agents, when
   * its usage source reads them (asks.ts).
   */
  asks?: { metrics: AskMetrics; stats?: AskStats };
}

export interface CoachReport {
  version: 1;
  ranAt: string;
  window: CoachWindow;
  agents: CoachAgentRow[];
  totals: UsageMetrics;
  totalsPerDay: PerDay;
  /** What the run itself cost: a counted run calls no model. */
  cost: { model: string | null; tokens: number };
  /**
   * Slice T-d: what judging did, when it had items: its model, the tokens
   * it spent, the items picked and skipped, and why any were skipped.
   */
  judge?: {
    model: string;
    tokens: number;
    items: number;
    skipped: number;
    why?: string[];
  };
  /** Slice T-b: the counted findings, all of them (findings.ts). */
  findings?: CoachFinding[];
}

/** A file's size, or 0 when it can't be read. */
function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function perDayOf(m: UsageMetrics, days: number): PerDay {
  const out: PerDay = {};
  for (const k of PER_DAY_METRICS) {
    const v = m[k];
    if (typeof v === "number") out[`${k}_per_day`] = round2(v / days);
  }
  return out;
}

function modelsOf(stats: readonly TranscriptStats[]) {
  const main: Record<string, number> = {};
  const subagent: Record<string, number> = {};
  for (const s of stats) {
    const to = s.subagent ? subagent : main;
    for (const [m, n] of Object.entries(s.models)) to[m] = (to[m] ?? 0) + n;
  }
  return { main, subagent };
}

export interface CoachOptions {
  stateDir: string;
  /** ms since the epoch (default: now). */
  now?: number;
  /** The window's length in days (agents.coach.window_days). */
  days: number;
  /** Picks the reader for a runtime (default: the registered one). */
  source?: (runtime: string) => UsageSource | undefined;
  env?: NodeJS.ProcessEnv;
  /** The rotation limit (agents.rotate.after_compactions, default 3). */
  after?: number;
  /** R12's longest sentence, in words (agents.coach.findings.sentence_words). */
  sentenceWords?: number;
  /** Told how many agents are read: 0 of n first, then after each. */
  progress?: (done: number, total: number) => void;
}

/** One conversation in the window, for the row detail (no id). */
export interface CoachConversation {
  from: string;
  to?: string;
  why: ConversationWhy;
  backfilled?: true;
}

const MAX_LISTED = 50;

/** Transcripts read at once: many agents, each with many, would run out of file handles. */
const MINE_AT_ONCE = 8;

export { mapLimited };

/** The breakdown for `records` over the window ending now. */
export async function coachBreakdown(
  records: readonly AgentRecord[],
  o: CoachOptions,
): Promise<CoachReport> {
  const now = o.now ?? Date.now();
  const window = coachWindow(now, o.days);
  const since = now - o.days * DAY_MS;
  const pick = o.source ?? sourceFor;
  const agents: CoachAgentRow[] = [];
  const all: TranscriptStats[] = [];
  let rotations = 0;
  o.progress?.(0, records.length);
  for (const [i, rec] of records.entries()) {
    if (i > 0) o.progress?.(i, records.length);
    const list = readConversations(o.stateDir, rec);
    // Current at some point in the window: not ended before it began.
    const inWindow = list.filter((c) => !c.to || Date.parse(c.to) >= since);
    const byWhy: CoachAgentRow["conversations"]["byWhy"] = {};
    for (const c of inWindow) byWhy[c.why] = (byWhy[c.why] ?? 0) + 1;
    const row: CoachAgentRow = {
      agent: rec.id,
      workspace: rec.workspace,
      persona: rec.persona,
      runtime: rec.runtime,
      conversations: {
        inWindow: inWindow.length,
        total: list.length,
        byWhy,
        list: inWindow
          .slice(-MAX_LISTED)
          .reverse()
          .map((c) => ({
            from: c.from,
            ...(c.to ? { to: c.to } : {}),
            why: c.why,
            ...(c.backfilled ? { backfilled: true as const } : {}),
          })),
      },
      transcripts: 0,
    };
    agents.push(row);
    if (!inWindow.length) {
      row.why = "no conversation in the window";
      continue;
    }
    const src = pick(rec.runtime);
    if (!src) {
      row.why = `no usage source reads ${rec.runtime}`;
      continue;
    }
    const files = [
      ...new Set(
        [...new Set(inWindow.map((c) => c.id))].flatMap((id) =>
          src.agentFiles(id, o.env),
        ),
      ),
    ];
    const stats = (
      await mapLimited(files, MINE_AT_ONCE, (f) => src.mine(f, { since }))
    ).filter((s) => s.calls > 0 || s.prompts > 0);
    if (!stats.length) {
      row.why = "no conversation in the window";
      continue;
    }
    const agentRotations = (rec.rotations ?? []).filter(
      (r) => Date.parse(r.at) >= since,
    ).length;
    rotations += agentRotations;
    const metrics = {
      ...weeklyMetrics(stats, undefined, o.after),
      rotations: agentRotations,
    };
    row.transcripts = stats.length;
    row.transcriptBytes = files.reduce((n, f) => n + sizeOf(f), 0);
    const rot = readRotation(agentFilesDir(o.stateDir, rec.id));
    if (rot && rot.conversation && rot.conversation === rec.resumeToken)
      row.current = { compactions: rot.compactions, after: rot.after };
    row.metrics = metrics;
    row.perDay = perDayOf(metrics, o.days);
    row.models = modelsOf(stats);
    if (src.asks) {
      const read = src.asks;
      const asks = await mapLimited(
        files.filter((f) => !/[\\/]subagents[\\/]/.test(f)),
        MINE_AT_ONCE,
        (f) => read(f, { since, maxWords: o.sentenceWords }),
      );
      const merged: AskStats = {
        asks: asks.flatMap((a) => a.asks),
        sends: asks.flatMap((a) => a.sends),
        received: asks.flatMap((a) => a.received),
        prompts: asks.flatMap((a) => a.prompts ?? []),
      };
      row.asks = { metrics: askMetrics(asks, o.days), stats: merged };
    }
    all.push(...stats);
  }
  if (records.length) o.progress?.(records.length, records.length);
  const totals = { ...weeklyMetrics(all, undefined, o.after), rotations };
  return {
    version: 1,
    ranAt: new Date(now).toISOString(),
    window,
    agents,
    totals,
    totalsPerDay: perDayOf(totals, o.days),
    cost: { model: null, tokens: 0 },
  };
}
