/**
 * Whether a port is held on this machine, and picking a free one: the one
 * check Den has (the web port for a new distribution, `create`, ON-2; the
 * edge's host ports, issue 455).
 *
 * "In use" is checked without talking to whoever holds the port: a TCP
 * connect that is closed as soon as it opens (no byte is sent), then a
 * bind. Either one finding something there means in use.
 *
 * Issue 455: a port is held when anything listens on it in any address
 * family, the way Docker publishes one (0.0.0.0, `::`, or one interface's
 * address) or a server binds IPv6 only. So the check, with no host given,
 * connects to both loopbacks and to each of this machine's own addresses,
 * then tries to bind both wildcards.
 */
import * as net from "net";
import * as os from "os";
import { RESERVED_DEN_PORTS } from "./constants.js";

/** How long one connect may take before it counts as held. */
const CONNECT_MS = 1_000;

/** Whether something accepts (or half-accepts) a connection at host:port. */
function connects(port: number, host: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v: boolean | null) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(CONNECT_MS);
    sock.once("connect", () => done(true));
    // Something there that doesn't complete a handshake: in use.
    sock.once("timeout", () => done(true));
    sock.once("error", (e: NodeJS.ErrnoException) =>
      // Refused: nothing there. No such address here (no IPv6, say):
      // nothing to learn from it.
      done(
        e.code === "ECONNREFUSED" ||
          e.code === "EADDRNOTAVAIL" ||
          e.code === "ENETUNREACH" ||
          e.code === "EHOSTUNREACH" ||
          e.code === "EAFNOSUPPORT"
          ? null
          : true,
      ),
    );
  });
}

/**
 * Whether binding host:port fails because it is taken. `strict`: any
 * failure is taken (one named host, as before). Otherwise only
 * EADDRINUSE: a wildcard this machine lacks, or a low port only root may
 * bind, says nothing about who holds it.
 */
function bindTaken(
  port: number,
  host: string,
  strict: boolean,
  ipv6Only = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e: NodeJS.ErrnoException) =>
      resolve(strict || e.code === "EADDRINUSE"),
    );
    srv.listen({ port, host, exclusive: true, ipv6Only }, () =>
      srv.close(() => resolve(false)),
    );
  });
}

/** This machine's own addresses (every interface, loopbacks first). */
export function ownAddresses(
  ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string[] {
  const out = new Set<string>(["127.0.0.1", "::1"]);
  for (const list of Object.values(ifaces))
    for (const a of list ?? []) {
      // A link-local IPv6 address needs its zone to connect: skip it.
      if (a.family === "IPv6" && /^fe80:/i.test(a.address)) continue;
      out.add(a.address);
    }
  return [...out];
}

/**
 * Whether something holds `port` on this machine. Never sends a byte.
 * With `host`, that one address (connect, then bind), as `create` always
 * did. Without, every address family (issue 455): both loopbacks are
 * connected to (a wildcard listener answers there too), then each of this
 * machine's other addresses and both wildcards are bound. A bind needs no
 * answer, so an interface a firewall silences costs no wait.
 */
export async function portInUse(
  port: number,
  host?: string,
  addresses: () => string[] = ownAddresses,
): Promise<boolean> {
  if (host !== undefined) {
    const c = await connects(port, host);
    return c === null ? bindTaken(port, host, true) : c;
  }
  const loops = ["127.0.0.1", "::1"];
  const hits = await Promise.all(loops.map((a) => connects(port, a)));
  if (hits.some((h) => h === true)) return true;
  const others = addresses().filter((a) => !loops.includes(a));
  const taken = await Promise.all(
    others.map((a) => bindTaken(port, a, false)),
  );
  if (taken.some(Boolean)) return true;
  // IPv6's wildcard alone (an IPv6-only listener) first, then IPv4's.
  if (await bindTaken(port, "::", false, true)) return true;
  return bindTaken(port, "0.0.0.0", false);
}

export interface PickPortOptions {
  /** The port wanted (the default); the search goes up from here. */
  start: number;
  /** Never chosen. */
  reserved?: readonly number[];
  /** How many ports above `start` to try. */
  span?: number;
  inUse?: (port: number) => Promise<boolean>;
}

/**
 * `start` when it is free, else the first free port above it that is not
 * reserved; null when none in the span is free.
 */
export async function pickFreePort(o: PickPortOptions): Promise<number | null> {
  const reserved = o.reserved ?? RESERVED_DEN_PORTS;
  const inUse = o.inUse ?? ((p: number) => portInUse(p));
  const span = o.span ?? 100;
  for (let p = o.start; p <= Math.min(o.start + span, 65535); p++) {
    if (reserved.includes(p)) continue;
    if (!(await inUse(p))) return p;
  }
  return null;
}
