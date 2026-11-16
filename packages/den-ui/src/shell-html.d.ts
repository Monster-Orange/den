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
  /** The mark: text (escaped) or the product's own svg, named by label. */
  mark?: { text?: string; svg?: string; label: string } | null;
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
  /** 0.7.0: the Settings entry, after foot. */
  settings?: SettingsEntry | null;
  /** 0.7.0: the account entry, last in the foot. */
  account?: Account | null;
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
  /** The button's own words, and its accessible name (escaped). */
  label?: string;
  /** Kept on the button as JSON; the kit's click opens Report with it. */
  prefill?: { kind?: string; title?: string; description?: string };
}): string;
/** A Report button's prefill (its data-den-report-prefill), or undefined. */
export declare function reportPrefillOf(
  el: Element | null | undefined,
): { kind?: string; title?: string; description?: string } | undefined;
export declare function topBarHtml(model?: ShellModel): string;
/** The whole shell: skip link, top bar and rail, as HTML. Pure: runs in Node. */
export declare function shellHtml(model?: ShellModel): string;

/** 0.7.0: a link in a crumb's own menu. */
export interface CrumbLink {
  label: string;
  href: string;
  current?: boolean;
}
/** 0.7.0: one scope crumb (COMPANY, PROJECT, ENV …). */
export interface Crumb {
  /** Its kind: data-scope, the id "den-scope-<key>", "den-<key>-sep". */
  key?: string;
  /** The small-caps word. */
  label: string;
  value?: string;
  /**
   * Links or HTML: the kit draws and opens the menu. true: the host opens
   * its own (hydrateScope's onOpen). None: a plain label, no ▾.
   */
  menu?: CrumbLink[] | string | true | null;
  id?: string;
  title?: string;
  hidden?: boolean;
  /** The first to give way on a narrow bar. */
  optional?: boolean;
  cls?: string;
  valueCls?: string;
  /**
   * A type-to-filter field at the top of a list of links: by default past
   * 6 of them; a number sets that threshold; true always; false never.
   */
  filter?: boolean | number;
}
export interface ScopeOptions {
  crumbs?: (Crumb | null | undefined | false)[];
  /** The group's name (default the kit's "Scope"). */
  label?: string;
  lang?: string;
  /** The host's HTML at the group's end. */
  after?: string;
}
export interface SearchOptions {
  placeholder?: string;
  /** Its name (default the placeholder). */
  label?: string;
  id?: string;
  /** false: no ⌘K inside, and no aria-keyshortcuts. */
  shortcut?: boolean;
  lang?: string;
}
export interface BellButtonOptions {
  count?: number;
  /** Its word (default the kit's "Notifications"). */
  label?: string;
  id?: string;
  lang?: string;
}
export interface BellItem {
  text: string;
  href?: string;
  /** The time as shown ("2 min"). */
  time?: string;
  /** Its ISO stamp, for <time datetime>. */
  datetime?: string;
  read?: boolean;
  id?: string;
}
export interface BellPanelOptions {
  title?: string;
  titleId?: string;
  /** Buttons beside the heading (HTML). */
  actions?: string;
  /** HTML under the heading. */
  lead?: string;
  items?: BellItem[];
  /** The host's own HTML in place of rows. */
  body?: string | null;
  /** The empty state: its words, and HTML under them. */
  empty?: { text?: string; more?: string };
  after?: string;
  foot?: string;
  lang?: string;
}
export interface Account {
  label: string;
  detail?: string;
  /**
   * A link; else `menu: true`, a button opening the account menu
   * (hydrateAccount's menu); else `action: true`, a button
   * (hydrateAccount's onAction).
   */
  href?: string;
  menu?: boolean;
  action?: boolean;
  icon?: string;
  id?: string;
  /** Its data-nav (default "account"). */
  navId?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  current?: boolean;
}
export declare function scopeCrumbHtml(
  c: Crumb | null | undefined,
  lang?: string,
): string;
/** The scope crumbs; no crumbs, "". */
export declare function scopeHtml(o?: ScopeOptions): string;
/** The search field, ⌘K inside it. */
export declare function searchHtml(o?: SearchOptions): string;
/** A count as the badge shows it: "" for none, "99+" past 99. */
export declare function bellCount(n: number | null | undefined): string;
export declare function bellButtonHtml(o?: BellButtonOptions): string;
export declare function bellPanelHtml(o?: BellPanelOptions): string;
/** The rail's account entry; no label, "". */
export declare function accountHtml(a: Account | null | undefined): string;
/** An account menu entry: a link, a button (onPick "item"), or a form post. */
export type AccountMenuItem =
  | { label: string; href: string }
  | { label: string; id: string }
  | {
      label: string;
      action: {
        method?: "post" | "get";
        url: string;
        csrf?: string;
        /** The hidden field's name (default "csrf"). */
        field?: string;
      };
    };
export interface AccountMenu {
  /** Who is signed in. */
  name?: string;
  /** Where ("Signed in · this device"). */
  detail?: string;
  items?: AccountMenuItem[];
  lang?: string;
}
/** The account entry's menu content. */
export declare function accountMenuHtml(o?: AccountMenu): string;
export interface SettingsEntry {
  href: string;
  /** Default the kit's "Settings". */
  label?: string;
  current?: boolean;
  /** Its data-nav (default "settings"). */
  id?: string;
}
export declare function settingsHtml(
  o: SettingsEntry | null | undefined,
  lang?: string,
): string;
export declare function appearanceButtonHtml(o?: {
  id?: string;
  label?: string;
  title?: string;
  lang?: string;
}): string;
export interface AppearanceMenu {
  /** "system", "dark" or "light": the checked mode. */
  mode?: string;
  /** Default the kit's System, Dark, Light. */
  modes?: { value: string; label: string }[];
  themes?: { value: string; label: string; selected?: boolean }[];
  /** A line under the themes. */
  notice?: string | null;
  /** Each named in itself. */
  languages?: { id: string; name: string; current?: boolean }[];
  /** After a rule: links, or buttons onPick("item", id). */
  items?: { label: string; href?: string; id?: string }[];
  lang?: string;
}
export declare function appearanceMenuHtml(o?: AppearanceMenu): string;
export interface WaitingOptions {
  /** The words before the dot ("stale server"). */
  label?: string;
  /** The bold word after it ("Restart"). */
  action?: string;
  title?: string;
  /** Its name. */
  name?: string;
  id?: string;
}
export declare function waitingHtml(o?: WaitingOptions): string;
