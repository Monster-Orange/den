import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  isEdgePeer,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const EDGE = "den.acme.example";
const PEER = "172.17.0.5";

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  port: 41237,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [EDGE],
  verifyBearer: () => "person:x",
  session: () => null,
  peerIsLoopback: (r) => r.socket?.remoteAddress === "127.0.0.1",
  peerIsEdge: (r) => isEdgePeer(r.socket?.remoteAddress, new Set([PEER])),
  localNet: () => ({ own: ["127.0.0.1", "::1"], bridges: [] }),
  ...over,
});

const req = (
  url: string,
  o: {
    method?: string;
    host?: string;
    peer?: string;
    headers?: Record<string, string>;
  } = {},
): http.IncomingMessage =>
  ({
    method: o.method ?? "GET",
    url,
    headers: {
      host: o.host ?? EDGE,
      "x-forwarded-for": "127.0.0.1",
      ...o.headers,
    },
    socket: { remoteAddress: o.peer ?? PEER },
  }) as unknown as http.IncomingMessage;

const starting = { edgeStarting: () => true };

describe("while the edge start hasn't settled", () => {
  it("every request through the edge gets the same 503, whatever its proof says", () => {
    const answers = [true, false].flatMap((proved) =>
      [
        req("/api/server-info"),
        req("/"),
        req("/agents", { headers: { accept: "text/html" } }),
        req("/api/settings", {
          method: "POST",
          headers: { authorization: "Bearer den_person_x" },
        }),
      ].map((r) =>
        checkRequest(r, ctx({ ...starting, edgeProved: () => proved })),
      ),
    );
    for (const a of answers)
      expect(a).toEqual({
        ok: false,
        status: 503,
        code: "edge_starting",
        error: "Den is starting. Try again in a moment.",
        via: "edge",
      });
  });

  it("the proof isn't even read", () => {
    let asked = 0;
    checkRequest(
      req("/api/server-info"),
      ctx({
        ...starting,
        edgeProved: () => {
          asked++;
          return true;
        },
      }),
    );
    expect(asked).toBe(0);
  });

  it("this machine's own names aren't held", () => {
    const out = checkRequest(
      req("/api/health", { host: "localhost:41237", peer: "127.0.0.1" }),
      ctx(starting),
    );
    expect(out.ok).toBe(true);
  });

  it("the edge's name from a peer that isn't the edge is still misdirected", () => {
    const out = checkRequest(
      req("/api/server-info", { peer: "10.0.0.8" }),
      ctx(starting),
    );
    expect(out).toMatchObject({ ok: false, status: 421, code: "misdirected" });
  });
});

describe("once it has settled", () => {
  it("a right proof is this machine, and a wrong one signs in, as before", () => {
    const settled = { edgeStarting: () => false };
    expect(
      checkRequest(
        req("/api/server-info"),
        ctx({ ...settled, edgeProved: () => true }),
      ).ok,
    ).toBe(true);
    expect(
      checkRequest(
        req("/api/server-info"),
        ctx({
          ...settled,
          edgeProved: () => false,
          verifyBearer: () => null,
        }),
      ),
    ).toMatchObject({ ok: false, status: 401, code: "signin_required" });
  });
});
