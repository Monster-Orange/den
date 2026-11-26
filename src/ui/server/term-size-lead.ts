export interface TermSize {
  cols: number;
  rows: number;
}

const SEEN_MAX = 64;

export class SizeLead<V> {
  private lead: V | null = null;
  private goneAt: number | null = null;
  private hold: () => number;
  private back: { v: V; at: number } | null = null;
  private readonly viewers = new Set<V>();
  private readonly seen = new Set<V>();
  private readonly grace: () => number;
  private readonly leave: () => number;
  private readonly now: () => number;

  constructor(
    o: {
      graceMs?: number | (() => number);
      leaveMs?: number | (() => number);
      now?: () => number;
    } = {},
  ) {
    const ms = (x: number | (() => number) | undefined) => () =>
      Math.max(0, typeof x === "function" ? x() : (x ?? 0));
    this.grace = ms(o.graceMs);
    this.leave = ms(o.leaveMs ?? o.graceMs);
    this.hold = this.grace;
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
    if (this.back && this.now() - this.back.at > this.grace()) this.back = null;
    if (this.back?.v === v) this.take(v);
    else if (this.lead === v) this.goneAt = null;
    else if (this.lead === null || (this.goneAt !== null && alone && !known))
      this.take(v);
  }

  detach(v: V, keep = true, leaving = false): void {
    this.viewers.delete(v);
    if (this.lead !== v) return;
    this.hold = leaving ? this.leave : this.grace;
    if (keep && this.hold() > 0) {
      this.goneAt = this.now();
      return;
    }
    if (keep && leaving) this.back = { v, at: this.now() };
    this.handOff();
  }

  expire(): boolean {
    const left = this.left();
    if (left === null || left > 0) return false;
    if (this.hold === this.leave && this.lead !== null)
      this.back = { v: this.lead, at: this.goneAt ?? this.now() };
    this.handOff();
    return true;
  }

  left(): number | null {
    if (this.goneAt === null) return null;
    return Math.max(0, this.hold() - (this.now() - this.goneAt));
  }

  resize(v: V, size: TermSize, claim = false): TermSize | null {
    this.attach(v);
    if (claim) this.back = null;
    if (claim || this.lead === v) {
      this.take(v);
      return { cols: size.cols, rows: size.rows };
    }
    return null;
  }

  input(v: V): void {
    this.attach(v);
    this.back = null;
    this.take(v);
  }

  private take(v: V): void {
    if (this.back?.v === v) this.back = null;
    this.lead = v;
    this.goneAt = null;
  }

  private handOff(): void {
    this.goneAt = null;
    this.hold = this.grace;
    this.lead = [...this.viewers].at(-1) ?? null;
  }
}
