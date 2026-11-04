/**
 * Journeys deterministic assertion engine (plan: jrn-verifier packet,
 * Approach §Assertion contract).
 *
 * Plain code, zero LLM involvement: every JourneyAssertion is evaluated by
 * executing its probe request ({method, path, body?}) through an
 * allowlisted + JWT-authenticated probe client (mirroring the scoped HTTP
 * tool's contract — the credential is injected harness-side and never
 * appears in errors or results), then checking the response
 * deterministically.
 *
 * `{placeholders}` in probe paths bind to ledger-extracted resource ids
 * from EITHER feed (http-tool or browser network interception). Binding
 * convention: `{<resourceType>_id}` binds to the MOST RECENT ledger entry
 * of that resourceType. A missing binding fails the assertion with a clear
 * message — it never crashes the verifier and never issues the probe.
 *
 * Assertions are API probes even for browser-surface journeys: the UI
 * writes app state; the verifier reads it back through the API, which
 * keeps the verdict independent of UI markup.
 */

import type { JourneyAssertion, JourneyProbeRequest } from "../spec/schema.js";
import { resolveExtraHeaders } from "../tools/http-tool.js";
import type { RunLedger } from "../tools/ledger.js";

// ── Probe client (http-tool contract mirror, harness-side) ──────────────────

// Per-request transport cap applied to every probe fetch even when no
// deadline signal is provided (review finding 6) — verification and
// teardown requests can never hang a journey run indefinitely.
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Response the probe client hands to the evaluator. */
export interface ProbeResponse {
  status: number;
  /** Parsed JSON body when the response is JSON; raw text otherwise. */
  body: unknown;
}

/** Executes one bound probe request. Thrown errors never carry the token. */
export type VerifierProbeClient = (
  request: JourneyProbeRequest,
) => Promise<ProbeResponse>;

export interface VerifierProbeClientOptions {
  /**
   * Base URLs the probes may reach; relative paths resolve against the
   * first entry (the API base URL by convention) — same contract as the
   * scoped HTTP tool.
   */
  allowedBaseUrls: string[];
  /** Harness-held JWT source; the value never leaves the client. */
  tokenProvider: () => Promise<string>;
  /**
   * Optional extra-header source (the app's session-derived scoping
   * headers), matching the scoped HTTP tool. Derived from the same browser
   * session as the token.
   */
  headersProvider?: () => Promise<Record<string, string>>;
  /** Injectable fetch (unit tests stub it; defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Optional deadline AbortSignal; combined with the per-request timeout
   * so in-flight probes abort when the caller's budget expires.
   */
  signal?: AbortSignal;
  /** Per-request transport cap; defaults to DEFAULT_PROBE_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

/**
 * Build the verifier's probe client: allowlist resolution + harness-side
 * `Authorization: Bearer <jwt>` (plus any session-derived headers)
 * injection, mirroring the scoped HTTP tool. Unlike the tool (agent-facing,
 * never throws), this client is
 * harness-facing and throws typed errors — the assertion engine converts
 * them into structured failures; the token is redacted from any
 * transport-error message before it propagates.
 */
export function buildVerifierProbeClient(
  options: VerifierProbeClientOptions,
): VerifierProbeClient {
  const {
    allowedBaseUrls,
    tokenProvider,
    headersProvider,
    fetchImpl = fetch,
    signal: deadlineSignal,
    requestTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = options;
  if (allowedBaseUrls.length === 0) {
    throw new Error(
      "buildVerifierProbeClient requires at least one allowlisted base URL",
    );
  }

  return async (request) => {
    const isAbsolute = /^https?:\/\//i.test(request.path);
    const url = isAbsolute
      ? new URL(request.path)
      : new URL(request.path, allowedBaseUrls[0]);

    const allowed = allowedBaseUrls.some(
      (base) => url.origin === new URL(base).origin,
    );
    if (!allowed) {
      throw new Error(
        `Probe target "${url.origin}" is not an allowlisted base URL ` +
          "(verifier probes carry the same allowlist as the HTTP tool).",
      );
    }

    const token = await tokenProvider();
    const headers: Record<string, string> = {
      ...(await resolveExtraHeaders(headersProvider)),
      Authorization: `Bearer ${token}`,
    };
    // Every probe fetch is bounded (finding 6): per-request timeout
    // always, plus the caller's deadline signal when provided.
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const init: RequestInit = {
      method: request.method,
      headers,
      signal: deadlineSignal
        ? AbortSignal.any([deadlineSignal, timeoutSignal])
        : timeoutSignal,
    };
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (error) {
      // Redact the credential from transport-error messages before they
      // propagate into assertion diagnostics.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Probe ${request.method} ${url.pathname} failed: ` +
          message.split(token).join("[REDACTED]"),
      );
    }

    const rawBody = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    let body: unknown = rawBody;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    return { status: response.status, body };
  };
}

// ── Placeholder binding ──────────────────────────────────────────────────────

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;
const ID_SUFFIX = "_id";

export type PlaceholderBinding =
  | { ok: true; path: string }
  | { ok: false; missing: string[] };

/**
 * Bind every `{placeholder}` in a probe path from the run ledger.
 * `{<resourceType>_id}` binds to the MOST RECENT ledger entry of that
 * resourceType, regardless of which feed recorded it. Unresolvable
 * placeholders are reported (assertion failure), never thrown.
 */
export function bindPlaceholders(
  path: string,
  ledger: RunLedger,
): PlaceholderBinding {
  const missing: string[] = [];

  const bound = path.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const resourceType = name.endsWith(ID_SUFFIX)
      ? name.slice(0, -ID_SUFFIX.length)
      : name;
    // Most recent entry wins when a journey created several resources of
    // one type — the assertion targets what the agent just finished with.
    for (let i = ledger.entries.length - 1; i >= 0; i -= 1) {
      if (ledger.entries[i].resourceType === resourceType) {
        return ledger.entries[i].id;
      }
    }
    missing.push(name);
    return whole;
  });

  return missing.length > 0
    ? { ok: false, missing }
    : { ok: true, path: bound };
}

