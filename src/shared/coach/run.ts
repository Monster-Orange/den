/**
 * Issue 52: one Coach run, as `<cli> coach run` and the Coach tab's Run now
 * both do it: this Den's own agents (their records), over the window,
 * saved under the state dir. Read-only; calls no model.
 */
import { listRecords, type AgentRecord } from "../agents/records.js";
import { readAgentsConfig } from "../den-config.js";
import type { UsageSource } from "../usage/sources.js";
import { coachBreakdown, type CoachReport } from "./breakdown.js";
import type { CoachSettings } from "./settings.js";
import { writeCoachReport } from "./store.js";

export interface CoachRunOptions {
  stateDir: string;
  settings: CoachSettings;
  now?: number;
  records?: (stateDir: string) => AgentRecord[];
  source?: (runtime: string) => UsageSource | undefined;
  /** agents.rotate.after_compactions (default: the org config's, else 3). */
  rotateAfter?: () => number;
}

/** agents.rotate.after_compactions, as `usage` reads it; 3 on error. */
function rotateLimit(): number {
  try {
    return readAgentsConfig().rotate?.afterCompactions ?? 3;
  } catch {
    return 3;
  }
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
  });
  writeCoachReport(o.stateDir, report, o.settings.keep_runs);
  return report;
}
