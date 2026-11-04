/**
 * The app under test, as the journeys pillar needs to know it.
 *
 * The engine knows nothing about any one product's API. Everything
 * app-specific (which endpoints create resources and how to delete them,
 * how a browser session yields an API token, which web-origin routes proxy
 * the API) is declared by the repo that hosts the journey specs, under
 * `journeys.app` in its manifest:
 *
 *   journeys:
 *     testDir: journeys
 *     testMatch: "**\/*.journey.yml"
 *     app:
 *       session_token:            # how a browser session yields an API token
 *         path: /api/auth/token   # GET on the web origin with the session cookies
 *         token_field: access_token
 *         headers:                # extra request headers, from response fields
 *           X-Org-ID: org_id
 *       web_api:                  # API calls the browser makes via the web origin
 *         prefix: /api/
 *         ignore: [/api/auth/]
 *         rewrites:               # web path prefix -> API path prefix
 *           - { from: /api/items, to: /api/v1/items }
 *       resources:                # creations the run ledger tracks and tears down
 *         - type: item
 *           create: POST /api/v1/items
 *           delete: DELETE /api/v1/items/{id}
 *       actions:                  # mutating calls that create nothing to clean up
 *         - POST /api/v1/items/*\/archive
 *
 * Patterns use `*` for exactly one path segment (the same syntax as a
 * spec's `http_capabilities`). Every field is optional; an absent block
 * means: no tracked resources, no web-origin API feed, and no session
 * token (a journey that needs API assertions then fails loudly).
 */

import { z } from "zod";
import type {
  CleanupRequest,
  HttpMethod,
  LedgerRegistry,
  ObservedCall,
  ResourceDescriptor,
} from "./tools/ledger.js";

