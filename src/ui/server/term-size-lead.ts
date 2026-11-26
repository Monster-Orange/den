export interface TermSize {
  cols: number;
  rows: number;
}

const SEEN_MAX = 64;

export class SizeLead<V> {
  private lead: V | null = null;
  private goneAt: number | null = null;
  private readonly viewers = new Set<V>();
  private readonly seen = new Set<V>();
  private readonly grace: () => number;
  private readonly now: () => number;

  constructor(
    o: { graceMs?: number | (() => number); now?: () => number } = {},
  ) {
    const g = o.graceMs ?? 0;
    this.grace = () => Math.max(0, typeof g === "function" ? g() : g);
    this.now = o.now ?? Date.now;
  }

  leader(): V | null {
    return this.lead;
  }

  holds(v: V): boolean {
    return this.lead === v;
  }

  held(): boolean {
    return this.lead !== null;
  }

  attach(v: V): void {
    const alone = this.viewers.size === 0;
    this.viewers.add(v);
    const known = this.seen.delete(v);
    this.seen.add(v);
    if (this.seen.size > SEEN_MAX)
      this.seen.delete(this.seen.values().next().value as V);
    if (this.lead === v) this.goneAt = null;
    else if (this.lead === null || (this.goneAt !== null && alone && !known))
      this.take(v);
  }

  detach(v: V, keep = true): void {
    this.viewers.delete(v);
    if (this.lead !== v) return;
    if (keep && this.grace() > 0) {
      this.goneAt = this.now();
      return;
    }
    this.handOff();
  }

  expire(): boolean {
    const left = this.left();
    if (left === null || left > 0) return false;
    this.handOff();
    return true;
  }

  left(): number | null {
    if (this.goneAt === null) return null;
    return Math.max(0, this.grace() - (this.now() - this.goneAt));
  }

  resize(v: V, size: TermSize, claim = false): TermSize | null {
    this.attach(v);
    if (claim || this.lead === v) {
      this.take(v);
      return { cols: size.cols, rows: size.rows };
    }
    return null;
  }

  input(v: V): void {
    this.attach(v);
    this.take(v);
  }

  private take(v: V): void {
    this.lead = v;
    this.goneAt = null;
  }

  private handOff(): void {
    this.goneAt = null;
    this.lead = [...this.viewers].at(-1) ?? null;
  }
}
