/**
 * SEC-1a (SEC-1 spec §3): the checks every request passes, as a pure
 * function of the request's method and headers. The real server's wiring
 * is sec1a-request-checks.integration.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  hostAllowed,
  originAllowed,
  parseHostHeader,
  sessionRequestAllowed,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const PORT = 41234;
const ctx = (edge: string[] = []): GuardContext => ({
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => edge,
  verifyBearer: (t) => (t === "den_pt_good" ? "person:someone" : null),
  // The cookie's value names the session; "good" is the live one.
  session: (r) =>
    /den_session_\d+=good/.test(String(r.headers.cookie ?? ""))
      ? { key: "k".repeat(64), csrf: "the-csrf" }
      : null,
});
/** A signed-in browser's cookie (0.4.71: a write needs one on loopback too). */
const SIGNED = `den_session_${PORT}=good`;
/**
 * A request from a signed-in browser (these checks are what a session still
 * has to pass); `cookie: ""` for one with no session.
 */
const req = (
  method: string,
  headers: Record<string, string>,
): http.IncomingMessage =>
  ({
    method,
    headers: { cookie: SIGNED, ...headers },
  }) as unknown as http.IncomingMessage;
const local = `localhost:${PORT}`;

describe("a sign-in on this machine too (0.4.71)", () => {
  it("a write, an upgrade or a GET that runs something with no session or bearer: 401 signin_required, whatever its Origin and token", () => {
    for (const [m, p, extra] of [
      ["POST", "/api/settings", {}],
      ["DELETE", "/api/workspaces/x", {}],
      ["GET", "/api/sessions/s1/io", { upgrade: "websocket" }],
      ["GET", "/api/run", { "sec-fetch-site": "same-origin" }],
      ["GET", "/api/service/taillog", { "sec-fetch-site": "same-origin" }],
    ] as const) {
      const r = checkRequest(
        {
          method: m,
          url: p,
          headers: {
            host: local,
            origin: `http://${local}`,
            "x-den-csrf": "the-csrf",
            ...extra,
          },
        } as unknown as http.IncomingMessage,
        ctx(),
      );
      expect([p, r]).toMatchObject([
        p,
        { ok: false, status: 401, code: "signin_required" },
      ]);
    }
  });
  it("a read with no session passes, as before", () => {
    const r = checkRequest(
      {
        method: "GET",
        url: "/api/settings",
        headers: { host: local },
      } as unknown as http.IncomingMessage,
      ctx(),
    );
    expect(r).toMatchObject({ ok: true, session: null });
  });
});

describe("the Host allowlist", () => {
  it.each([
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    `[::1]:${PORT}`,
    `LOCALHOST:${PORT}`,
  ])("accepts %s", (h) => expect(hostAllowed(h, ctx())).toBe("loopback"));
  it.each([
    "evil.example",
    `evil.example:${PORT}`,
    "localhost",
    "localhost:1",
    `127.0.0.2:${PORT}`,
    `localhost.evil.example:${PORT}`,
    "",
    "a:b:c",
  ])("refuses %p", (h) => expect(hostAllowed(h, ctx())).toBeNull());
  it("accepts the edge hostname on any port, only when configured", () => {
    expect(hostAllowed("den.acme.localhost", ctx())).toBeNull();
    expect(hostAllowed("den.acme.localhost", ctx(["den.acme.localhost"]))).toBe(
      "edge",
    );
    expect(
      hostAllowed("den.acme.localhost:8443", ctx(["den.acme.localhost"])),
    ).toBe("edge");
  });
  it("parses bracketed IPv6", () =>
    expect(parseHostHeader(`[::1]:${PORT}`)).toEqual({
      name: "[::1]",
      port: PORT,
    }));
  it("a missing Host is 421 misdirected", () => {
    const r = checkRequest(req("GET", {}), ctx());
    expect(r).toMatchObject({ ok: false, status: 421, code: "misdirected" });
  });
  it("a rebinding Host is 421 on a GET too", () => {
    const r = checkRequest(req("GET", { host: "evil.example" }), ctx());
    expect(r).toMatchObject({ ok: false, status: 421, code: "misdirected" });
  });
});

