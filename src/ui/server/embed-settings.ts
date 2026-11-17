/**
 * Issue 103: Settings › Embedding, the person's (config/local/user.yml
 * `embed:`). How other web apps reach an agent: a deep link that fills its
 * composer (`/p/<project>/agents/<id>?context=<url>`).
 *
 *   url_max_chars   the longest `?context=` URL a deep link takes (8192)
 *   origins         the web apps (exact origins) that may frame the
 *                   embedded agent pane, /embed/p/<project>/agents/<id>;
 *                   none by default. Never a pattern and never `*`
 *   key_minutes     how long an embedded pane's key lasts (15)
 *   context_max_kb  the largest page a host may share with an agent
 *                   ({ type: "den:context", … }, as JSON), in KB (256)
 *   app_key_audit_window_seconds  issue 334: an app key's reads are
 *                   audited one line per key, route and outcome per this
 *                   many seconds, with their count (60)
 *
 * Every other page refuses to be framed by anyone but Den itself
 * (frameHeaders: `frame-ancestors 'self'`, X-Frame-Options SAMEORIGIN):
 * the Tests page frames Den's own report.
 *
 * A limit is a Setting with a permissive default, never hard-wired. GET
 * /api/settings serves `embed`; POST takes `embed: { … }` (a key set to
 * null goes back to its default). Only a person changes them
 * (PERSON_ONLY_SETTINGS).
 */
import type { UserConfig } from "../../shared/den-config.js";

export const EMBED_DEFAULTS = {
  url_max_chars: 8192,
  origins: [] as string[],
  key_minutes: 15,
  context_max_kb: 256,
  app_key_audit_window_seconds: 60,
};

type NumKey =
  | "url_max_chars"
  | "key_minutes"
  | "context_max_kb"
  | "app_key_audit_window_seconds";

/** The bounds each number may take. */
const LIMITS: Record<NumKey, [number, number]> = {
  url_max_chars: [64, 1_000_000],
  key_minutes: [1, 1440],
  context_max_kb: [1, 10_240],
  app_key_audit_window_seconds: [1, 86_400],
};

/** The most origins the list holds. */
export const MAX_ORIGINS = 100;

export interface EmbedSettings {
  url_max_chars: number;
  origins: string[];
  key_minutes: number;
  context_max_kb: number;
  app_key_audit_window_seconds: number;
}

/**
 * `v` as an origin, or why it isn't one. Exact only: scheme://host[:port]
 * as the browser writes it (lower case, no default port, no path, no
 * trailing slash, no user or password), http or https. No `*`, and no
 * other pattern: an origin matches only itself.
 */
export function checkOrigin(
  v: unknown,
): { ok: true; origin: string } | { ok: false; error: string } {
  const bad = (why: string) => ({
    ok: false as const,
    error: `${JSON.stringify(v)} is not an origin: ${why}. Write it as scheme://host[:port], like https://app.example.com.`,
  });
  if (typeof v !== "string" || !v) return bad("it must be text");
  if (v.includes("*")) return bad("no wildcards");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad("it doesn't parse");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return bad("only http and https");
  if (u.username || u.password) return bad("no login details in it");
  if (u.origin !== v) return bad(`it would be read as ${u.origin}`);
  return { ok: true, origin: u.origin };
}

/** Whether `origin` is on `list`: exactly, never a prefix or a part. */
export function originListed(
  origin: unknown,
  list: readonly string[],
): boolean {
  return typeof origin === "string" && origin !== "" && list.includes(origin);
}

function originsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const o of v) {
    const c = checkOrigin(o);
    if (c.ok && !out.includes(c.origin)) out.push(c.origin);
  }
  return out.slice(0, MAX_ORIGINS);
}

/** The embedded pane's page: /embed/p/<project>/agents/<id>. */
export const EMBED_PAGE = /^\/embed\/p\/[^/]+\/agents\/[^/]+\/?$/;

/**
 * The framing headers a response carries. Every page: framed by Den
 * itself only (`frame-ancestors 'self'`, X-Frame-Options SAMEORIGIN for
 * older browsers). The embedded pane: framed only by the listed origins
 * (none: `'none'`), no X-Frame-Options (it can't name a list).
 */
export function frameHeaders(
  pathname: string,
  origins: () => readonly string[],
): Record<string, string> {
  if (!EMBED_PAGE.test(pathname))
    return {
      "Content-Security-Policy": "frame-ancestors 'self'",
      "X-Frame-Options": "SAMEORIGIN",
    };
  const list = originsOf([...origins()]);
  return {
    "Content-Security-Policy": `frame-ancestors ${list.length ? list.join(" ") : "'none'"}`,
  };
}

function num(v: unknown, key: NumKey): number {
  const [lo, hi] = LIMITS[key];
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi
    ? v
    : EMBED_DEFAULTS[key];
}

/** The stored settings, each falling back to its default. */
export function embedSettings(user: UserConfig): EmbedSettings {
  const e = (user.embed ?? {}) as Record<string, unknown>;
  return {
    url_max_chars: num(e.url_max_chars, "url_max_chars"),
    origins: originsOf(e.origins),
    key_minutes: num(e.key_minutes, "key_minutes"),
    context_max_kb: num(e.context_max_kb, "context_max_kb"),
    app_key_audit_window_seconds: num(
      e.app_key_audit_window_seconds,
      "app_key_audit_window_seconds",
    ),
  };
}

/**
 * Apply a POSTed `embed` to `user` (in place). Each number: in its
 * bounds, or null for the default. `origins`: a list of exact origins
 * (checkOrigin), or null for none. Anything else: the error to answer.
 */
export function patchEmbed(
  user: UserConfig,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (v === null) {
    delete user.embed;
    return { ok: true };
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ok: false, error: "embed must be an object, or null" };
  const next = { ...((user.embed ?? {}) as Record<string, unknown>) };
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "origins") {
      if (val === null) {
        delete next.origins;
        continue;
      }
      if (!Array.isArray(val))
        return { ok: false, error: "embed.origins must be a list, or null" };
      if (val.length > MAX_ORIGINS)
        return {
          ok: false,
          error: `embed.origins holds at most ${MAX_ORIGINS} origins`,
        };
      const list: string[] = [];
      for (const o of val) {
        const c = checkOrigin(o);
        if (!c.ok) return { ok: false, error: c.error };
        if (!list.includes(c.origin)) list.push(c.origin);
      }
      if (list.length) next.origins = list;
      else delete next.origins;
      continue;
    }
    if (!(k in LIMITS))
      return { ok: false, error: `embed has no setting "${k}"` };
    const key = k as NumKey;
    if (val === null) {
      delete next[key];
      continue;
    }
    const [lo, hi] = LIMITS[key];
    if (
      typeof val !== "number" ||
      !Number.isInteger(val) ||
      val < lo ||
      val > hi
    )
      return {
        ok: false,
        error: `embed.${key} must be a whole number from ${lo} to ${hi}, or null`,
      };
    next[key] = val;
  }
  if (Object.keys(next).length) user.embed = next;
  else delete user.embed;
  return { ok: true };
}

/**
 * Why `v` can't be a deep link's context, or null: an http or https URL
 * (with a host) of at most `max` characters. Nothing else is taken.
 */
export function contextUrlProblem(
  v: string,
  max: number,
): { reason: "context_scheme" | "context_long"; max: number } | null {
  if (v.length > max) return { reason: "context_long", max };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { reason: "context_scheme", max };
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.host)
    return { reason: "context_scheme", max };
  return null;
}
