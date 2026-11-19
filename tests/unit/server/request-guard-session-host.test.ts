/**
 * The session lives only on Den's own named address (when an https one
 * works): the request checks don't take a session cookie presented on a
 * loopback name then. Browsers share a host's cookies across ports, so a
 * cookie on localhost reaches every other local app the person opens.
 *
 *  - a session cookie on a loopback-host write: 401 signin_required;
 *  - GET /api/session's caller there is not signed in (no session);
 *  - the CLI's bearer on loopback works as before;
 *  - a plain read on loopback stays open;
 *  - the named host's session works;
 *  - an install with no working https address: the loopback session
 *    works as before (no lockout).
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  type GuardContext,
  type GuardSession,
} from "../../../src/ui/server/request-guard.js";

const PORT = 41237;
const local = `localhost:${PORT}`;
const NAMED = "den.acme.test";
const SESSION: GuardSession = { key: "k".repeat(64), csrf: "session-csrf" };

const ctx = (namedWorks: boolean): GuardContext => ({
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [NAMED],
  verifyBearer: (t) => (t === "den_pt_good" ? "person:someone" : null),
  session: (req) =>
    /den_session_\d+=good/.test(String(req.headers.cookie ?? ""))
      ? SESSION
      : null,
  peerIsLoopback: () => true,
  edgeProved: () => true,
  loopbackSessions: () => !namedWorks,
});
const req = (
  method: string,
  url: string,
  headers: Record<string, string>,
): http.IncomingMessage =>
  ({
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;

const WRITE = "/api/workspaces/north/agents";
const page = (host: string, scheme = "http") => ({
  host,
  origin: `${scheme}://${host}`,
  "sec-fetch-site": "same-origin",
  "x-den-csrf": "session-csrf",
});

describe("a named https address works", () => {
  for (const host of [local, `127.0.0.1:${PORT}`, `[::1]:${PORT}`])
    it(`a session cookie on ${host} doesn't count for a write: 401 signin_required`, () => {
      expect(
        checkRequest(
          req("POST", WRITE, {
            ...page(host),
            cookie: `den_session_${PORT}=good`,
          }),
          ctx(true),
        ),
      ).toMatchObject({ ok: false, status: 401, code: "signin_required" });
    });

  it("GET /api/session on loopback with that cookie: no session (so no CSRF token)", () => {
    expect(
      checkRequest(
        req("GET", "/api/session", {
          host: local,
          "sec-fetch-site": "same-origin",
          cookie: `den_session_${PORT}=good`,
        }),
        ctx(true),
      ),
    ).toMatchObject({ ok: true, session: null });
  });

  it("the CLI's bearer on loopback still works", () => {
    expect(
      checkRequest(
        req("POST", WRITE, {
          host: local,
          authorization: "Bearer den_pt_good",
        }),
        ctx(true),
      ),
    ).toMatchObject({ ok: true, principal: { kind: "person" } });
  });

  it("a plain read on loopback stays open", () => {
    expect(
      checkRequest(req("GET", "/api/settings", { host: local }), ctx(true)),
    ).toMatchObject({ ok: true });
  });

  it("the session on the named host works for a write", () => {
    expect(
      checkRequest(
        req("POST", WRITE, {
          ...page(NAMED, "https"),
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
          cookie: `__Host-den_session_${PORT}=good`,
        }),
        ctx(true),
      ),
    ).toMatchObject({ ok: true, principal: { kind: "person-browser" } });
  });
});

describe("no working https address (no lockout)", () => {
  it("the loopback session works for a write, as before", () => {
    expect(
      checkRequest(
        req("POST", WRITE, {
          ...page(local),
          cookie: `den_session_${PORT}=good`,
        }),
        ctx(false),
      ),
    ).toMatchObject({ ok: true, principal: { kind: "person-browser" } });
  });
});
