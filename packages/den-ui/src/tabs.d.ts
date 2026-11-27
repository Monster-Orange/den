export interface TabsItem {
  id: string;
  text: string;
  href?: string;
  count?: number | string;
  disabled?: boolean;
  panel?: string;
}

export interface TabsModel {
  kind?: "page" | "switch" | "panel";
  label: string;
  items: TabsItem[];
  chosen?: string;
  size?: "auto" | "m" | "l";
  overflow?: "fold" | "scroll";
  lang?: string;
  words?: { moreStart?: string; moreEnd?: string };
}

export declare const TABS_WORDS: Record<
  string,
  { moreStart: string; moreEnd: string }
>;

export interface TabsOptions {
  onChange?: (id: string) => boolean | void;
}

export interface Tabs {
  set(id: string): void;
  chosen(): string;
  destroy(): void;
}

export declare function tabsHtml(model: TabsModel): string;

export declare function hydrateTabs(
  el: HTMLElement | null,
  opts?: TabsOptions,
): Tabs;
