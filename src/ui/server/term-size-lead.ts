export interface TermSize {
  cols: number;
  rows: number;
}

export class SizeLead<V> {
  private lead: V | null = null;
  private readonly viewers = new Set<V>();

  leader(): V | null {
    return this.lead;
  }

  attach(v: V): void {
    this.viewers.add(v);
    if (this.lead === null) this.lead = v;
  }

  detach(v: V): void {
    this.viewers.delete(v);
    if (this.lead !== v) return;
    this.lead = [...this.viewers].at(-1) ?? null;
  }

  resize(v: V, size: TermSize, claim = false): TermSize | null {
    this.attach(v);
    if (claim || this.lead === v) {
      this.lead = v;
      return { cols: size.cols, rows: size.rows };
    }
    return null;
  }

  input(v: V): void {
    this.attach(v);
    this.lead = v;
  }
}
