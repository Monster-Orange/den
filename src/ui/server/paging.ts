import type * as http from "http";
import { readUserConfig } from "../../shared/den-config.js";
import { sendJson } from "./http-helpers.js";
import {
  PAGE_DEFAULT,
  PAGE_MAX_DEFAULT,
  PAGE_MAX_RANGE,
} from "../../shared/list-page.js";

export { PAGE_DEFAULT, PAGE_MAX_DEFAULT, PAGE_MAX_RANGE };

export type PageKeyPart = string | number;
export type PageKey = PageKeyPart | PageKeyPart[];
export type PageDir = "next" | "prev";

export interface PageMark {
  key: PageKey;
  id: string;
}

export interface PageAsk {
  list: string;
  limit: number;
  after: PageMark | null;
  dir: PageDir;
  page: number | null;
  at: "first" | "last" | null;
}

export interface Page<T> {
  items: T[];
  next: string | null;
  prev: string | null;
  total?: number;
  offset?: number;
  page?: number;
  pages?: number;
}

export interface PageError {
  status: 400;
  code: "bad_limit" | "bad_cursor" | "bad_page";
  error: string;
}

export function pageMax(read = readUserConfig): number {
  try {
    const v = Number(read().web?.list_page_max);
    return Number.isInteger(v) &&
      v >= PAGE_MAX_RANGE.min &&
      v <= PAGE_MAX_RANGE.max
      ? v
      : PAGE_MAX_DEFAULT;
  } catch {
    return PAGE_MAX_DEFAULT;
  }
}

const isPart = (v: unknown): v is PageKeyPart =>
  typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

export function encodeCursor(
  list: string,
  mark: PageMark,
  dir: PageDir = "next",
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      l: list,
      k: mark.key,
      i: mark.id,
      ...(dir === "prev" ? { d: "p" } : {}),
    }),
  ).toString("base64url");
}

export function decodeCursor(
  c: string,
  list: string,
): { after: PageMark; dir: PageDir } | null {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(c)) return null;
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf-8")) as {
      v?: unknown;
      l?: unknown;
      k?: unknown;
      i?: unknown;
      d?: unknown;
    };
    const keyOk = Array.isArray(o.k)
      ? o.k.length > 0 && o.k.every(isPart)
      : isPart(o.k);
    if (o.v !== 1 || o.l !== list || !keyOk || typeof o.i !== "string")
      return null;
    if (o.d !== undefined && o.d !== "p") return null;
    return {
      after: { key: o.k as PageKey, id: o.i },
      dir: o.d === "p" ? "prev" : "next",
    };
  } catch {
    return null;
  }
}

const badPage = (error: string): PageError => ({
  status: 400,
  code: "bad_page",
  error,
});

export function readPageAsk(
  q: URLSearchParams | string,
  list: string,
  max = pageMax(),
): PageAsk | PageError {
  const p =
    typeof q === "string" ? new URL(q, "http://localhost").searchParams : q;
  const rawLimit = p.get("limit");
  let limit = Math.min(PAGE_DEFAULT, max);
  if (rawLimit !== null && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1)
      return {
        status: 400,
        code: "bad_limit",
        error: `limit is a whole number from 1 (at most ${max}), got ${JSON.stringify(rawLimit.slice(0, 20))}`,
      };
    limit = Math.min(n, max);
  }
  const ask: PageAsk = {
    list,
    limit,
    after: null,
    dir: "next",
    page: null,
    at: null,
  };
  const rawCursor = p.get("cursor") || null;
  const rawPage = p.get("page") || null;
  const rawAt = p.get("at") || null;
  if ([rawCursor, rawPage, rawAt].filter((v) => v !== null).length > 1)
    return badPage("send one of cursor, page and at, not two");
  if (rawCursor !== null) {
    const c = decodeCursor(rawCursor, list);
    if (!c)
      return {
        status: 400,
        code: "bad_cursor",
        error: "cursor is not one this list gave: start again without it",
      };
    return { ...ask, after: c.after, dir: c.dir };
  }
  if (rawPage !== null) {
    const n = Number(rawPage);
    if (!Number.isInteger(n) || n < 1)
      return badPage(
        `page is a whole number from 1, got ${JSON.stringify(rawPage.slice(0, 20))}`,
      );
    return { ...ask, page: n };
  }
  if (rawAt !== null) {
    if (rawAt !== "first" && rawAt !== "last")
      return badPage(
        `at is first or last, got ${JSON.stringify(rawAt.slice(0, 20))}`,
      );
    return { ...ask, at: rawAt };
  }
  return ask;
}

export function isPageError(a: PageAsk | PageError): a is PageError {
  return "code" in a;
}

const parts = (k: PageKey): PageKeyPart[] => (Array.isArray(k) ? k : [k]);

const num = (v: number): number => (Number.isNaN(v) ? 0 : v);

function cmpPart(a: PageKeyPart, b: PageKeyPart): number {
  if (typeof a === "number" && typeof b === "number") return num(a) - num(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function comparePageKeys(a: PageMark, b: PageMark): number {
  const pa = parts(a.key);
  const pb = parts(b.key);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const c = cmpPart(pa[i]!, pb[i]!);
    if (c) return c;
  }
  return cmpPart(a.id, b.id);
}

export function pageCount(total: number, limit: number): number {
  return Math.max(1, Math.ceil(total / limit));
}

export interface PageOpts<T> {
  key: (row: T) => PageKey;
  id: (row: T) => string;
  order?: "asc" | "desc";
  filter?: (row: T) => boolean;
  total?: boolean;
}

export function pageOf<T>(
  rows: readonly T[],
  ask: PageAsk,
  o: PageOpts<T>,
): Page<T> {
  const sign = o.order === "desc" ? -1 : 1;
  const keyed = rows
    .filter((r) => (o.filter ? o.filter(r) : true))
    .map((row) => ({ row, key: o.key(row), id: o.id(row) }))
    .sort((a, b) => sign * comparePageKeys(a, b));
  const n = keyed.length;
  const L = ask.limit;
  const pages = pageCount(n, L);
  const firstAt = (pred: (r: PageMark) => boolean): number => {
    const i = keyed.findIndex(pred);
    return i < 0 ? n : i;
  };
  let start = 0;
  const after = ask.after;
  if (after && ask.dir === "prev")
    start = Math.max(
      0,
      firstAt((r) => sign * comparePageKeys(r, after) >= 0) - L,
    );
  else if (after)
    start = firstAt((r) => sign * comparePageKeys(r, after) > 0);
  else if (ask.page !== null) start = (Math.min(ask.page, pages) - 1) * L;
  else if (ask.at === "last") start = (pages - 1) * L;
  const slice = keyed.slice(start, start + L);
  const first = slice[0];
  const last = slice[slice.length - 1];
  return {
    items: slice.map((r) => r.row),
    next:
      last && start + slice.length < n ? encodeCursor(ask.list, last) : null,
    prev: first && start > 0 ? encodeCursor(ask.list, first, "prev") : null,
    ...(o.total
      ? {
          total: n,
          offset: start,
          page: Math.floor(start / L) + 1,
          pages,
        }
      : {}),
  };
}

export function sendPageError(res: http.ServerResponse, e: PageError): void {
  sendJson(res, { ok: false, code: e.code, error: e.error }, e.status);
}
