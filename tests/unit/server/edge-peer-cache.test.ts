import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import {
  edgePeerCache,
  WATCH_SINCE_MARGIN_MS,
} from "../../../src/ui/server/edge-peer-cache.js";
import {
  isEdgePeer,
  setEdgeAddresses,
} from "../../../src/ui/server/request-guard.js";

afterEach(() => setEdgeAddresses(null));

const EDGE_IP = "172.20.0.2";
const TTL = 60_000;

function rig(first: string[] = [EDGE_IP]) {
  let t = 1_000_000;
  let answer: { id: string | null; addresses: string[] } = {
    id: first.length ? "edge-1" : null,
    addresses: first,
  };
  let pending: (() => void)[] = [];
  const reads: number[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const watches: {
    id: string;
    sinceMs: number;
    lost: () => void;
    ended: () => void;
    stopped: boolean;
  }[] = [];
  const states: string[] = [];
  const cache = edgePeerCache({
    watch: (id, on, sinceMs) => {
      const w = { id, sinceMs, ...on, stopped: false };
      watches.push(w);
      return () => {
        w.stopped = true;
      };
    },
    onWatchState: (st) => states.push(st),
    read: () => {
      reads.push(t);
      return new Promise<{ id: string | null; addresses: string[] }>(
        (resolve) => pending.push(() => resolve(answer)),
      );
    },
    ttlMs: () => TTL,
    now: () => t,
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  const settle = async () => {
    const p = pending;
    pending = [];
    for (const r of p) r();
    await new Promise((r) => setImmediate(r));
  };
  return {
    cache,
    reads,
    timers,
    settle,
    watches,
    states,
    tick: (ms: number) => (t += ms),
    answer: (a: string[], id: string | null = a.length ? "edge-1" : null) =>
      (answer = { id, addresses: a }),
  };
}

describe("the edge-address cache", () => {
  it("loopback is always the edge, and never reads", () => {
    const r = rig();
    expect(r.cache.isEdge("127.0.0.1")).toBe(true);
    expect(r.cache.isEdge("::1")).toBe(true);
    expect(r.reads).toEqual([]);
  });

  it("a hit within the TTL reads nothing more", async () => {
    const r = rig();
    void r.cache.refresh(true);
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(true);
    r.tick(TTL - 1);
    expect(r.cache.isEdge(EDGE_IP)).toBe(true);
    expect(r.reads).toHaveLength(1);
  });

  it("a hit past the TTL reads again: an edge that stopped is no longer trusted at its old address", async () => {
    const r = rig();
    void r.cache.refresh(true);
    await r.settle();
    r.tick(TTL + 1);
    r.answer([]);
    expect(r.cache.isEdge(EDGE_IP)).toBe(true);
    expect(r.reads).toHaveLength(2);
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    expect(isEdgePeer(EDGE_IP)).toBe(false);
  });

  it("nothing read for two TTLs (Docker not answering): the old address is refused", async () => {
    const r = rig();
    void r.cache.refresh(true);
    await r.settle();
    r.tick(2 * TTL + 1);
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    expect(isEdgePeer(EDGE_IP)).toBe(false);
    expect(isEdgePeer("127.0.0.1")).toBe(true);
  });

  it("a miss from beyond loopback reads again, in the Docker ranges or not", async () => {
    const r = rig(["10.210.47.9"]);
    void r.cache.refresh(true);
    await r.settle();
    r.answer(["10.210.47.12"]);
    r.tick(5_001);
    expect(r.cache.isEdge("10.210.47.12")).toBe(false);
    expect(r.reads).toHaveLength(2);
    await r.settle();
    expect(r.cache.isEdge("10.210.47.12")).toBe(true);
    expect(r.cache.isEdge("10.210.47.9")).toBe(false);
  });

  it("one read at a time, at most every 5 s", async () => {
    const r = rig();
    void r.cache.refresh(true);
    expect(r.cache.isEdge("172.20.0.9")).toBe(false);
    await r.settle();
    expect(r.cache.isEdge("172.20.0.9")).toBe(false);
    expect(r.reads).toHaveLength(1);
    r.tick(5_001);
    expect(r.cache.isEdge("172.20.0.9")).toBe(false);
    expect(r.reads).toHaveLength(2);
  });

  it("edge up's read goes out at once, and again after one in flight", async () => {
    const r = rig();
    void r.cache.refresh(true);
    void r.cache.refresh(true);
    expect(r.reads).toHaveLength(1);
    await r.settle();
    expect(r.reads).toHaveLength(2);
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(true);
  });

  it("start: a timer reads again every TTL while nothing asks", async () => {
    const r = rig();
    r.cache.start();
    expect(r.reads).toHaveLength(1);
    await r.settle();
    expect(r.timers.map((x) => x.ms)).toEqual([TTL]);
    r.tick(TTL);
    r.answer([]);
    r.timers[0].fn();
    expect(r.reads).toHaveLength(2);
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    expect(r.timers.map((x) => x.ms)).toEqual([TTL, TTL]);
  });
});

describe("the edge container's Docker events (watched by its ID)", () => {
  const up = async () => {
    const r = rig();
    r.cache.start();
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(true);
    expect(r.watches.map((w) => w.id)).toEqual(["edge-1"]);
    return r;
  };

  it("it goes away (die, stop, kill, destroy, a network disconnect): its address is refused at once, within the TTL, and read again", async () => {
    const r = await up();
    r.answer([]);
    r.tick(1_000);
    r.watches[0].lost();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    expect(isEdgePeer(EDGE_IP)).toBe(false);
    expect(r.reads).toHaveLength(2);
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    expect(r.watches[0].stopped).toBe(true);
  });

  it("an event only takes trust away: the address comes back only from a full read", async () => {
    const r = await up();
    r.tick(1_000);
    r.watches[0].lost();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(true);
  });

  it("a read already in flight when it goes away doesn't bring the old address back", async () => {
    const r = await up();
    r.tick(TTL);
    r.timers[0].fn();
    r.watches[0].lost();
    r.answer([]);
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    await r.settle();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
  });

  it("the watch ends (can't start, exits, errors): the cache is dropped at once, and read again within 5 s, not the TTL", async () => {
    const r = await up();
    expect(r.states).toEqual(["up"]);
    r.tick(1_000);
    r.watches[0].ended();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    expect(r.states).toEqual(["up", "down"]);
    const soon = r.timers.filter((x) => x.ms <= 5_000);
    expect(soon.length).toBeGreaterThan(0);
    r.tick(5_000);
    soon[soon.length - 1].fn();
    await r.settle();
    expect(r.watches.map((w) => w.id)).toEqual(["edge-1", "edge-1"]);
    expect(r.cache.isEdge(EDGE_IP)).toBe(true);
    expect(r.states).toEqual(["up", "down", "up"]);
  });

  it("while the watch is down, a hit past 5 s reads again (the short TTL)", async () => {
    const r = await up();
    r.watches[0].ended();
    await r.settle();
    const n = r.reads.length;
    r.watches[1]?.ended();
    r.tick(5_001);
    r.cache.isEdge(EDGE_IP);
    expect(r.reads.length).toBeGreaterThan(n);
  });

  it("an event from a watch the cache already stopped changes nothing", async () => {
    const r = await up();
    r.answer([EDGE_IP], "edge-2");
    r.tick(TTL);
    r.timers[0].fn();
    await r.settle();
    expect(r.watches[0].stopped).toBe(true);
    r.watches[0].lost();
    expect(r.cache.isEdge(EDGE_IP)).toBe(true);
  });

  it("a new edge ID after a recreate is watched, and the old one's watch stopped", async () => {
    const r = await up();
    r.answer(["172.20.0.7"], "edge-2");
    r.tick(1_000);
    r.watches[0].lost();
    await r.settle();
    expect(r.watches.map((w) => [w.id, w.stopped])).toEqual([
      ["edge-1", true],
      ["edge-2", false],
    ]);
    expect(r.cache.isEdge("172.20.0.7")).toBe(true);
  });

  it("the watch replays from before the read began (with a margin), so a die between the read and the watch connecting is seen", async () => {
    const r = rig();
    const readAt = 1_000_000;
    r.cache.start();
    r.tick(800);
    await r.settle();
    expect(r.watches).toHaveLength(1);
    expect(r.watches[0].sinceMs).toBe(readAt - WATCH_SINCE_MARGIN_MS);
    expect(WATCH_SINCE_MARGIN_MS).toBeGreaterThanOrEqual(30_000);
    r.watches[0].lost();
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
  });

  it("a watch moved to a new ID replays from before the read that found it", async () => {
    const r = await up();
    r.answer(["172.20.0.7"], "edge-2");
    r.tick(TTL);
    const readAt = 1_000_000 + TTL;
    r.timers[0].fn();
    r.tick(500);
    await r.settle();
    expect(r.watches[1]).toMatchObject({
      id: "edge-2",
      sinceMs: readAt - WATCH_SINCE_MARGIN_MS,
    });
  });

  it("stop: the watch is stopped (Den stopping)", async () => {
    const r = await up();
    r.cache.stop();
    expect(r.watches[0].stopped).toBe(true);
  });
});

describe("edge.address_recheck_seconds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-ttl-"));
  const write = (extra: string[]) => {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "den.yml"),
      [
        "edge:",
        "  org: acme",
        "  domain: acme.localhost",
        "  tls: none",
        ...extra,
        "",
      ].join("\n"),
    );
  };

  it("defaults to 60; takes 1 to 300; refuses anything else, naming the key", () => {
    try {
      write([]);
      expect(readEdgeConfig(root).addressRecheckSeconds).toBe(60);
      write(["  address_recheck_seconds: 5"]);
      expect(readEdgeConfig(root).addressRecheckSeconds).toBe(5);
      write(["  address_recheck_seconds: 300"]);
      expect(readEdgeConfig(root).addressRecheckSeconds).toBe(300);
      for (const bad of ["0", "1.5", "x", "301", "86400"]) {
        write([`  address_recheck_seconds: ${bad}`]);
        expect(() => readEdgeConfig(root)).toThrow(
          /edge\.address_recheck_seconds/,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
