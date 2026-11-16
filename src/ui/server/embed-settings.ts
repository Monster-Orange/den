/**
 * Issue 103: Settings › Embedding, the person's (config/local/user.yml
 * `embed:`). How other web apps reach an agent: a deep link that fills its
 * composer (`/p/<project>/agents/<id>?context=<url>`).
 *
 *   url_max_chars   the longest `?context=` URL a deep link takes (8192)
 *
 * A limit is a Setting with a permissive default, never hard-wired. GET
 * /api/settings serves `embed`; POST takes `embed: { … }` (a key set to
 * null goes back to its default). Only a person changes them
 * (PERSON_ONLY_SETTINGS).
 */
import type { UserConfig } from "../../shared/den-config.js";

export const EMBED_DEFAULTS = {
  url_max_chars: 8192,
} as const;

/** The bounds each number may take. */
const LIMITS: Record<keyof typeof EMBED_DEFAULTS, [number, number]> = {
  url_max_chars: [64, 1_000_000],
};

export interface EmbedSettings {
  url_max_chars: number;
}

function num(v: unknown, key: keyof typeof EMBED_DEFAULTS): number {
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
  };
}

/**
 * Apply a POSTed `embed` to `user` (in place). Each key: a number in its
 * bounds, or null for the default. Anything else: the error to answer.
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
    if (!(k in LIMITS))
      return { ok: false, error: `embed has no setting "${k}"` };
    const key = k as keyof typeof EMBED_DEFAULTS;
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
