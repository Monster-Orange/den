/**
 * SEC-1b (SEC-1 spec §4): the route classes as the request checks apply
 * them, a pure function of the request (its Host, its peer, its cookie's
 * session, its headers). The real server's wiring is
 * sec1b-signin.integration.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  bindRefusal,
  checkRequest,
  isEdgePeer,
  requestIsHttps,
  type GuardContext,
  type GuardSession,
} from "../../../src/ui/server/request-guard.js";

const PORT = 41235;
const local = `localhost:${PORT}`;
const EDGE = "den.acme.localhost";
const SESSION: GuardSession = { key: "k".repeat(64), csrf: "session-csrf" };

const ctx = (opts: { lan?: string[] } = {}): GuardContext => ({
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [EDGE],
  lanHosts: () => opts.lan ?? [],
  verifyBearer: (t) => (t === "den_pt_good" ? "person:someone" : null),
  csrfToken: "start-csrf",
  // The cookie's value names the session; "good" is the live one.
  session: (req) =>
    /den_session_\d+=good/.test(String(req.headers.cookie ?? ""))
      ? SESSION
      : null,
  peerIsLoopback: (req) =>
    (req.socket as { remoteAddress?: string }).remoteAddress === "127.0.0.1",
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
    headers,
    socket: { remoteAddress: peer },
  }) as unknown as http.IncomingMessage;
const cookie = { cookie: `den_session_${PORT}=good` };
/** The edge's X-Forwarded-For for a client on another machine. */
const AWAY = { "x-forwarded-for": "203.0.113.7" };
const START = "/api/workspaces/north/agents";