describe("the Origin check", () => {
  it("accepts an allowed host's origin (http or https), refuses others", () => {
    expect(originAllowed(`http://localhost:${PORT}`, ctx())).toBe(true);
    expect(originAllowed(`http://127.0.0.1:${PORT}`, ctx())).toBe(true);
    expect(originAllowed(`http://[::1]:${PORT}`, ctx())).toBe(true);
    expect(
      originAllowed("https://den.acme.localhost", ctx(["den.acme.localhost"])),
    ).toBe(true);
    expect(originAllowed("http://evil.example", ctx())).toBe(false);
    expect(originAllowed(`http://localhost:${PORT + 1}`, ctx())).toBe(false);
    expect(originAllowed("null", ctx())).toBe(false);
    expect(originAllowed(`file://localhost:${PORT}`, ctx())).toBe(false);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s from another origin: 403 origin_rejected",
    (m) => {
      const r = checkRequest(
        req(m, {
          host: local,
          origin: "http://evil.example",
          "x-den-csrf": "the-csrf",
        }),
        ctx(),
      );
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "origin_rejected",
      });
    },
  );

  it("a mutation with no Origin and no Authorization: 403 origin_rejected", () => {
    expect(checkRequest(req("POST", { host: local }), ctx())).toMatchObject({
      ok: false,
      status: 403,
      code: "origin_rejected",
    });
  });

  it("a WebSocket upgrade is checked like a mutation", () => {
    expect(
      checkRequest(req("GET", { host: local, upgrade: "websocket" }), ctx()),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
    expect(
      checkRequest(
        req("GET", {
          host: local,
          upgrade: "websocket",
          origin: "http://evil.example",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
  });

  it("an upgrade's CSRF token rides as the den.csrf.<token> subprotocol (a browser's WebSocket sends no header); a plain request's never does", () => {
    const up = (protocols: string, extra: Record<string, string> = {}) =>
      checkRequest(
        req("GET", {
          host: local,
          upgrade: "websocket",
          origin: `http://${local}`,
          "sec-websocket-protocol": protocols,
          ...extra,
        }),
        ctx(),
      );
    expect(up("den.io, den.csrf.the-csrf")).toMatchObject({ ok: true });
    expect(up("den.csrf.the-csrf")).toMatchObject({ ok: true });
    expect(up("den.io")).toMatchObject({ ok: false, code: "csrf" });
    expect(up("den.io, den.csrf.other")).toMatchObject({
      ok: false,
      code: "csrf",
    });
    expect(up("den.io, den.csrf.")).toMatchObject({ ok: false, code: "csrf" });
    // Not an upgrade: the subprotocol header proves nothing.
    expect(
      checkRequest(
        req("POST", {
          host: local,
          origin: `http://${local}`,
          "sec-websocket-protocol": "den.csrf.the-csrf",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "csrf" });
  });

  it("a GET with another site's Origin passes (only the Host is checked)", () => {
    expect(
      checkRequest(
        req("GET", { host: local, origin: "http://evil.example" }),
        ctx(),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("CSRF and the bearer", () => {
  it("an allowed Origin without the CSRF header: 403 csrf; a wrong one too", () => {
    const o = { host: local, origin: `http://localhost:${PORT}` };
    expect(checkRequest(req("POST", o), ctx())).toMatchObject({
      ok: false,
      status: 403,
      code: "csrf",
    });
    expect(
      checkRequest(req("POST", { ...o, "x-den-csrf": "nope" }), ctx()),
    ).toMatchObject({ ok: false, code: "csrf" });
  });
  it("an allowed Origin with the CSRF token passes, as person-browser", () => {
    expect(
      checkRequest(
        req("POST", {
          host: local,
          origin: `http://localhost:${PORT}`,
          "x-den-csrf": "the-csrf",
        }),
        ctx(),
      ),
    ).toEqual({
      ok: true,
      principal: { kind: "person-browser", session: "k".repeat(64) },
      via: "loopback",
      beyond: false,
      edgeLocal: false,
      session: { key: "k".repeat(64), csrf: "the-csrf" },
    });
  });
  it("no Origin with a valid bearer passes, as person:<user>; CSRF skipped", () => {
    expect(
      checkRequest(
        req("POST", { host: local, authorization: "Bearer den_pt_good" }),
        ctx(),
      ),
    ).toEqual({
      ok: true,
      principal: { kind: "person", actor: "person:someone" },
      via: "loopback",
      beyond: false,
      edgeLocal: false,
      session: null,
    });
    expect(
      checkRequest(
        req("DELETE", {
          host: local,
          origin: `http://localhost:${PORT}`,
          authorization: "Bearer den_pt_good",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: true });
  });
  it("an invalid bearer: 401 unauthorized, on a GET as on a POST", () => {
    for (const m of ["GET", "POST"])
      expect(
        checkRequest(
          req(m, { host: local, authorization: "Bearer den_pt_bad" }),
          ctx(),
        ),
      ).toMatchObject({ ok: false, status: 401, code: "unauthorized" });
  });
  it("a valid bearer never passes another site's Origin", () => {
    expect(
      checkRequest(
        req("POST", {
          host: local,
          origin: "http://evil.example",
          authorization: "Bearer den_pt_good",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
  });
  it("another scheme's Authorization is no credential (no Origin: 403)", () => {
    expect(
      checkRequest(
        req("POST", { host: local, authorization: "Basic eDp5" }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
  });
});

describe("GET /api/session's caller", () => {
  it("same-origin only", () => {
    expect(sessionRequestAllowed(req("GET", { host: local }), ctx())).toBe(
      true,
    );
    expect(
      sessionRequestAllowed(
        req("GET", { host: local, "sec-fetch-site": "same-origin" }),
        ctx(),
      ),
    ).toBe(true);
    expect(
      sessionRequestAllowed(
        req("GET", { host: local, "sec-fetch-site": "same-site" }),
        ctx(),
      ),
    ).toBe(false);
    expect(
      sessionRequestAllowed(
        req("GET", { host: local, origin: "http://evil.example" }),
        ctx(),
      ),
    ).toBe(false);
  });
});

describe("GETs that run something (route-classes: shell-grade / mutating)", () => {
  const run = "/api/run?pillar=smoke";
  // A signed-in browser's (0.4.71): these checks come on top of the sign-in.
  const get = (url: string, headers: Record<string, string>) =>
    ({
      method: "GET",
      url,
      headers: { host: local, cookie: SIGNED, ...headers },
    }) as unknown as http.IncomingMessage;

  it.each([
    "/api/run",
    "/api/service/exec?repo=a&service=b&cmd=up",
    "/api/workspace/exec",
    "/api/workspace/sync",
    "/api/aws/login",
  ])(
    "%s from another site (Sec-Fetch-Site cross-site or same-site): 403 cross_site",
    (u) => {
      for (const site of ["cross-site", "same-site"])
        expect(
          checkRequest(get(u, { "sec-fetch-site": site }), ctx()),
        ).toMatchObject({
          ok: false,
          status: 403,
          code: "cross_site",
        });
    },
  );
  it("another site's Origin: 403 origin_rejected", () => {
    expect(
      checkRequest(
        get(run, {
          origin: "http://evil.example",
          "sec-fetch-site": "same-origin",
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
  });
  it("neither header and no bearer (curl): 403; with the bearer it passes", () => {
    expect(checkRequest(get(run, {}), ctx())).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      checkRequest(get(run, { authorization: "Bearer den_pt_good" }), ctx()),
    ).toMatchObject({
      ok: true,
      principal: { kind: "person", actor: "person:someone" },
    });
  });
  it("this server's own page (same-origin, or a typed URL) passes", () => {
    expect(
      checkRequest(get(run, { "sec-fetch-site": "same-origin" }), ctx()),
    ).toMatchObject({ ok: true });
    expect(
      checkRequest(get(run, { "sec-fetch-site": "none" }), ctx()),
    ).toMatchObject({ ok: true });
    expect(
      checkRequest(
        get(run, {
          "sec-fetch-site": "same-origin",
          origin: `http://localhost:${PORT}`,
        }),
        ctx(),
      ),
    ).toMatchObject({ ok: true });
  });
  it("a read-only GET is unchanged: another site, no headers, all pass", () => {
    for (const h of [
      {},
      { "sec-fetch-site": "cross-site" },
      { origin: "http://evil.example" },
    ])
      expect(checkRequest(get("/api/health", h), ctx())).toMatchObject({
        ok: true,
      });
  });
});

describe("the sign-in GETs (/auth, the GitHub sign-in poll) with no fetch metadata", () => {
  // A plain-http origin that isn't localhost (a LAN bind with
  // web.allow_plain_http_remote) is not "potentially trustworthy": Chromium
  // sends it no Sec-Fetch-* headers, and a top-level navigation no Origin.
  const LAN = "192.168.1.122";
  const lanCtx = (): GuardContext => ({
    ...ctx(),
    lanHosts: () => [LAN],
    peerIsLoopback: () => false,
  });
  const get = (url: string, headers: Record<string, string>, host: string) =>
    ({
      method: "GET",
      url,
      headers: { host, ...headers },
      socket: { remoteAddress: "192.168.1.50" },
    }) as unknown as http.IncomingMessage;
  const signinGets = [
    "/auth?c=a-one-time-code",
    "/api/github/signin/abcdefghijklmnopqrst",
  ];
  const hosts: Array<[string, () => GuardContext]> = [
    [`${LAN}:${PORT}`, lanCtx],
    [local, ctx],
  ];

  it.each(signinGets)(
    "%s with neither Sec-Fetch-Site nor Origin passes (it carries its own credential)",
    (u) => {
      for (const [host, c] of hosts)
        expect([host, checkRequest(get(u, {}, host), c()).ok]).toEqual([
          host,
          true,
        ]);
    },
  );
  it.each(signinGets)(
    "%s with Sec-Fetch-Site cross-site or same-site, or a foreign Origin, is still refused",
    (u) => {
      for (const [host, c] of hosts) {
        for (const site of ["cross-site", "same-site"])
          expect(
            checkRequest(get(u, { "sec-fetch-site": site }, host), c()),
          ).toMatchObject({ ok: false, status: 403, code: "cross_site" });
        expect(
          checkRequest(get(u, { origin: "http://evil.example" }, host), c()),
        ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
      }
    },
  );
  it("another mutating GET with neither header and no bearer is still refused", () => {
    for (const u of ["/api/run?pillar=smoke", "/api/workspace/exec"]) {
      // Signed in, with neither header: refused all the same.
      expect(
        checkRequest(get(u, { cookie: SIGNED }, local), ctx()),
      ).toMatchObject({ ok: false, status: 403, code: "origin_rejected" });
      // Not signed in (0.4.71): a sign-in comes first, here too.
      expect(checkRequest(get(u, {}, local), ctx())).toMatchObject({
        ok: false,
        status: 401,
        code: "signin_required",
      });
    }
    // Beyond loopback it never gets that far: a sign-in comes first.
    expect(
      checkRequest(get("/api/run", {}, `${LAN}:${PORT}`), lanCtx()),
    ).toMatchObject({ ok: false, status: 401, code: "signin_required" });
  });
});
