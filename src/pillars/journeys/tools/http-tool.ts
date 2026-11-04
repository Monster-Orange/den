/**
 * Scoped HTTP custom tool for journey agents (@cursor/sdk custom-tool
 * surface). The agent gets a single `http_request` tool whose reach is
 * restricted to allowlisted base URLs; the harness injects
 * `Authorization: Bearer <jwt>` (plus any session-derived scoping headers)
 * inside execute() so the credential never enters the prompt, the tool
 * args, results, or the transcript. The token and headers are derived from
 * the real browser session (see tools/browser-session.ts).
 *
 * 4xx/5xx responses are structured results (the agent is expected to read
 * and react to them); only policy violations (allowlist, method
 * capability, invalid args) and transport failures produce `isError`
 * results — and even those never throw, so no stack trace can carry the
 * token.
 *
 * Method-capability contract (review finding 4): the tool NEVER issues
 * DELETE (cleanup is harness-only, via the entrypoint's teardown client
 * over the run ledger), and each journey's allowed methods derive from
 * its spec surface — browser-surface journeys get read-only GET when the
 * tool is mounted at all; api/mixed journeys get GET/POST/PUT/PATCH. See
 * {@link allowedMethodsForSurface}.
 *
 * Path-capability contract (review finding R2-1): mutating methods
 * (POST/PUT/PATCH) additionally require an explicit per-journey
 * capability grant — a {methods, pathPattern} pair from the spec's
 * `http_capabilities` field, where `*` in the pattern matches exactly one
 * path segment. A mutating request matching no grant is rejected with a
 * typed CAPABILITY_NOT_GRANTED error BEFORE any fetch. The safe default
 * (no grants) makes the tool read-only for mutations. GET stays
 * origin-wide — reads are the tool's purpose. The verifier's probe client
 * and the teardown client are harness-side and unaffected.
 */

import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import { RunLedger, sanitizePath, type HttpMethod } from "./ledger.js";

/** MCP wire name the tool is mounted under. */
export const HTTP_TOOL_NAME = "http_request";

// Response-body cap forwarded to the model. Bounds the token cost of one
// tool result; large payloads (file listings, long message histories) are
// truncated with an explicit flag so the agent knows to narrow its query.
export const DEFAULT_MAX_RESPONSE_BYTES = 32_768;

// Per-request transport cap applied to EVERY fetch even when no run
// deadline signal is provided (review finding 6) — a single hung request
// can never stall a journey indefinitely.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Every method the tool can even parse (validation boundary). */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Method-capability contract (review finding 4):
 * - The agent-facing tool NEVER performs DELETE — cleanup is exclusively
 *   harness-side, via the entrypoint's teardown client over the run
 *   ledger. Passing DELETE in `allowedMethods` throws at build time.
 * - Per-journey capability is derived from the spec's surface:
 *   browser-surface journeys get a read-only GET tool (if mounted at
 *   all); api/mixed journeys get GET/POST/PUT/PATCH.
 */
export function allowedMethodsForSurface(
  surface: "browser" | "api" | "mixed",
): readonly HttpMethod[] {
  return surface === "browser" ? ["GET"] : ["GET", "POST", "PUT", "PATCH"];
}

// ── Path capabilities (review finding R2-1) ─────────────────────────────────

/** Methods a capability grant may cover — GET is origin-wide by design and
 * DELETE is harness-only, so neither is grantable. */
const GRANTABLE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
]);

/**
 * One journey-scoped mutating-capability grant (runner-side shape of the
 * spec's `http_capabilities` entries).
 */
export interface HttpCapabilityGrant {
  /** Mutating methods the grant covers (POST/PUT/PATCH only). */
  methods: readonly HttpMethod[];
  /**
   * Matched against the full request pathname; `*` matches exactly one
   * path segment (e.g. `/api/v1/items/{*}/notes`, written without the
   * braces in real patterns).
   */
  pathPattern: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a grant's path pattern: `*` → one path segment, rest literal. */
function pathPatternToRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join("[^/]+");
  return new RegExp(`^${source}$`);
}

/**
 * Fail-closed canonicalization guard (round-3 review finding): WHATWG URL
 * keeps `%2F`, `%5C`, and multi-layer encodings encoded in `pathname`, so
 * grant wildcards (`[^/]+`) would treat them as one segment while a
 * downstream server may decode them into extra `/`-separated segments —
 * expanding a mutating request beyond the granted route. Returns true
 * when any path segment hides structural characters behind
 * percent-encoding: an encoded `/` or `\`, an encoded `.`/`..` dot
 * segment, control characters, or malformed percent-encoding at any
 * decode layer. Each layer is NFKC-normalized before structural checks,
 * so compatibility characters such as fullwidth slashes and dots cannot
 * bypass the guard. A literal percent (`%25` → `%`) is safe because it
 * does not introduce another percent-escape sequence.
 */
