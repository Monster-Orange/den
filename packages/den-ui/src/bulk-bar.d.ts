/** One of the host's actions on the selected rows. */
export interface BulkAction {
  id: string;
  /** The host's own word for it; the kit adds the count. */
  label: string;
  /** How many rows it acts on ("Pause 3"); none: the label alone. */
  count?: number;
  /** Drawn, but can't be pressed. */
  disabled?: boolean;
}

export interface BulkBarData {
  /** How many rows are selected; 0 hides the bar. */
  count?: number;
  actions?: BulkAction[];
  lang?: string;
}

export interface BulkBarOptions extends Omit<BulkBarData, "lang"> {
  /**
   * An action pressed. A host that opens a dialog passes `button` as its
   * opener, so focus comes back to it.
   */
  onAction?: (id: string, button: HTMLButtonElement) => void;
  /** Clear pressed: the host unselects its rows; the bar hides at once. */
  onClear?: () => void;
  /** Where focus goes when the bar hides with focus in it. */
  returnFocus?: HTMLElement | null | (() => HTMLElement | null);
  /** The words' language (default: <html lang>). */
  lang?: string | (() => string);
}

export interface BulkBar {
  update(data: { count?: number; actions?: BulkAction[] }): void;
  destroy(): void;
}

/** The bar as markup, in the kit's words; hidden at 0. Pure: runs in Node. */
export declare function bulkBarHtml(data?: BulkBarData): string;

/** The bulk bar in `el` (el becomes the bar), with its live region beside it. */
export declare function mountBulkBar(
  el: HTMLElement,
  opts: BulkBarOptions,
): BulkBar;
