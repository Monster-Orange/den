/**
 * Errors people can see and act on (R26, 0.3.0-dev.38).
 *
 *   R26a  a page request (a browser navigation: GET/HEAD, Accept text/html,
 *         not /api/*) that fails gets the shell frame around an error page
 *         (public/error.html, drawn by error-page.js): 404 "Page not found"
 *         or 500 "Something went wrong", with the request id (422 "Config
 *         is invalid" for a ConfigError).
 *   R26b  every /api/* error is JSON, one shape:
 *         { ok: false, error, code, requestId }. jsonApiErrors() makes that
 *         true for every route at the response, whatever the route sent
 *         (send400's text, a route's own { ok: false, error } body, …).
 *
 * Each request gets a short id (X-Request-Id on every response); the
 * server log line of a failure carries it, so a person's "request a1b2c3d4"
 * finds the stack trace.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { PLUGIN_FILE, PLUGIN_ID } from "../../shared/plugins/manifest.js";
import { PLUGINS_DIR, readLock } from "../../shared/plugins/store.js";

/** A short request id: 8 hex characters. */
export function newRequestId(): string {
  return randomBytes(4).toString("hex");
}

/** The stable `code` for an HTTP status. */
export function codeForStatus(status: number): string {
  const codes: Record<number, string> = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    408: "timeout",
    409: "conflict",
    410: "gone",
    413: "too_large",
    415: "unsupported_media_type",
    422: "invalid",
    423: "locked",
    429: "rate_limited",
    500: "internal",
    501: "not_implemented",
    502: "bad_gateway",
    503: "unavailable",
    504: "timeout",
  };
  return codes[status] ?? (status >= 500 ? "internal" : `http_${status}`);
}

export interface ApiErrorBody {
  ok: false;
  error: string;
  code: string;
  requestId: string;
  [field: string]: unknown;
}

/**
 * The R26b body for an error response: `raw` is what the route sent. A JSON
 * object keeps its fields (a route's own `runCmd`, `reason`, …) and gains
 * ok, error, code and requestId; text becomes the message.
 */
export function apiErrorBody(
  status: number,
  raw: string,
  requestId: string,
): ApiErrorBody {
  const fallback = http.STATUS_CODES[status] ?? `HTTP ${status}`;
  let obj: Record<string, unknown> | null = null;
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v))
        obj = v as Record<string, unknown>;
    } catch {
      /* text that looks like JSON: the message */
    }
  }
  if (obj) {
    const error =
      typeof obj.error === "string" && obj.error
        ? obj.error
        : typeof obj.message === "string" && obj.message
          ? obj.message
          : fallback;
    return {
      ...obj,
      ok: false,
      error,
      code:
        typeof obj.code === "string" && obj.code
          ? obj.code
          : codeForStatus(status),
      requestId,
    };
  }
  return {
    ok: false,
    error: text || fallback,
    code: codeForStatus(status),
    requestId,
  };
}

/**
 * Make every error status this response ends with a JSON R26b body. A 2xx
 * or 3xx (an SSE stream among them) passes through untouched; an error's
 * body is held until end() and rewritten. Call once per /api request,
 * before the route runs.
 */
export function jsonApiErrors(
  res: http.ServerResponse,
  requestId: string,
): void {
  const origWriteHead = res.writeHead.bind(res) as (
    ...a: unknown[]
  ) => http.ServerResponse;
  const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
  const origEnd = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
  let held: { status: number; headers: http.OutgoingHttpHeaders } | null = null;
  const chunks: Buffer[] = [];
  const isError = (s: number): boolean => s >= 400;

  const hold = (status: number, headers: unknown): void => {
    const h: http.OutgoingHttpHeaders = {};
    if (Array.isArray(headers)) {
      for (let i = 0; i + 1 < headers.length; i += 2)
        h[String(headers[i]).toLowerCase()] = headers[i + 1] as string;
    } else if (headers && typeof headers === "object") {
      for (const [k, v] of Object.entries(headers))
        h[k.toLowerCase()] = v as string;
    }
    held = { status, headers: h };
  };

  (res as unknown as { writeHead: unknown }).writeHead = (
    status: number,
    ...rest: unknown[]
  ) => {
    if (!isError(status)) return origWriteHead(status, ...rest);
    const headers =
      typeof rest[0] === "string" ? rest[1] : (rest[0] as unknown);
    hold(status, headers);
    return res;
  };
  (res as unknown as { write: unknown }).write = (
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    if (!held && !res.headersSent && isError(res.statusCode))
      hold(res.statusCode, {});
    if (!held) return origWrite(chunk, ...rest);
    if (chunk != null && typeof chunk !== "function")
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf-8"),
      );
    return true;
  };
  (res as unknown as { end: unknown }).end = (...args: unknown[]) => {
    if (!held && !res.headersSent && isError(res.statusCode))
      hold(res.statusCode, {});
    if (!held) return origEnd(...args);
    const chunk = args[0];
    if (chunk != null && typeof chunk !== "function")
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf-8"),
      );
    const h = held as { status: number; headers: http.OutgoingHttpHeaders };
    held = null;
    const body = JSON.stringify(
      apiErrorBody(
        h.status,
        Buffer.concat(chunks).toString("utf-8"),
        requestId,
      ),
    );
    const headers: http.OutgoingHttpHeaders = { ...h.headers };
    delete headers["content-length"];
    headers["content-type"] = "application/json";
    headers["cache-control"] = "no-store";
    origWriteHead(h.status, headers);
    return origEnd(body);
  };
}