// ── Minimal JSONPath evaluator ───────────────────────────────────────────────

/**
 * Result of resolving a JSONPath: the value at the path, or a reason it
 * could not be resolved. Filter expressions resolve to the ARRAY of
 * matching items (so array_* assertion kinds operate on the match set).
 */
export type JsonPathResult =
  | { resolved: true; value: unknown }
  | { resolved: false; reason: string };

type PathSegment =
  | { kind: "property"; name: string }
  | { kind: "index"; index: number }
  | { kind: "filter"; field: string; equals: string | number | boolean };

// Segment grammar: .prop | [n] | [?(@.field=='literal')] (single-field
// equality filters — the subset the journey specs use).
const SEGMENT_PATTERN =
  /\.([A-Za-z0-9_-]+)|\[(\d+)\]|\[\?\(@\.([A-Za-z0-9_-]+)\s*==\s*(?:'([^']*)'|"([^"]*)"|(true|false)|(-?\d+(?:\.\d+)?))\)\]/y;

function parseJsonPath(path: string): PathSegment[] | undefined {
  if (!path.startsWith("$")) {
    return undefined;
  }
  const segments: PathSegment[] = [];
  SEGMENT_PATTERN.lastIndex = 1;
  while (SEGMENT_PATTERN.lastIndex < path.length) {
    const match = SEGMENT_PATTERN.exec(path);
    if (match === null) {
      return undefined;
    }
    const [, property, index, field, single, double, boolean, numeric] = match;
    if (property !== undefined) {
      segments.push({ kind: "property", name: property });
    } else if (index !== undefined) {
      segments.push({ kind: "index", index: Number(index) });
    } else if (field !== undefined) {
      const equals =
        single ??
        double ??
        (boolean !== undefined ? boolean === "true" : Number(numeric));
      segments.push({ kind: "filter", field, equals });
    }
  }
  return segments;
}

/**
 * Evaluate the JSONPath subset used by journey assertions against a
 * response body: `$`, dotted properties (`$.items`), numeric indices
 * (`$.items[0]`), and single-field equality filters over arrays
 * (`$[?(@.role=='assistant')]` — resolves to the array of matches).
 * Never throws: malformed paths and unresolvable steps report a reason.
 */
export function evaluateJsonPath(body: unknown, path: string): JsonPathResult {
  const segments = parseJsonPath(path);
  if (segments === undefined) {
    return { resolved: false, reason: `Malformed JSONPath: ${path}` };
  }

  let current: unknown = body;
  for (const segment of segments) {
    switch (segment.kind) {
      case "property": {
        if (
          typeof current !== "object" ||
          current === null ||
          Array.isArray(current) ||
          !(segment.name in current)
        ) {
          return {
            resolved: false,
            reason: `Property "${segment.name}" not found while resolving ${path}`,
          };
        }
        current = (current as Record<string, unknown>)[segment.name];
        break;
      }
      case "index": {
        if (!Array.isArray(current) || segment.index >= current.length) {
          return {
            resolved: false,
            reason: `Index [${segment.index}] out of range while resolving ${path}`,
          };
        }
        current = current[segment.index];
        break;
      }
      case "filter": {
        if (!Array.isArray(current)) {
          return {
            resolved: false,
            reason: `Filter applied to a non-array while resolving ${path}`,
          };
        }
        current = current.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as Record<string, unknown>)[segment.field] === segment.equals,
        );
        break;
      }
    }
  }
  return { resolved: true, value: current };
}

// ── Assertion evaluation ─────────────────────────────────────────────────────

