/**
 * Issue 1480 (Reviewer C, Lane 1): where an app's event feed may point.
 *
 * - feedSelfProblem: a feed that names Den itself (its web address, its
 *   port on this machine, the edge's names) or its Hub is refused: a
 *   bearer there goes to Den's own routes, and the stream would loop
 *   Den's own events.
 * - feedAddressLocal: whether a feed's address is this machine or a
 *   private, link-local or shared network, by its name or by every
 *   address its name resolves to. A name that can't be resolved counts
 *   as local: the person decides. Such a feed needs the person's own
 *   Allow (app_feed_read would read local services); one checked public
 *   is written `public_only`, and its address is resolved again at each
 *   connect (app-feed-service.ts).
 */
import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

/** One resolved address, as dns.lookup({ all: true }) answers. */
export type FeedLookup = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

/** Den's own addresses and its Hub's, as a feed may not name them. */
export interface FeedOwnAddresses {
  /** Host names (web.url's, Hub's): refused at any port. */
  hosts: string[];
  /** The edge's domains: refused, and every name under them. */
  domains: string[];
  /** Den's ports: refused on this machine. */
  ports: number[];
}

const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  NOT_PUBLIC.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  NOT_PUBLIC.addSubnet(net, bits, "ipv6");

/** Whether `ip` is an address on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const a = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const v = isIP(a);
  if (v === 0) return false;
  if (v === 6) {
    // An IPv4 address mapped into IPv6 is judged as that address.
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (m) return isPublicAddress(m[1]!);
    return !NOT_PUBLIC.check(a, "ipv6");
  }
  return !NOT_PUBLIC.check(a, "ipv4");
}

const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
const isLocalName = (h: string) =>
  h === "localhost" || h.endsWith(".localhost");

const defaultLookup: FeedLookup = (host) =>
  dns.lookup(host, { all: true, verbatim: true });

/**
 * Whether `url` names this machine or a private network: by its name, or
 * by any address it resolves to now. Unresolvable counts as local.
 */
export async function feedAddressLocal(
  url: string,
  lookup: FeedLookup = defaultLookup,
): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const h = hostOf(u);
  if (!h || isLocalName(h)) return true;
  if (isIP(h)) return !isPublicAddress(h);
  try {
    const all = await lookup(h);
    return !all.length || all.some((x) => !isPublicAddress(x.address));
  } catch {
    return true;
  }
}

/** Why `url` names Den or its Hub itself, or null. `key`: url, list_url. */
export function feedSelfProblem(
  url: string,
  key: string,
  own: FeedOwnAddresses,
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = hostOf(u);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const here =
    isLocalName(h) ||
    h === "::1" ||
    h === "0.0.0.0" ||
    /^(::ffff:)?127\./.test(h);
  const hosts = own.hosts.map((x) => x.toLowerCase());
  const domains = own.domains.map((x) => x.toLowerCase());
  if (
    hosts.includes(h) ||
    domains.some((dm) => h === dm || h.endsWith(`.${dm}`)) ||
    (here && own.ports.includes(port))
  )
    return `${key} points at Den or its Hub itself: a feed comes from an app`;
  return null;
}
