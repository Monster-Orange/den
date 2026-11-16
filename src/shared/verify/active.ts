/**
 * Issue 210: the Verify runs going on in this Den right now (screen S3).
 *
 * A run goes on in the background: whoever started it gets its id at
 * once and reads its record for progress. One run at a time per project
 * and environment (VERIFY-SPEC section 6, verify.run.concurrency: 1).
 * Cancel aborts the run's signal and remembers who cancelled and when,
 * for its record. In memory: a run that was going when Den stopped is
 * not live any more (its record still says "running").
 */
import type { RunActor } from "./records.js";
import type { RunResult } from "./run.js";

export interface Cancelled {
  by: RunActor;
  /** ISO time. */
  at: string;
}

interface Going {
  project: string;
  env: string;
  ac: AbortController;
  done: Promise<RunResult | null>;
  /** Who started it: an agent may cancel only its own run. */
  startedBy?: RunActor;
  cancelled?: Cancelled;
}

export type StartRun = (
  signal: AbortSignal,
  cancelled: () => Cancelled | undefined,
) => Promise<RunResult>;

export class ActiveRuns {
  private readonly runs = new Map<string, Going>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The run going on this project and environment, if any. */
  going(project: string, env: string): string | undefined {
    for (const [id, g] of this.runs)
      if (g.project === project && g.env === env) return id;
    return undefined;
  }

  /** Whether this run is going on in this Den now. */
  isLive(project: string, runId: string): boolean {
    return this.runs.get(runId)?.project === project;
  }

  /** Who started a run that is going (for who may cancel it). */
  startedBy(runId: string): RunActor | undefined {
    return this.runs.get(runId)?.startedBy;
  }

  /**
   * Starts `start` in the background under `runId`. False when a run is
   * already going on that project and environment.
   */
  start(
    p: { project: string; env: string; runId: string; startedBy?: RunActor },
    start: StartRun,
  ): boolean {
    if (this.going(p.project, p.env) || this.runs.has(p.runId)) return false;
    const ac = new AbortController();
    const g: Going = {
      project: p.project,
      env: p.env,
      ac,
      done: Promise.resolve(null),
      ...(p.startedBy ? { startedBy: p.startedBy } : {}),
    };
    this.runs.set(p.runId, g);
    g.done = start(ac.signal, () => g.cancelled)
      .catch(() => null)
      .finally(() => this.runs.delete(p.runId));
    return true;
  }

  /** Cancels a run going on this project. False when none is. */
  cancel(project: string, runId: string, by: RunActor): boolean {
    const g = this.runs.get(runId);
    if (!g || g.project !== project) return false;
    g.cancelled ??= { by, at: this.now().toISOString() };
    g.ac.abort();
    return true;
  }

  /** The run's result once it ends (null: not going, or it threw). */
  async done(runId: string): Promise<RunResult | null> {
    return (await this.runs.get(runId)?.done) ?? null;
  }
}
