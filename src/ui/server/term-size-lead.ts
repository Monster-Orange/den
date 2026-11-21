/**
 * Issue 791: who sets a terminal's size when more than one browser views
 * it (the Agents page's pane and a peek over another page, two browsers).
 * A session has one PTY size. The last active viewer sets it:
 *
 *   - a lone viewer leads (the first to attach, or the one left);
 *   - typing in a view (the person's keys, never the terminal's own
 *     answers) makes it the active one: the PTY takes the size that view
 *     last asked for, with no resize message of its own;
 *   - a claim (Take over, the pane the person just opened) makes that
 *     view the active one at once, at its size;
 *   - any other view's resize (a refit: its window, a late font, its
 *     layout) is kept as what it wants, never applied while another view
 *     leads: the page is told the size in use and draws at it;
 *   - when the active view goes, the next one left leads, at its own size.
 *
 * So a small peek over the page never shrinks the agent's terminal for
 * the full view, and the view being typed in is never resized mid-typing.
 * The io route (session-routes.ts) keeps one per session; nothing here
 * touches a socket or a PTY: each call returns the size to apply, or null.
 */
export interface TermSize {
  cols: number;
  rows: number;
}

export class SizeLead<V> {
  private lead: V | null = null;
  /** Every viewer, in attach order, with the size it last asked for. */
  private readonly wants = new Map<V, TermSize | null>();
  /** The size this lead last applied (null: none yet). */
  private applied: TermSize | null = null;

  /** The viewer that sets the size now (null: none yet). */
  leader(): V | null {
    return this.lead;
  }

  attach(v: V): void {
    if (!this.wants.has(v)) this.wants.set(v, null);
    if (this.lead === null) this.lead = v;
  }

  /** The viewer went: the next one left leads, at the size it asked for. */
  detach(v: V): TermSize | null {
    this.wants.delete(v);
    if (this.lead !== v) return null;
    this.lead = null;
    const next = [...this.wants.keys()].at(-1);
    if (next === undefined) return null;
    this.lead = next;
    return this.apply(this.wants.get(next) ?? null);
  }

  /**
   * Viewer `v` asks for `size` (`claim`: the person's own act, Take over
   * or a pane just opened). The size to give the PTY, or null: another
   * viewer leads, and this one follows the size in use.
   */
  resize(v: V, size: TermSize, claim = false): TermSize | null {
    this.attach(v);
    this.wants.set(v, { cols: size.cols, rows: size.rows });
    if (claim || this.lead === v || !this.wants.has(this.lead as V)) {
      this.lead = v;
      // Always said again: another attach (the CLI) may have resized the
      // PTY unseen; the same size again is free.
      this.applied = { cols: size.cols, rows: size.rows };
      return this.applied;
    }
    return null;
  }

  /** The PTY's size as the host says it (any attach's resize). */
  heard(size: TermSize): void {
    this.applied = { cols: size.cols, rows: size.rows };
  }

  /** The person typed in `v`: it leads, at the size it last asked for. */
  input(v: V): TermSize | null {
    this.attach(v);
    if (this.lead === v) return null;
    this.lead = v;
    return this.apply(this.wants.get(v) ?? null);
  }

  private apply(size: TermSize | null): TermSize | null {
    if (!size) return null;
    if (
      this.applied &&
      this.applied.cols === size.cols &&
      this.applied.rows === size.rows
    )
      return null;
    this.applied = { cols: size.cols, rows: size.rows };
    return this.applied;
  }
}