describe("on loopback", () => {
  it("read-only GETs and pages are open, signed in or not", () => {
    for (const p of [
      "/",
      "/api/settings",
      "/api/health",
      "/api/workspaces/north/agents",
    ])
      expect([
        p,
        checkRequest(req("GET", p, { host: local }), ctx()).ok,
      ]).toEqual([p, true]);
  });

  it("shell-grade needs no sign-in on loopback (Ward, 2026-11-06): Origin and the start's CSRF pass it, as for any mutation", () => {
    const r = checkRequest(
      req("POST", START, {
        host: local,
        origin: `http://${local}`,
        "x-den-csrf": "start-csrf",
      }),
      ctx(),
    );
    expect(r).toMatchObject({
      ok: true,
      session: null,
      beyond: false,
      principal: { kind: "person-browser" },
    });
    // The terminal's io and the resume: no signin_required on loopback.
    for (const [method, p] of [
      ["GET", "/api/sessions/s1/io"],
      ["POST", "/api/workspaces/north/agents/a1/resume"],
    ] as const) {
      const g = checkRequest(
        req(method, p, {
          host: local,
          origin: `http://${local}`,
          "sec-fetch-site": "same-origin",
          "x-den-csrf": "start-csrf",
        }),
        ctx(),
      );
      expect([p, g.ok]).toEqual([p, true]);
    }
    // The browser-session admin routes too (the CLI sends its bearer).
    expect(
      checkRequest(
        req("GET", "/api/web/sessions", {
          host: local,
          "sec-fetch-site": "same-origin",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: true });
    // /signin is read-only and sign-in free (§6b.3): its handler decides,
    // on loopback and beyond.
    for (const host of [local, EDGE])
      expect(
        checkRequest(req("GET", "/signin", { host }), ctx()),
      ).toMatchObject({ ok: true, session: null });
  });

  it("shell-grade on loopback still needs Origin and CSRF: no sign-in is not no checks", () => {
    expect(
      checkRequest(
        req("POST", START, { host: local, "x-den-csrf": "start-csrf" }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
    expect(
      checkRequest(
        req("POST", START, { host: local, origin: `http://${local}` }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, status: 403, code: "csrf" });
    expect(
      checkRequest(
        req("GET", "/api/sessions/s1/io", {
          host: local,
          "sec-fetch-site": "cross-site",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, status: 403, code: "cross_site" });
  });

  it("beyond loopback (the edge for another machine), shell-grade still needs a sign-in", () => {
    expect(
      checkRequest(
        req("POST", START, {
          host: EDGE,
          ...AWAY,
          origin: `https://${EDGE}`,
          "x-den-csrf": "start-csrf",
        }),
        ctx(),
      ),
    ).toMatchObject({
      ok: false,
      status: 401,
      code: "signin_required",
      scope: "den",
    });
    expect(
      checkRequest(
        req("GET", "/api/sessions/s1/io", { host: local }, "192.0.2.7"),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "signin_required", scope: "den" });
  });

  it("shell-grade with a session, Origin and the session's CSRF: passes, as the browser's session", () => {
    const r = checkRequest(
      req("POST", START, {
        host: local,
        origin: `http://${local}`,
        "x-den-csrf": "session-csrf",
        ...cookie,
      }),
      ctx(),
    );
    expect(r).toMatchObject({
      ok: true,
      session: SESSION,
      beyond: false,
      principal: { kind: "person-browser", session: SESSION.key },
    });
  });

  it("signed in, the CSRF must be the session's: the server start's is 403 csrf", () => {
    for (const p of [START, "/api/settings"])
      expect(
        checkRequest(
          req("POST", p, {
            host: local,
            origin: `http://${local}`,
            "x-den-csrf": "start-csrf",
            ...cookie,
          }),
          ctx(),
        ),
      ).toMatchObject({ ok: false, status: 403, code: "csrf" });
  });

  it("a shell-grade session still needs Origin", () => {
    expect(
      checkRequest(
        req("POST", START, {
          host: local,
          "x-den-csrf": "session-csrf",
          ...cookie,
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
  });

  it("the person's bearer passes shell-grade (the CLI, MCP): no session, no Origin", () => {
    expect(
      checkRequest(
        req("POST", START, {
          host: local,
          authorization: "Bearer den_pt_good",
        }),
        ctx(),
      ),
    ).toMatchObject({
      ok: true,
      principal: { kind: "person", actor: "person:someone" },
    });
  });

  it("mutating without a session keeps SEC-1a's checks (Origin and the start's CSRF)", () => {
    expect(
      checkRequest(
        req("POST", "/api/settings", {
          host: local,
          origin: `http://${local}`,
          "x-den-csrf": "start-csrf",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: true, session: null });
  });
});

describe("beyond loopback", () => {
  it("an edge Host for another machine (its X-Forwarded-For) with no session: 401 signin_required even on a read-only GET or page", () => {
    for (const p of ["/", "/api/settings", "/api/health", "/settings"])
      expect([
        p,
        checkRequest(req("GET", p, { host: EDGE, ...AWAY }), ctx()),
      ]).toMatchObject([
        p,
        { ok: false, status: 401, code: "signin_required", scope: "den" },
      ]);
  });

  it("an edge Host for another machine with a session passes, and its mutations still need Origin and CSRF", () => {
    expect(
      checkRequest(
        req("GET", "/api/settings", { host: EDGE, ...AWAY, ...cookie }),
        ctx(),
      ),
    ).toMatchObject({ ok: true, beyond: true, via: "edge" });
    expect(
      checkRequest(
        req("POST", "/api/settings", { host: EDGE, ...AWAY, ...cookie }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
    expect(
      checkRequest(
        req("POST", "/api/settings", {
          host: EDGE,
          ...AWAY,
          origin: `https://${EDGE}`,
          "x-den-csrf": "session-csrf",
          ...cookie,
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: true });
  });

  it("a person bearer passes beyond loopback too", () => {
    expect(
      checkRequest(
        req("GET", "/api/settings", {
          host: EDGE,
          ...AWAY,
          authorization: "Bearer den_pt_good",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: true });
  });

  it("the sign-in routes need no session: /auth and /api/session", () => {
    expect(
      checkRequest(
        req("GET", "/auth?c=x", {
          host: EDGE,
          ...AWAY,
          "sec-fetch-site": "none",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: true });
    expect(
      checkRequest(req("GET", "/api/session", { host: EDGE, ...AWAY }), ctx()),
    ).toMatchObject({ ok: true, session: null, beyond: true });
  });

  it("a localhost Host from a peer that isn't loopback (a 0.0.0.0 bind) is beyond loopback", () => {
    expect(
      checkRequest(
        req("GET", "/api/settings", { host: local }, "192.0.2.7"),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "signin_required", scope: "den" });
  });

  it("a LAN name is allowed only when listed (allow_plain_http_remote), and then needs a session", () => {
    const lan = `192.0.2.4:${PORT}`;
    expect(
      checkRequest(req("GET", "/", { host: lan }, "192.0.2.7"), ctx()),
    ).toMatchObject({ ok: false, status: 421 });
    const c = ctx({ lan: ["192.0.2.4"] });
    expect(
      checkRequest(req("GET", "/", { host: lan }, "192.0.2.7"), c),
    ).toMatchObject({ ok: false, status: 401, code: "signin_required" });
    expect(
      checkRequest(req("GET", "/", { host: lan, ...cookie }, "192.0.2.7"), c),
    ).toMatchObject({ ok: true, via: "lan", beyond: true });
  });
});

describe("HTTPS (the cookie's Secure)", () => {
  const xfp = { "x-forwarded-proto": "https" };
  it("the edge Host from the edge's peer, with X-Forwarded-Proto https: HTTPS", () => {
    for (const peer of [
      "127.0.0.1",
      "172.18.0.5",
      "192.168.65.1",
      "::ffff:127.0.0.1",
    ])
      expect([
        peer,
        requestIsHttps(
          req("GET", "/auth", { host: EDGE, ...xfp }, peer),
          "edge",
        ),
      ]).toEqual([peer, true]);
  });
  it("a spoofed X-Forwarded-Proto: a localhost Host from loopback, or the edge Host from elsewhere, is not", () => {
    expect(
      requestIsHttps(req("GET", "/auth", { host: local, ...xfp }), "loopback"),
    ).toBe(false);
    expect(
      requestIsHttps(
        req("GET", "/auth", { host: EDGE, ...xfp }, "192.0.2.7"),
        "edge",
      ),
    ).toBe(false);
    expect(requestIsHttps(req("GET", "/auth", { host: EDGE }), "edge")).toBe(
      false,
    );
  });
});

describe("refusing to start a non-loopback bind", () => {
  const no = { allowPlainHttpRemote: false, fronted: false };
  it("loopback binds start", () => {
    for (const b of ["127.0.0.1", "::1", "localhost", "127.0.0.2"])
      expect([b, bindRefusal(b, no)]).toEqual([b, null]);
  });
  it("0.0.0.0, ::, or a LAN address without HTTPS in front: refused, saying why", () => {
    for (const b of ["0.0.0.0", "::", "192.0.2.4"]) {
      const why = bindRefusal(b, no);
      expect(why).toMatch(/clear text/);
      expect(why).toMatch(/web\.allow_plain_http_remote: true/);
    }
  });
  it("starts with web.allow_plain_http_remote; the edge in front is not enough (its own port still answers plain HTTP)", () => {
    expect(
      bindRefusal("0.0.0.0", { ...no, allowPlainHttpRemote: true }),
    ).toBeNull();
    for (const b of ["0.0.0.0", "::", "192.0.2.4", "10.0.0.5"]) {
      const why = bindRefusal(b, { ...no, fronted: true });
      expect([b, why]).toEqual([b, expect.stringMatching(/clear text/)]);
      expect(why).toMatch(/even with the edge in front/);
    }
  });
  it("edge-fronted, a Docker bridge address (Linux's host-gateway) starts; not without the edge", () => {
    for (const b of ["172.17.0.1", "172.18.0.1", "172.31.255.1"])
      expect([b, bindRefusal(b, { ...no, fronted: true })]).toEqual([b, null]);
    expect(bindRefusal("172.17.0.1", no)).toMatch(/clear text/);
    for (const b of ["172.15.0.1", "172.32.0.1", "192.168.65.1"])
      expect([b, bindRefusal(b, { ...no, fronted: true })]).toEqual([
        b,
        expect.stringMatching(/clear text/),
      ]);
  });
});

describe("the edge hostname is believed only from an edge peer", () => {
  const edgeCtx = (): GuardContext => ({
    ...ctx(),
    peerIsEdge: (r) => isEdgePeer(r.socket?.remoteAddress),
  });
  it("from a LAN client sending Host: <edge> straight to the port: 421, signed in or not", () => {
    for (const peer of ["192.168.1.20", "10.0.0.7", "192.0.2.9"])
      for (const h of [{}, cookie])
        expect([
          peer,
          checkRequest(
            req("GET", "/api/settings", { host: EDGE, ...h }, peer),
            edgeCtx(),
          ),
        ]).toEqual([
          peer,
          expect.objectContaining({
            ok: false,
            status: 421,
            code: "misdirected",
          }),
        ]);
  });
  it("from loopback or a Docker network (the edge's Traefik): the edge, as before", () => {
    for (const peer of [
      "127.0.0.1",
      "::ffff:127.0.0.1",
      "172.18.0.3",
      "192.168.65.3",
    ])
      expect([
        peer,
        checkRequest(
          req("GET", "/api/settings", { host: EDGE, ...cookie }, peer),
          edgeCtx(),
        ),
      ]).toEqual([peer, expect.objectContaining({ ok: true, via: "edge" })]);
  });
  it("a loopback Host is unaffected by the peer check", () => {
    expect(
      checkRequest(
        req("GET", "/api/settings", { host: local }, "127.0.0.1"),
        edgeCtx(),
      ),
    ).toMatchObject({ ok: true, via: "loopback" });
  });
});

describe("a revoked agent token (SEC-1 §6c.2: `web logout --all`)", () => {
  it("answers 401 token_revoked, telling the agent to restart or resume", () => {
    const c: GuardContext = {
      ...ctx(),
      verifyBearer: (t) => (t === "den_at_revoked" ? "revoked" : null),
    };
    const r = checkRequest(
      req("GET", "/api/settings", {
        host: local,
        authorization: "Bearer den_at_revoked",
      }),
      c,
    );
    expect(r).toMatchObject({ ok: false, status: 401, code: "token_revoked" });
    expect(r.ok ? "" : r.error).toMatch(/restart or resume the agent/);
  });
});
