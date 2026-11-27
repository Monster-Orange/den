export interface PagerWords {
  range?: string;
  rangeOpen?: string;
  label?: string;
  first?: string;
  firstSr?: string;
  prev?: string;
  prevSr?: string;
  next?: string;
  nextSr?: string;
  last?: string;
  lastSr?: string;
  pageOf?: string;
  pageShort?: string;
  pageSr?: string;
  go?: string;
  perPage?: string;
  more?: string;
  moreN?: string;
  lastN?: string;
  all?: string;
  moreErr?: string;
}

export type PagerTarget =
  | "first"
  | "prev"
  | "next"
  | "last"
  | { page: number }
  | { per: number };

export interface PagerModel {
  mode?: "pages" | "more";
  from: number;
  to: number;
  total?: number | null;
  hasNext?: boolean;
  page?: number;
  pages?: number;
  per?: number;
  perOptions?: number[];
  href?: (target: PagerTarget) => string | null | undefined;
  step?: number;
  firstHref?: string;
  prevHref?: string;
  nextHref?: string;
  lastHref?: string;
  moreHref?: string;
  lang?: string;
  words: PagerWords;
}

export interface PagerLoad {
  html: string;
  to: number;
  moreHref?: string;
  hasNext?: boolean;
}

export interface PagerNav {
  kind: "page" | "per";
  target: PagerTarget;
  href: string;
}

export interface PagerOptions {
  load?: () => Promise<PagerLoad>;
  list?: HTMLElement | string | null;
  onNavigate?: (ask: PagerNav) => void;
  shortcuts?: boolean | (() => boolean);
}

export interface Pager {
  destroy(): void;
}

export declare function pagerHtml(model: PagerModel): string;

export declare function hydratePager(
  el: HTMLElement | null,
  opts?: PagerOptions,
): Pager;

export declare function cursorHref(
  url: string,
  target: PagerTarget,
  next?: string | null,
  opts?: {
    after?: string;
    back?: string;
    per?: string;
    offset?: string;
    keep?: number;
    size?: number;
  },
): string;

export declare function cursorStart(
  url: string,
  opts?: { offset?: string },
): number;
