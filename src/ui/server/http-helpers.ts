/**
 * Shared HTTP helpers for the den web server.
 *
 * Extracted so route handlers in separate files can import them
 * without depending on index.ts.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { brandHtmlTitle, readBrand } from "../../shared/brand.js";
import { fillProductTokens } from "../../shared/product.js";
import { addDenUiMarker } from "../../shared/ui-marker.js";
import { engineVersion } from "../../shared/paths.js";
import { isStampedFile, stampAssetUrls } from "./asset-stamp.js";

// ── MIME types ────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".zip": "application/zip",
  ".txt": "text/plain",
};

function mime(filePath: string): string {
  return (
    MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** readBody's error when a body is over its maxBytes. */
export class BodyTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`the body is over ${maxBytes} bytes`);
  }
}

/**
 * The request's body as text. With maxBytes, a longer body stops being
 * kept at that size (the rest is read and dropped, so the answer still
 * reaches the client) and the promise rejects with BodyTooLarge.
 */
export function readBody(
  req: http.IncomingMessage,
  maxBytes?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        over = true;
        body = "";
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () =>
      over ? reject(new BodyTooLarge(maxBytes!)) : resolve(body),
    );
    req.on("error", reject);
  });
}

/**
 * Issue 621: a body read up to `max` bytes; null once it is longer (the
 * rest is drained, never kept).
 */
export function readBodyCapped(
  req: http.IncomingMessage,
  max: number,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(over ? null : Buffer.concat(chunks).toString("utf-8")),
    );
    req.on("error", reject);
  });
}

/** The methods Den serves. Any other answers 405 before any route. */
export const SERVED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** 405, with the methods the route takes. No CORS header: Den serves none. */
export function sendMethodNotAllowed(
  res: http.ServerResponse,
  allow = "GET, HEAD, POST, PUT, PATCH, DELETE",
): void {
  res.setHeader("Allow", allow);
  sendJson(
    res,
    {
      ok: false,
      code: "method_not_allowed",
      error: `This method isn't served here. Allowed: ${allow}.`,
    },
    405,
  );
}

/** True when the request is a GET or HEAD (or one of `also`); else answers 405 (a route's own check). */
export function readMethodOnly(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  also: readonly string[] = [],
): boolean {
  const m = (req.method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || also.includes(m)) return true;
  sendMethodNotAllowed(res, ["GET", "HEAD", ...also].join(", "));
  return false;
}

export function sendJson(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    // API responses are live state (health dots, workspace config) — never
    // let a browser or proxy serve yesterday's answer.
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * A last fill for every served page, set by the server: the appearance
 * placeholders the pre-paint script reads (@@DEN_MODE@@, @@DEN_DEFAULT_MODE@@).
 */
let htmlFill: ((html: string) => string) | null = null;
export function setHtmlFill(fn: ((html: string) => string) | null): void {
  htmlFill = fn;
}

/**
 * Issue 231: the version stamped on every same-origin .css/.js URL in what
 * Den serves (asset-stamp.ts). The server sets the version it loaded at
 * start; until then, Den's own package.json, read once.
 */
let assetVersion: string | null | undefined;
export function setAssetVersion(v: string | null): void {
  assetVersion = v;
}
/** Text served as a page, script or stylesheet, its asset URLs stamped. */
export function stampServed(file: string, text: string): string {
  if (assetVersion === undefined) assetVersion = engineVersion() ?? null;
  return assetVersion && isStampedFile(file)
    ? stampAssetUrls(text, assetVersion)
    : text;
}

export function serveFile(
  res: http.ServerResponse,
  filePath: string,
  /** A page served from another's file (the Graph page): its raw text in, out. */
  transform?: (html: string) => string,
  /** The status to answer with (an error page's: R26a). */
  status = 200,
): void {
  try {
    let data: Buffer | string = fs.readFileSync(filePath);
    if (transform) data = transform(data.toString("utf-8"));
    // Pages are static and product-neutral: their product names are
    // placeholders (__DEN_CLI__, …) filled from the running profile.
    if (filePath.endsWith(".html") || filePath.endsWith(".js"))
      data = fillProductTokens(data.toString("utf-8"));
    if (filePath.endsWith(".html")) {
      data = addDenUiMarker(brandHtmlTitle(String(data), readBrand()));
      if (htmlFill) data = htmlFill(data);
    }
    if (isStampedFile(filePath)) data = stampServed(filePath, String(data));
    const headers: Record<string, string> = { "Content-Type": mime(filePath) };
    // App code must never be stale (no ETag/Last-Modified validators are sent,
    // so any heuristic caching would have no way to revalidate).
    if (filePath.endsWith(".html") || filePath.endsWith(".js"))
      headers["Cache-Control"] = "no-store";
    res.writeHead(status, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

/**
 * 0.4.15: the headers for a file something other than Den wrote (a test
 * run's report: an agent may have written it). CSP `sandbox` without
 * allow-same-origin runs its scripts in an opaque origin, so they can't
 * read Den's localStorage (the approval key) or act as Den's page;
 * nosniff keeps a .json from being run as a page. Issue 103: framed by
 * Den's own pages only (the Tests page's report frame), as every page is.
 */
export const UNTRUSTED_FILE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "sandbox allow-scripts allow-popups allow-downloads; frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

/** A file something other than Den wrote, as it is (no product tokens), sandboxed. */
export function serveUntrustedFile(
  res: http.ServerResponse,
  filePath: string,
): void {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime(filePath),
    ...UNTRUSTED_FILE_HEADERS,
  });
  res.end(data);
}

export function send400(res: http.ServerResponse, msg: string): void {
  res.writeHead(400, { "Content-Type": "text/plain" });
  res.end(msg);
}

export function send404(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}
