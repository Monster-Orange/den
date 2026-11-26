/**
 * D80: this install's address, `web.url` (config/local/user.yml), for
 * example https://acme.local.example.com. It is a fact of the install, set
 * once (`<cli> web url <address>`), and the one address people are given:
 * the start banner, `web up`, sign-in links, doctor, Hub's den_url.
 *
 * The name resolves to this machine on the machine itself and to it over
 * the network everywhere else, so one address works from every device.
 * Nothing is worked out from where the browser is; nothing falls back to
 * localhost. Unset is said as such (notSetLine), and doctor fails.
 *
 * Agents' own MCP and API calls stay on loopback: an internal detail, never
 * shown to a person.
 */
import {
  mergeUserConfig,
  readUserConfig,
  type UserConfig,
} from "../den-config.js";
import {
  aliasCandidates,
  checkWebUrl,
  isLoopbackUrl,
  loopbackRefusal,
} from "./web-url-check.js";
import { auditConfig } from "../config-audit.js";

export { checkWebUrl, isLoopbackUrl };

export interface WebUrl {
  /** The origin: scheme, host and port, no path. */
  url: string;
  /**
   * False when a one-time migration wrote it from what the install
   * already had (Hub's den_url, an edge route): doctor asks to confirm.
   */
  confirmed: boolean;
  /** Where a migrated one came from ("the edge route", say). */
  from?: string;
}

function webBlock(user: UserConfig): Record<string, unknown> {
  const w = user.web;
  return w && typeof w === "object" && !Array.isArray(w) ? w : {};
}

/** The install's address, or null when it isn't set (or isn't valid). */
export function readWebUrl(
  read: () => UserConfig = readUserConfig,
): WebUrl | null {
  let user: UserConfig;
  try {
    user = read();
  } catch {
    return null;
  }
  const w = webBlock(user);
  const ok = checkWebUrl(w.url);
  if (!("url" in ok)) return null;
  return {
    url: ok.url,
    confirmed: w.url_confirmed !== false,
    ...(typeof w.url_from === "string" ? { from: w.url_from } : {}),
  };
}

/**
 * Issue 666: how a web.url change came about, for its activity row: the
 * path (`web url`, Settings, the migration, an alias made the address)
 * and who asked (a person's principal; absent: the process's own user).
 */
export interface WebUrlChange {
  path: string;
  who?: string;
}

/** The activity row for a web.url change (or a refused one). */
function auditChange(
  from: string | null,
  to: string,
  how: WebUrlChange,
  refused?: string,
): void {
  auditConfig({
    verb: "web-url",
    detail: `${from ?? "unset"} → ${to} (by ${how.path}${how.who ? `, ${how.who}` : ""})`,
    ...(refused ? { outcome: "refused" as const, reason: refused } : {}),
  });
}

/** web.url as written (valid or not), for the row's "from". */
function storedUrl(read: () => UserConfig): string | null {
  try {
    const u = webBlock(read()).url;
    return typeof u === "string" && u ? u : null;
  } catch {
    return null;
  }
}

/**
 * Set the address (as the person gave it: confirmed). Returns the origin.
 * Issue 666: a loopback name is refused here, whoever calls, and every
 * change (or refusal) is an activity row.
 */
export function setWebUrl(
  address: string,
  merge: (p: Partial<UserConfig>) => unknown = mergeUserConfig,
  read: () => UserConfig = readUserConfig,
  how: WebUrlChange = { path: "setWebUrl" },
): string {
  const ok = checkWebUrl(address);
  if (!("url" in ok)) throw new Error(ok.error);
  const before = storedUrl(read);
  const loop = loopbackRefusal(ok.url);
  if (loop) {
    auditChange(before, ok.url, how, loop);
    throw new Error(loop);
  }
  const web: Record<string, unknown> = { ...webBlock(read()), url: ok.url };
  delete web.url_confirmed;
  delete web.url_from;
  merge({ web });
  auditChange(before, ok.url, how);
  return ok.url;
}

/** What the migration may take: an edge route's address, and where from. */
export interface WebUrlFinding {
  url: string;
  from: string;
  /** A route the config's edge.routes names on purpose (not the brand's). */
  named?: boolean;
}

