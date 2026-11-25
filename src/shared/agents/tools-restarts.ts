import type { RestartJob } from "./restart-queue.js";
import { redactSecrets } from "../redact.js";

export interface StaleOne {
  id: string;
  workspace: string;
}

export interface ToolsOldWaiting {
  kind: "tools_old";
  id: "tools-old";
  n: number;
  agents: {
    agent: string;
    workspace: string;
    reason?: string;
    waits?: "job" | "unknown";
    job?: { command: string; minutes: number };
  }[];
  restarting?: { done: number; total: number };
}

export interface Held extends StaleOne {
  waits: "job" | "unknown";
  job?: { command: string; minutes: number };
}

export interface ToolsRestartsDeps {
  queue: { add(job: RestartJob): Promise<unknown> };
  restart(a: StaleOne): Promise<unknown>;
}

function reasonOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = redactSecrets(raw).split(/\r?\n/)[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

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

  start(
    list: readonly StaleOne[],
    restart: (a: StaleOne) => Promise<unknown> = (a) => this.d.restart(a),
  ): StaleOne[] {
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

  hold(list: readonly Held[]): void {
    for (const h of list) this.held.set(keyOf(h), h);
  }

  row(stale: readonly StaleOne[]): ToolsOldWaiting | null {
    const agents: ToolsOldWaiting["agents"] = [];
    const seen = new Set<string>();
    for (const a of stale) {
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
