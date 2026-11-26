/**
 * Issue 1129: one queue for every batch of agent restarts, whatever the
 * cause: a resume after Den or the machine restarts, Hub's new tools, a
 * settings change. Started all at once, dozens of agents each start a
 * model session (and often a test run) in the same minute; on one install
 * the load ended in a hardware watchdog reboot.
 *
 * - `agents.resume.batch` agents start at a time (default 4), then the
 *   queue waits `agents.resume.gap_seconds` (default 30) before the next
 *   batch. 0: every agent at once, as before.
 * - While the 1-minute load is over `agents.resume.load_ceiling` (default
 *   cores × 2), the next batch waits, and looks again after another gap.
 *   Once the oldest waiting agent has waited `agents.resume.max_wait_seconds`
 *   (default 600), the next window starts a batch whatever the load, and
 *   logs why: a busy machine never keeps an agent down for hours. 0: the
 *   load may hold them as long as it stays over.
 * - Agents that were working when the install stopped go first, then the
 *   idle ones, each in the order they came.
 * - An agent a person opens starts at once, ahead of the rest (openNow).
 * - An agent already waiting is never added twice: the second cause gets
 *   the first one's result.
 *
 * Time and load are injected (tests use fakes); the config is read before
 * each batch, so a changed Setting applies to the next one.
 */

/**
 * Why a job waits. Issue 1225: "services" is a project's services brought
 * back after a restart; it shares the stagger, and isn't an agent.
 */
export type RestartWhy = "resume" | "hub-tools" | "settings" | "services";

export interface RestartJob {
  id: string;
  why: RestartWhy;
  /** It was working (mid-turn) when the install stopped: it goes first. */
  working?: boolean;
  /** Starts it; its result (or error) goes back to whoever added it. */
  run: () => Promise<unknown>;
}

export interface RestartQueueConfig {
  /** Agents per batch; 0 or less: all at once. */
  batch: number;
  /** The wait between batches (ms). */
  gapMs: number;
  /** The 1-minute load above which the next batch waits; 0: no ceiling. */
  loadCeiling: number;
  /**
   * The longest the load may hold an agent back (ms): once the oldest has
   * waited this long, a batch starts whatever the load. 0: no limit.
   */
  maxWaitMs?: number;
}

export interface RestartQueueDeps {
  config(): RestartQueueConfig;
  /** The 1-minute load average now. */
  load(): number;
  sleep(ms: number): Promise<void>;
  /** The clock (ms); default Date.now. */
  now?(): number;
  log?(line: string): void;
  /** How many wait now: called whenever that changes (doctor, the bell). */
  changed?(waiting: number): void;
  heldBy?(err: unknown): string | null;
  stillWanted?(id: string, heldAt: number): boolean;
}

interface Entry extends RestartJob {
  seq: number;
  /** When it was added (ms): the most wait counts from here. */
  addedAt: number;
  heldAt?: number;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class RestartQueue {
  private readonly pending: Entry[] = [];
  private seq = 0;
  private draining: Promise<void> | null = null;
  /**
   * When the last batch started, or the load last held one back (ms): the
   * next batch waits a whole gap from then, even one a later add starts.
   */
  private lastAt: number | null = null;
  /** How many started in the window that began at lastAt. */
  private inWindow = 0;
  private readonly holding = new Map<
    string,
    { e: Entry; why: string; at: number }
  >();
  private retrying = false;

  constructor(private readonly d: RestartQueueDeps) {}

  /** Queue `job`; settles with its run's result once it has started. */
  add(job: RestartJob): Promise<unknown> {
    const there = this.pending.find((e) => e.id === job.id);
    if (there) {
      if (job.working) there.working = true;
      return there.promise;
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Its caller may not wait for it: a failure is still not unhandled.
    promise.catch(() => undefined);
    this.pending.push({
      ...job,
      seq: ++this.seq,
      addedAt: (this.d.now ?? Date.now)(),
      promise,
      resolve,
      reject,
    });
    this.d.changed?.(this.pending.length);
    this.kick();
    return promise;
  }

  /** Drain, unless a drain runs; again after it when some still wait. */
  private kick(): void {
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
      if (this.pending.length) this.kick();
    });
  }

  /**
   * A person opened agent `id`: when it waits here, it starts now, ahead
   * of the queue, and leaves it (its promise; whoever added it gets the
   * result too). `run`, when given, starts it instead of the queued run
   * (the person's own Resume). Null when it isn't waiting.
   */
  openNow(id: string, run?: () => Promise<unknown>): Promise<unknown> | null {
    this.forget(id);
    const i = this.pending.findIndex((e) => e.id === id);
    if (i < 0) return null;
    const [e] = this.pending.splice(i, 1);
    if (run) e.run = run;
    delete e.heldAt;
    this.d.changed?.(this.pending.length);
    this.start(e);
    return e.promise;
  }

  /** The agents waiting now, in the order they will start. */
  waiting(): { id: string; why: RestartWhy }[] {
    return this.ordered().map((e) => ({ id: e.id, why: e.why }));
  }

