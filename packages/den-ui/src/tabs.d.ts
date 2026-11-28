export interface TabsItem {
  id: string;
  text: string;
  href?: string;
  count?: number | string;
  disabled?: boolean;
  alert?: boolean;
  panel?: string;
  close?: string;
  dot?: { state: "run" | "ok" | "bad" | "off"; text: string };
}

export interface TabsModel {
  kind?: "page" | "switch" | "panel";
  label: string;
  items: TabsItem[];
  chosen?: string;
  size?: "auto" | "m" | "l";
  min?: 1 | 2;
}

export interface TabsOptions {
  onChange?: (id: string) => boolean | void;
  onClose?: (id: string) => boolean | void;
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