function hidesEncodedPathStructure(pathname: string): boolean {
  for (const rawSegment of pathname.split("/")) {
    let current = rawSegment;
    for (;;) {
      current = current.normalize("NFKC");
      if (
        /[/\\]/.test(current) ||
        current === "." ||
        current === ".." ||
        [...current].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        })
      ) {
        return true;
      }
      const hasEscape = /%[0-9A-Fa-f]{2}/.test(current);
      if (!hasEscape) {
        // A literal percent may result from decoding %25, but a raw or
        // newly-exposed malformed percent escape must fail closed.
        if (
          current.includes("%") &&
          (current === rawSegment ||
            /%[^0-9A-Fa-f]|%[0-9A-Fa-f]$/.test(current))
        ) {
          return true;
        }
        break;
      }
      let next: string;
      try {
        next = decodeURIComponent(current);
      } catch {
        // A malformed escape can be exposed by a later decode layer
        // (for example %25C0%25AF → %C0%AF). Refuse rather than assume
        // downstream servers will treat it as a harmless literal.
        return true;
      }
      current = next;
    }
  }
  return false;
}

interface CompiledGrant {
  methods: ReadonlySet<string>;
  pattern: RegExp;
}

function compileGrants(
  grants: readonly HttpCapabilityGrant[],
): CompiledGrant[] {
  return grants.map((grant) => {
    for (const method of grant.methods) {
      if (!GRANTABLE_METHODS.has(method)) {
        throw new Error(
          `HTTP capability grants may only cover POST/PUT/PATCH — got ` +
            `"${method}" for pattern "${grant.pathPattern}". GET is ` +
            "origin-wide by design and DELETE is harness-only (teardown).",
        );
      }
    }
    return {
      methods: new Set(grant.methods),
      pattern: pathPatternToRegExp(grant.pathPattern),
    };
  });
}

/** Structural subset of den's EnvironmentConfig this module needs. */
export interface HttpToolEnvBaseUrls {
  baseUrls: {
    web?: string;
    api: string;
    services: Record<string, string>;
  };
}

/**
 * Allowlist for the HTTP tool: the API base URL plus every service base
 * URL. `baseUrls.web` is deliberately excluded — the browser toolset owns
 * the web surface; this tool is API-scoped.
 */
export function allowedBaseUrlsFromEnv(env: HttpToolEnvBaseUrls): string[] {
  return [env.baseUrls.api, ...Object.values(env.baseUrls.services)];
}

export interface ScopedHttpToolOptions {
  /**
   * Base URLs the tool may reach. Relative `path_or_url` values resolve
   * against the first entry (the API base URL by convention).
   */
  allowedBaseUrls: string[];
  /** Harness-held JWT source; the value never leaves execute(). */
  tokenProvider: () => Promise<string>;
  /**
   * Optional extra-header source: every request carries these headers (e.g.
   * the org or workspace id the app scopes API calls by — the app's
   * `journeys.app.session_token.headers`). Derived from the browser session
   * alongside the token; not secrets. Empty values are dropped.
   */
  headersProvider?: () => Promise<Record<string, string>>;
  /** Ledger fed with every successful mutating call (source: http-tool). */
  ledger: RunLedger;
  /** Response-body byte cap; defaults to DEFAULT_MAX_RESPONSE_BYTES. */
  maxResponseBytes?: number;
  /**
   * Methods this journey's tool may issue (see
   * {@link allowedMethodsForSurface}). DELETE is never permitted and
   * throws at build time. Defaults to the api/mixed surface set.
   */
  allowedMethods?: readonly HttpMethod[];
  /**
   * Journey-scoped mutating grants (review finding R2-1): a POST/PUT/
   * PATCH request must match one grant's method + path pattern or it is
   * rejected before fetching. Defaults to NO grants — read-only for
   * mutations. GET needs no grant (origin-wide reads).
   */
  capabilities?: readonly HttpCapabilityGrant[];
  /**
   * Run-deadline AbortSignal (budgets.timeout_s); combined with the
   * per-request timeout so in-flight fetches abort when the run's
   * wall-clock budget expires.
   */
  signal?: AbortSignal;
  /** Per-request transport cap; defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

export type HttpToolErrorCode =
  | "INVALID_ARGS"
  | "METHOD_NOT_ALLOWED"
  | "CAPABILITY_NOT_GRANTED"
  | "HOST_NOT_ALLOWLISTED"
  | "REQUEST_FAILED";

/** JSON payload serialized into the tool result's text content. */
export interface HttpToolPayload {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  truncated?: boolean;
  error?: { code: HttpToolErrorCode; message: string };
}

/** Tool result shape returned by execute(). */
export interface HttpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(payload: HttpToolPayload, isError = false): HttpToolResult {
  const result: HttpToolResult = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

function errorResult(code: HttpToolErrorCode, message: string): HttpToolResult {
  return textResult({ error: { code, message } }, true);
}

/**
 * Resolve the requested path or URL against the allowlist. Returns the
 * final URL when permitted; undefined when the target host is not
 * allowlisted. Matching is origin-exact against each allowed base URL, so
 * lookalike hosts (e.g. `localhost:8000.evil.example.com`) never pass.
 */
function resolveAllowlistedUrl(
  pathOrUrl: string,
  allowedBaseUrls: string[],
): URL | undefined {
  const isAbsolute = /^https?:\/\//i.test(pathOrUrl);
  const target = isAbsolute
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, allowedBaseUrls[0]);

