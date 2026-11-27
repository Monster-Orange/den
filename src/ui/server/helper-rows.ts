import type { AgentRow } from "../cli/agent-ops.js";

type Row = AgentRow["helpers"];

export interface HelperAsk {
  id: string;
  key: string;
  compute: () => Row;
}

export interface HelperPace {
  waitMs: number;
  restMs: number;
}

export class HelperRows {
  private readonly rows = new Map<
    string,
    { key: string; at: number; row: Row; asked: number; bytes: number }
  >();
  private bytes = 0;
  private budget = Infinity;
  private idleMs = 60_000;
  private askedAt = 0;
  private readonly queue = new Map<string, HelperAsk>();
  private running: Promise<void> | null = null;
  private restMs = 0;
  private computed = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly pause: (restMs: number) => Promise<void> = (restMs) =>
      new Promise((r) =>
        restMs > 0 ? setTimeout(r, restMs) : setImmediate(r),
      ),
  ) {}

  peek(ask: HelperAsk): Row {
    const r = this.rows.get(ask.id);
    return r && r.key === ask.key ? r.row : undefined;
  }

  known(ask: HelperAsk): boolean {
    return this.rows.get(ask.id)?.key === ask.key;
  }

  async ensure(
    asks: HelperAsk[],
    maxAgeMs: number,
    budgetBytes = Infinity,
    pace: HelperPace = { waitMs: Infinity, restMs: 0 },
  ): Promise<boolean> {
    let wait = false;
    for (const a of asks) {
      const r = this.rows.get(a.id);
      if (!r || r.key !== a.key || maxAgeMs <= 0) {
        this.queue.set(a.id, a);
        wait = true;
      } else if (this.now() - r.at >= maxAgeMs) this.queue.set(a.id, a);
    }
    const now = this.now();
    for (const a of asks) {
      const r = this.rows.get(a.id);
      if (!r) continue;
      r.asked = now;
      this.rows.delete(a.id);
      this.rows.set(a.id, r);
    }
    this.budget = budgetBytes;
    this.restMs = pace.restMs;
    this.idleMs = Math.max(60_000, 12 * maxAgeMs);
    this.askedAt = now;
    this.trim();
    if (!this.queue.size) return false;
    const before = this.computed;
    const run = this.start();
    if (!wait) return false;
    if (pace.waitMs === Infinity) await run;
    else if (pace.waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        run,
        new Promise<void>((r) => (timer = setTimeout(r, pace.waitMs))),
      ]);
      clearTimeout(timer);
    }
    return this.computed > before;
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private trim(): void {
    const now = this.now();
    for (const [id, r] of this.rows) {
      if (r.asked >= this.askedAt) break;
      if (now - r.asked > this.idleMs || this.bytes > this.budget)
        this.drop(id);
      else break;
    }
  }

  private drop(id: string): void {
    const r = this.rows.get(id);
    if (!r) return;
    this.bytes -= r.bytes;
    this.rows.delete(id);
  }

  private start(): Promise<void> {
    this.running ??= (async () => {
      try {
        for (;;) {
          await this.pause(this.restMs);
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
          this.computed++;
          this.drop(a.id);
          const bytes = 128 + 2 * (JSON.stringify(row)?.length ?? 0);
          const at = this.now();
          this.rows.set(a.id, { key: a.key, at, row, asked: at, bytes });
          this.bytes += bytes;
          this.trim();
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}

export const SERVER_HELPER_ROWS = new HelperRows();
