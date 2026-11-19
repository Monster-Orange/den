/** One option of a facet: the host's value and label, and its count. */
export interface FilterOption {
  value: string;
  /** The host's own word for it (data, as a rail page's label is). */
  label: string;
  /** How many choosing it would give; 0 can't be chosen unless chosen. */
  count?: number;
}

/** One facet: the host's id and label, and its options. */
export interface FilterFacet {
  id: string;
  label: string;
  options: FilterOption[];
}

/** What is chosen: each facet's chosen values. */
export type FilterSelected = Record<string, string[]>;

/** What changed: an option or a chip, a facet's Clear, or Clear all (null). */
export type FilterChange =
  | { facet: string; value: string; on: boolean }
  | { clear: string | null };

export interface FilterBarData {
  /** The bar's id; the panel is `<id>-panel` (default "den-fb"). */
  id?: string;
  facets?: FilterFacet[];
  selected?: FilterSelected;
  /** Drawn with the panel open. */
  open?: boolean;
  lang?: string;
}

export interface FilterBarOptions extends Omit<FilterBarData, "lang"> {
  /** Called after each change, with what is chosen now. */
  onChange?: (selected: FilterSelected, change: FilterChange) => void;
  /** The host's nodes before Filters in the row (a find box). */
  start?: Element | Element[] | null;
  /** The host's nodes after Filters in the row (Sort, the page's buttons). */
  end?: Element | Element[] | null;
  /** The words' language (default: <html lang>). */
  lang?: string | (() => string);
}

export interface FilterBar {
  /** New facets (counts) or choices from the host; focus stays put. */
  update(data: { facets?: FilterFacet[]; selected?: FilterSelected }): void;
  selected(): FilterSelected;
  open(): void;
  close(): void;
  destroy(): void;
}

/** How many values are chosen, across every facet. */
export declare function chosenCount(
  selected: FilterSelected | null | undefined,
): number;

/** The bar as markup, in the kit's words. Pure: runs in Node. */
export declare function filterBarHtml(data?: FilterBarData): string;

/** The filter bar in `el`: Filters, the chosen chips, the facet panel. */
export declare function mountFilterBar(
  el: HTMLElement,
  opts: FilterBarOptions,
): FilterBar;
