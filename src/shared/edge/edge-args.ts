interface Allowed {
  key: RegExp;
  value?: RegExp | ((v: string) => boolean);
}

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
  { key: /^accesslog\.fields\.defaultmode$/ },
  { key: /^accesslog\.fields\.names\.[a-z0-9_]+$/ },
  { key: /^log\.level$/, value: /^(info|warn|error|fatal|panic)$/i },
  { key: /^log\.(format|nocolor)$/ },
  { key: /^core\.defaultrulesyntax$/, value: /^v[23]$/i },
  { key: /^global\.(checknewversion|sendanonymoususage)$/ },
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
  { key: /^providers\.providersthrottleduration$/, value: duration(0, 5_000) },
];

const ALLOWED_TEXT =
  "accesslog (and its format, bufferingSize, filters.* and fields.defaultMode / fields.names.*), " +
  "log.level (INFO, WARN, ERROR, FATAL or PANIC), log.format, log.noColor, " +
  "core.defaultRuleSyntax (v2 or v3), global.checkNewVersion, global.sendAnonymousUsage, " +
  "entryPoints.web / entryPoints.websecure transport timeouts (readTimeout and idleTimeout above 0) and keep-alive, " +
  "serversTransport.maxIdleConnsPerHost and its dial, response-header and ping timeouts, " +
  "providers.providersThrottleDuration (at most 5s)";

const OWNED_KEY =
  /^entrypoints\.[^.]+\.(forwardedheaders\.(insecure|trustedips)|proxyprotocol\.)/;

const FLAG = /^(-{1,2})([^=\s]+)(?:=([\s\S]*))?$/;

export interface EdgeArgs {
  keep: string[];
  dropped: string[];
}

function refuse(entry: string, what: string): never {
  throw new Error(
    `edge.args: "${entry}" ${what}, which edge.args can't set: Den sets the ` +
      "edge's entrypoints, providers, API (none), logs and tracing itself. " +
      `edge.args can set ${ALLOWED_TEXT}.`,
  );
}

// An allow-list: Traefik's API would show the proof, so any flag outside
// the list is refused.
export function parseEdgeArgs(args: readonly string[]): EdgeArgs {
  const keep: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const entry = args[i];
    const m = FLAG.exec(entry);
    if (!m || m[2].startsWith("-") || !/^[a-z0-9_.-]+$/i.test(m[2]))
      refuse(entry, "is not a Traefik flag (--key=value)");
    const key = m[2].toLowerCase();
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

export const API_FLAG = /^-{1,2}(api(\.|=|$)|configfile(=|$))/i;

export function commandServesApi(cmd: readonly string[]): boolean {
  return cmd.some((a) => API_FLAG.test(a));
}
