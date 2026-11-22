/**
 * Issue 791: who sets a terminal's size when more than one browser views
 * it (the Agents page's pane and a peek over another page, two browsers).
 * A session has one PTY size. The last active viewer sets it:
 *
 *   - a lone viewer leads (the first to attach, or the one left);
 *   - typing in a view (the person's keys, never the terminal's own
 *     answers) makes it the active one. Its size comes with its own
 *     resize (a page says its size before the keys when it must); a
 *     hidden page that types says none, and nothing is resized (D54);
 *   - a claim (Take over, the pane the person just opened) makes that
 *     view the active one at once, at its size;
 *   - any other view's resize (a refit: its window, a late font, its
 *     layout) is never applied while another view leads: the page is
 *     told the size in use and draws at it;
 *   - when the active view goes, the newest one left leads; it says its
 *     own size (the page does, once it hears it is alone).
 *
 * So a small peek over the page never shrinks the agent's terminal for
 * the full view, and the view being typed in is never resized mid-typing.
 * The io route (session-routes.ts) keeps one per session; nothing here
 * touches a socket or a PTY: resize() returns the size to apply, or null.
 */
export interface TermSize {
  cols: number;
  rows: number;
}

export class SizeLead<V> {
  private lead: V | null = null;
  /** Every viewer, in attach order. */
  private readonly viewers = new Set<V>();

  /** The viewer that sets the size now (null: none yet). */
  leader(): V | null {
    return this.lead;
  }

  attach(v: V): void {
    this.viewers.add(v);
    if (this.lead === null) this.lead = v;
  }

  /** The viewer went: the newest one left leads. */
  detach(v: V): void {
    this.viewers.delete(v);
    if (this.lead !== v) return;
    this.lead = [...this.viewers].at(-1) ?? null;
  }

  /**
   * Viewer `v` asks for `size` (`claim`: the person's own act, Take over
   * or a pane just opened). The size to give the PTY, or null: another
   * viewer leads, and this one follows the size in use.
   */
  resize(v: V, size: TermSize, claim = false): TermSize | null {
    this.attach(v);
    if (claim || this.lead === v) {
      this.lead = v;
      return { cols: size.cols, rows: size.rows };
    }
    return null;
  }

  /** The person typed in `v`: it is the active view now. */
  input(v: V): void {
    this.attach(v);
    this.lead = v;
  }
}
