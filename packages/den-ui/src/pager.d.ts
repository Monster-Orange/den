export interface PagerWords {
  range?: string;
  label?: string;
  prev?: string;
  next?: string;
  more?: string;
  last?: string;
  all?: string;
  moreErr?: string;
}

export interface PagerModel {
  mode?: "pages" | "more";
  from: number;
  to: number;
  total: number;
  step?: number;
  prevHref?: string;
  nextHref?: string;
  moreHref?: string;
  lang?: string;
  words: PagerWords;
}

export interface PagerLoad {
  html: string;
  to: number;
  moreHref?: string;
}

export interface PagerOptions {
  load?: () => Promise<PagerLoad>;
  list?: HTMLElement | string | null;
}

export interface Pager {
  destroy(): void;
}

export declare function pagerHtml(model: PagerModel): string;

export declare function hydratePager(
  el: HTMLElement | null,
  opts?: PagerOptions,
): Pager;
