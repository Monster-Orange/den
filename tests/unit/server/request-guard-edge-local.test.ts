/**
 * The edge counts as local when it attests the client is this machine
 * (0.4.3; 0.4.5, SEC-2a): the edge hostname from an edge peer gets
 * loopback's treatment (no sign-in on any route) when the right-most
 * X-Forwarded-For entry, the one the edge appended, is loopback or one of
 * this machine's addresses. A client it can't place (none, or a Docker/VM
 * gateway) signs in unless web.edge_unattested: local; another machine
 * always does, as does everything when the server is deliberately exposed.
 * localhost never asks. Host, Origin, CSRF and the agent-token rules stay.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  edgeClient,
  forwardedClient,
  isEdgePeer,
  localNet,
  type GuardContext,
  type LocalNet,
} from "../../../src/ui/server/request-guard.js";
import {
  cidrToSubnet,
  edgeNetworkSubnets,
} from "../../../src/ui/server/edge-exposure.js";

const PORT = 41236;
const EDGE = "den.acme.example";
const START = "/api/workspaces/north/agents";
/** This machine: a LAN address, a VPN (Tailscale) one, an OrbStack bridge. */
const HERE: LocalNet = {
  own: ["127.0.0.1", "::1", "192.168.1.122", "100.101.102.103"],
  bridges: [{ address: "192.168.216.0", netmask: "255.255.255.0" }],
};

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [EDGE],
  verifyBearer: (t) =>
    t === "den_at_agent"
      ? {
          kind: "agent",
          actor: "agent:a1",
          workspace: "north",
          grants: [],
          session: { name: "s1", id: "s1" },
        }
      : null,
  csrfToken: "start-csrf",
  session: () => null,
  peerIsLoopback: (r) => r.socket?.remoteAddress === "127.0.0.1",
  peerIsEdge: (r) => isEdgePeer(r.socket?.remoteAddress),
  localNet: () => HERE,
  ...over,
});
const req = (
  method: string,
  url: string,
  headers: Record<string, string>,
  peer = "127.0.0.1",
): http.IncomingMessage =>
  ({
    method,
    url,
    headers: { host: EDGE, ...headers },
    socket: { remoteAddress: peer },
  }) as unknown as http.IncomingMessage;
const xff = (v: string) => ({ "x-forwarded-for": v });
const shellGrade = (h: Record<string, string>, peer?: string) =>
  req(
    "POST",
    START,
    { origin: `https://${EDGE}`, "x-den-csrf": "start-csrf", ...h },
    peer,
  );

