import type { AgentRow } from "../cli/agent-ops.js";

type Row = AgentRow["helpers"];

export interface HelperAsk {
  id: string;
  key: string;
  compute: () => Row;
}

export class HelperRows {
  private readonly rows = new Map<
    string,
    { key: string; at: number; row: Row }
  >();
  private readonly queue = new Map<string, HelperAsk>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly pause: () => Promise<void> = () =>
      new Promise((r) => setImmediate(r)),
  ) {}

  peek(ask: HelperAsk): Row {
    const r = this.rows.get(ask.id);
    return r && r.key === ask.key ? r.row : undefined;
  }

  async ensure(asks: HelperAsk[], maxAgeMs: number): Promise<boolean> {
    let wait = false;
    for (const a of asks) {
      const r = this.rows.get(a.id);
      if (!r || r.key !== a.key || maxAgeMs <= 0) {
        this.queue.set(a.id, a);
        wait = true;
      } else if (this.now() - r.at >= maxAgeMs) this.queue.set(a.id, a);
    }
    const ids = new Set(asks.map((a) => a.id));
    for (const id of this.rows.keys()) if (!ids.has(id)) this.rows.delete(id);
    if (!this.queue.size) return false;
    const run = this.start();
    if (wait) await run;
    return wait;
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private start(): Promise<void> {
    this.running ??= (async () => {
      try {
        for (;;) {
          await this.pause();
          const next = this.queue.values().next();
          if (next.done) break;
          const a = next.value;
          this.queue.delete(a.id);
          let row: Row;
          try {
            row = a.compute();
          } catch {
            row = undefined;
          }
          this.rows.set(a.id, { key: a.key, at: this.now(), row });
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}

export const SERVER_HELPER_ROWS = new HelperRows();
