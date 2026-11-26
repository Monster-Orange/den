/** A box's place beside its anchor: below it (the default) or above it. */
export type PopoverPlacement = "below" | "above";

export interface PopoverOptions {
  /** What it shows: a Node, or an HTML string the product has escaped. */
  content?: Node | string;
  /** Its name (aria-label), when nothing inside it names it. */
  label?: string;
  /** The id of an element inside it that names it (aria-labelledby). */
  labelledBy?: string;
  /** The side asked for; it flips when that side has no room. */
  placement?: PopoverPlacement;
  /** Called once, when it closes for any reason. */
  onClose?: () => void;
}

export interface Popover {
  /** The popover's element: div.den-pop.den-popover, role="dialog". */
  el: HTMLElement;
  /** Close it; refocus (default true) puts focus back on the anchor. */
  close(refocus?: boolean): void;
  /** Place it again, after its content changed size. */
  place(): void;
}

/**
 * Open a non-modal popover anchored to `anchor` (an HTML element, or an
 * SVG node such as a map's), closing any other that is open.
 */
export function openPopover(anchor: Element, opts?: PopoverOptions): Popover;

/** Where a w×h box goes beside anchor box `a` in a vw×vh viewport. */
export function placeBox(
  a: { top: number; bottom: number; left: number },
  w: number,
  h: number,
  vw: number,
  vh: number,
  want?: PopoverPlacement,
): { top: number; left: number; side: PopoverPlacement };
