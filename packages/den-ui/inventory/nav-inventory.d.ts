/** A Playwright Page, or anything that evaluates a function in a page. */
export interface NavPage {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}
/** Where an element sits: the top bar, the rail, or the rail's foot. */
export type NavSlot = "top" | "rail" | "foot";
export interface NavBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface NavElement {
  /** "#id", '[data-nav="x"]', or the parent's key " > " tag.class[n]. */
  key: string;
  parent: string | null;
  slot: NavSlot;
  role: string;
  tag: string;
  /** aria-label, else aria-labelledby, else alt, else its text, else title. */
  name: string;
  classes: string[];
  box: NavBox;
  /** Computed styles, by property name (STYLE_PROPS). */
  style: Record<string, string>;
}
export interface NavSnapshot {
  version: number;
  viewport: { w: number; h: number };
  userAgent: string;
  elements: NavElement[];
  /** Each colour seen → the :root --tokens that compute to it. */
  tokens: Record<string, string[]>;
}
export interface NavCompareOptions {
  /** Keys ("#den-status") or one class (".den-scope"): left out, with all under them. */
  hostSlots?: string[];
  /** Tokens ("--accent") whose colour may differ. */
  themeTokens?: string[];
  /** How far a box edge may move, in px (default 2). */
  tolerance?: number;
}
export interface NavDiff {
  key: string;
  slot: NavSlot | "";
  /** "element", "order", "slot", "role", "tag", "name", "classes", "box.<edge>", "style.<prop>", "version". */
  property: string;
  reference: string | number;
  actual: string | number;
}
export declare const STYLE_PROPS: string[];
export declare const COLOR_PROPS: string[];
export declare const NAV_INVENTORY_VERSION: number;
export declare function collectNav(page: NavPage): Promise<NavSnapshot>;
export declare function compareNav(
  actual: NavSnapshot,
  reference: NavSnapshot,
  opts?: NavCompareOptions,
): NavDiff[];
export declare function formatNavDiffs(diffs: NavDiff[]): string;
