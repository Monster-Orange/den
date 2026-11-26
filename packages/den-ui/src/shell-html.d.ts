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
  /**
   * The mark: `src`, an image file drawn as Den draws its theme's mark
   * (the default is the kit's `marks/den.svg`); else text (escaped) or the
   * product's own svg markup, named by label.
   */
  mark?: Mark | null;
}
/** 0.7.3: the fixed kinds a rail entry's tag may name. */
export type NavKindId = "project" | "den" | "service" | "hub";
/**
 * 0.7.3: a rail entry's kind: a fixed one (any case), or an artifact pin's
 * own kind word (the host's, in its language). Never a machine's name.
 */
export type NavKind = NavKindId | Uppercase<NavKindId> | { artifact: string };
/**
 * 0.7.4: why a rail entry is off (greyed; the kit's words say why):
 * not connected yet, its sign-in no longer accepted, not allowed (an
 * admin decides), can't be reached, or its settings have a problem.
 */
export type NavOff =
  | "connect"
  | "reconnect"
  | "forbidden"
  | "unreachable"
  | "config";
/** 0.7.3: what a rail badge counts (the kit's words for it). */
export type BadgeWhat = "open" | "waiting" | "down" | "running";
/** 0.7.3: a project's initial, in a disc in place of the icon. */
export interface NavInitial {
  initial: string;
}
export interface NavItem {
  id: string;
  label: string;
  href: string;
  group?: string;
  /** An icon's name (icons.js), or (0.7.3) a project's initial disc. */
  icon?: string | NavInitial;
  tip?: string;
  current?: boolean;
  /**
   * A count. `what` (0.7.3): what it counts; the kit words it with the
   * name ("North · Den, 3 waiting"). Hosts pass data, never the words.
   */
  badge?: {
    n: number | string;
    bad?: boolean;
    warn?: boolean;
    what?: BadgeWhat;
  } | null;
  /** HTML in place of the icon (a status dot). */
  lead?: string;
  mono?: boolean;
  cls?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** The pinned id: the row is a pin row (Delete unpins it). */
  pin?: string | null;
  /** HTML after the link inside the pin row. */
  after?: string;
  /**
   * 0.7.3: a small uppercase tag at the row's end (pins and links into
   * another product); the tooltip and name are always the kit's,
   * "<label> · <Kind>" (a host's tip, title or aria-label is not used).
   */
  kind?: NavKind | null;
  /**
   * 0.7.4: the entry is off: greyed (.den-off), and its tooltip and name
   * say why in the kit's words ("Acme Co · Hub, reconnect in Settings").
   * Any other value is dropped.
   */
  off?: NavOff | null;
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
  /** Issue 1444: the folded sections' ids; never the current page's. */
  folded?: string[];
}
export interface ShellModel extends RailModel {
  product?: Product;
  slots?: Slots;
  /** false: no Report button (reports off). */
  report?: boolean;
  /**
   * Issue 694: false for a page with no rail. The top bar draws no ☰ and
   * no aria-controls for the rail (stamped data-nav-shape="no-rail");
   * shellHtml draws no rail. Default true.
   */
  rail?: boolean;
}
export declare function navItemHtml(
  n: NavItem,
  navRole?: string,
  lang?: string,
): string;
/** 0.7.3: attributes that carry a host's words (flagged in an entry of the rail). */
export declare const HOST_TEXT_ATTRS: readonly string[];
/** 0.7.3: what a badge may count. */
export declare const BADGE_WHATS: readonly BadgeWhat[];
/** 0.7.3: the fixed kinds. */
export declare const NAV_KINDS: readonly NavKindId[];
/** 0.7.4: the reasons an entry may be off. */
export declare const NAV_OFFS: readonly NavOff[];
/** 0.7.4: an entry's off reason, from its data (any case), or null. */
export declare function navOff(off: unknown): NavOff | null;
/** 0.7.3: a kind's id ("artifact" for an artifact's) and its word. */
export declare function navKind(
  kind: NavKind | null | undefined,
  lang?: string,
): { id: NavKindId | "artifact"; word: string } | null;
export declare function railGroupHtml(
  g: NavGroup,
  body: string,
  lang?: string,
  /** Issue 1444: drawn data-folded (hydrateRailFolds hides its entries). */
  folded?: boolean,
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
/** The search's placeholder and name are the kit's words ("Search…"). */
export interface SearchOptions {
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
  /**
   * Issue 101: the rows of the panel's two sections, in place of rows:
   * the kit heads them "Needs you" (always first) and "Earlier".
   */
  sections?: { needs: string; done?: string; earlier?: string };
  /** The empty state: its words, and HTML under them. */
  empty?: { text?: string; more?: string };
  after?: string;
  foot?: string;
  lang?: string;
}
export interface Account {
  /** 0.7.1: who is signed in, as data. The kit draws the name, then @login. */
  name?: string;
  /** The login, without "@" (the kit adds it). */
  login?: string;
  /** Shown in the account menu's header only, never in the rail's entry. */
  role?: string;
  /** No identity known: the kit's word for this computer ("Local"). */
  local?: boolean;
  lang?: string;
  /** @deprecated 0.7.1: use name (flagged by the nav inventory). */
  label?: string;
  /** @deprecated 0.7.1: use login (flagged by the nav inventory). */
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
/** The rail's account entry; nobody known, "". */
export declare function accountHtml(a: Account | null | undefined): string;
/**
 * Issue 656: whether a display name is just the login (trimmed, a leading
 * "@" dropped, case ignored). The kit draws such a name as no name.
 */
export declare function sameAsLogin(
  name: string | null | undefined,
  login: string | null | undefined,
): boolean;
/** Who is signed in, as the kit draws it: its lines and its shape. */
export declare function accountWho(
  a: Account | null | undefined,
  o?: { menu?: boolean },
): {
  lines: string[];
  /** The role: the menu's header only. */
  role: string;
  shape: string;
  legacy: boolean;
  full: string;
} | null;
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
  /** Who is signed in, as data (0.7.1), drawn as the entry is. */
  name?: string;
  login?: string;
  role?: string;
  /** @deprecated 0.7.1: use login (flagged by the nav inventory). */
  detail?: string;
  items?: AccountMenuItem[];
  lang?: string;
}
/** Whether a menu of n entries gets the filter field (see Crumb.filter). */
export declare function menuHasFilter(
  filter: boolean | number | undefined,
  n: number,
): boolean;
/**
 * A menu's filter field (aria-controls `<menuId>-list`, the role="menu"
 * list) and its "No match" line: [field, none].
 */
export declare function menuFilterParts(
  menuId: string,
  label?: string,
  lang?: string,
): [string, string];
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
/** One row of a kit menu (◐ ▾, the account menu and the page menu draw theirs with it). */
export interface MenuRow {
  label: string;
  /** A link (a disabled one is drawn as a button: nothing to follow). */
  href?: string | null;
  /** A radio: aria-checked. */
  checked?: boolean | null;
  /** data-kind and data-value: what a pick reports. */
  kind?: string | null;
  value?: string | number | null;
  id?: string | null;
  /** A class of its own, after den-mi. */
  cls?: string | null;
  /** aria-disabled="true". */
  disabled?: boolean;
  /** The id of the line that says why. */
  describedBy?: string | null;
}
export declare function menuRowHtml(r: MenuRow): string;
/** A host's words: text, or a key in the kit's tables (addStrings) and its vars. */
export type HostWords =
  | string
  | { key: string; vars?: Record<string, unknown> };
/** An item of the page action menu, or a rule. */
export type PageMenuItem =
  | {
      id: string;
      label: HostWords;
      /** A link to follow; else a button (onSelect). */
      href?: string;
      disabled?: boolean;
      /** Why it is disabled: drawn under it, and its description. */
      note?: HostWords;
      /** Where to turn it on: the note becomes a row to follow. */
      noteHref?: string;
      /** Its own pick (hydratePageMenu), before opts.onSelect. */
      onSelect?: (item: PageMenuItem) => void;
    }
  | { hr: true };
/** More ▾: the kit's button, a menu button. */
export declare function pageMenuButtonHtml(o?: {
  id?: string;
  size?: "sm";
  lang?: string;
}): string;
/** The page action menu's rows, from data. */
export declare function pageMenuHtml(o: {
  /** The menu button's id: each row's id is "<id>-<item id>". */
  id?: string;
  items: PageMenuItem[];
  lang?: string;
}): string;
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

/** The brand's mark: an image file, text, or the host's own svg markup. */
export interface Mark {
  src?: string;
  text?: string;
  svg?: string;
  label: string;
}
/** The brand's mark (#den-mark); see Mark. */
export declare function markHtml(mark?: Mark | null): string;
