/**
 * Issue 209: Verify's answer for each environment (VERIFY-SPEC section
 * 12; handoff S1, S4, S7, S8), from each module's latest result there and
 * the runs that left them.
 *
 * An environment is:
 *   failed    a check that runs there failed, errored or was blocked
 *   nothing   no check runs there, or its latest run ran nothing
 *   notrun    checks run there, but none has a result yet
 *   partly    some checks passed and the rest have no result yet
 *   ready     every check that runs there passed
 *
 * Nothing ran is never a pass. The answers come worst first, in that
 * order. Freshness against the current commit is issue 213's.
 */
import type { LatestByEnv, ResultState } from "./changes.js";
import type { VerifyModule } from "./config.js";
import {
  hasEnded,
  type EndedRunRecord,
  type RunActor,
  type RunRecord,
} from "./records.js";

export type EnvAnswer = "failed" | "nothing" | "notrun" | "partly" | "ready";

/** Worst first. */
export const ANSWER_ORDER: readonly EnvAnswer[] = [
  "failed",
  "nothing",
  "notrun",
  "partly",
  "ready",
];

export interface RunSummary {
  runId: string;
  endedAt: string;
  verdict: EndedRunRecord["verdict"];
  scope: string;
  startedBy?: RunActor;
  allowedBy?: RunActor;
  commit?: string | null;
  checks: number;
}

export interface EnvOverview {
  env: string;
  answer: EnvAnswer;
  /** Why nothing: no check runs here, or the latest run ran nothing. */
  nothing?: "none-here" | "nothing-ran";
  counts: {
    passed: number;
    failed: number;
    error: number;
    blocked: number;
    notrun: number;
    total: number;
  };
  /** The latest run on this environment. */
  run?: RunSummary;
  failures: {
    module: string;
    state: "failed" | "error";
    message?: string;
    runId?: string;
    /** Its run kept output to open. */
    report: boolean;
  }[];
  blocked: { module: string; blockedBy: string }[];
}

/** A check's state on one environment: "off" where it doesn't run. */
export type CheckState = ResultState | "none" | "off";

export interface CheckRow {
  module: string;
  layer: string;
  kind: string;
  dependsOn: string[];
  states: Record<string, CheckState>;
}

export interface ActivityItem {
  runId: string;
  env: string;
  verdict: EndedRunRecord["verdict"];
  startedAt: string;
  endedAt: string;
  startedBy?: RunActor;
  allowedBy?: RunActor;
  checks: number;
}

export interface VerifyOverview {
  project: string;
  /** The environments in the install's order (the table's columns). */
  envOrder: string[];
  /** The latest runs, newest first: who started, allowed and ended each. */
  activity: ActivityItem[];
  /** How many checks the project declares (0: the empty page). */
  modules: number;
  envs: EnvOverview[];
  checks: CheckRow[];
}

export interface OverviewInput {
  project: string;
  envs: readonly string[];
  modules: readonly VerifyModule[];
  layers: Record<string, string[]>;
  latest: LatestByEnv;
  /** The project's run records, newest first (ones still running are left out). */
  runs: readonly RunRecord[];
}

/** How many runs the activity shows. */
const ACTIVITY_RUNS = 8;

const runsHere = (m: VerifyModule, env: string) =>
  m.environments === "all" || m.environments.includes(env);

function summary(r: EndedRunRecord): RunSummary {
  return {
    runId: r.runId,
    endedAt: r.endedAt,
    verdict: r.verdict,
    scope: r.scope,
    ...(r.startedBy ? { startedBy: r.startedBy } : {}),
    ...(r.allowedBy ? { allowedBy: r.allowedBy } : {}),
    ...(r.commit !== undefined ? { commit: r.commit } : {}),
    checks: r.modules.length,
  };
}

function envOverview(i: Ended, env: string): EnvOverview {
  const here = i.modules.filter((m) => runsHere(m, env));
  const latest = i.latest[env] ?? {};
  const lastRun = i.runs.find((r) => r.env === env);
  const runById = new Map(i.runs.map((r) => [r.runId, r]));
  const counts = {
    passed: 0,
    failed: 0,
    error: 0,
    blocked: 0,
    notrun: 0,
    total: here.length,
  };
  const failures: EnvOverview["failures"] = [];
  const blocked: EnvOverview["blocked"] = [];
  for (const m of here) {
    const res = latest[m.id];
    if (!res) {
      counts.notrun++;
      continue;
    }
    counts[res.state]++;
    const rec = res.runId
      ? runById.get(res.runId)?.modules.find((x) => x.id === m.id)
      : undefined;
    if (res.state === "failed" || res.state === "error")
      failures.push({
        module: m.name,
        state: res.state,
        ...(rec?.message ? { message: rec.message } : {}),
        ...(res.runId ? { runId: res.runId } : {}),
        report: !!rec?.tail?.length,
      });
    else if (res.state === "blocked")
      blocked.push({ module: m.name, blockedBy: rec?.blockedBy ?? "" });
  }
  const bad = counts.failed + counts.error + counts.blocked;
  let answer: EnvAnswer;
  let nothing: EnvOverview["nothing"];
  if (!here.length) {
    answer = "nothing";
    nothing = "none-here";
  } else if (bad) answer = "failed";
  else if (!counts.passed) {
    if (lastRun?.verdict === "nothing ran") {
      answer = "nothing";
      nothing = "nothing-ran";
    } else answer = "notrun";
  } else answer = counts.notrun ? "partly" : "ready";
  return {
    env,
    answer,
    ...(nothing ? { nothing } : {}),
    counts,
    ...(lastRun ? { run: summary(lastRun) } : {}),
    failures,
    blocked,
  };
}

/** The project's answer on each environment, worst first. */
/** The input with ended runs only: a run still going never is the answer. */
type Ended = Omit<OverviewInput, "runs"> & { runs: readonly EndedRunRecord[] };

export function verifyOverview(input: OverviewInput): VerifyOverview {
  const i: Ended = { ...input, runs: input.runs.filter(hasEnded) };
  const envs = i.envs
    .map((e, n) => ({ o: envOverview(i, e), n }))
    .sort(
      (a, b) =>
        ANSWER_ORDER.indexOf(a.o.answer) - ANSWER_ORDER.indexOf(b.o.answer) ||
        a.n - b.n,
    )
    .map((x) => x.o);
  const checks = i.modules.map(
    (m): CheckRow => ({
      module: m.name,
      layer: m.layer,
      kind: m.kind,
      dependsOn: i.layers[m.layer] ?? [],
      states: Object.fromEntries(
        i.envs.map((e): [string, CheckState] => [
          e,
          runsHere(m, e) ? (i.latest[e]?.[m.id]?.state ?? "none") : "off",
        ]),
      ),
    }),
  );
  const activity = i.runs.slice(0, ACTIVITY_RUNS).map(
    (r): ActivityItem => ({
      runId: r.runId,
      env: r.env,
      verdict: r.verdict,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      ...(r.startedBy ? { startedBy: r.startedBy } : {}),
      ...(r.allowedBy ? { allowedBy: r.allowedBy } : {}),
      checks: r.modules.length,
    }),
  );
  return {
    project: i.project,
    envOrder: [...i.envs],
    activity,
    modules: i.modules.length,
    envs,
    checks,
  };
}
