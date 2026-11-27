import {
  isEdgePeer,
  isLoopbackAddress,
  setEdgeAddresses,
} from "./request-guard.js";

export interface EdgeSeen {
  id: string | null;
  addresses: string[];
}

export const DOWN_TTL_MS = 5_000;

export const WATCH_SINCE_MARGIN_MS = 30_000;

export type EdgeWatchState = "none" | "up" | "down";

export interface EdgePeerCacheDeps {
  read: () => Promise<EdgeSeen>;
  ttlMs: () => number;
  now?: () => number;
  minGapMs?: number;
  schedule?: (fn: () => void, ms: number) => void;
  watch?: (
    id: string,
    on: { lost: () => void; ended: () => void },
    sinceMs: number,
  ) => () => void;
  onWatchState?: (s: EdgeWatchState) => void;
}

export interface EdgePeerCache {
  isEdge(addr: string | undefined): boolean;
  refresh(force?: boolean): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Docker hands a freed address to the next container at once, so the edge
 * container's die, stop, kill, destroy or disconnect drops its addresses.
 * Events only take trust away; addresses come only from a full read. While
 * the watch is down, an address is kept for at most twice 5 s.
 */
export function edgePeerCache(deps: EdgePeerCacheDeps): EdgePeerCache {
  const now = deps.now ?? Date.now;
  const minGap = deps.minGapMs ?? 5_000;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref();
    });
  let readAt = -Infinity;
  let startedAt = -Infinity;
  let busy: Promise<void> | null = null;
  let again = false;
  let gen = 0;
  let watched: { id: string; stop: () => void } | null = null;
  let state: EdgeWatchState = "none";
  let stopped = false;

  const setState = (s: EdgeWatchState) => {
    if (s === state) return;
    state = s;
    deps.onWatchState?.(s);
  };
  const ttl = () =>
    deps.watch && state === "down"
      ? Math.min(deps.ttlMs(), DOWN_TTL_MS)
      : deps.ttlMs();
  const unwatch = () => {
    const w = watched;
    watched = null;
    w?.stop();
  };
  const drop = () => {
    gen++;
    readAt = -Infinity;
    setEdgeAddresses(null);
  };
  const follow = (id: string | null, readBegan: number) => {
    if (!deps.watch || stopped) return;
    if (!id) {
      unwatch();
      setState("none");
      return;
    }
    if (watched?.id === id) return;
    unwatch();
    const mine = { id, stop: () => undefined as void };
    watched = mine;
    const stop = deps.watch(
      id,
      {
        lost: () => {
          if (watched !== mine) return;
          drop();
          void refresh(true);
        },
        ended: () => {
          if (watched !== mine) return;
          watched = null;
          drop();
          setState("down");
          schedule(() => void refresh(true), DOWN_TTL_MS);
        },
      },
      readBegan - WATCH_SINCE_MARGIN_MS,
    );
    if (watched === mine) {
      mine.stop = stop;
      setState("up");
    } else stop();
  };

  const go = (): Promise<void> => {
    startedAt = now();
    const began = startedAt;
    const g = gen;
    busy = deps
      .read()
      .then((seen) => {
        if (g !== gen) {
          again = true;
          return;
        }
        setEdgeAddresses(seen.addresses);
        readAt = now();
        follow(seen.id, began);
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
      if (age > 2 * ttl()) setEdgeAddresses(null);
      const hit = isEdgePeer(addr);
      if (!hit || age > ttl()) void refresh();
      return hit;
    },
    refresh,
    start() {
      const tick = () => {
        if (stopped) return;
        void refresh(true).finally(() => schedule(tick, ttl()));
      };
      tick();
    },
    stop() {
      stopped = true;
      unwatch();
    },
  };
}
