/**
 * Issue 1223: the agents still on older tools (Den updated since they
 * started, or Hub's tools changed), as one bell row with one Restart for
 * the person. Restart sends them through the restart queue (issue 1129: a
 * batch at a time, under the load ceiling), never all at once. The row
 * says how far a restart got; an agent that failed stays listed with the
 * reason while the others finish, and a new Restart tries it again.
 *
 * The stale list comes from the caller (staleAgents, cached): the row is
 * built from it on each read, so it leaves the bell once none is left.
 */
import type { RestartJob } from "./restart-queue.js";

export interface StaleOne {
  id: string;
  workspace: string;
}

/** The bell row, as GET /api/notifications' `waiting` lists it. */
export interface ToolsOldWaiting {
  kind: "tools_old";
  id: "tools-old";
  /** Agents still on older tools (failed ones included). */
  n: number;
  agents: { agent: string; workspace: string; reason?: string }[];
  /** A Restart under way: how many are back, of how many. */
  restarting?: { done: number; total: number };
}

export interface ToolsRestartsDeps {
  queue: { add(job: RestartJob): Promise<unknown> };
  /** Restarts one at its next idle, on the same conversation. */
  restart(a: StaleOne): Promise<unknown>;
}

export class ToolsRestarts {
  private batch = new Map<string, StaleOne>();
  private done = new Set<string>();
  private failed = new Map<string, { a: StaleOne; reason: string }>();

  constructor(private readonly d: ToolsRestartsDeps) {}

  private running(): number {
    let n = 0;
    for (const id of this.batch.keys())
      if (!this.done.has(id) && !this.failed.has(id)) n++;
    return n;
  }

  /** Queues each not already under way; returns the ones queued. */
  start(list: readonly StaleOne[]): StaleOne[] {
    // A finished batch: a new Restart starts counting again.
    if (this.batch.size && !this.running()) {
      this.batch.clear();
      this.done.clear();
    }
    const out: StaleOne[] = [];
    for (const a of list) {
      if (this.batch.has(a.id) && !this.failed.has(a.id)) continue;
      this.failed.delete(a.id);
      this.done.delete(a.id);
      this.batch.set(a.id, a);
      out.push(a);
      void this.d.queue
        .add({ id: a.id, why: "tools", run: () => this.d.restart(a) })
        .then(
          () => this.done.add(a.id),
          (e: unknown) =>
            this.failed.set(a.id, {
              a,
              reason: e instanceof Error ? e.message : String(e),
            }),
        );
    }
    return out;
  }

  /** The row for `stale` (the agents on older tools now), or null. */
  row(stale: readonly StaleOne[]): ToolsOldWaiting | null {
    const agents: ToolsOldWaiting["agents"] = [];
    const seen = new Set<string>();
    for (const a of stale) {
      // Back already: the stale list hasn't been asked again yet.
      if (this.done.has(a.id) || this.failed.has(a.id)) continue;
      seen.add(a.id);
      agents.push({ agent: a.id, workspace: a.workspace });
    }
    for (const { a, reason } of this.failed.values())
      if (!seen.has(a.id))
        agents.push({ agent: a.id, workspace: a.workspace, reason });
    const left = this.running();
    if (!agents.length && !left) return null;
    return {
      kind: "tools_old",
      id: "tools-old",
      n: agents.length,
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
