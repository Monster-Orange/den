import type {
  AccountMenu,
  AppearanceMenu,
  BellItem,
  BellPanelOptions,
  Chip,
  PageMenuItem,
  WaitingOptions,
} from "./shell-html.js";

export interface HydrateOptions {
  lang?: string | (() => string);
  /** The toggle was pressed: store it, then call shell.setCollapsed(next). */
  onCollapse?: (next: boolean) => void;
  /** Delete on a pinned row. */
  onUnpin?: (id: string) => void;
  /** The elements made inert behind the open drawer. */
  inert?: () => (Element | null)[];
  /** True while a product menu is open (Escape is the menu's then). */
  menuOpen?: () => boolean;
}
export interface Shell {
  nav: HTMLElement | null;
  rove(): void;
  paint(html: string, force?: boolean): boolean;
  setCollapsed(on: boolean): void;
  unpin(id: string): void;
  openDrawer(): void;
  closeDrawer(refocus?: boolean): void;
  drawerOpen(): boolean;
  /** Issue 313: fit the crumbs' labels and the chips (⋯) again now. */
  fitTop(): void;
  syncPinToggles(root: ParentNode, isPinned: (id: string) => boolean): void;
}
export declare function syncPinToggles(
  root: ParentNode,
  isPinned: (id: string) => boolean,
  lang?: string,
): void;
/** Issue 313: the chips that don't fit go behind ⋯, the last first. */
export declare function fitChips<C>(io: {
  chips(): C[];
  overflows(): boolean;
  setOver(chip: C, on: boolean): void;
  showMore(on: boolean): void;
}): C[];
/** Issue 313: a crumb's label narrower than min() and cut hides. */
export declare function fitCrumbLabels<L>(io: {
  labels(): L[];
  min(): number;
  width(label: L): number;
  whole(label: L): boolean;
  setCut(label: L, on: boolean): void;
}): L[];
/** Issue 313: ⋯'s open menu stays open across a re-fit with the same chips behind it. */
export declare function keepChipsMenu<C>(before: C[], after: C[]): boolean;
/** Issue 313: a chip behind ⋯ takes ⋯'s box and focus (at null: its own again). */
export declare function standInChip(
  chip: object | null,
  at: { getBoundingClientRect(): unknown; focus(o?: unknown): void } | null,
): void;
/** Issue 313: repaint a chip from new data, in place. */
export declare function setChip(el: Element | null, c?: Chip): void;
export declare function hydrateShell(
  root: ParentNode,
  opts?: HydrateOptions,
): Shell;

/** 0.7.0: the scope crumbs' menus. */
export interface ScopeHydrateOptions {
  /** A crumb whose menu is the host's (menu: true) was opened. */
  onOpen?: (key: string, button: HTMLElement) => void;
}
export interface ScopeHandle {
  close(): void;
  isOpen(): boolean;
}
export declare function hydrateScope(
  root: ParentNode & EventTarget,
  opts?: ScopeHydrateOptions,
): ScopeHandle;
export interface SearchHydrateOptions {
  /** A click or Enter ("click"), ⌘K or Ctrl-K ("key"). */
  onActivate?: (via: string, event?: Event) => void;
  /** false: no ⌘K / Ctrl-K. */
  keys?: boolean;
}
export interface SearchHandle {
  activate(via?: string): void;
  destroy(): void;
}
export declare function hydrateSearch(
  button: HTMLElement | null,
  opts?: SearchHydrateOptions,
): SearchHandle;
export interface BellHydrateOptions {
  lang?: string | (() => string);
  title?: string;
  titleId?: string;
  items?: BellItem[] | (() => BellItem[]);
  empty?: { text?: string; more?: string };
  foot?: string | (() => string);
  /** The whole content: HTML, or bellPanelHtml's options. */
  panel?: () => string | BellPanelOptions;
  onOpen?: () => void;
  onClose?: () => void;
  /** An Esc while open: true when the host took it (the panel stays). */
  onEscape?: (e: KeyboardEvent) => boolean | void;
  /** The panel's id (default "den-bell-pop"). */
  id?: string;
}
export interface BellHandle {
  el: HTMLElement;
  open(): void;
  close(focus?: boolean): void;
  isOpen(): boolean;
  paint(): void;
  setCount(n: number): void;
}
export declare function hydrateBell(
  button: HTMLElement,
  opts?: BellHydrateOptions,
): BellHandle;
export interface AccountHydrateOptions {
  lang?: string | (() => string);
  /** The entry as an action (no href, no menu): a click calls it. */
  onAction?: (e: Event) => void;
  /** The entry's menu (`menu: true` on the entry), each time it opens. */
  menu?: () => Omit<AccountMenu, "lang">;
  /** A button entry's pick: "item" and its id. */
  onPick?: (kind: string, value: string | null, row: HTMLElement) => void;
  /** A form entry's submit; preventDefault keeps it from posting. */
  onSubmit?: (e: SubmitEvent, form: HTMLFormElement) => void;
}
/**
 * A type-to-filter field for a host's own menu (.den-mi entries), when it
 * has more entries than `filter` allows (past 6 by default): the field
 * (focus it once the menu shows), else null. The menu's rows (and its
 * role and name) move into a `.den-mlist` role="menu" list, id
 * `<menu id>-list`; `menu` keeps its id and becomes the pop-up holding the
 * field, the list and "No match" (a menu owns only its items).
 */
export declare function attachMenuFilter(
  menu: HTMLElement,
  o?: {
    label?: string;
    lang?: string;
    filter?: boolean | number;
    onClose?: (refocus: boolean) => void;
  },
): HTMLInputElement | null;
/** The account entry: its menu's handle when it has one, else nothing. */
export declare function hydrateAccount(
  root: ParentNode & EventTarget,
  opts?: AccountHydrateOptions,
): AppearanceHandle | void;
export interface AppearanceHydrateOptions {
  lang?: string | (() => string);
  /** The menu's content, each time it opens. */
  menu?: () => Omit<AppearanceMenu, "lang">;
  /** A pick: "mode", "theme", "language" or "item", and its value. */
  onPick?: (kind: string, value: string | null, row: HTMLElement) => void;
}
export interface AppearanceHandle {
  open(): void;
  close(refocus?: boolean): void;
  isOpen(): boolean;
}
export declare function hydrateAppearance(
  button: HTMLElement,
  opts?: AppearanceHydrateOptions,
): AppearanceHandle;
export interface PageMenuHydrateOptions {
  /** The items, or a function giving them each time the menu opens. */
  items: PageMenuItem[] | (() => PageMenuItem[]);
  /** A pick of an item with no onSelect of its own. */
  onSelect?: (id: string, item: PageMenuItem) => void;
  lang?: string | (() => string);
}
/** The page action menu on the button pageMenuButtonHtml drew. */
export declare function hydratePageMenu(
  button: HTMLElement,
  opts: PageMenuHydrateOptions,
): AppearanceHandle;
/** The update-waiting pill after the version chip; null hides it. */
export declare function setWaiting(
  o: (WaitingOptions & { onClick?: (e: Event) => void }) | null,
  root?: Document | Element,
): HTMLElement | null;
