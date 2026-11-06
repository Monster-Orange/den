/**
 * The edge counts as local (0.4.3): with no sign-in through the edge, who
 * can reach the edge can use terminals. When Den can tell the edge is
 * reachable beyond this machine it says so, once in web.log and in a
 * banner on every page (the shell, dismissible per browser).
 *
 * How it tells (read-only, once at start):
 *  - an edge hostname that routes to Den resolves to an address that isn't
 *    loopback (a LAN or a VPN address, such as Tailscale's 100.x); or
 *  - the edge's container publishes a port on every interface (a
 *    PortBindings HostIp of "", 0.0.0.0 or ::), from `docker inspect`.
 * Neither (an edge on `*.localhost`, published on 127.0.0.1, or not
 * running): no warning.
 */
import { execFile } from "child_process";
import { promises as dns } from "dns";
import { isLoopbackAddress } from "./request-guard.js";

export const EDGE_EXPOSED_MESSAGE =
  "Your edge is reachable from other machines; anyone who can reach it can use terminals. Auth is coming.";

export interface ExposureDeps {
  /** Every address a hostname resolves to (none when it doesn't). */
  lookup?: (host: string) => Promise<string[]>;
  /** The edge container's `docker inspect` PortBindings, or null. */
  portBindings?: (container: string) => Promise<unknown>;
}

async function lookupAll(host: string): Promise<string[]> {
  try {
    return (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

function inspectPortBindings(container: string): Promise<unknown> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["inspect", "--format", "{{json .HostConfig.PortBindings}}", container],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(String(stdout)));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** A published port bound on every interface, from PortBindings. */
export function publishedOnAllInterfaces(bindings: unknown): string | null {
  if (!bindings || typeof bindings !== "object") return null;
  for (const [port, list] of Object.entries(bindings as object)) {
    if (!Array.isArray(list)) continue;
    for (const b of list as { HostIp?: string; HostPort?: string }[]) {
      const ip = String(b?.HostIp ?? "");
      if (ip === "" || ip === "0.0.0.0" || ip === "::")
        return `the edge publishes ${b?.HostPort || port} on every interface`;
    }
  }
  return null;
}

/**
 * Why the edge is reachable beyond this machine, or null when Den can't
 * tell that it is.
 */
export async function edgeExposure(
  hosts: readonly string[],
  container: string | null,
  deps: ExposureDeps = {},
): Promise<string | null> {
  const lookup = deps.lookup ?? lookupAll;
  for (const h of hosts) {
    const away = (await lookup(h)).find((a) => !isLoopbackAddress(a));
    if (away) return `${h} resolves to ${away}`;
  }
  if (!container || hosts.length === 0) return null;
  const bindings = await (deps.portBindings ?? inspectPortBindings)(container);
  return publishedOnAllInterfaces(bindings);
}
