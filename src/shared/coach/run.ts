/**
 * Issue 52: one Coach run, as `<cli> coach run` and the Coach tab's Run now
 * both do it: this Den's own agents (their records), over the window,
 * saved under the state dir. Read-only; calls no model.
 */
import { listRecords, type AgentRecord } from "../agents/records.js";
import { readAgentsConfig } from "../den-config.js";
import type { UsageSource } from "../usage/sources.js";
import { coachBreakdown, type CoachReport } from "./breakdown.js";
import { coachFindings } from "./findings.js";
import type { OrgAgent } from "./lead-skips.js";
import type { CoachSettings } from "./settings.js";
import {
  judgeSpentSince,
  recordJudgeSpend,
  writeCoachReport,
} from "./store.js";
import { judgeReport, type ModelRun } from "./judge.js";

export interface CoachRunOptions {
  stateDir: string;
  settings: CoachSettings;
  now?: number;
  records?: (stateDir: string) => AgentRecord[];
  source?: (runtime: string) => UsageSource | undefined;
  /** agents.rotate.after_compactions (default: the org config's, else 3). */
  rotateAfter?: () => number;
  /** How many agents are read so far (the Coach tab's Running state). */
  progress?: (done: number, total: number) => void;
  /** Slice T-d's model call (default: the runtime's CLI). */
  judgeRun?: ModelRun;
  /**
   * Issue 113: an agent's persona role (lead, orchestrator, …), so the run
   * knows who leads which project. Without it, skipped_lead isn't found.
   */
  roleOf?: (rec: AgentRecord) => string | undefined;
}

/**
 * Issue 113: this Den's agents as the Coach sees who leads what. A stopped
 * agent is still a name a message went to, but leads nothing.
 */
export function orgOf(
  records: readonly AgentRecord[],
  roleOf: (rec: AgentRecord) => string | undefined,
): OrgAgent[] {
  return records.map((r) => {
    let role: string | undefined;
    if (!r.stoppedAt)
      try {
        role = roleOf(r);
      } catch {
        role = undefined;
      }
    return {
      id: r.id,
      workspace: r.workspace,
      ...(r.displayName ? { name: r.displayName } : {}),
      ...(role ? { role } : {}),
    };
  });
}

/** agents.rotate.after_compactions, as `usage` reads it; 3 on error. */
function rotateLimit(): number {
  try {
    return readAgentsConfig().rotate?.afterCompactions ?? 3;
  } catch {
    return 3;
  }
}

/**
 * Keep only the findings' samples: the asks, messages and prompts each
 * row's stats hold are read for findings, then dropped, so no saved
 * report or route holds more text than the samples.
 */
export function stripEvidence(report: CoachReport): void {
  for (const a of report.agents) if (a.asks) delete a.asks.stats;
}

/** Run the Coach and save its report; the report. */
export async function runCoach(o: CoachRunOptions): Promise<CoachReport> {
  const records = (o.records ?? listRecords)(o.stateDir);
  const report = await coachBreakdown(records, {
    stateDir: o.stateDir,
    now: o.now ?? Date.now(),
    days: o.settings.window_days,
    ...(o.source ? { source: o.source } : {}),
    after: (o.rotateAfter ?? rotateLimit)(),
    sentenceWords: o.settings.findings.sentence_words,
    ...(o.progress ? { progress: o.progress } : {}),
  });
  report.findings = coachFindings(
    report,
    o.settings.findings,
    o.roleOf ? orgOf(records, o.roleOf) : undefined,
  );
  const now = Date.parse(report.ranAt);
  const judged = await judgeReport(report, o.settings.judge, o.judgeRun, {
    spentToday: judgeSpentSince(o.stateDir, now - 86_400_000),
  });
  if (judged.tokens > 0) recordJudgeSpend(o.stateDir, now, judged.tokens);
  stripEvidence(report);
  writeCoachReport(o.stateDir, report, o.settings.keep_runs);
  return report;
}
