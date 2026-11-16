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
 * The verdict and exit code (the one table, run-outcome.ts): passed 0,
 * failed 1 (any module failed, errored or was blocked), nothing ran 3,
 * cancelled 4. A plan with nothing to run runs nothing, and hands back
 * the latest answer, so a page keeps showing it.
 *
 * Issue 210: the run's record is kept from the start ("running", each
 * module "queued", one behind a layer saying which) and again after each
 * module, so a page can show progress. Cancel (`signal`) stops the
 * command that is running; it and every module not finished become
 * "cancelled", and the run is "cancelled" (exit 4), never a pass. Only
 * finished modules become latest results.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  NOTHING_RAN_EXIT,
  VERDICT_EXIT,
  type Verdict,
} from "../run-outcome.js";
import {
  readLatest,
  writeLatest,
  type LatestResult,
  type ResultState,
} from "./changes.js";
import type { VerifyModule } from "./config.js";
import {
  atOrAbove,
  firstFailing,
  readFindings,
  type Findings,
  type Severity,
} from "./findings.js";
import type { VerifyPlan } from "./plan.js";
import {
  writeRunRecord,
  type ModuleRecord,
  type RunActor,
  type RunRecord,
} from "./records.js";

export { VERDICT_EXIT, type Verdict };

/** A module's state after a run: a result, or cancelled (never a result). */
export type ModuleState = ResultState | "cancelled";

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
  ms: number;
  /** Issue 212: passed only after a retry. */
  flaky?: true;
  /** Issue 212: every attempt, when there was more than one. */
  attempts?: Attempt[];
  /** Issue 212: a security scan's findings, from its SARIF. */
  findings?: Findings;
}

/** Issue 212: one try of a command module. */
export interface Attempt {
  state: "passed" | "failed" | "error";
  exitCode?: number | null;
  message?: string;
  ms: number;
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
  /** Aborted on Cancel: stop the command (issue 210). */
  signal?: AbortSignal;
}

export interface RunDeps {
  stateDir: string;
  head: (repoPath: string) => string | null;
  runCmd: (
    m: VerifyModule,
    ctx: CmdContext,
  ) => Promise<{ exitCode: number | null; lines?: string[] }>;
  /** GET `url`: its HTTP status (it throws when nothing answers). */
  probe: (url: string) => Promise<number>;
  runId?: () => string;
  now?: () => Date;
  /** Issue 209: who started the run and who allowed it, for its record. */
  by?: { startedBy?: RunActor; allowedBy?: RunActor };
  /** Issue 210: Cancel, and who cancelled (for the record). */
  signal?: AbortSignal;
  cancelled?: () => { by: RunActor; at: string } | undefined;
  /** Issue 212: verify.run.retries (0 when absent). */
  retries?: number;
  /** Issue 212: verify.security.fail_on ("high" when absent). */
  failOn?: Severity;
}

/** The verdict of a set of module states (VERIFY-SPEC section 5). */
export function verdictOf(states: readonly ModuleState[]): Verdict {
  if (states.includes("cancelled")) return "cancelled";
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
): Promise<Pick<ModuleRun, "state" | "message">> {
  for (const url of m.healthUrls[env] ?? []) {
    let status: number;
    try {
      status = await probe(url);
    } catch (e) {
      return {
        state: "failed",
        message: `GET ${url}: ${(e as Error).message}`,
      };
    }
    if (status <= 0 || status >= 400)
      return { state: "failed", message: `GET ${url} returned ${status}` };
  }
  return { state: "passed" };
}

