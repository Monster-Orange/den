/**
 * Issue 208: running a plan (VERIFY-SPEC section 5), in its order.
 *
 *   - built-in smoke sends GET to each of the repo's health URLs for the
 *     environment: up when it answers below 400
 *   - a `cmd` module runs its command in its repo, with DEN_ENV,
 *     DEN_RUN_ID and DEN_RESULTS_DIR; exit 0 passes
 *   - a layer whose smoke failed blocks the rest of that layer ("blocked
 *     by smoke"); a layer that depends on one that failed is blocked by
 *     it ("blocked by api"). Blocked is never a pass
 *
 * The verdict and exit code (the one table): passed 0, failed 1 (any
 * module failed, errored or was blocked), nothing ran 3. A plan with
 * nothing to run runs nothing, writes nothing, and hands back the latest
 * answer, so a page keeps showing it.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { NOTHING_RAN_EXIT } from "../run-outcome.js";
import {
  readLatest,
  writeLatest,
  type LatestResult,
  type ResultState,
} from "./changes.js";
import type { VerifyModule } from "./config.js";
import type { VerifyPlan } from "./plan.js";
import { writeRunRecord, type ModuleRecord, type RunActor } from "./records.js";
import {
  guardProbe,
  methodRules,
  type MethodRules,
  type RequestLog,
} from "./guard.js";
import {
  readSarifFindings,
  scanVerdict,
  type Finding,
  type SeverityCounts,
} from "./history.js";
import { SEVERITIES, stricter, type Severity } from "./settings.js";

export type ModuleState = ResultState;
export type Verdict = "passed" | "failed" | "nothing ran";

export const VERDICT_EXIT: Readonly<Record<Verdict, number>> = {
  passed: 0,
  failed: 1,
  "nothing ran": NOTHING_RAN_EXIT,
};

export interface ModuleRun {
  id: string;
  name: string;
  repo: string;
  layer: string;
  kind: string;
  mark: string;
  state: ModuleState;
  /** Blocked: "smoke" (its layer's), or the layer it depends on. */
  blockedBy?: string;
  exitCode?: number | null;
  /** The first failure, in one line. */
  message?: string;
  /** Issue 212: each attempt's state, when it ran more than once. */
  attempts?: ModuleState[];
  /** Issue 212: a scan's findings (its SARIF), and the threshold it met. */
  findings?: { counts: SeverityCounts; failOn: Severity; list: Finding[] };
  ms: number;
  /** Issue 214: on a read-only run, every request smoke sent or the guard blocked. */
  requests?: RequestLog[];
}

export interface RunResult {
  ok: true;
  runId: string;
  project: string;
  env: string;
  scope: string;
  verdict: Verdict;
  exitCode: number;
  reason?: VerifyPlan["reason"];
  modules: ModuleRun[];
  /** Each module's latest result on this environment, after this run. */
  latest: Record<string, LatestResult>;
}

export interface CmdContext {
  env: string;
  runId: string;
  resultsDir: string;
}

export interface RunDeps {
  stateDir: string;
  head: (repoPath: string) => string | null;
  runCmd: (
    m: VerifyModule,
    ctx: CmdContext,
  ) => Promise<{ exitCode: number | null; lines?: string[] }>;
  /** GET `url` (or `method`): its HTTP status (it throws when nothing answers). */
  probe: (url: string, method?: string) => Promise<number>;
  /** Issue 214: the method rule for a read-only run (production); every request goes through it. */
  methods?: MethodRules;
  /** Built-in smoke's method: GET. A seam for the guard's tests only. */
  smokeMethod?: string;
  runId?: () => string;
  now?: () => Date;
  /** Issue 209: who started the run and who allowed it, for its record. */
  by?: { startedBy?: RunActor; allowedBy?: RunActor };
  /** Issue 214: the schedule this run is for. */
  schedule?: string;
  /** Issue 212: `verify.run.retries` (0): a failed module runs again. */
  retries?: number;
  /** Issue 212: `verify.security.fail_on` (high): a scan's threshold. */
  failOn?: Severity;
}

/** The verdict of a set of module states (VERIFY-SPEC section 5). */
export function verdictOf(states: readonly ModuleState[]): Verdict {
  if (states.some((s) => s !== "passed")) return "failed";
  return states.length ? "passed" : "nothing ran";
}

