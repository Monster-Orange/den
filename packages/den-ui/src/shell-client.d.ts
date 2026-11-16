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
