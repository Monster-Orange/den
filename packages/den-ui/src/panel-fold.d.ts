/** What a strip's count counts, worded as the kit's badges are. */
export type EdgeStripCountKind = "open" | "waiting" | "down" | "running";

export interface FoldToggleModel {
  /** The panel shows (default true): aria-pressed. */
  pressed?: boolean;
  /** The panel's id: aria-controls. */
  controls?: string;
  /** The kit's words' language: en, es or ja (default en). */
  lang?: string;
}

export interface EdgeStripModel {
  /** The count under Show panel; 0 or none draws none; 99+ past 99. */
  count?: number;
  /** What it counts (default "open"); any other is "open". */
  what?: EdgeStripCountKind;
  /** The folded panel's id: Show panel's aria-controls. */
  controls?: string;
  lang?: string;
}

export interface FoldToggleOptions {
  /** A press: next is true when the panel should show. */
  onToggle?: (next: boolean) => void;
}

export interface FoldToggle {
  /** Moves aria-pressed with no call (the host's own change). */
  set(pressed: boolean): void;
  pressed(): boolean;
  destroy(): void;
}

export interface EdgeStripOptions {
  /** Show panel: the host shows the panel and hides the strip. */
  onShow?: () => void;
  /** The count's words' language (default: the nearest [lang], else en). */
  lang?: string;
}

export interface EdgeStrip {
  setCount(n: number, what?: EdgeStripCountKind): void;
  destroy(): void;
}

/** <button class="den-fold" aria-pressed>: an icon, then "Panel". */
export declare function foldToggleHtml(model?: FoldToggleModel): string;

/** <div class="den-strip" role="complementary">, 40px: Show panel, the count. */
export declare function edgeStripHtml(model?: EdgeStripModel): string;

/** A press moves aria-pressed and calls onToggle(next). */
export declare function hydrateFoldToggle(
  button: HTMLElement | null,
  opts?: FoldToggleOptions,
): FoldToggle;

/**
 * Show panel calls onShow(); then, when focus is still in the strip (now
 * hidden) or on the body, it goes to the fold toggle for the same panel,
 * else to the panel when it takes focus.
 */
export declare function hydrateEdgeStrip(
  strip: HTMLElement | null,
  opts?: EdgeStripOptions,
): EdgeStrip;
