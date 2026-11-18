/**
 * Issue 394: the rail's save as the page goes. The kit's saveShell sends it
 * with keepalive, then again with navigator.sendBeacon if the page hides
 * first. A beacon carries the cookies but no custom header, so it can't
 * carry the CSRF token. The shell-save route (SHELL_SAVE_BEACONS) is
 * guarded like the other Origin-checked, CSRF-free routes:
 *  - the request's Origin must be one of this install's own
 *    (originAllowed: the loopback names on Den's port, the edge hosts, the
 *    LAN hosts); any other Origin, or none, is refused (403);
 *  - sign-in stays as it is: beyond loopback, a session (or a bearer);
 *  - an agent's token never reaches it (a person's write);
 *  - only that route: /api/settings itself still needs the CSRF token.
 * The real server's wiring is shell-save.integration.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  isEdgePeer,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";
import { SHELL_SAVE_BEACONS } from "../../../src/ui/server/route-classes.js";

const PORT = 41237;
const EDGE = "den.acme.example";
const SAVE = "/api/settings/shell";

const ctx = (signedIn: boolean): GuardContext => ({
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
  session: () =>
    signedIn ? { key: "k".repeat(64), csrf: "session-csrf" } : null,
  peerIsLoopback: (r) => r.socket?.remoteAddress === "127.0.0.1",
  peerIsEdge: (r) => isEdgePeer(r.socket?.remoteAddress),
  localNet: () => ({ own: ["127.0.0.1", "::1"], bridges: [] }),
});
/** A beacon's shape: a POST, a text or JSON Blob, no custom header. */
const beacon = (
  where: "edge" | "loopback",
  headers: Record<string, string>,
  url = SAVE,
): http.IncomingMessage =>
  ({
    method: "POST",
    url,
    headers:
      where === "edge"
        ? {
            host: EDGE,
            "x-forwarded-for": "203.0.113.7",
            "content-type": "application/json",
            ...headers,
          }
        : {
            host: `localhost:${PORT}`,
            "content-type": "text/plain;charset=UTF-8",
            ...headers,
          },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;

describe("issue 394: the shell save's beacon form", () => {
  it("is its own route entry", () => {
    expect(SHELL_SAVE_BEACONS).toEqual([SAVE]);
  });

  it("the install's own Origin, no CSRF token: accepted (edge signed in; loopback)", () => {
    expect(
      checkRequest(beacon("edge", { origin: `https://${EDGE}` }), ctx(true)),
    ).toMatchObject({ ok: true });
    for (const o of [
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`,
      `http://[::1]:${PORT}`,
    ])
      expect(
        checkRequest(beacon("loopback", { origin: o }), ctx(false)),
      ).toMatchObject({ ok: true });
  });

  it("another site's Origin is refused (403), signed in or not, wherever it comes", () => {
    for (const o of [
      "https://evil.example",
      `http://localhost:${PORT + 1}`,
      `https://${EDGE}.evil.example`,
      "null",
    ]) {
      expect(
        checkRequest(beacon("edge", { origin: o }), ctx(true)),
      ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
      expect(
        checkRequest(beacon("loopback", { origin: o }), ctx(false)),
      ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
    }
  });

  it("a missing Origin is refused (403)", () => {
    expect(checkRequest(beacon("edge", {}), ctx(true))).toMatchObject({
      ok: false,
      status: 403,
      code: "origin_rejected",
    });
    expect(checkRequest(beacon("loopback", {}), ctx(false))).toMatchObject({
      ok: false,
      status: 403,
      code: "origin_rejected",
    });
  });

  it("beyond loopback, sign-in is still needed (401 with no session)", () => {
    expect(
      checkRequest(beacon("edge", { origin: `https://${EDGE}` }), ctx(false)),
    ).toMatchObject({ ok: false, status: 401, code: "signin_required" });
  });

  it("an agent's token never reaches it", () => {
    expect(
      checkRequest(
        beacon("edge", {
          origin: `https://${EDGE}`,
          authorization: "Bearer den_at_agent",
        }),
        ctx(true),
      ).ok,
    ).toBe(false);
  });

  it("only the shell save: POST /api/settings still needs its CSRF token", () => {
    expect(
      checkRequest(
        beacon("edge", { origin: `https://${EDGE}` }, "/api/settings"),
        ctx(true),
      ),
    ).toMatchObject({ ok: false, status: 403, code: "csrf" });
    expect(
      checkRequest(
        beacon(
          "loopback",
          { origin: `http://localhost:${PORT}` },
          "/api/settings",
        ),
        ctx(false),
      ),
    ).toMatchObject({ ok: false, status: 403, code: "csrf" });
  });

  it("only POST: a PUT or DELETE to it still needs the CSRF token", () => {
    for (const method of ["PUT", "DELETE"]) {
      const r = beacon("edge", { origin: `https://${EDGE}` });
      (r as { method: string }).method = method;
      expect(checkRequest(r, ctx(true))).toMatchObject({
        ok: false,
        status: 403,
        code: "csrf",
      });
    }
  });
});
