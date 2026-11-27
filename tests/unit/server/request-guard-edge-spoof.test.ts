/**
 * Review H1 (0.4.46): a peer on a Docker bridge is not the edge just for
 * being there. A container on the bridge Den binds to can send the edge
 * hostname and its own X-Forwarded-For; without the edge's proof, the
 * forwarded client is never believed: it signs in, on every route, and
 * web.edge_unattested: local doesn't open it. Fails closed.
 *
 * Pure guard, no server. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  isEdgePeer,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const EDGE = "den.acme.example";

const PEERS: ReadonlySet<string> = new Set([
  "172.17.0.5",
  "172.20.1.9",
  "192.168.65.3",
]);

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  port: 41237,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [EDGE],
  verifyBearer: () => null,
  session: () => null,
  peerIsLoopback: (r) => r.socket?.remoteAddress === "127.0.0.1",
  peerIsEdge: (r) => isEdgePeer(r.socket?.remoteAddress, PEERS),
  localNet: () => ({ own: ["127.0.0.1", "::1"], bridges: [] }),
  ...over,
});

const req = (
  url: string,
  peer: string,
  headers: Record<string, string> = {},
): http.IncomingMessage =>
  ({
    method: "GET",
    url,
    headers: { host: EDGE, "x-forwarded-for": "127.0.0.1", ...headers },
    socket: { remoteAddress: peer },
  }) as unknown as http.IncomingMessage;

describe("a bridge peer that claims this machine without the edge's proof", () => {
  it("is never local: sign-in on every route, whatever web.edge_unattested says", () => {
    for (const peer of PEERS)
      for (const unattested of ["signin", "local"] as const)
        for (const url of ["/", "/api/settings", "/agents"]) {
          const out = checkRequest(
            req(url, peer),
            ctx({ edgeUnattested: unattested }),
          );
          // Beyond this machine: a sign-in is asked (or, on a route that
          // never needs one, it is let through as beyond).
          const signsIn = out.ok
            ? out.beyond
            : out.code === "signin_required" && out.beyond === true;
          expect([peer, unattested, url, signsIn]).toEqual([
            peer,
            unattested,
            url,
            true,
          ]);
        }
  });
});
