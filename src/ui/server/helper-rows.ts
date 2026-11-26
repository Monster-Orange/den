import type { AgentRow } from "../cli/agent-ops.js";

type Row = AgentRow["helpers"];

/** One agent's helper row: `key` names its inputs, `compute` reads it. */
export interface HelperAsk {
  id: string;
  key: string;
  compute: () => Row;
}

/**
 * Issue 1668: the helper rows of the session list, shared by every list.
 * A row is read by one run at a time, which yields to the event loop
 * between agents, so a list never holds the server while transcripts are
 * read. A row missing or with changed inputs is read before the list
 * answers; one older than `maxAgeMs` is served and read again behind it.
 */
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

  /** What a list shows now for `ask`, if a row was read for its inputs. */
  peek(ask: HelperAsk): Row {
    const r = this.rows.get(ask.id);
    return r && r.key === ask.key ? r.row : undefined;
  }

  /**
   * Reads what `asks` need. True when a row was read for this list
   * (it should be built again with `peek`), false when all were served.
   */
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

  /** Settles when no run is going (tests). */
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

/** The server's one set, shared by the session list and the helpers count. */
export const SERVER_HELPER_ROWS = new HelperRows();
