/**
 * One page of a list, for every route and MCP tool that returns rows.
 *
 *   GET …?limit=<n>&cursor=<next from the last page>
 *   → { items, next, total? }
 *
 * limit: 50 when unset, at most web.list_page_max (user.yml, 200). A
 * cursor is opaque: base64url of the last row's sort key and id. The next
 * page starts strictly after that row, so rows written meanwhile never
 * repeat or shift a page. Filters run before the cut. `next` is null on
 * the last page. `total` only where counting costs nothing.
 */
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

export interface PageAsk {
  limit: number;
  after: { key: PageKey; id: string } | null;
}

export interface Page<T> {
  items: T[];
  next: string | null;
  total?: number;
}

export interface PageError {
  status: 400;
  code: "bad_limit" | "bad_cursor";
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

export function encodeCursor(key: PageKey, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: key, i: id })).toString(
    "base64url",
  );
}

export function decodeCursor(c: string): PageAsk["after"] {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(c)) return null;
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf-8")) as {
      v?: unknown;
      k?: unknown;
      i?: unknown;
    };
    const keyOk = Array.isArray(o.k)
      ? o.k.length > 0 && o.k.every(isPart)
      : isPart(o.k);
    if (o.v !== 1 || !keyOk || typeof o.i !== "string") return null;
    return { key: o.k as PageKey, id: o.i };
  } catch {
    return null;
  }
}

/** ?limit and ?cursor from a URL or its search params; a PageError when either is bad. */
export function readPageAsk(
  q: URLSearchParams | string,
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
  const rawCursor = p.get("cursor");
  if (rawCursor === null || rawCursor === "") return { limit, after: null };
  const after = decodeCursor(rawCursor);
  if (!after)
    return {
      status: 400,
      code: "bad_cursor",
      error: "cursor is not one this list gave: start again without it",
    };
  return { limit, after };
}

export function isPageError(a: PageAsk | PageError): a is PageError {
  return "code" in a;
}

const parts = (k: PageKey): PageKeyPart[] => (Array.isArray(k) ? k : [k]);

function cmpPart(a: PageKeyPart, b: PageKeyPart): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ascending (key, id) order; "desc" reverses both. */
export function comparePageKeys(
  a: { key: PageKey; id: string },
  b: { key: PageKey; id: string },
): number {
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

export interface PageOpts<T> {
  key: (row: T) => PageKey;
  id: (row: T) => string;
  order?: "asc" | "desc";
  filter?: (row: T) => boolean;
  /** The rows are in memory already, so their count costs nothing. */
  total?: boolean;
}

/**
 * One page of rows held in memory: filter, sort by (key, id), start after
 * the cursor's row, take `limit`. A source that can seek (a file, Hub,
 * GitHub) builds its own page and still answers with `Page` and
 * `encodeCursor`.
 */
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
  const after = ask.after;
  const from = after
    ? keyed.findIndex((r) => sign * comparePageKeys(r, after) > 0)
    : 0;
  const start = from < 0 ? keyed.length : from;
  const slice = keyed.slice(start, start + ask.limit);
  const last = slice[slice.length - 1];
  const more = start + slice.length < keyed.length;
  return {
    items: slice.map((r) => r.row),
    next: more && last ? encodeCursor(last.key, last.id) : null,
    ...(o.total ? { total: keyed.length } : {}),
  };
}

/** A PageError as the route's 400. */
export function sendPageError(res: http.ServerResponse, e: PageError): void {
  sendJson(res, { ok: false, code: e.code, error: e.error }, e.status);
}
