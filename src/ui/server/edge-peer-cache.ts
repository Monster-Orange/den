/**
 * The web server's cache of the edge container's own addresses
 * (isEdgePeer, setEdgeAddresses): when it reads them again.
 *
 *   - Every TTL (edge.address_recheck_seconds, default 60): a timer while
 *     the server runs, and a hit past the TTL. An edge that stopped, or
 *     was recreated at a new address, stops being trusted at its old one
 *     within a TTL; Docker hands freed addresses out again.
 *   - Nothing read for two TTLs (Docker not answering, a read stuck): no
 *     address is the edge, loopback only. It fails closed.
 *   - On a miss from any peer beyond loopback, not only the Docker ranges:
 *     a daemon with its own address pools gives the edge one outside them.
 *   - One read at a time, at most one per 5 s; `edge up`'s read (force)
 *     goes out at once, or right after the one in flight.
 */
import {
  isEdgePeer,
  isLoopbackAddress,
  setEdgeAddresses,
} from "./request-guard.js";

export interface EdgePeerCacheDeps {
  /** The edge container's addresses now (edgeContainerAddresses). */
  read: () => Promise<string[]>;
  /** The TTL, read each time (a Setting). */
  ttlMs: () => number;
  now?: () => number;
  /** The least time between two reads that aren't forced. */
  minGapMs?: number;
  /** Run `fn` in `ms` (an unref'd timer by default). */
  schedule?: (fn: () => void, ms: number) => void;
}

export interface EdgePeerCache {
  /** Whether `addr` is the edge (loopback, or the edge container's own). */
  isEdge(addr: string | undefined): boolean;
  /** Read again: within the rate limit, or at once when forced. */
  refresh(force?: boolean): Promise<void>;
  /** Read now, then every TTL. */
  start(): void;
}

export function edgePeerCache(deps: EdgePeerCacheDeps): EdgePeerCache {
  const now = deps.now ?? Date.now;
  const minGap = deps.minGapMs ?? 5_000;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref();
    });
  let readAt = -Infinity; // the last read that answered
  let startedAt = -Infinity;
  let busy: Promise<void> | null = null;
  let again = false;

  const go = (): Promise<void> => {
    startedAt = now();
    busy = deps
      .read()
      .then((a) => {
        setEdgeAddresses(a);
        readAt = now();
      })
      .catch(() => undefined)
      .finally(() => {
        busy = null;
        if (again) {
          again = false;
          void go();
        }
      });
    return busy;
  };

  const refresh = (force = false): Promise<void> => {
    if (busy) {
      if (force) again = true;
      return busy;
    }
    if (!force && now() - startedAt < minGap) return Promise.resolve();
    return go();
  };

  return {
    isEdge(addr) {
      if (isLoopbackAddress(addr)) return true;
      const age = now() - readAt;
      // Nothing read for two TTLs: what was read last is not believed.
      if (age > 2 * deps.ttlMs()) setEdgeAddresses(null);
      const hit = isEdgePeer(addr);
      if (!hit || age > deps.ttlMs()) void refresh();
      return hit;
    },
    refresh,
    start() {
      const tick = () => {
        void refresh(true).finally(() => schedule(tick, deps.ttlMs()));
      };
      tick();
    },
  };
}
