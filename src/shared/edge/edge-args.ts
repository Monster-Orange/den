/**
 * `edge.args`: the Traefik static-config flags a distribution or a person
 * may add to the edge's command. An allow-list: Traefik's flag parser takes
 * one dash as well as two, `--key=value` and `--key value`, in any case,
 * so a list of what to drop always misses a spelling. Den renders the
 * edge's entrypoints, providers, API (none), logs and tracing itself; each
 * entry here must set one of the keys below, or it is refused with a line
 * naming it (at config read and when the command is rendered).
 *
 * The one exception is the trust Den sets itself (the entrypoints'
 * forwarded headers and PROXY protocol, SEC-2a): those entries are dropped,
 * with edge up's notice, as they always were, so a config written before
 * Den set them keeps working.
 *
 * Pure.
 */

interface Allowed {
  key: RegExp;
  /** The values it may take; any value when unset. */
  value?: RegExp | ((v: string) => boolean);
}

/**
 * A Traefik duration in ms: Go's form (`1m30s`, `500ms`) or a bare number
 * of seconds. Null when it is neither.
 */
export function durationMs(v: string): number | null {
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const unit: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    µs: 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(v)) return null;
  let ms = 0;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g))
    ms += Number(m[1]) * unit[m[2]];
  return ms;
}

/** A duration of at least `min` ms and at most `max` ms. */
const duration =
  (min: number, max = Infinity) =>
  (v: string): boolean => {
    const ms = durationMs(v);
    return ms !== null && ms >= min && ms <= max;
  };

const ALLOWED: readonly Allowed[] = [
  { key: /^accesslog$/ },
  { key: /^accesslog\.(format|bufferingsize)$/ },
  { key: /^accesslog\.filters\.(statuscodes|retryattempts|minduration)$/ },
  // Not accesslog.fields.headers.*: a kept header (the proof's) is logged.
  { key: /^accesslog\.fields\.defaultmode$/ },
  { key: /^accesslog\.fields\.names\.[a-z0-9_]+$/ },
  // Not DEBUG or TRACE: they log the dynamic config, the proof among it.
  { key: /^log\.level$/, value: /^(info|warn|error|fatal|panic)$/i },
  { key: /^log\.(format|nocolor)$/ },
  { key: /^core\.defaultrulesyntax$/, value: /^v[23]$/i },
  { key: /^global\.(checknewversion|sendanonymoususage)$/ },
  // Not 0 (no limit): a client could hold a connection open for good.
  {
    key: /^entrypoints\.(web|websecure)\.transport\.respondingtimeouts\.(readtimeout|idletimeout)$/,
    value: duration(1),
  },
  {
    key: /^entrypoints\.(web|websecure)\.transport\.(respondingtimeouts\.writetimeout|lifecycle\.(requestacceptgracetimeout|gracetimeout)|keepalivemaxtime)$/,
    value: duration(0),
  },
  {
    key: /^entrypoints\.(web|websecure)\.transport\.keepalivemaxrequests$/,
    value: /^\d+$/,
  },
  { key: /^serverstransport\.maxidleconnsperhost$/, value: /^-?\d+$/ },
  {
    key: /^serverstransport\.forwardingtimeouts\.(dialtimeout|responseheadertimeout|pingtimeout)$/,
    value: duration(0),
  },
  // At most 5 s: a longer one holds off every dynamic change, a new proof
  // among them.
  { key: /^providers\.providersthrottleduration$/, value: duration(0, 5_000) },
];

/** ALLOWED, as the refusal says it. */
const ALLOWED_TEXT =
  "accesslog (and its format, bufferingSize, filters.* and fields.defaultMode / fields.names.*), " +
  "log.level (INFO, WARN, ERROR, FATAL or PANIC), log.format, log.noColor, " +
  "core.defaultRuleSyntax (v2 or v3), global.checkNewVersion, global.sendAnonymousUsage, " +
  "entryPoints.web / entryPoints.websecure transport timeouts (readTimeout and idleTimeout above 0) and keep-alive, " +
  "serversTransport.maxIdleConnsPerHost and its dial, response-header and ping timeouts, " +
  "providers.providersThrottleDuration (at most 5s)";

/** The trust Den sets itself (SEC-2a): dropped, with a notice. */
const OWNED_KEY =
  /^entrypoints\.[^.]+\.(forwardedheaders\.(insecure|trustedips)|proxyprotocol\.)/;

/** One entry: `-key`, `--key`, either with `=value`. */
const FLAG = /^(-{1,2})([^=\s]+)(?:=([\s\S]*))?$/;

/** What parseEdgeArgs makes of `edge.args`. */
export interface EdgeArgs {
  /** The entries the edge's command carries, in order. */
  keep: string[];
  /** The entries Den drops because it sets them itself (with their values). */
  dropped: string[];
}

function refuse(entry: string, what: string): never {
  throw new Error(
    `edge.args: "${entry}" ${what}, which edge.args can't set: Den sets the ` +
      "edge's entrypoints, providers, API (none), logs and tracing itself. " +
      `edge.args can set ${ALLOWED_TEXT}.`,
  );
}

/**
 * `edge.args` checked against the allow-list: what the command keeps and
 * what is dropped as Den's own trust. Throws on anything else, naming the
 * entry and the key it sets.
 */
export function parseEdgeArgs(args: readonly string[]): EdgeArgs {
  const keep: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const entry = args[i];
    const m = FLAG.exec(entry);
    if (!m || m[2].startsWith("-") || !/^[a-z0-9_.-]+$/i.test(m[2]))
      refuse(entry, "is not a Traefik flag (--key=value)");
    const key = m[2].toLowerCase();
    // `--key value`: the next entry, when it is no flag, is the value.
    const spaced =
      m[3] === undefined && i + 1 < args.length && !args[i + 1].startsWith("-");
    const value = spaced ? args[i + 1] : m[3];
    const entries = spaced ? [entry, args[i + 1]] : [entry];
    if (spaced) i++;
    if (OWNED_KEY.test(key)) {
      dropped.push(...entries);
      continue;
    }
    const rule = ALLOWED.find((a) => a.key.test(key));
    if (!rule) refuse(entry, `sets ${key}`);
    const fits = (v: string) =>
      typeof rule.value === "function" ? rule.value(v) : rule.value!.test(v);
    if (rule.value && !(value !== undefined && fits(value)))
      refuse(entry, `sets ${key} to ${value ?? "nothing"}`);
    keep.push(...entries);
  }
  return { keep, dropped };
}

/**
 * An entry that turns Traefik's API or dashboard on, or has it read a
 * static config file of its own: `--api…`, `-api…`, `--configFile…`, any
 * case.
 */
export const API_FLAG = /^-{1,2}(api(\.|=|$)|configfile(=|$))/i;

/**
 * Whether a command (a running edge's, as `docker inspect` gives it) turns
 * Traefik's API on: an edge started before Den refused such edge.args.
 */
export function commandServesApi(cmd: readonly string[]): boolean {
  return cmd.some((a) => API_FLAG.test(a));
}