/** Structured outcome of one assertion (diagnostics for the report). */
export interface AssertionResult {
  assertion: JourneyAssertion;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message?: string;
}

function failed(
  assertion: JourneyAssertion,
  message: string,
  expected?: unknown,
  actual?: unknown,
): AssertionResult {
  return { assertion, passed: false, message, expected, actual };
}

function passed(
  assertion: JourneyAssertion,
  expected?: unknown,
  actual?: unknown,
): AssertionResult {
  return { assertion, passed: true, expected, actual };
}

function resolvePath(
  assertion: JourneyAssertion & { path: string },
  response: ProbeResponse,
): { value: unknown } | { failure: AssertionResult } {
  const result = evaluateJsonPath(response.body, assertion.path);
  if (!result.resolved) {
    return { failure: failed(assertion, result.reason) };
  }
  return { value: result.value };
}

function evaluateAssertion(
  assertion: JourneyAssertion,
  response: ProbeResponse,
): AssertionResult {
  switch (assertion.kind) {
    case "http_status": {
      return response.status === assertion.equals
        ? passed(assertion, assertion.equals, response.status)
        : failed(
            assertion,
            `Expected HTTP ${assertion.equals}, got ${response.status}`,
            assertion.equals,
            response.status,
          );
    }
    case "json_path_exists": {
      const result = evaluateJsonPath(response.body, assertion.path);
      return result.resolved
        ? passed(assertion, assertion.path, result.value)
        : failed(
            assertion,
            `JSONPath ${assertion.path} did not resolve: ${result.reason}`,
            assertion.path,
          );
    }
    case "json_path_equals": {
      const resolved = resolvePath(assertion, response);
      if ("failure" in resolved) return resolved.failure;
      return resolved.value === assertion.equals
        ? passed(assertion, assertion.equals, resolved.value)
        : failed(
            assertion,
            `Value at ${assertion.path} does not equal the expected literal`,
            assertion.equals,
            resolved.value,
          );
    }
    case "json_path_contains": {
      const resolved = resolvePath(assertion, response);
      if ("failure" in resolved) return resolved.failure;
      const value = resolved.value;
      const contains =
        typeof value === "string" && typeof assertion.contains === "string"
          ? value.includes(assertion.contains)
          : Array.isArray(value) && value.includes(assertion.contains);
      return contains
        ? passed(assertion, assertion.contains, value)
        : failed(
            assertion,
            `Value at ${assertion.path} does not contain the expected target`,
            assertion.contains,
            value,
          );
    }
    case "array_min_length": {
      const resolved = resolvePath(assertion, response);
      if ("failure" in resolved) return resolved.failure;
      if (!Array.isArray(resolved.value)) {
        return failed(
          assertion,
          `Value at ${assertion.path} is not an array`,
          assertion.min,
          resolved.value,
        );
      }
      const length = resolved.value.length;
      return length >= assertion.min
        ? passed(assertion, assertion.min, length)
        : failed(
            assertion,
            `Array at ${assertion.path} has ${length} item(s); expected >= ${assertion.min}`,
            assertion.min,
            length,
          );
    }
    case "array_contains_match": {
      const resolved = resolvePath(assertion, response);
      if ("failure" in resolved) return resolved.failure;
      if (!Array.isArray(resolved.value)) {
        return failed(
          assertion,
          `Value at ${assertion.path} is not an array`,
          assertion.match,
          resolved.value,
        );
      }
      const matches = resolved.value.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          Object.entries(assertion.match).every(
            ([field, literal]) =>
              (item as Record<string, unknown>)[field] === literal,
          ),
      );
      return matches
        ? passed(assertion, assertion.match)
        : failed(
            assertion,
            `No item in the array at ${assertion.path} matches every field predicate`,
            assertion.match,
            resolved.value,
          );
    }
  }
}

/**
 * Evaluate every assertion against live probe responses. ALL assertions
 * run (a failure never short-circuits the rest — the report wants the
 * full picture); the verdict composer applies all-must-pass semantics.
 * Probe failures — missing placeholder bindings, thrown client errors —
 * become structured assertion failures, never crashes.
 */
export async function runAssertions(
  assertions: readonly JourneyAssertion[],
  ledger: RunLedger,
  client: VerifierProbeClient,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    const binding = bindPlaceholders(assertion.request.path, ledger);
    if (!binding.ok) {
      results.push(
        failed(
          assertion,
          `Unbound placeholder(s) [${binding.missing.join(", ")}] in probe ` +
            `path "${assertion.request.path}" — no matching resource was ` +
            "recorded in the run ledger (either feed).",
        ),
      );
      continue;
    }

    let response: ProbeResponse;
    try {
      response = await client({ ...assertion.request, path: binding.path });
    } catch (error) {
      results.push(
        failed(
          assertion,
          `Probe request failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }

    results.push(evaluateAssertion(assertion, response));
  }

  return results;
}
