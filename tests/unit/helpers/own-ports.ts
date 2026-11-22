/**
 * Issue 991: the ports a box run's "host:*" base URL covers. A box's
 * browser reaches this machine's loopback, so it may load only what this
 * test process serves:
 *
 * - ports a server in this process is listening on now (every listen is
 *   seen; a port leaves when its server closes, so freePort's pick, bound
 *   and closed before a child takes it, doesn't stay allowed);
 * - ports claimed with `boxOwnPort`, by a helper that saw its child server
 *   answer there (startDenServer does).
 *
 * One registry per process, kept on net.Server's prototype: Jest loads
 * this module once per test file, and listen is patched once.
 */
import * as net from "net";

const KEY = Symbol.for("den.gate.ownPorts");
interface Registry {
  live: Map<number, number>;
  claimed: Set<number>;
}
type Proto = { listen: (...a: unknown[]) => unknown; [KEY]?: Registry };

function registry(): Registry {
  const proto = net.Server.prototype as unknown as Proto;
  if (proto[KEY]) return proto[KEY];
  const reg: Registry = { live: new Map(), claimed: new Set() };
  proto[KEY] = reg;
  const listen = proto.listen;
  proto.listen = function (this: net.Server, ...a: unknown[]) {
    this.once("listening", () => {
      const at = this.address();
      if (!at || typeof at !== "object") return;
      const port = at.port;
      reg.live.set(port, (reg.live.get(port) ?? 0) + 1);
      this.once("close", () => {
        const n = (reg.live.get(port) ?? 1) - 1;
        if (n > 0) reg.live.set(port, n);
        else reg.live.delete(port);
      });
    });
    return listen.apply(this, a);
  };
  return reg;
}
registry();

/** The run's own ports, as the box guard asks them. */
export function ownPorts(): { has(port: number): boolean } {
  const reg = registry();
  return { has: (port) => reg.live.has(port) || reg.claimed.has(port) };
}

/** A port a child server of this run answers on: the box guard allows it. */
export function boxOwnPort(port: number): void {
  registry().claimed.add(port);
}