const HTTP_METHODS = [
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

const absolutePath = z
  .string()
  .regex(/^\//, { message: "must be an absolute path (start with /)" });

/** "METHOD /path" with an optional method (defaulted per field). */
const routeString = z.string().regex(/^(?:[A-Z]+\s+)?\/\S*$/, {
  message: 'must look like "METHOD /path" or "/path"',
});

const sessionTokenSchema = z.strictObject({
  /** GET path on the web origin that returns a JSON token for the session. */
  path: absolutePath,
  /** Response field holding the bearer token (default "access_token"). */
  token_field: z.string().min(1).optional(),
  /**
   * Extra headers every API call carries: header name -> response field
   * (for example a workspace or org id the API scopes requests by).
   */
  headers: z.record(z.string().min(1), z.string().min(1)).optional(),
});

const webApiSchema = z.strictObject({
  /** Web-origin path prefix whose mutations feed the run ledger. */
  prefix: absolutePath,
  /** Web-origin prefixes never recorded (login and session routes). */
  ignore: z.array(absolutePath).optional(),
  /** Web path prefix -> API path prefix, so both feeds bind the same id. */
  rewrites: z
    .array(z.strictObject({ from: absolutePath, to: absolutePath }))
    .optional(),
});

const resourceSchema = z.strictObject({
  /** Binds `{<type>_id}` placeholders in assertion probes. */
  type: z.string().regex(/^[a-z][a-z0-9_]*$/, {
    message: "must be lower-case letters, digits and _",
  }),
  /** Creating call, "POST /api/v1/items" (method defaults to POST). */
  create: routeString,
  /** Cleanup call with an {id} placeholder (method defaults to DELETE). */
  delete: routeString.refine((v) => v.includes("{id}"), {
    message: "must contain {id}",
  }),
  /** Response-body field holding the new id (default "id"). */
  id_field: z.string().min(1).optional(),
});

export const journeysAppSchema = z.strictObject({
  session_token: sessionTokenSchema.optional(),
  web_api: webApiSchema.optional(),
  resources: z.array(resourceSchema).optional(),
  /** "METHOD /path" patterns (method defaults to POST) never recorded. */
  actions: z.array(routeString).optional(),
});

export type JourneysAppConfig = z.infer<typeof journeysAppSchema>;
export type JourneysSessionTokenConfig = z.infer<typeof sessionTokenSchema>;
export type JourneysWebApiConfig = z.infer<typeof webApiSchema>;

/** Thrown when a manifest's `journeys.app` block is invalid. */
export class JourneysAppConfigError extends Error {
  constructor(source: string, detail: string) {
    super(`Invalid journeys.app in ${source}: ${detail}`);
    this.name = "JourneysAppConfigError";
  }
}

/** Parse a raw `journeys.app` block; absent → {}. Throws on any error. */
export function parseJourneysAppConfig(
  raw: unknown,
  source: string,
): JourneysAppConfig {
  if (raw === undefined || raw === null) return {};
  const result = journeysAppSchema.safeParse(raw);
  if (!result.success) {
    throw new JourneysAppConfigError(
      source,
      result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }
  return result.data;
}

// ── Ledger registry from config ──────────────────────────────────────────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `*` → exactly one path segment, the rest literal, anchored. */
export function segmentPatternToRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join("[^/]+");
  return new RegExp(`^${source}$`);
}

function splitRoute(
  route: string,
  defaultMethod: HttpMethod,
): { method: HttpMethod; path: string } {
  const m = /^([A-Z]+)\s+(\S+)$/.exec(route.trim());
  if (!m) return { method: defaultMethod, path: route.trim() };
  if (!(HTTP_METHODS as readonly string[]).includes(m[1])) {
    throw new Error(`Unknown HTTP method "${m[1]}" in "${route}"`);
  }
  return { method: m[1] as HttpMethod, path: m[2] };
}

function idExtractor(
  field: string,
): (call: ObservedCall) => string | undefined {
  return (call) => {
    if (typeof call.body !== "object" || call.body === null) return undefined;
    const id = (call.body as Record<string, unknown>)[field];
    return typeof id === "string" && id.length > 0 ? id : undefined;
  };
}

/**
 * Build the run ledger's registry from `journeys.app`: one descriptor per
 * declared resource and the declared action patterns. No resources → an
 * empty registry, so every successful mutation is reported as unmanaged
 * (never guessed-deleted).
 */
export function ledgerRegistryFromApp(app: JourneysAppConfig): LedgerRegistry {
  const descriptors: ResourceDescriptor[] = (app.resources ?? []).map((r) => {
    const create = splitRoute(r.create, "POST");
    const del = splitRoute(r.delete, "DELETE");
    return {
      resourceType: r.type,
      creation: {
        method: create.method,
        pathPattern: segmentPatternToRegExp(create.path),
      },
      extractId: idExtractor(r.id_field ?? "id"),
      cleanup: (id: string): CleanupRequest => ({
        method: del.method,
        path: del.path.split("{id}").join(encodeURIComponent(id)),
      }),
    };
  });
  const actionPatterns = (app.actions ?? []).map((a) =>
    segmentPatternToRegExp(splitRoute(a, "POST").path),
  );
  return { descriptors, actionPatterns };
}

// ── Web-origin path rewrites ─────────────────────────────────────────────────

/**
 * Map a web-origin path onto the API vocabulary via `web_api.rewrites`.
 * A rewrite applies when `from` equals the path or is followed by "/"
 * (segment-aware: `/api/items` never rewrites `/api/items-old`). The
 * longest matching `from` wins; no match returns the path unchanged.
 */
export function rewriteWebApiPath(
  pathname: string,
  webApi: JourneysWebApiConfig | undefined,
): string {
  let best: { from: string; to: string } | undefined;
  for (const rule of webApi?.rewrites ?? []) {
    const from = rule.from.replace(/\/+$/, "");
    const matches = pathname === from || pathname.startsWith(`${from}/`);
    if (matches && (best === undefined || from.length > best.from.length)) {
      best = { from, to: rule.to.replace(/\/+$/, "") };
    }
  }
  return best === undefined
    ? pathname
    : `${best.to}${pathname.slice(best.from.length)}`;
}

/** {@link rewriteWebApiPath} over an absolute URL (origin/query kept). */
export function rewriteWebApiUrl(
  rawUrl: string,
  webApi: JourneysWebApiConfig | undefined,
): string {
  const url = new URL(rawUrl);
  url.pathname = rewriteWebApiPath(url.pathname, webApi);
  return url.toString();
}