export const newRunId = () =>
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
  const tails = new Map<string, string[]>();
  const record = (
    r: Pick<RunRecord, "verdict" | "exitCode" | "modules"> &
      Partial<
        Pick<RunRecord, "reason" | "commit" | "cancelledBy" | "cancelledAt">
      >,
  ) =>
    writeRunRecord(d.stateDir, {
      runId,
      project: plan.project,
      env: plan.env,
      scope: plan.scope,
      startedAt,
      ...(d.by?.startedBy ? { startedBy: d.by.startedBy } : {}),
      ...(d.by?.allowedBy ? { allowedBy: d.by.allowedBy } : {}),
      ...r,
      ...(r.verdict !== "running" ? { endedAt: now().toISOString() } : {}),
      modules: r.modules.map((m): ModuleRecord => {
        const tail = tails.get(m.id);
        return tail?.length ? { ...m, tail } : m;
      }),
    });
  const base = {
    ok: true as const,
    runId,
    project: plan.project,
    env: plan.env,
    scope: plan.scope,
  };
  if (plan.nothingToRun) {
    const r: RunResult = {
      ...base,
      verdict: "nothing ran",
      exitCode: NOTHING_RAN_EXIT,
      ...(plan.reason ? { reason: plan.reason } : {}),
      modules: [],
      latest: readLatest(d.stateDir, plan.project)[plan.env] ?? {},
    };
    record(r);
    return r;
  }
  const smokeFailed = new Set<string>();
  const badLayers = new Set<string>();
  const out: ModuleRun[] = [];
  const rowOf = (m: (typeof plan.modules)[number]) => ({
    id: m.id,
    name: m.name,
    repo: m.repo,
    layer: m.layer,
    kind: m.kind,
    mark: m.mark,
  });
  /** The record while it runs: done, the one running, the rest queued. */
  const progress = (running: number) =>
    record({
      verdict: "running",
      exitCode: null,
      modules: plan.modules.map((m, n): ModuleRecord => {
        if (n < out.length) return out[n];
        // A layer it depends on with modules still to finish.
        const waitsFor = dependsOn(plan.layers, m.layer).find((l) =>
          plan.modules.some((x, k) => k >= out.length && x.layer === l),
        );
        return {
          ...rowOf(m),
          state: n === running ? "running" : "queued",
          ms: 0,
          ...(n !== running && waitsFor ? { waitsFor } : {}),
        };
      }),
    });
  const cancelled = () => d.signal?.aborted === true;
  /** One try of a command module; a scan is judged by its findings. */
  const runOnce = async (
    m: VerifyModule,
    resultsDir: string,
  ): Promise<
    Omit<ModuleRun, "id" | "name" | "repo" | "layer" | "kind" | "mark" | "ms">
  > => {
    try {
      fs.mkdirSync(resultsDir, { recursive: true });
      const x = await d.runCmd(m, {
        env: plan.env,
        runId,
        resultsDir,
        ...(d.signal ? { signal: d.signal } : {}),
      });
      const last = x.lines?.filter((l) => l.trim()).at(-1);
      if (x.lines?.length) tails.set(m.id, x.lines.slice(-KEEP_LINES));
      if (cancelled()) return { state: "cancelled", exitCode: x.exitCode };
      if (x.exitCode === null)
        return { state: "error", exitCode: null, message: last ?? "stopped" };
      // Issue 212 (T13): a scan that wrote SARIF passes or fails by its
      // findings against the threshold, whatever the scanner's exit code.
      const found = m.kind === "security" ? readFindings(resultsDir) : null;
      if (found) {
        const setting = d.failOn ?? "high";
        const failOn =
          m.failOn && atOrAbove(m.failOn, setting)
            ? setting
            : (m.failOn ?? setting);
        const first = firstFailing(found, failOn);
        const findings = { ...found, failOn };
        return first
          ? {
              state: "failed",
              exitCode: x.exitCode,
              message: first.message,
              findings,
            }
          : { state: "passed", exitCode: x.exitCode, findings };
      }
      return x.exitCode === 0
        ? { state: "passed", exitCode: 0 }
        : {
            state: "failed",
            exitCode: x.exitCode,
            ...(last ? { message: last } : {}),
          };
    } catch (e) {
      return cancelled()
        ? { state: "cancelled" }
        : { state: "error", message: (e as Error).message };
    }
  };
  for (const [n, m] of plan.modules.entries()) {
    const row = rowOf(m);
    if (cancelled()) {
      out.push({ ...row, state: "cancelled", ms: 0 });
      continue;
    }
    progress(n);
    const started = Date.now();
    const blocker =
      m.kind !== "smoke" && smokeFailed.has(m.layer)
        ? "smoke"
        : dependsOn(plan.layers, m.layer).find((l) => badLayers.has(l));
    let r: Omit<ModuleRun, keyof typeof row | "ms">;
    if (blocker) r = { state: "blocked", blockedBy: blocker };
    else if (m.adapter === "smoke") r = await smoke(m, plan.env, d.probe);
    else {
      const base = path.join(
        d.stateDir,
        "verify",
        plan.project,
        "runs",
        runId,
        m.id.replace(/[^A-Za-z0-9._-]+/g, "_"),
      );
      // Issue 212: a failed command runs again up to verify.run.retries
      // times; each try keeps its own results folder, and every try is kept.
      const tries = 1 + Math.max(0, d.retries ?? 0);
      const attempts: Attempt[] = [];
      let r1: Omit<ModuleRun, keyof typeof row | "ms"> = { state: "error" };
      for (let a = 1; a <= tries; a++) {
        const t0 = Date.now();
        const resultsDir = a === 1 ? base : `${base}.try${a}`;
        r1 = await runOnce(m, resultsDir);
        if (r1.state === "cancelled") break;
        attempts.push({
          state: r1.state as Attempt["state"],
          ...(r1.exitCode !== undefined ? { exitCode: r1.exitCode } : {}),
          ...(r1.message ? { message: r1.message } : {}),
          ms: Date.now() - t0,
        });
        if (r1.state === "passed" || cancelled()) break;
      }
      r = {
        ...r1,
        ...(attempts.length > 1 ? { attempts } : {}),
        ...(attempts.length > 1 && r1.state === "passed"
          ? { flaky: true as const }
          : {}),
      };
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
  // Cancelled is never a result: only finished modules become latest.
  const finished = out.filter(
    (r): r is ModuleRun & { state: ResultState } => r.state !== "cancelled",
  );
  if (finished.length)
    writeLatest(
      d.stateDir,
      plan.project,
      plan.env,
      Object.fromEntries(
        finished.map((r) => [
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
  const result: RunResult = {
    ...base,
    verdict,
    exitCode: VERDICT_EXIT[verdict],
    modules: out,
    latest: readLatest(d.stateDir, plan.project)[plan.env] ?? {},
  };
  const c = verdict === "cancelled" ? d.cancelled?.() : undefined;
  record({
    verdict,
    exitCode: result.exitCode,
    modules: out,
    commit: first ? headOf(first.repoPath) : null,
    ...(c ? { cancelledBy: c.by, cancelledAt: c.at } : {}),
  });
  return result;
}

/** The last lines a command's output keeps for its result. */
const KEEP_LINES = 20;

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
      // Its own process group, so Cancel stops what it started too.
      detached: true,
    });
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    if (ctx.signal?.aborted) stop();
    ctx.signal?.addEventListener("abort", stop, { once: true });
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
    child.on("close", (code) => {
      ctx.signal?.removeEventListener("abort", stop);
      resolve({ exitCode: code, lines: tail.split("\n") });
    });
  });
}

/** GET a health URL: its status (redirects are answers, not followed). */
export async function httpProbe(url: string): Promise<number> {
  const res = await fetch(url, { method: "GET", redirect: "manual" });
  await res.body?.cancel();
  return res.status;
}
