/**
 * The edge peer is the edge container itself, not any address in the
 * Docker ranges. Den reads the edge container's own addresses (the
 * container labelled with this state dir, `docker inspect` of its
 * networks) and believes the edge hostname, its proof and its
 * X-Forwarded-* headers only from loopback or one of those. Another
 * container on a Docker network, with the right proof and a forwarded
 * client of 127.0.0.1, is not the edge: 421, and never HTTPS.
 *
 * Pure guard, no server, no Docker. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  isEdgePeer,
  requestIsHttps,
  setEdgeAddresses,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";
import {
  edgeContainerAddresses,
  networkAddresses,
} from "../../../src/shared/edge/exposure.js";

const EDGE = "den.acme.example";
const EDGE_IP = "172.20.0.2";

afterEach(() => setEdgeAddresses(null));

const ctx = (): GuardContext => ({
  port: 41238,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [EDGE],
  verifyBearer: () => null,
  session: () => null,
  peerIsLoopback: (r) => r.socket?.remoteAddress === "127.0.0.1",
  peerIsEdge: (r) => isEdgePeer(r.socket?.remoteAddress),
  // The right proof, as if it had been read from somewhere.
  edgeProved: () => true,
  localNet: () => ({ own: ["127.0.0.1", "::1"], bridges: [] }),
});
const req = (peer: string, url = "/api/settings"): http.IncomingMessage =>
  ({
    method: "GET",
    url,
    headers: {
      host: EDGE,
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "https",
    },
    socket: { remoteAddress: peer },
  }) as unknown as http.IncomingMessage;

const OTHERS = [
  "172.20.0.3",
  "172.17.0.5",
  "172.31.255.9",
  "192.168.65.3",
  "::ffff:172.20.0.3",
];

describe("the edge peer is the edge container's own address", () => {
  it("loopback and the edge's addresses are; another Docker-range address is not", () => {
    setEdgeAddresses([EDGE_IP, "fd00:20::2"]);
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
      expect([a, isEdgePeer(a)]).toEqual([a, true]);
    for (const a of [EDGE_IP, `::ffff:${EDGE_IP}`, "fd00:20::2"])
      expect([a, isEdgePeer(a)]).toEqual([a, true]);
    for (const a of OTHERS) expect([a, isEdgePeer(a)]).toEqual([a, false]);
  });

  it("no edge container known: loopback only (fails closed)", () => {
    for (const a of [EDGE_IP, ...OTHERS])
      expect([a, isEdgePeer(a)]).toEqual([a, false]);
    expect(isEdgePeer("127.0.0.1")).toBe(true);
  });

  it("another container with the right header and X-Forwarded-For 127.0.0.1: not the edge (421), never HTTPS", () => {
    setEdgeAddresses([EDGE_IP]);
    for (const peer of OTHERS) {
      expect([peer, checkRequest(req(peer), ctx())]).toEqual([
        peer,
        expect.objectContaining({ ok: false, status: 421 }),
      ]);
      expect([peer, requestIsHttps(req(peer), "edge", true)]).toEqual([
        peer,
        false,
      ]);
    }
    // The edge itself still gets through, as before.
    expect(checkRequest(req(EDGE_IP, "/"), ctx())).toMatchObject({
      ok: true,
      via: "edge",
      beyond: false,
    });
    expect(requestIsHttps(req(EDGE_IP), "edge", true)).toBe(true);
  });
});

describe("reading the edge container's addresses", () => {
  it("every network's IPv4 and IPv6 address, from docker inspect's Networks", () => {
    expect(
      networkAddresses(
        JSON.stringify({
          "acme-edge": { IPAddress: "172.20.0.2", GlobalIPv6Address: "" },
          apps: {
            IPAddress: "172.21.0.4",
            GlobalIPv6Address: "fd00:21::4",
          },
          junk: { IPAddress: "not an ip" },
        }),
      ).sort(),
    ).toEqual(["172.20.0.2", "172.21.0.4", "fd00:21::4"]);
    for (const bad of ["", "null", "[]", "{"])
      expect(networkAddresses(bad)).toEqual([]);
  });

  /** A fake docker: `ps` lists `rows`' ids; `inspect` gives each one's line. */
  const docker = (
    rows: { id: string; name: string; org: string; root: string; ip: string }[],
    calls: string[][] = [],
  ) => {
    return async (args: string[]) => {
      calls.push(args);
      if (args[0] === "ps") return rows.map((r) => r.id).join("\n") + "\n";
      const r = rows.find((x) => x.id === args[args.length - 1])!;
      return (
        [
          `/${r.name}`,
          r.org,
          r.root,
          JSON.stringify({ net: { IPAddress: r.ip } }),
        ].join("|") + "\n"
      );
    };
  };
  const EDGE_ROW = {
    id: "abc123",
    name: "acme-edge",
    org: "acme",
    root: "/state/edge",
    ip: EDGE_IP,
  };
  const want = { root: "/state/edge", org: "acme" };

  it("finds the edge by its state-dir label, then inspects its name, org and networks", async () => {
    const calls: string[][] = [];
    expect(
      await edgeContainerAddresses(want, docker([EDGE_ROW], calls)),
    ).toEqual([EDGE_IP]);
    expect(calls).toEqual([
      [
        "ps",
        "--filter",
        "label=den.edge.root=/state/edge",
        "--format",
        "{{.ID}}",
      ],
      [
        "inspect",
        "--type",
        "container",
        "--format",
        '{{.Name}}|{{index .Config.Labels "den.edge.org"}}|{{index .Config.Labels "den.edge.root"}}|{{json .NetworkSettings.Networks}}',
        "abc123",
      ],
    ]);
  });

  it("another container with the same state-dir label is not the edge: it needs the org label and the edge's name too", async () => {
    const spoofs = [
      { ...EDGE_ROW, id: "bad1", name: "app-web-1", ip: "172.20.0.9" },
      {
        ...EDGE_ROW,
        id: "bad2",
        name: "acme-edge",
        org: "other",
        ip: "172.20.0.8",
      },
    ];
    expect(
      await edgeContainerAddresses(want, docker([...spoofs, EDGE_ROW])),
    ).toEqual([EDGE_IP]);
    expect(await edgeContainerAddresses(want, docker(spoofs))).toEqual([]);
  });

  it("no edge container, or Docker not answering: none", async () => {
    expect(await edgeContainerAddresses(want, async () => "")).toEqual([]);
    expect(
      await edgeContainerAddresses(want, async () => {
        throw new Error("no docker");
      }),
    ).toEqual([]);
  });
});
