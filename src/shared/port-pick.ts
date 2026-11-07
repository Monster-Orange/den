/**
 * Picking a free localhost port for a new distribution's web server
 * (`create`, ON-2), so a second Den on one machine doesn't collide with the
 * first on DEFAULT_PORT.
 *
 * "In use" is checked without talking to whoever holds the port: a TCP
 * connect that is closed as soon as it opens (no byte is sent), then a
 * bind. Either one finding something there means in use.
 */
import * as net from "net";
import { RESERVED_DEN_PORTS } from "./constants.js";

/** Whether something holds `port` on localhost. Never sends a byte. */
export function portInUse(port: number, host = "localhost"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (inUse: boolean | null) => {
      sock.destroy();
      if (inUse !== null) return resolve(inUse);
      // Nothing accepted a connection: can we bind it ourselves?
      const srv = net.createServer();
      srv.once("error", () => resolve(true));
      srv.listen({ port, host, exclusive: true }, () =>
        srv.close(() => resolve(false)),
      );
    };
    sock.setTimeout(1_000);
    sock.once("connect", () => done(true));
    // Something there that doesn't complete a handshake: in use.
    sock.once("timeout", () => done(true));
    sock.once("error", (e: NodeJS.ErrnoException) =>
      done(e.code === "ECONNREFUSED" ? null : true),
    );
  });
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
