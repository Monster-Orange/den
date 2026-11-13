/**
 * SEC-2a's approve-with-a-code, as the request checks apply it (a pure
 * function of the request). Beyond loopback, from a browser Den can't
 * place:
 *  - asking for a code is sign-in free: an allowed Origin, no CSRF token
 *    (the signed-out page holds none); another site's is refused;
 *  - its poll carries its own id: same-origin, or bare (a plain-http LAN
 *    origin gets no fetch metadata), never cross-site;
 *  - the waiting list, approve and deny need a session or a bearer;
 *  - an agent's token reaches none of them.
 * The real server's wiring is sec2a-pair.integration.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  isEdgePeer,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const PORT = 41237;
const EDGE = "den.acme.example";
const POLL = "/api/signin/code/abcdefghijklmnopqrstuvwx";

const ctx = (): GuardContext => ({
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [EDGE],
  verifyBearer: (t) =>
    t === "den_pt_good"
      ? "person:someone"
      : t === "den_at_agent"
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
  localNet: () => ({ own: ["127.0.0.1", "::1"], bridges: [] }),
});
/** Through the edge, for a browser on another machine. */
const req = (
  method: string,
  url: string,
  headers: Record<string, string>,
): http.IncomingMessage =>
  ({
    method,
    url,
    headers: { host: EDGE, "x-forwarded-for": "203.0.113.7", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;

describe("asking for a code (the signed-out page)", () => {
  it("an allowed Origin, no session, no CSRF token: passes", () => {
    expect(
      checkRequest(
        req("POST", "/api/signin/code", { origin: `https://${EDGE}` }),
        ctx(),
      ),
    ).toMatchObject({ ok: true, principal: null, beyond: true });
  });

  it("another site's request is refused (Origin), as is one with no Origin", () => {
    expect(
      checkRequest(
        req("POST", "/api/signin/code", { origin: "https://evil.example" }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
    expect(
      checkRequest(req("POST", "/api/signin/code", {}), ctx()),
    ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
  });

  it("the poll: same-origin or bare passes; cross-site or same-site is refused", () => {
    for (const h of [{ "sec-fetch-site": "same-origin" }, {}])
      expect(checkRequest(req("GET", POLL, h), ctx())).toMatchObject({
        ok: true,
      });
    for (const site of ["cross-site", "same-site"])
      expect(
        checkRequest(req("GET", POLL, { "sec-fetch-site": site }), ctx()),
      ).toMatchObject({ ok: false, status: 403, code: "cross_site" });
    expect(
      checkRequest(req("GET", POLL, { origin: "https://evil.example" }), ctx()),
    ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
  });
});

describe("D67: its page withdraws its code as it goes", () => {
  const signedIn = (): GuardContext => ({
    ...ctx(),
    session: () => ({ key: "k".repeat(64), csrf: "session-csrf" }),
  });

  it("by its poll id, an allowed Origin, no CSRF token: signed out, or signed in another way since", () => {
    for (const c of [ctx(), signedIn()])
      expect(
        checkRequest(req("DELETE", POLL, { origin: `https://${EDGE}` }), c),
      ).toMatchObject({ ok: true });
  });

  it("another site's, or one with no Origin, is refused; so is an agent's token", () => {
    for (const c of [ctx(), signedIn()]) {
      expect(
        checkRequest(
          req("DELETE", POLL, { origin: "https://evil.example" }),
          c,
        ),
      ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
      expect(checkRequest(req("DELETE", POLL, {}), c)).toMatchObject({
        ok: false,
        status: 403,
      });
    }
    expect(
      checkRequest(
        req("DELETE", POLL, {
          origin: `https://${EDGE}`,
          authorization: "Bearer den_at_agent",
        }),
        ctx(),
      ).ok,
    ).toBe(false);
  });

  it("only DELETE: a signed-in POST to a sign-in route still needs its CSRF token", () => {
    expect(
      checkRequest(
        req("POST", "/api/signin/code", { origin: `https://${EDGE}` }),
        signedIn(),
      ),
    ).toMatchObject({ ok: false, status: 403, code: "csrf" });
  });
});

describe("approving (someone already in)", () => {
  const routes = [
    ["GET", "/api/web/waiting"],
    ["POST", "/api/web/approve"],
    ["POST", "/api/web/deny"],
  ] as const;

  it("signed out beyond loopback: sign in first, even with an allowed Origin", () => {
    for (const [m, p] of routes)
      expect([
        p,
        checkRequest(
          req(m, p, {
            origin: `https://${EDGE}`,
            "sec-fetch-site": "same-origin",
          }),
          ctx(),
        ),
      ]).toMatchObject([
        p,
        { ok: false, status: 401, code: "signin_required" },
      ]);
  });

  it("the CLI's bearer passes (`web approve`)", () => {
    for (const [m, p] of routes)
      expect([
        p,
        checkRequest(req(m, p, { authorization: "Bearer den_pt_good" }), ctx())
          .ok,
      ]).toEqual([p, true]);
  });

  it("an agent's token reaches none of them, nor the code routes", () => {
    for (const [m, p] of [
      ...routes,
      ["POST", "/api/signin/code"],
      ["GET", POLL],
    ])
      expect([
        p,
        checkRequest(
          req(m, p, { authorization: "Bearer den_at_agent" }),
          ctx(),
        ),
      ]).toMatchObject([p, { ok: false, code: "agent_forbidden" }]);
  });
});
