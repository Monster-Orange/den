/**
 * 0.4.45: the two Hub editions Settings › Agents › Hub names under
 * Connect, until the install is connected. The distribution says where
 * they are (den.yml `hub_editions`): Den's source names no host.
 *
 *   hub_editions:
 *     teams_host: hub.example.com      # the shared Hub, as plain text
 *     enterprise_domain: example.com   # "a unique subdomain on …"
 *     talk_url: https://example.com/den#enterprise   # "Talk to us"
 *
 * Unset, or a value that isn't one: that line isn't shown. Never an email
 * address, a price or a date.
 */

export interface HubEditions {
  teamsHost?: string;
  enterpriseDomain?: string;
  talkUrl?: string;
}

const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function host(v: unknown): string | undefined {
  return typeof v === "string" && HOST.test(v.trim()) ? v.trim() : undefined;
}

function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** den.yml's `hub_editions`, the values that are good; null: none. */
export function hubEditions(raw: unknown): HubEditions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: HubEditions = {};
  const t = host(r.teams_host);
  if (t) out.teamsHost = t;
  const d = host(r.enterprise_domain);
  if (d) out.enterpriseDomain = d;
  const u = httpsUrl(r.talk_url);
  if (u) out.talkUrl = u;
  return Object.keys(out).length ? out : null;
}
