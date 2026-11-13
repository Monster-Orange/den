/**
 * #63: the edge's access log, masked by Den. Traefik writes every request
 * as one JSON line with its full path and query, and can't mask part of
 * either; so Traefik writes its lines to a 0600 file in a 0700 dir that
 * Den's server empties every second, and Den writes `edge-access.log`
 * with one-time tokens taken out. (Not a named pipe: Traefik opens its
 * log read-write, so with Den's reader down a full pipe would block every
 * request on the log write. A log must never stall traffic.)
 *
 * Masked by default: the query keys token, code, key, secret, password,
 * state, and the path /auth/link/*. `edge.access_log.mask_query` and `mask_paths`
 * add to those. The request id is Traefik's trace id (it sends the same
 * one upstream in `traceparent`).
 *
 * Off unless `edge.access_log` turns it on. Pure here: no I/O.
 */

export const DEFAULT_MASK_QUERY: readonly string[] = [
  "token",
  "code",
  "key",
  "secret",
  "password",
  // An OAuth or connect `state` is single-use and guards the callback.
  "state",
];
export const DEFAULT_MASK_PATHS: readonly string[] = ["/auth/link/*"];
export const REDACTED = "[redacted]";

export interface AccessLogConfig {
  enabled: boolean;
  /** Query keys whose values are masked (lowercase; the defaults first). */
  maskQuery: string[];
  /** Path patterns: `/prefix/*` masks every segment after the prefix. */
  maskPaths: string[];
  /** edge-access.log is rotated (one .1 kept) past this size. */
  maxMb: number;
}

const QUERY_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const PATH_PATTERN = /^\/[A-Za-z0-9_.~/-]*\*$/;

/** `edge.access_log`: true/false, or a map; null/absent is off. */
export function readAccessLogConfig(v: unknown): AccessLogConfig {
  const base = {
    maskQuery: [...DEFAULT_MASK_QUERY],
    maskPaths: [...DEFAULT_MASK_PATHS],
    maxMb: 20,
  };
  if (v === undefined || v === null || v === false)
    return { enabled: false, ...base };
  if (v === true) return { enabled: true, ...base };
  if (typeof v !== "object" || Array.isArray(v))
    throw new Error(
      "edge.access_log must be true, false, or a map: { enabled, mask_query, mask_paths, max_mb }",
    );
  const m = v as Record<string, unknown>;
  for (const k of Object.keys(m))
    if (!["enabled", "mask_query", "mask_paths", "max_mb"].includes(k))
      throw new Error(
        `edge.access_log: unknown key "${k}" (known: enabled, mask_query, mask_paths, max_mb)`,
      );
  const list = (x: unknown, key: string, ok: RegExp): string[] => {
    if (x === undefined || x === null) return [];
    if (
      !Array.isArray(x) ||
      !x.every((s) => typeof s === "string" && ok.test(s))
    )
      throw new Error(
        key === "mask_query"
          ? "edge.access_log.mask_query must be a list of query keys (letters, digits, _ . -)"
          : 'edge.access_log.mask_paths must be a list of paths ending in "*", e.g. /invite/*',
      );
    return x as string[];
  };
  const maxMb = m.max_mb ?? 20;
  if (
    typeof maxMb !== "number" ||
    !Number.isInteger(maxMb) ||
    maxMb < 1 ||
    maxMb > 1000
  )
    throw new Error("edge.access_log.max_mb must be a whole number, 1 to 1000");
  return {
    enabled: m.enabled !== false,
    maskQuery: [
      ...new Set([
        ...base.maskQuery,
        ...list(m.mask_query, "mask_query", QUERY_KEY).map((k) =>
          k.toLowerCase(),
        ),
      ]),
    ],
    maskPaths: [
      ...new Set([
        ...base.maskPaths,
        ...list(m.mask_paths, "mask_paths", PATH_PATTERN),
      ]),
    ],
    maxMb,
  };
}

/** `path?query` with the configured segments and query values masked. */
export function maskRequestPath(
  raw: string,
  c: Pick<AccessLogConfig, "maskQuery" | "maskPaths">,
): string {
  const q = raw.indexOf("?");
  let p = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? null : raw.slice(q + 1);
  for (const pat of c.maskPaths) {
    const prefix = pat.slice(0, -1); // "/auth/link/"
    if (
      p.toLowerCase().startsWith(prefix.toLowerCase()) &&
      p.length > prefix.length
    )
      p = prefix + REDACTED;
  }
  if (query === null) return p;
  const keys = new Set(c.maskQuery.map((k) => k.toLowerCase()));
  const masked = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const k = eq < 0 ? pair : pair.slice(0, eq);
      let name = k;
      try {
        name = decodeURIComponent(k.replace(/\+/g, " "));
      } catch {
        /* a bad escape: matched as written */
      }
      return keys.has(name.toLowerCase()) && eq >= 0
        ? `${k}=${REDACTED}`
        : pair;
    })
    .join("&");
  return `${p}?${masked}`;
}

/** The fields kept from Traefik's line, in this order. */
const KEEP = [
  "StartUTC",
  "RequestMethod",
  "RequestHost",
  "RequestPath",
  "RequestProtocol",
  "DownstreamStatus",
  "OriginStatus",
  "Duration",
  "RouterName",
  "ServiceName",
  "ServiceURL",
  "ClientHost",
  "RetryAttempts",
] as const;

/** Traefik's own 502 body ("Bad Gateway"): it got nothing from the service. */
const EDGE_502_SIZE = 11;

/**
 * One of Traefik's access-log lines as Den writes it: the kept fields,
 * the path masked, `request_id` (the trace id), and for a 502 the edge
 * made itself, `why`. Null for a line that isn't one of Traefik's.
 */
export function maskAccessLine(
  line: string,
  c: Pick<AccessLogConfig, "maskQuery" | "maskPaths">,
): string | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || typeof v.RequestPath !== "string")
    return null;
  const out: Record<string, unknown> = {};
  for (const k of KEEP) if (v[k] !== undefined) out[k] = v[k];
  out.RequestPath = maskRequestPath(v.RequestPath, c);
  const rid = v.TraceId ?? v.trace_id;
  if (typeof rid === "string" && /^[0-9a-f]{32}$/.test(rid))
    out.request_id = rid;
  if (
    v.DownstreamStatus === 502 &&
    (v.OriginContentSize === EDGE_502_SIZE || v.OriginStatus === 0)
  )
    out.why =
      "the edge got no answer from the service (refused, reset or closed)";
  return JSON.stringify(out);
}

/** A W3C traceparent's trace id (the request id), or null. */
export function requestIdOf(traceparent: unknown): string | null {
  if (typeof traceparent !== "string") return null;
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(
    traceparent.trim(),
  );
  return m && !/^0+$/.test(m[1]) ? m[1] : null;
}