  held(): { id: string; why: string }[] {
    return [...this.holding.values()]
      .sort((a, b) => a.e.seq - b.e.seq)
      .map((h) => ({ id: h.e.id, why: h.why }));
  }

  forget(id: string): void {
    this.holding.delete(id);
  }

  /** Settles when nothing waits (tests, and a caller that waits it out). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private ordered(): Entry[] {
    return [...this.pending].sort(
      (a, b) =>
        Number(b.working === true) - Number(a.working === true) ||
        a.seq - b.seq,
    );
  }

  private start(e: Entry): void {
    if (
      e.heldAt !== undefined &&
      this.d.stillWanted &&
      !this.d.stillWanted(e.id, e.heldAt)
    ) {
      e.reject(new Error(`agent ${e.id} was stopped while it waited`));
      return;
    }
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(e.run());
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(e.resolve, (err) => {
      const why = this.d.heldBy?.(err);
      if (why) this.hold(e, why);
      e.reject(err);
    });
  }

  private hold(e: Entry, why: string): void {
    const maxWait = this.d.config().maxWaitMs ?? 0;
    const waited = (this.d.now ?? Date.now)() - e.addedAt;
    if (maxWait > 0 && waited >= maxWait) {
      this.holding.delete(e.id);
      this.d.log?.(
        `Agent ${e.id} stops waiting for room: it waited ${Math.round(waited / 1000)} s, the most wait (agents.resume.max_wait_seconds) is ${Math.round(maxWait / 1000)} s (${why})`,
      );
      return;
    }
    e.heldAt ??= (this.d.now ?? Date.now)();
    this.holding.set(e.id, { e, why, at: e.heldAt });
    this.retryLater();
  }

  private retryLater(): void {
    if (this.retrying) return;
    this.retrying = true;
    void (async () => {
      try {
        while (this.holding.size) {
          const gap = this.d.config().gapMs;
          await this.d.sleep(gap > 0 ? gap : 30_000);
          const due = [...this.holding.values()];
          this.holding.clear();
          for (const { e, at } of due) {
            if (this.pending.some((x) => x.id === e.id)) continue;
            if (this.d.stillWanted && !this.d.stillWanted(e.id, at)) continue;
            const again: Entry = { ...e, seq: ++this.seq };
            again.promise = new Promise<unknown>((res, rej) => {
              again.resolve = res;
              again.reject = rej;
            });
            again.promise.catch(() => undefined);
            this.pending.push(again);
          }
          if (due.length) {
            this.d.changed?.(this.pending.length);
            this.kick();
          }
          await this.idle();
          await Promise.resolve();
        }
      } finally {
        this.retrying = false;
      }
    })();
  }

  private async drain(): Promise<void> {
    // After this tick: a burst of adds is ordered as one (working first).
    await Promise.resolve();
    const now = () => (this.d.now ?? Date.now)();
    while (this.pending.length) {
      const cfg = this.d.config();
      if (!(cfg.batch > 0)) {
        for (const e of this.ordered()) this.take(e);
        this.d.changed?.(0);
        return;
      }
      const t = now();
      // A new window: a whole gap since the last one began (or none yet).
      if (this.lastAt === null || t - this.lastAt >= cfg.gapMs) {
        this.lastAt = t;
        const load = this.d.load();
        const maxWait = cfg.maxWaitMs ?? 0;
        const waited = t - Math.min(...this.pending.map((e) => e.addedAt));
        if (cfg.loadCeiling > 0 && load > cfg.loadCeiling) {
          if (maxWait > 0 && waited >= maxWait) {
            this.inWindow = 0; // the most wait is up: a batch goes anyway
            this.d.log?.(
              `Agent restarts go although load ${load.toFixed(1)} is over ${cfg.loadCeiling}: the oldest waited ${Math.round(waited / 1000)} s, the most wait (agents.resume.max_wait_seconds) is ${Math.round(maxWait / 1000)} s`,
            );
          } else {
            this.inWindow = cfg.batch; // this window starts nobody
            this.d.log?.(
              `Agent restarts wait: load ${load.toFixed(1)} is over ${cfg.loadCeiling} (${this.pending.length} waiting)`,
            );
          }
        } else this.inWindow = 0;
      }
      // Room left in this window: restarts that came one at a time fill it.
      if (this.inWindow < cfg.batch) {
        for (const e of this.ordered().slice(0, cfg.batch - this.inWindow)) {
          this.take(e);
          this.inWindow += 1;
        }
        this.d.changed?.(this.pending.length);
        if (!this.pending.length) return;
      }
      // The window is full: wait for its end, then a new one begins.
      await this.d.sleep(Math.max(0, cfg.gapMs - (now() - this.lastAt)));
      this.lastAt = null;
    }
  }

  /** Out of the queue, and started. */
  private take(e: Entry): void {
    const i = this.pending.indexOf(e);
    if (i >= 0) this.pending.splice(i, 1);
    this.start(e);
  }
}
