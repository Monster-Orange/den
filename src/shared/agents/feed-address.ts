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
  // Reviewer C: NAT64 (it can name any IPv4 address) and documentation.
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
] as const)
  NOT_PUBLIC.addSubnet(net, bits, "ipv6");

/** This machine's own addresses: Den's port there is Den itself. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addSubnet("0.0.0.0", 32, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
LOOPBACK.addAddress("::", "ipv6");
// Reviewer C: IPv4 loopback mapped into IPv6, in any spelling.
LOOPBACK.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

/** Whether `ip` (an address, not a name) is this machine. */
function isLoopback(ip: string): boolean {
  const v = isIP(ip);
  return v !== 0 && LOOPBACK.check(ip, v === 6 ? "ipv6" : "ipv4");
}

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

/**
 * Issue 1491: the one address a public-only feed's request may go to, or
 * null when it may go to none: its name is this machine's, it doesn't
 * resolve, or any answer is not public. The request is then pinned to
 * this address (feed-pinned-request.ts), so a second lookup that answers
 * differently (DNS rebinding) is never made.
 */
export async function checkedAddress(
  url: string,
  lookup: FeedLookup = defaultLookup,
): Promise<{ address: string; family: 4 | 6 } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = hostOf(u);
  if (!h || isLocalName(h)) return null;
  const v = isIP(h);
  if (v) return isPublicAddress(h) ? { address: h, family: v as 4 | 6 } : null;
  let all: { address: string; family: number }[];
  try {
    all = await lookup(h);
  } catch {
    return null;
  }
  if (!all.length || all.some((x) => !isPublicAddress(x.address))) return null;
  const [first] = all;
  return {
    address: first!.address,
    family: isIP(first!.address) === 6 ? 6 : 4,
  };
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
  const here = isLocalName(h) || isLoopback(h);
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
