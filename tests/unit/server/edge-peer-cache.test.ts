/**
 * The server's cache of the edge container's own addresses (isEdgePeer):
 * how the web server's peerIsEdge reads and re-reads them.
 *
 *   - read again on a TTL (edge.address_recheck_seconds, default 60): a
 *     hit past it re-reads, and a timer re-reads while nothing asks, so an
 *     edge that stopped or moved stops being trusted at its old address;
 *   - nothing read for two TTLs (Docker not answering): no address is the
 *     edge, loopback only;
 *   - read again on a miss from any peer beyond loopback, not only the
 *     Docker ranges (a daemon with its own address pools);
 *   - at most one read at a time, at most one per 5 s, except `edge up`'s.
 *
 * Fake clock and reads: no Docker, no server.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import { edgePeerCache } from "../../../src/ui/server/edge-peer-cache.js";
import {
  isEdgePeer,
  setEdgeAddresses,
} from "../../../src/ui/server/request-guard.js";

afterEach(() => setEdgeAddresses(null));

const EDGE_IP = "172.20.0.2";
const TTL = 60_000;

function rig(first: string[] = [EDGE_IP]) {
  let t = 1_000_000;
  let answer = first;
  let pending: (() => void)[] = [];
  const reads: number[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const cache = edgePeerCache({
    read: () => {
      reads.push(t);
      return new Promise<string[]>((resolve) =>
        pending.push(() => resolve(answer)),
      );
    },
    ttlMs: () => TTL,
    now: () => t,
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  /** Let every read in flight answer. */
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
    tick: (ms: number) => (t += ms),
    answer: (a: string[]) => (answer = a),
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
    r.answer([]); // the edge stopped
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
    // Reads go out but never answer.
    expect(r.cache.isEdge(EDGE_IP)).toBe(false);
    expect(isEdgePeer(EDGE_IP)).toBe(false);
    expect(isEdgePeer("127.0.0.1")).toBe(true);
  });

  it("a miss from beyond loopback reads again, in the Docker ranges or not", async () => {
    const r = rig(["10.210.47.9"]);
    void r.cache.refresh(true);
    await r.settle();
    r.answer(["10.210.47.12"]); // the edge was recreated at a new address
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
    expect(r.cache.isEdge("172.20.0.9")).toBe(false); // busy
    await r.settle();
    expect(r.cache.isEdge("172.20.0.9")).toBe(false); // within 5 s
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
