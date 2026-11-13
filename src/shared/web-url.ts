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
} from "./den-config.js";
import { checkWebUrl } from "./web-url-check.js";

export { checkWebUrl };

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

/** Set the address (as the person gave it: confirmed). Returns the origin. */
export function setWebUrl(
  address: string,
  merge: (p: Partial<UserConfig>) => unknown = mergeUserConfig,
  read: () => UserConfig = readUserConfig,
): string {
  const ok = checkWebUrl(address);
  if (!("url" in ok)) throw new Error(ok.error);
  const web: Record<string, unknown> = { ...webBlock(read()), url: ok.url };
  delete web.url_confirmed;
  delete web.url_from;
  merge({ web });
  return ok.url;
}

/**
 * One time, for an install made before web.url: the address it already
 * had (`found`: Hub's den_url, else an edge route to this server), written
 * unconfirmed with where it came from. Nothing when web.url is set, or
 * when there is nothing to take. Returns what is set afterwards.
 */
export function migrateWebUrl(
  found: () => { url: string; from: string } | undefined,
  merge: (p: Partial<UserConfig>) => unknown = mergeUserConfig,
  read: () => UserConfig = readUserConfig,
): WebUrl | null {
  const now = readWebUrl(read);
  if (now) return now;
  let hit: { url: string; from: string } | undefined;
  try {
    hit = found();
  } catch {
    hit = undefined;
  }
  const ok = hit ? checkWebUrl(hit.url) : null;
  if (!hit || !ok || !("url" in ok)) return null;
  try {
    merge({
      web: {
        ...webBlock(read()),
        url: ok.url,
        url_confirmed: false,
        url_from: hit.from,
      },
    });
  } catch {
    return null;
  }
  return { url: ok.url, confirmed: false, from: hit.from };
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
