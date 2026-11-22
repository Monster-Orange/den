/**
 * `<cli> coach` (issue 52, TUNE-1): the Coach's read-only run, by hand.
 *
 *   run [--json]    read this Den's own agents' conversations in the window
 *                   (agents.coach.window_days, default 7), save the report
 *                   (<state dir>/coach/latest.json and coach/runs/), and
 *                   print it
 *   show [--json]   print the last saved report
 *
 * Off by default: `run` refuses until agents.coach.enabled is true. It
 * reads files on this machine, keeps counts only, calls no model and sends
 * nothing anywhere.
 */
import type { AgentRecord } from "../../shared/agents/records.js";
import type { CoachReport } from "../../shared/coach/breakdown.js";
import {
  COACH_DEFAULTS,
  type CoachSettings,
} from "../../shared/coach/settings.js";
import { runCoach } from "../../shared/coach/run.js";
import { readCoachReport } from "../../shared/coach/store.js";
import { readAgentsConfig } from "../../shared/den-config.js";
import { getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import type { UsageSource } from "../../shared/usage/sources.js";

export const COACH_HELP = {
  usage: "coach <run|show> [--json]",
  lines: [
    "The Coach: how this Den's own agents spend tokens and time, per agent,",
    "over every conversation each had in the window. Read on this machine,",
    "counts only; nothing is sent anywhere. Off until agents.coach.enabled.",
    "",
    "{cli} coach run [--json]",
    "    read the last agents.coach.window_days days (default 7), save the",
    "    report under <state dir>/coach/, and print it",
    "{cli} coach show [--json]",
    "    print the last saved report",
  ],
};

export interface CoachDeps {
  stateDir?: () => string;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  settings?: () => CoachSettings;
  records?: (stateDir: string) => AgentRecord[];
  source?: (runtime: string) => UsageSource | undefined;
  rotateAfter?: () => number;
}

class CoachUsageError extends Error {}

const DAY_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/** The report in short lines, for a person. */
export function renderCoachReport(r: CoachReport): string[] {
  const from = DAY_FMT.format(new Date(r.window.from));
  const to = DAY_FMT.format(new Date(r.window.to));
  const days = `${r.window.days} day${r.window.days === 1 ? "" : "s"}`;
  const lines = [
    `Coach, ${from} to ${to} (${days}). Run at ${r.ranAt}.`,
    r.cost.model
      ? `This run cost ${r.cost.tokens} tokens on ${r.cost.model}.`
      : "This run called no model: it only counts.",
    `All agents: ${r.totals.calls} calls (${r.totalsPerDay.calls_per_day ?? 0} a day), ` +
      `${r.totals.compactions} compactions, ${r.totals.rotations ?? 0} rotations.`,
    "",
  ];
  for (const a of r.agents) {
    const who = `${a.agent} (${a.workspace})`;
    if (!a.metrics) {
      lines.push(`${who}: ${a.why ?? "no numbers"}.`);
      continue;
    }
    const m = a.metrics;
    lines.push(
      `${who}: ${m.calls} calls (${a.perDay?.calls_per_day ?? 0} a day), ` +
        `${a.conversations.inWindow} conversation${a.conversations.inWindow === 1 ? "" : "s"}, ` +
        `${m.compactions} compactions, ${m.polls} polls, ${m.denials} denials, ` +
        `${m.tool_error_pct}% tool errors, ${m.correction_pct}% corrections, ` +
        `${m.subagent_opus_pct}% of subagent calls on Opus.`,
    );
  }
  return lines;
}

export async function cmdCoach(
  args: string[],
  deps: CoachDeps = {},
): Promise<number> {
  const stateDir = (deps.stateDir ?? getStateDir)();
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const sub = rest[0] ?? "show";
  try {
    if (rest.length > 1) throw new CoachUsageError(`unexpected "${rest[1]}"`);
    if (sub === "show") {
      const r = readCoachReport(stateDir);
      if (!r) {
        err(`No Coach report yet. Run ${product().cli} coach run first.`);
        return 1;
      }
      if (json) out(JSON.stringify(r, null, 2));
      else for (const l of renderCoachReport(r)) out(l);
      return 0;
    }
    if (sub === "run") {
      const settings = (
        deps.settings ??
        (() => readAgentsConfig().coach ?? { ...COACH_DEFAULTS })
      )();
      if (!settings.enabled) {
        err(
          `The Coach is off. Turn it on with agents.coach.enabled: true in ${product().configFile}.`,
        );
        return 1;
      }
      const r = await runCoach({
        stateDir,
        settings,
        now: (deps.now ?? Date.now)(),
        ...(deps.records ? { records: deps.records } : {}),
        ...(deps.source ? { source: deps.source } : {}),
        ...(deps.rotateAfter ? { rotateAfter: deps.rotateAfter } : {}),
      });
      if (json) out(JSON.stringify(r, null, 2));
      else for (const l of renderCoachReport(r)) out(l);
      return 0;
    }
    throw new CoachUsageError(`unknown coach command "${sub}"`);
  } catch (e) {
    if (e instanceof CoachUsageError) {
      err(`✗ ${e.message}`);
      err(`Usage: ${product().cli} ${COACH_HELP.usage}`);
      return 2;
    }
    throw e;
  }
}
