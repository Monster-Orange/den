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

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
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
 * 0.4.12: the headers for a file something other than Den wrote (a test
 * run's report: an agent may have written it). CSP `sandbox` without
 * allow-same-origin runs its scripts in an opaque origin, so they can't
 * read Den's localStorage (the approval key) or act as Den's page;
 * nosniff keeps a .json from being run as a page.
 */
export const UNTRUSTED_FILE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "sandbox allow-scripts allow-popups allow-downloads",
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
