import type { BellItem, BellPanelOptions } from "./shell-html.js";

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
  syncPinToggles(root: ParentNode, isPinned: (id: string) => boolean): void;
}
export declare function syncPinToggles(
  root: ParentNode,
  isPinned: (id: string) => boolean,
  lang?: string,
): void;
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
export declare function hydrateAccount(
  root: ParentNode & EventTarget,
  opts?: { onAction?: (e: Event) => void },
): void;
