/**
 * 0.4.3, the edge counts as local: the edge hostname from an edge peer
 * gets loopback's treatment (no sign-in on any route) unless the edge's
 * X-Forwarded-For names another machine, or the server is deliberately
 * exposed (a non-loopback DEN_BIND_HOST bind). Host, Origin, CSRF and the
 * agent-token rules stay.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  edgeClientIsLocal,
  forwardedClient,
  isEdgePeer,
  localNet,
  type GuardContext,
  type LocalNet,
} from "../../../src/ui/server/request-guard.js";

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

describe("the edge hostname from an edge peer counts as local", () => {
  it("no X-Forwarded-For: no sign-in on any route, pages and shell-grade included", () => {
    for (const p of ["/", "/api/settings", "/settings", "/agents"])
      expect([p, checkRequest(req("GET", p, {}), ctx())]).toEqual([
        p,
        expect.objectContaining({ ok: true, via: "edge", beyond: false }),
      ]);
    expect(checkRequest(shellGrade({}), ctx())).toMatchObject({
      ok: true,
      via: "edge",
      beyond: false,
    });
  });

  it("from a Docker peer (Linux's bridge) too", () => {
    expect(checkRequest(shellGrade({}, "172.18.0.3"), ctx())).toMatchObject({
      ok: true,
      beyond: false,
    });
  });

  it("X-Forwarded-For of loopback: local", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
      expect([a, checkRequest(shellGrade(xff(a)), ctx()).ok]).toEqual([
        a,
        true,
      ]);
  });

  it("X-Forwarded-For of one of this machine's own addresses (LAN, VPN): local", () => {
    for (const a of ["192.168.1.122", "100.101.102.103"])
      expect([a, checkRequest(shellGrade(xff(a)), ctx()).ok]).toEqual([
        a,
        true,
      ]);
  });

  it("X-Forwarded-For of the Docker/VM gateway (can't tell): local", () => {
    for (const a of ["172.17.0.1", "192.168.65.1", "192.168.216.3"])
      expect([a, checkRequest(shellGrade(xff(a)), ctx()).ok]).toEqual([
        a,
        true,
      ]);
  });

  it("X-Forwarded-For of another machine: sign-in required, on every route", () => {
    for (const a of [
      "203.0.113.7",
      "192.168.1.50",
      "100.64.0.9",
      "2001:db8::5",
    ])
      for (const r of [req("GET", "/api/settings", xff(a)), shellGrade(xff(a))])
        expect([a, checkRequest(r, ctx())]).toEqual([
          a,
          expect.objectContaining({
            ok: false,
            status: 401,
            code: "signin_required",
          }),
        ]);
  });

  it("takes the left-most X-Forwarded-For entry (the original client)", () => {
    expect(
      checkRequest(shellGrade(xff("203.0.113.7, 127.0.0.1")), ctx()),
    ).toMatchObject({ ok: false, code: "signin_required" });
    expect(
      checkRequest(shellGrade(xff("127.0.0.1, 203.0.113.7")), ctx()),
    ).toMatchObject({ ok: true });
  });

  it("Host, Origin and CSRF still apply", () => {
    // Host: the edge hostname from a LAN peer (not the edge): 421.
    expect(
      checkRequest(req("GET", "/", {}, "192.168.1.50"), ctx()),
    ).toMatchObject({ ok: false, status: 421 });
    expect(
      checkRequest(
        req("POST", START, { origin: "https://evil.example" }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
    expect(
      checkRequest(req("POST", START, { origin: `https://${EDGE}` }), ctx()),
    ).toMatchObject({ ok: false, code: "csrf" });
  });

  it("an agent's token keeps its limits", () => {
    expect(
      checkRequest(
        req("POST", "/api/web/logout", {
          authorization: "Bearer den_at_agent",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "agent_forbidden" });
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

describe("edgeClientIsLocal, forwardedClient and localNet", () => {
  it("reads the left-most entry as an IP, dropping a port or brackets", () => {
    expect(forwardedClient("[::1]:443, 10.0.0.1")).toBe("::1");
    expect(forwardedClient(" 127.0.0.1:5000")).toBe("127.0.0.1");
    expect(forwardedClient("unknown")).toBeUndefined();
    expect(forwardedClient(undefined)).toBeUndefined();
  });
  it("missing or unreadable: can't tell, local", () => {
    expect(edgeClientIsLocal(undefined, HERE)).toBe(true);
    expect(edgeClientIsLocal("unknown", HERE)).toBe(true);
  });
  it("a bridge's subnet is local; the LAN's isn't (en0 is no bridge)", () => {
    expect(edgeClientIsLocal("192.168.216.200", HERE)).toBe(true);
    expect(edgeClientIsLocal("192.168.217.3", HERE)).toBe(false);
    expect(edgeClientIsLocal("192.168.1.50", HERE)).toBe(false);
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