describe("the edge hostname from an edge peer counts as local when the edge attests it", () => {
  it("X-Forwarded-For of loopback: local, on every route, pages and shell-grade included", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      for (const p of ["/", "/api/settings", "/settings", "/agents"])
        expect([a, p, checkRequest(req("GET", p, xff(a)), ctx())]).toEqual([
          a,
          p,
          expect.objectContaining({ ok: true, via: "edge", beyond: false }),
        ]);
      expect(checkRequest(shellGrade(xff(a)), ctx())).toMatchObject({
        ok: true,
        via: "edge",
        beyond: false,
      });
    }
  });

  it("X-Forwarded-For of one of this machine's own addresses (LAN, VPN): local, its address kept for the device record", () => {
    for (const a of ["192.168.1.122", "100.101.102.103"])
      expect([a, checkRequest(shellGrade(xff(a)), ctx())]).toEqual([
        a,
        expect.objectContaining({ ok: true, beyond: false, client: a }),
      ]);
  });

  it("X-Forwarded-For of another machine: sign-in required, on every route, whatever web.edge_unattested says", () => {
    for (const unattested of ["signin", "local"] as const)
      for (const a of [
        "203.0.113.7",
        "192.168.1.50",
        "100.64.0.9",
        "2001:db8::5",
      ])
        for (const r of [
          req("GET", "/api/settings", xff(a)),
          shellGrade(xff(a)),
        ])
          expect([
            unattested,
            a,
            checkRequest(r, ctx({ edgeUnattested: unattested })),
          ]).toEqual([
            unattested,
            a,
            expect.objectContaining({
              ok: false,
              status: 401,
              code: "signin_required",
            }),
          ]);
  });

  it("believes only the right-most X-Forwarded-For entry (the one the edge appended): a forged loopback on the left is ignored", () => {
    expect(
      checkRequest(shellGrade(xff("127.0.0.1, 203.0.113.7")), ctx()),
    ).toMatchObject({ ok: false, code: "signin_required" });
    expect(
      checkRequest(shellGrade(xff("127.0.0.1, 172.18.0.5")), ctx()),
    ).toMatchObject({ ok: false, code: "signin_required" });
    expect(
      checkRequest(shellGrade(xff("203.0.113.7, 127.0.0.1")), ctx()),
    ).toMatchObject({ ok: true });
  });

  it("Host, Origin and CSRF still apply", () => {
    const here = xff("127.0.0.1");
    // Host: the edge hostname from a LAN peer (not the edge): 421.
    expect(
      checkRequest(req("GET", "/", here, "192.168.1.50"), ctx()),
    ).toMatchObject({ ok: false, status: 421 });
    expect(
      checkRequest(
        req("POST", START, { origin: "https://evil.example", ...here }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
    expect(
      checkRequest(
        req("POST", START, { origin: `https://${EDGE}`, ...here }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "csrf" });
  });

  it("an agent's token keeps its limits", () => {
    expect(
      checkRequest(
        req("POST", "/api/web/logout", {
          authorization: "Bearer den_at_agent",
          ...xff("127.0.0.1"),
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "agent_forbidden" });
  });
});

describe("a client the edge can't place (SEC-2a: web.edge_unattested)", () => {
  const unplaced: [string, Record<string, string>, string][] = [
    ["no X-Forwarded-For", {}, "127.0.0.1"],
    [
      "no X-Forwarded-For, from a Docker peer (Linux's bridge)",
      {},
      "172.18.0.3",
    ],
    ["an unreadable one", xff("unknown"), "127.0.0.1"],
    ["the Docker gateway", xff("172.17.0.1"), "127.0.0.1"],
    ["Docker Desktop's VM network", xff("192.168.65.1"), "127.0.0.1"],
    ["an OrbStack bridge's subnet", xff("192.168.216.3"), "127.0.0.1"],
    ["a bridge's own address", xff("192.168.216.0"), "127.0.0.1"],
  ];

  it.each(unplaced)(
    "%s: signs in by default (web.edge_unattested unset or signin)",
    (_w, h, peer) => {
      for (const c of [ctx(), ctx({ edgeUnattested: "signin" })])
        expect(checkRequest(shellGrade(h, peer), c)).toMatchObject({
          ok: false,
          status: 401,
          code: "signin_required",
        });
      expect(
        checkRequest(req("GET", "/settings", h, peer), ctx()),
      ).toMatchObject({ ok: false, code: "signin_required" });
    },
  );

  it.each(unplaced)(
    "%s: local with web.edge_unattested: local (0.4.3's allow), no address recorded",
    (_w, h, peer) => {
      const r = checkRequest(
        shellGrade(h, peer),
        ctx({ edgeUnattested: "local" }),
      );
      expect(r).toMatchObject({ ok: true, via: "edge", beyond: false });
      expect(r.ok && r.client).toBeFalsy();
    },
  );

  it("the sign-in routes themselves stay open to it (the signed-out page and Sign in with GitHub)", () => {
    for (const p of [
      "/signin",
      "/api/session",
      "/api/github/signin/abcdefghijklmnopqrst",
    ])
      expect([
        p,
        checkRequest(req("GET", p, { "sec-fetch-site": "same-origin" }), ctx())
          .ok,
      ]).toEqual([p, true]);
    // Starting one: an allowed Origin, no CSRF token (the page has none).
    expect(
      checkRequest(
        req("POST", "/api/github/signin", { origin: `https://${EDGE}` }),
        ctx(),
      ),
    ).toMatchObject({ ok: true, principal: null });
    expect(
      checkRequest(
        req("POST", "/api/github/signin", { origin: "https://evil.example" }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
    // Its poll sets the cookie: same-origin only.
    expect(
      checkRequest(
        req("GET", "/api/github/signin/abcdefghijklmnopqrst", {
          "sec-fetch-site": "cross-site",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "cross_site" });
  });

  it("localhost always works with no sign-in (a loopback Host from a loopback peer)", () => {
    for (const c of [ctx(), ctx({ edgeUnattested: "signin" })])
      expect(
        checkRequest(
          req("POST", START, {
            host: `localhost:${PORT}`,
            origin: `http://localhost:${PORT}`,
            "x-den-csrf": "start-csrf",
          }),
          c,
        ),
      ).toMatchObject({ ok: true, via: "loopback", beyond: false });
  });
});

describe("a deliberate network exposure still needs a sign-in", () => {
  it("a non-loopback DEN_BIND_HOST bind (exposed): the edge needs one, X-Forwarded-For or not", () => {
    for (const h of [{}, xff("127.0.0.1")])
      expect(checkRequest(shellGrade(h), ctx({ exposed: true }))).toMatchObject(
        { ok: false, status: 401, code: "signin_required" },
      );
  });
  it("a LAN name (allow_plain_http_remote) is beyond loopback, as before", () => {
    const lan = `192.168.1.122:${PORT}`;
    expect(
      checkRequest(
        req("GET", "/", { host: lan }, "192.168.1.50"),
        ctx({ lanHosts: () => ["192.168.1.122"] }),
      ),
    ).toMatchObject({ ok: false, status: 401, code: "signin_required" });
  });
});

describe("edgeClient, forwardedClient and localNet", () => {
  it("reads the right-most entry as an IP, dropping a port or brackets", () => {
    expect(forwardedClient("10.0.0.1, [::1]:443")).toBe("::1");
    expect(forwardedClient("[::1]:443, 10.0.0.1")).toBe("10.0.0.1");
    expect(forwardedClient(" 127.0.0.1:5000")).toBe("127.0.0.1");
    expect(forwardedClient("127.0.0.1, unknown")).toBeUndefined();
    expect(forwardedClient("unknown")).toBeUndefined();
    expect(forwardedClient(undefined)).toBeUndefined();
  });
  it("missing or unreadable: unattested", () => {
    expect(edgeClient(undefined, HERE)).toBe("unattested");
    expect(edgeClient("unknown", HERE)).toBe("unattested");
  });
  it("loopback and own addresses: local; a bridge's subnet or a Docker range: unattested; the LAN's: foreign (en0 is no bridge)", () => {
    expect(edgeClient("127.0.0.1", HERE)).toBe("local");
    expect(edgeClient("100.101.102.103", HERE)).toBe("local");
    expect(edgeClient("192.168.216.200", HERE)).toBe("unattested");
    expect(edgeClient("172.20.0.1", HERE)).toBe("unattested");
    expect(edgeClient("192.168.217.3", HERE)).toBe("foreign");
    expect(edgeClient("192.168.1.50", HERE)).toBe("foreign");
  });
  it("localNet takes every interface address and only container/VM bridges' subnets", () => {
    const n = localNet({
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.168.1.122",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:aa:aa:aa:aa:aa",
          internal: false,
          cidr: "192.168.1.122/24",
        },
      ],
      utun8: [
        {
          address: "100.101.102.103",
          netmask: "255.255.255.255",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "100.101.102.103/32",
        },
      ],
      bridge107: [
        {
          address: "192.168.216.0",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "bb:bb:bb:bb:bb:bb",
          internal: false,
          cidr: "192.168.216.0/24",
        },
      ],
      docker0: [
        {
          address: "172.17.0.1",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "cc:cc:cc:cc:cc:cc",
          internal: false,
          cidr: "172.17.0.1/16",
        },
      ],
    });
    expect(n.own).toEqual(
      expect.arrayContaining(["127.0.0.1", "192.168.1.122", "100.101.102.103"]),
    );
    expect(n.bridges.map((b) => b.address).sort()).toEqual([
      "172.17.0.1",
      "192.168.216.0",
    ]);
  });
});

describe("the edge's own Docker networks, and OrbStack's host (0.4.3)", () => {
  it("cidrToSubnet: an IPv4 CIDR as address and netmask; IPv6, junk and wide ones refused", () => {
    expect(cidrToSubnet("192.168.214.0/24")).toEqual({
      address: "192.168.214.0",
      netmask: "255.255.255.0",
    });
    expect(cidrToSubnet("10.210.0.0/16")).toEqual({
      address: "10.210.0.0",
      netmask: "255.255.0.0",
    });
    for (const bad of [
      "fd00::/64",
      "0.0.0.0/0",
      "10.0.0.0/4",
      "300.1.1.1/24",
      "",
    ])
      expect(cidrToSubnet(bad)).toBeNull();
  });

  it("edgeNetworkSubnets: each network's IPv4 subnets; a missing network or Docker gives none", async () => {
    const seen: string[] = [];
    const nets = await edgeNetworkSubnets(
      ["acme-edge", "shared", "acme-edge", "gone"],
      async (n) => {
        seen.push(n);
        if (n === "acme-edge")
          return [{ Subnet: "192.168.214.0/24" }, { Subnet: "fd00:1::/64" }];
        if (n === "shared") return [{ Subnet: "10.210.4.0/22" }];
        return null;
      },
    );
    expect(seen).toEqual(["acme-edge", "shared", "gone"]);
    expect(nets).toEqual([
      { address: "192.168.214.0", netmask: "255.255.255.0" },
      { address: "10.210.4.0", netmask: "255.255.252.0" },
    ]);
  });

  it("a proxy on the edge's network, or its gateway, is never another machine once the subnet is known (unattested)", () => {
    const withEdge: LocalNet = {
      own: HERE.own,
      bridges: [
        ...HERE.bridges,
        { address: "192.168.214.0", netmask: "255.255.255.0" },
      ],
    };
    for (const c of ["192.168.214.3", "192.168.214.1"]) {
      expect(edgeClient(c, HERE)).toBe("foreign");
      expect(edgeClient(c, withEdge)).toBe("unattested");
    }
    // Another machine is still another machine.
    expect(edgeClient("8.8.8.8", withEdge)).toBe("foreign");
    expect(edgeClient("192.168.213.3", withEdge)).toBe("foreign");
  });

  it("OrbStack's host address (0.250.250.254) is never another machine (unattested)", () => {
    expect(edgeClient("0.250.250.254", HERE)).toBe("unattested");
  });
});
