/**
 * How Den's own code reaches Den's web server on this machine.
 *
 * The server listens on DEN_BIND_HOST (127.0.0.1 when unset). Never dial
 * `localhost`: Node resolves it to ::1 first, and another program
 * listening there on the same port answers instead (D80). The lint rule
 * in .eslintrc.json keeps `http://localhost:${port}` out of src.
 */
import * as net from "net";

/**
 * Where probes and calls reach the server, and the Host they send: the
 * address DEN_BIND_HOST binds. Unset, 0.0.0.0 or `::` answer on loopback,
 * so 127.0.0.1; one specific address (a LAN IP with
 * web.allow_plain_http_remote, or ::1) answers only there. The Host names
 * that address (an IPv6 one bracketed): the Host allowlist accepts it (a
 * loopback name, or the bound LAN address).
 */
export function webProbeTarget(
  bind: string | undefined,
  port: number,
): { host: string; hostHeader: string } {
  const b = (bind ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const host = b === "" || b === "0.0.0.0" || b === "::" ? "127.0.0.1" : b;
  return {
    host,
    hostHeader: `${net.isIPv6(host) ? `[${host}]` : host}:${port}`,
  };
}

/** `http://<bound address>:<port>`: the base for a call to Den's server. */
export function denWebBase(
  port: number,
  bind: string | undefined = process.env.DEN_BIND_HOST,
): string {
  return `http://${webProbeTarget(bind, port).hostHeader}`;
}