/** A browser navigation to a page: what gets the shell's error page. */
export function wantsHtmlPage(
  req: http.IncomingMessage,
  pathname: string,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  return String(req.headers.accept ?? "").includes("text/html");
}

/**
 * What failed, for a person and the log, never with query values: the
 * path, with id-like segments (numbers, long hex, uuids) as `:id`.
 */
export function routeTemplate(pathname: string): string {
  return (
    pathname
      .split("/")
      .map((seg) =>
        /^\d+$/.test(seg) ||
        /^[0-9a-f]{12,}$/i.test(seg) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)
          ? ":id"
          : seg,
      )
      .join("/") || "/"
  );
}

export interface PluginRoute {
  id: string;
  /** Its name from its manifest, when it is installed. */
  name: string | null;
  installed: boolean;
  /** In plugins.lock.json (added, but its files are missing). */
  locked: boolean;
}

/**
 * The plugin a page path belongs to: plugin pages live under
 * /plugins/<id>/ (PL-SPEC §4: served from plugins/<id>/). Null for any
 * other path.
 */
export function pluginForPath(
  pathname: string,
  distRoot: string,
): PluginRoute | null {
  const m = pathname.match(/^\/plugins\/([^/]+)(?:\/|$)/);
  if (!m || !PLUGIN_ID.test(m[1])) return null;
  const id = m[1];
  const dir = path.join(distRoot, PLUGINS_DIR, id);
  let name: string | null = null;
  let installed = false;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, PLUGIN_FILE), "utf-8"),
    ) as { name?: unknown };
    installed = true;
    if (typeof manifest.name === "string") name = manifest.name;
  } catch {
    installed = fs.existsSync(path.join(dir, "den-theme.json"));
  }
  let locked = false;
  try {
    locked = Object.prototype.hasOwnProperty.call(readLock(distRoot), id);
  } catch {
    /* no lock */
  }
  return { id, name, installed, locked };
}

/** What error.html is told: everything error-page.js draws from. */
export interface ErrorPageData {
  /**
   * 422: the config fails validation (a ConfigError). 401, 403, 421: the
   * request checks refused it (SEC-1a): `message` says why, `code` names it.
   */
  status: 401 | 403 | 404 | 421 | 422 | 500;
  /** 401, 403, 421: the refusal's code (misdirected, origin_rejected, …). */
  code?: string;
  /** 404 and 422: the path asked for (no query). */
  path?: string;
  /** 422: the ConfigError's message (it names config keys, never values); 401/403/421: the refusal's. */
  message?: string;
  /** 422: each problem: its file, key path and message (0.3.0-dev.40). */
  issues?: Array<{ file: string; key: string; message: string }>;
  /** 422: the distribution's CLI, for "`<cli> validate`". */
  cli?: string;
  /** 500: what failed. */
  method?: string;
  route?: string;
  requestId: string;
  time: string;
  version: string | null;
  plugin?: PluginRoute | null;
  /** MD-2: the restart message, when the engine on disk is newer. */
  engine?: { loaded: string | null; onDisk: string | null; message: string };
}

/**
 * error.html with its data in a JSON script (a `<` in any value can't
 * close the script: it is escaped).
 */
export function fillErrorPage(html: string, data: ErrorPageData): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return html.replace("@@DEN_ERROR@@", () => json);
}