/** Each layer's dependencies, direct or through others. */
function dependsOn(layers: Record<string, string[]>, l: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => {
    for (const d of layers[x] ?? [])
      if (!out.includes(d)) {
        out.push(d);
        walk(d);
      }
  };
  walk(l);
  return out;
}

async function smoke(
  m: VerifyModule,
  env: string,
  probe: RunDeps["probe"],
  method = "GET",
): Promise<Pick<ModuleRun, "state" | "message">> {
  for (const url of m.healthUrls[env] ?? []) {
    let status: number;
    try {
      status = await probe(url, method);
    } catch (e) {
      return {
        state: "failed",
        message: `${method} ${url}: ${(e as Error).message}`,
      };
    }
    if (status <= 0 || status >= 400)
      return {
        state: "failed",
        message: `${method} ${url} returned ${status}`,
      };
  }
  return { state: "passed" };
}

const newRunId = () =>
  `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;

export async function runPlan(
  plan: VerifyPlan,
  d: RunDeps,
): Promise<RunResult> {
  const runId = (d.runId ?? newRunId)();
  const now = d.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const keep = (
    r: RunResult,
    tails: Map<string, string[]>,
    commit?: string | null,
  ): RunResult => {
    writeRunRecord(d.stateDir, {
      runId,
      project: r.project,
      env: r.env,
      scope: r.scope,
      verdict: r.verdict,
      exitCode: r.exitCode,
      ...(r.reason ? { reason: r.reason } : {}),
      startedAt,
      endedAt: now().toISOString(),
      ...(d.by?.startedBy ? { startedBy: d.by.startedBy } : {}),
      ...(d.by?.allowedBy ? { allowedBy: d.by.allowedBy } : {}),
      ...(plan.trigger ? { trigger: plan.trigger } : {}),
      ...(d.schedule ? { schedule: d.schedule } : {}),
      ...(commit !== undefined ? { commit } : {}),
      modules: r.modules.map((m): ModuleRecord => {
        const tail = tails.get(m.id);
        return tail?.length ? { ...m, tail } : m;
      }),
    });
    return r;
  };
  const base = {
    ok: true as const,
    runId,
    project: plan.project,
    env: plan.env,
    scope: plan.scope,
  };
  if (plan.nothingToRun)
    return keep(
      {
        ...base,
        verdict: "nothing ran",
        exitCode: NOTHING_RAN_EXIT,
        ...(plan.reason ? { reason: plan.reason } : {}),
        modules: [],
        latest: readLatest(d.stateDir, plan.project)[plan.env] ?? {},
      },
      new Map(),
    );
  const tails = new Map<string, string[]>();
  const smokeFailed = new Set<string>();
  const badLayers = new Set<string>();
  const out: ModuleRun[] = [];
  for (const m of plan.modules) {
    const started = Date.now();
    const row = {
      id: m.id,
      name: m.name,
      repo: m.repo,
      layer: m.layer,
      kind: m.kind,
      mark: m.mark,
    };
    const blocker =
      m.kind !== "smoke" && smokeFailed.has(m.layer)
        ? "smoke"
        : dependsOn(plan.layers, m.layer).find((l) => badLayers.has(l));
    let r: Omit<ModuleRun, keyof typeof row | "ms">;
    if (blocker) r = { state: "blocked", blockedBy: blocker };
    else if (m.adapter === "smoke") {
      // Issue 214: a read-only run's requests go through the guard, logged.
      const rules =
        d.methods ?? (plan.readOnly ? methodRules(undefined, plan.env) : null);
      if (rules) {
        const log: RequestLog[] = [];
        r = {
          ...(await smoke(
            m,
            plan.env,
            guardProbe(d.probe, rules, log),
            d.smokeMethod,
          )),
          requests: log,
        };
      } else r = await smoke(m, plan.env, d.probe, d.smokeMethod);
    } else {
      const resultsDir = path.join(
        d.stateDir,
        "verify",
        plan.project,
        "runs",
        runId,
        m.id.replace(/[^A-Za-z0-9._-]+/g, "_"),
      );
      const tries = 1 + Math.max(0, d.retries ?? 0);
      const attempts: ModuleState[] = [];
      for (;;) {
        r = await runOnce(m, plan.env, runId, resultsDir, d, tails);
        attempts.push(r.state);
        if (r.state === "passed" || attempts.length >= tries) break;
      }
      if (attempts.length > 1) r = { ...r, attempts };
    }
    if (r.state !== "passed") {
      badLayers.add(m.layer);
      if (m.kind === "smoke") smokeFailed.add(m.layer);
    }
    out.push({ ...row, ...r, ms: Date.now() - started });
  }
  const at = now().toISOString();
  const byModule = new Map(plan.modules.map((m) => [m.id, m]));
  const heads = new Map<string, string | null>();
  const headOf = (p: string) => {
    if (!heads.has(p)) heads.set(p, d.head(p));
    return heads.get(p) ?? null;
  };
  writeLatest(
    d.stateDir,
    plan.project,
    plan.env,
    Object.fromEntries(
      out.map((r) => [
        r.id,
        {
          commit: headOf(byModule.get(r.id)!.repoPath),
          state: r.state,
          at,
          runId,
        },
      ]),
    ),
  );
  const verdict = verdictOf(out.map((r) => r.state));
  const first = plan.modules[0];
  return keep(
    {
      ...base,
      verdict,
      exitCode: VERDICT_EXIT[verdict],
      modules: out,
      latest: readLatest(d.stateDir, plan.project)[plan.env] ?? {},
    },
    tails,
    first ? headOf(first.repoPath) : null,
  );
}

/** The last lines a command's output keeps for its result. */
const KEEP_LINES = 20;

type Outcome = Omit<
  ModuleRun,
  "id" | "name" | "repo" | "layer" | "kind" | "mark" | "ms"
>;

/**
 * One attempt of a command module. A scan (kind security) that wrote
 * SARIF to DEN_RESULTS_DIR is decided by its findings against the
 * threshold (the org's, or the module's stricter one), not its exit code;
 * one that wrote none, or any other module, by its exit code.
 */
async function runOnce(
  m: VerifyModule,
  env: string,
  runId: string,
  resultsDir: string,
  d: RunDeps,
  tails: Map<string, string[]>,
): Promise<Outcome> {
  try {
    fs.rmSync(resultsDir, { recursive: true, force: true });
    fs.mkdirSync(resultsDir, { recursive: true });
    const x = await d.runCmd(m, { env, runId, resultsDir });
    const last = x.lines?.filter((l) => l.trim()).at(-1);
    if (x.lines?.length) tails.set(m.id, x.lines.slice(-KEEP_LINES));
    if (x.exitCode === null)
      return { state: "error", exitCode: null, message: last ?? "stopped" };
    const scan = m.kind === "security" ? readSarifFindings(resultsDir) : null;
    if (scan) {
      const failOn = stricter(d.failOn ?? "high", m.failOn);
      const v = scanVerdict(scan.counts, failOn);
      const first = scan.findings.find(
        (f) => SEVERITIES.indexOf(f.severity) <= SEVERITIES.indexOf(failOn),
      );
      return {
        state: v.state,
        exitCode: x.exitCode,
        findings: { counts: scan.counts, failOn, list: scan.findings },
        ...(v.state === "failed" && first
          ? {
              message: `${v.atOrAbove} at or above ${failOn}, first ${first.rule} (${first.severity})`,
            }
          : {}),
      };
    }
    return x.exitCode === 0
      ? { state: "passed", exitCode: 0 }
      : {
          state: "failed",
          exitCode: x.exitCode,
          ...(last ? { message: last } : {}),
        };
  } catch (e) {
    return { state: "error", message: (e as Error).message };
  }
}

/** Runs a `cmd` module's command in its repo (DEN_* in its environment). */
export function spawnCmd(
  m: VerifyModule,
  ctx: CmdContext,
): Promise<{ exitCode: number | null; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", m.cmd ?? "false"], {
      cwd: m.repoPath,
      env: {
        ...process.env,
        DEN_ENV: ctx.env,
        DEN_RUN_ID: ctx.runId,
        DEN_RESULTS_DIR: ctx.resultsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (b: Buffer) => {
      tail = (tail + b.toString("utf-8"))
        .split("\n")
        .slice(-KEEP_LINES)
        .join("\n");
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ exitCode: code, lines: tail.split("\n") }),
    );
  });
}

/** GET a health URL: its status (redirects are answers, not followed). */
export async function httpProbe(url: string, method = "GET"): Promise<number> {
  const res = await fetch(url, { method, redirect: "manual" });
  await res.body?.cancel();
  return res.status;
}
