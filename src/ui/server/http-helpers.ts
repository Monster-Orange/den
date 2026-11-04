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

export function serveFile(res: http.ServerResponse, filePath: string): void {
  try {
    let data: Buffer | string = fs.readFileSync(filePath);
    // Pages are static and product-neutral: their product names are
    // placeholders (__DEN_CLI__, …) filled from the running profile.
    if (filePath.endsWith(".html") || filePath.endsWith(".js"))
      data = fillProductTokens(data.toString("utf-8"));
    if (filePath.endsWith(".html"))
      data = brandHtmlTitle(String(data), readBrand());
    const headers: Record<string, string> = { "Content-Type": mime(filePath) };
    // App code must never be stale (no ETag/Last-Modified validators are sent,
    // so any heuristic caching would have no way to revalidate).
    if (filePath.endsWith(".html") || filePath.endsWith(".js"))
      headers["Cache-Control"] = "no-store";
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

export function send400(res: http.ServerResponse, msg: string): void {
  res.writeHead(400, { "Content-Type": "text/plain" });
  res.end(msg);
}

export function send404(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}
