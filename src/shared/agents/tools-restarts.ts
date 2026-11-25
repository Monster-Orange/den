/**
 * Issue 1223: the agents still on older tools (Den updated since they
 * started, or Hub's tools changed), as one bell row with one Restart for
 * the person. Restart sends them through the restart queue (issue 1129: a
 * batch at a time, under the load ceiling), never all at once. The row
 * says how far a restart got; an agent that failed stays listed with the
 * reason while the others finish, and a new Restart tries it again.
 * Issue 1407: one the check holds back (a background job it started, or
 * a turn Den can't read) is never queued: it's listed with why it waits,
 * for the person's Restart now, and isn't counted in Restart N.
 *
 * The stale list comes from the caller (staleAgents, cached): the row is
 * built from it on each read, so it leaves the bell once none is left.
 */
import type { RestartJob } from "./restart-queue.js";
import { redactSecrets } from "../redact.js";

export interface StaleOne {
  id: string;
  workspace: string;
}

/** The bell row, as GET /api/notifications' `waiting` lists it. */
export interface ToolsOldWaiting {
  kind: "tools_old";
  id: "tools-old";
  /** Agents Restart N restarts (failed ones included; held ones not). */
  n: number;
  agents: {
    agent: string;
    workspace: string;
    reason?: string;
    /** Issue 1407: held for the person's Restart now. */
    waits?: "job" | "unknown";
    job?: { command: string; minutes: number };
  }[];
  /** A Restart under way: how many are back, of how many. */
  restarting?: { done: number; total: number };
}

/** Issue 1407: one the check held back for the person. */
export interface Held extends StaleOne {
  waits: "job" | "unknown";
  job?: { command: string; minutes: number };
}

export interface ToolsRestartsDeps {
  queue: { add(job: RestartJob): Promise<unknown> };
  /** Restarts one at its next idle, on the same conversation. */
  restart(a: StaleOne): Promise<unknown>;
}

/**
 * A failure's reason as the bell shows it (to anyone who reads it):
 * secrets redacted, its first line, at most 200 characters.
 */
function reasonOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = redactSecrets(raw).split(/\r?\n/)[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** One agent: ids are per project, so the project is part of the key. */
const keyOf = (a: StaleOne) => `${a.workspace}\0${a.id}`;

export class ToolsRestarts {
  private batch = new Map<string, StaleOne>();
  private done = new Set<string>();
  private failed = new Map<string, { a: StaleOne; reason: string }>();
  private held = new Map<string, Held>();

  constructor(private readonly d: ToolsRestartsDeps) {}

  private running(): number {
    let n = 0;
    for (const k of this.batch.keys())
      if (!this.done.has(k) && !this.failed.has(k)) n++;
    return n;
  }

  /**
   * Queues each not already under way; returns the ones queued. Each
   * restarts through `restart` (this call's), else the deps' own.
   */
  start(
    list: readonly StaleOne[],
    restart: (a: StaleOne) => Promise<unknown> = (a) => this.d.restart(a),
  ): StaleOne[] {
    // A finished batch: a new Restart starts counting again.
    if (this.batch.size && !this.running()) {
      this.batch.clear();
      this.done.clear();
    }
    const out: StaleOne[] = [];
    for (const a of list) {
      const k = keyOf(a);
      this.held.delete(k);
      if (this.batch.has(k) && !this.failed.has(k)) continue;
      this.failed.delete(k);
      this.done.delete(k);
      this.batch.set(k, a);
      out.push(a);
      void this.d.queue
        .add({ id: a.id, key: k, why: "tools", run: () => restart(a) })
        .then(
          () => this.done.add(k),
          (e: unknown) =>
            this.failed.set(k, {
              a,
              reason: reasonOf(e),
            }),
        );
    }
    return out;
  }

  /**
   * Issue 1407: agents the check held back (a job, or a turn Den can't
   * read): listed with why, never queued. A new start clears them.
   */
  hold(list: readonly Held[]): void {
    for (const h of list) this.held.set(keyOf(h), h);
  }

  /** The row for `stale` (the agents on older tools now), or null. */
  row(stale: readonly StaleOne[]): ToolsOldWaiting | null {
    const agents: ToolsOldWaiting["agents"] = [];
    const seen = new Set<string>();
    for (const a of stale) {
      // Back already: the stale list hasn't been asked again yet.
      const k = keyOf(a);
      if (this.done.has(k) || this.failed.has(k)) continue;
      seen.add(k);
      const h = this.held.get(k);
      agents.push({
        agent: a.id,
        workspace: a.workspace,
        ...(h ? { waits: h.waits, ...(h.job ? { job: h.job } : {}) } : {}),
      });
    }
    for (const [k, { a, reason }] of this.failed)
      if (!seen.has(k))
        agents.push({ agent: a.id, workspace: a.workspace, reason });
    const left = this.running();
    if (!agents.length && !left) return null;
    return {
      kind: "tools_old",
      id: "tools-old",
      n: agents.filter((a) => !a.waits).length,
      agents,
      ...(left
        ? {
            restarting: {
              done: this.batch.size - left - this.failed.size,
              total: this.batch.size,
            },
          }
        : {}),
    };
  }
}
