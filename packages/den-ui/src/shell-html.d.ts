export { icon } from "./icons.js";
export { esc } from "./strings.js";

export interface Product {
  /** The word beside the mark. */
  name?: string;
  /** Its tooltip (default: name). */
  title?: string;
  /** The version chip's text ("v" + version; "v…" when unknown). */
  version?: string | null;
  /** Where the brand goes (default "/"). */
  href?: string;
}
export interface NavItem {
  id: string;
  label: string;
  href: string;
  group?: string;
  icon?: string;
  tip?: string;
  current?: boolean;
  badge?: { n: number | string; bad?: boolean; label?: string } | null;
  /** HTML in place of the icon (a status dot). */
  lead?: string;
  mono?: boolean;
  cls?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** The pinned id: the row is a pin row (Delete unpins it). */
  pin?: string | null;
  /** HTML after the link inside the pin row. */
  after?: string;
}
export interface NavGroup {
  id: string;
  label: string;
  /** A "from <d>" tag on the group's heading. */
  from?: string;
}
export interface Slots {
  /** After the brand (a search, a scope menu). */
  start?: string;
  /** The right group's start, before Report (status chips). */
  end?: string;
  /** After Report. */
  bell?: string;
  /** Last, after the version chip. */
  account?: string;
}
export interface RailModel {
  nav?: NavItem[];
  groups?: NavGroup[];
  /** Entries (or HTML) under the rail's spacer, before the collapse toggle. */
  foot?: (NavItem | string)[];
  lang?: string;
  collapsed?: boolean;
}
export interface ShellModel extends RailModel {
  product?: Product;
  slots?: Slots;
  /** false: no Report button (reports off). */
  report?: boolean;
}
export declare function navItemHtml(n: NavItem): string;
export declare function railGroupHtml(
  g: NavGroup,
  body: string,
  lang?: string,
): string;
export declare function railHtml(model?: RailModel): string;
export declare function versionChipHtml(o?: {
  version?: string | null;
  lang?: string;
}): string;
export declare function reportButtonHtml(o?: {
  inFoot?: boolean;
  inTop?: boolean;
  lang?: string;
}): string;
export declare function topBarHtml(model?: ShellModel): string;
/** The whole shell: skip link, top bar and rail, as HTML. Pure: runs in Node. */
export declare function shellHtml(model?: ShellModel): string;