/**
 * The addresses the migration may take, best first: aliasCandidates (valid,
 * never loopback, https first), and within a scheme a route the config's
 * edge.routes names on purpose before the one made from the brand. A
 * distribution names a route when only that name is reachable from other
 * machines.
 */
export function rankFindings(
  hits: readonly WebUrlFinding[],
): { url: string; hit: WebUrlFinding }[] {
  const origin = (u: string) => {
    const c = checkWebUrl(u);
    return "url" in c ? c.url : null;
  };
  const ranked = aliasCandidates(hits.map((h) => h.url)).flatMap((url) => {
    const same = hits.filter((h) => origin(h.url) === url);
    const hit = same.find((h) => h.named) ?? same[0];
    return hit ? [{ url, hit }] : [];
  });
  const key = (r: { url: string; hit: WebUrlFinding }) =>
    (r.url.startsWith("https:") ? 0 : 2) + (r.hit.named ? 0 : 1);
  return ranked
    .map((r, i) => ({ r, i }))
    .sort((a, b) => key(a.r) - key(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

function readFindings(
  found: () => WebUrlFinding | readonly WebUrlFinding[] | undefined,
): readonly WebUrlFinding[] {
  try {
    const f = found();
    return !f ? [] : Array.isArray(f) ? f : [f as WebUrlFinding];
  } catch {
    return [];
  }
}

/**
 * One time, for an install made before web.url: the address it already
 * had (`found`: the edge routes to this server), written unconfirmed with
 * where it came from. Nothing when web.url is set, or when there is
 * nothing to take. Returns what is set afterwards.
 *
 * Issue 666: a loopback name is never taken (an edge on `localhost` gave
 * https://<name>.localhost, which only this machine opens): the first
 * alias that isn't one is (https first). A loopback web.url already there
 * is replaced by that alias, unconfirmed, for doctor to show; with no
 * alias it stays, and doctor fails it.
 *
 * A route the config's edge.routes names (`named`) is taken over the one
 * made from the brand (rankFindings). An address this migration already
 * wrote from the brand route (unconfirmed, url_from set) while a named
 * route exists is corrected to it, once, still unconfirmed. A confirmed
 * address, or one a person set, is never changed.
 */
export function migrateWebUrl(
  found: () => WebUrlFinding | readonly WebUrlFinding[] | undefined,
  merge: (p: Partial<UserConfig>) => unknown = mergeUserConfig,
  read: () => UserConfig = readUserConfig,
): WebUrl | null {
  const now = readWebUrl(read);
  const migrated = !!now && !now.confirmed && now.from !== undefined;
  if (now && !isLoopbackUrl(now.url) && !migrated) return now;
  const hits = readFindings(found);
  const best = rankFindings(hits)[0];
  if (!best) return now;
  const { url, hit } = best;
  let from: string;
  if (!now) from = hit.from;
  else if (isLoopbackUrl(now.url))
    from = `${hit.from}, in place of ${now.url}, which only this machine opens`;
  else {
    // Migrated from a route: correct it only when it was the brand route
    // and a named one is there.
    const tookBrand = hits.some((h) => {
      const c = checkWebUrl(h.url);
      return !h.named && "url" in c && c.url === now.url;
    });
    if (!hit.named || url === now.url || !tookBrand) return now;
    from = `${hit.from}, in place of ${now.url}, the route made from the brand name`;
  }
  try {
    merge({
      web: {
        ...webBlock(read()),
        url,
        url_confirmed: false,
        url_from: from,
      },
    });
  } catch {
    return now;
  }
  auditChange(now?.url ?? null, url, { path: "the one-time migration" });
  return { url, confirmed: false, from };
}

/** What a person reads where the address would be, when it isn't set. */
export function notSetLine(cli: string): string {
  return `address not set: run \`${cli} web url <address>\``;
}

/** `path` (with its query) on the install's address; null when it isn't set. */
export function publicLink(path = "/", w = readWebUrl()): string | null {
  if (!w) return null;
  return `${w.url}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The install's address, or an Error saying it isn't set (notSetLine). */
export function requireWebUrl(cli: string, w = readWebUrl()): string {
  if (!w) throw new Error(notSetLine(cli));
  return w.url;
}