  for (const base of allowedBaseUrls) {
    if (target.origin === new URL(base).origin) {
      return target;
    }
  }
  return undefined;
}

/**
 * Resolve an optional extra-header source: trimmed values, empties dropped.
 * Shared by the scoped HTTP tool and the verifier's probe client.
 */
export async function resolveExtraHeaders(
  provider: (() => Promise<Record<string, string>>) | undefined,
): Promise<Record<string, string>> {
  if (provider === undefined) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(await provider())) {
    const trimmed = value.trim();
    if (trimmed.length > 0) out[name] = trimmed;
  }
  return out;
}

/**
 * Build the scoped HTTP custom tool. Mount under {@link HTTP_TOOL_NAME} in
 * `Agent.create({local: {customTools}})`.
 */
export function buildScopedHttpTool(
  options: ScopedHttpToolOptions,
): SDKCustomTool {
  const {
    allowedBaseUrls,
    tokenProvider,
    headersProvider,
    ledger,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    allowedMethods = allowedMethodsForSurface("api"),
    capabilities = [],
    signal: deadlineSignal,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;
  if (allowedBaseUrls.length === 0) {
    throw new Error(
      "buildScopedHttpTool requires at least one allowlisted base URL",
    );
  }
  if (allowedMethods.includes("DELETE")) {
    throw new Error(
      "The agent-facing HTTP tool never performs DELETE — cleanup is " +
        "harness-only via the teardown client. Remove DELETE from " +
        "allowedMethods.",
    );
  }
  const allowedMethodSet: ReadonlySet<string> = new Set(allowedMethods);
  const grants = compileGrants(capabilities);
  const grantedMethods = new Set(grants.flatMap((grant) => [...grant.methods]));
  // Only advertise methods the tool can actually honor: reads plus the
  // mutating methods at least one grant covers (review finding R2-1).
  const advertisedMethods = allowedMethods.filter(
    (method) => !GRANTABLE_METHODS.has(method) || grantedMethods.has(method),
  );

  return {
    description:
      "Make an authenticated HTTP request to the app's API. Only " +
      "allowlisted API base URLs are reachable; authentication is " +
      "handled for you — never supply credentials. Relative paths resolve " +
      "against the primary API base URL.",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: [...advertisedMethods],
          description: "HTTP method (only the listed methods are permitted)",
        },
        path_or_url: {
          type: "string",
          description:
            "API path (e.g. /api/v1/items) or absolute URL under an " +
            "allowlisted base URL",
        },
        body: {
          type: "object",
          description: "Optional JSON request body",
        },
        query: {
          type: "object",
          description: "Optional query parameters (string values)",
          additionalProperties: { type: "string" },
        },
      },
      required: ["method", "path_or_url"],
      additionalProperties: false,
    },
    execute: async (args: Record<string, SDKJsonValue>) => {
      const method = typeof args.method === "string" ? args.method : "";
      const pathOrUrl =
        typeof args.path_or_url === "string" ? args.path_or_url : "";

      if (!KNOWN_METHODS.has(method)) {
        return errorResult(
          "INVALID_ARGS",
          `Unsupported method "${method}". Allowed: ${[...advertisedMethods].join(", ")}.`,
        );
      }
      if (method === "DELETE") {
        return errorResult(
          "METHOD_NOT_ALLOWED",
          "DELETE is never available to journey agents — resource cleanup " +
            "is performed harness-side by the run's teardown over the " +
            "resource ledger.",
        );
      }
      if (!allowedMethodSet.has(method)) {
        return errorResult(
          "METHOD_NOT_ALLOWED",
          `Method "${method}" is not permitted for this journey. ` +
            `Allowed: ${[...advertisedMethods].join(", ")}.`,
        );
      }
      if (pathOrUrl.length === 0) {
        return errorResult("INVALID_ARGS", "path_or_url is required.");
      }

      let url: URL | undefined;
      try {
        url = resolveAllowlistedUrl(pathOrUrl, allowedBaseUrls);
      } catch {
        return errorResult("INVALID_ARGS", `Malformed URL: ${pathOrUrl}`);
      }
      if (url === undefined) {
        return errorResult(
          "HOST_NOT_ALLOWLISTED",
          `Host "${new URL(pathOrUrl, allowedBaseUrls[0]).host}" is not an ` +
            "allowlisted API base URL.",
        );
      }

      // Journey-scoped path capability (review finding R2-1): a mutating
      // request must match a grant's method + path pattern — checked on
      // the bare pathname, BEFORE any fetch.
      if (GRANTABLE_METHODS.has(method)) {
        // Decode-and-compare canonicalization (round-3 finding): reject
        // percent-encoded separators / dot-segment tricks BEFORE grant
        // matching and any fetch. GET stays as-is — path tricks cannot
        // change the origin, and reads are origin-wide by design.
        if (hidesEncodedPathStructure(url.pathname)) {
          return errorResult(
            "CAPABILITY_NOT_GRANTED",
            `${method} ${url.pathname} contains percent-encoded path ` +
              "structure (encoded separators or dot segments) that could " +
              "expand beyond the granted route after server-side " +
              "decoding. Use literal, singly-encoded path segments.",
          );
        }
        const granted = grants.some(
          (grant) =>
            grant.methods.has(method) && grant.pattern.test(url.pathname),
        );
        if (!granted) {
          return errorResult(
            "CAPABILITY_NOT_GRANTED",
            `${method} ${url.pathname} matches no capability grant for ` +
              "this journey. Mutations are limited to the journey's " +
              "declared http_capabilities; everything else is read-only.",
          );
        }
      }

      const query = args.query;
      if (
        typeof query === "object" &&
        query !== null &&
        !Array.isArray(query)
      ) {
        for (const [key, value] of Object.entries(query)) {
          if (typeof value === "string") {
            url.searchParams.append(key, value);
          }
        }
      }

      const headers: Record<string, string> = {
        ...(await resolveExtraHeaders(headersProvider)),
        Authorization: `Bearer ${await tokenProvider()}`,
      };
      // Every fetch is bounded: per-request timeout always, plus the
      // run-deadline signal when the runner provided one (finding 6).
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
      const init: RequestInit = {
        method,
        headers,
        signal: deadlineSignal
          ? AbortSignal.any([deadlineSignal, timeoutSignal])
          : timeoutSignal,
      };
      const body = args.body;
      if (body !== undefined && method !== "GET" && method !== "HEAD") {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      let response: Response;
      try {
        response = await fetch(url.toString(), init);
      } catch (error) {
        // Transport failures never throw out of the tool: a thrown error's
        // message/stack could carry request internals. Report a scrubbed,
        // structured failure instead.
        const message = error instanceof Error ? error.message : String(error);
        const token = headers.Authorization;
        return errorResult(
          "REQUEST_FAILED",
          `Request to ${sanitizePath(url.toString())} failed: ` +
            message.split(token).join("[REDACTED]"),
        );
      }

      const rawBody = await response.text();
      const truncated = Buffer.byteLength(rawBody, "utf8") > maxResponseBytes;
      const cappedBody = truncated
        ? rawBody.slice(0, maxResponseBytes)
        : rawBody;

      const contentType = response.headers.get("content-type") ?? "";
      let parsedBody: unknown = cappedBody;
      if (!truncated && contentType.includes("application/json")) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = cappedBody;
        }
      }

      ledger.record(
        {
          method: method as HttpMethod,
          pathOrUrl: url.toString(),
          status: response.status,
          body: parsedBody,
        },
        "http-tool",
      );

      const payload: HttpToolPayload = {
        status: response.status,
        // Header subset by construction: only content-type is ever exposed.
        // Set-Cookie, WWW-Authenticate, and friends stay harness-side.
        headers: contentType ? { "content-type": contentType } : {},
        body: parsedBody,
      };
      if (truncated) {
        payload.truncated = true;
      }
      return textResult(payload);
    },
  };
}
