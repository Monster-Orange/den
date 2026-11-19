/**
 * Only GET and HEAD are reads. Any other method (OPTIONS, PROPFIND, PURGE,
 * a made-up one) on any route is checked as a change: Origin and CSRF, a
 * credential where one is needed. A method a route doesn't list never
 * falls back to the read class.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";

const PORT = 7811;
const ctx: GuardContext = {
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [],
  verifyBearer: () => null,
  csrfToken: "the-csrf",
};

const req = (method: string, url: string, headers: Record<string, string>) =>
  ({
    method,
    url,
    headers: { host: `localhost:${PORT}`, ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;

/** A concrete path for a route pattern (":id" and "*" filled in). */
const concrete = (p: string) =>
  p.replace(/:[A-Za-z]+/g, "x").replace(/\*$/, "x");

const ODD = ["OPTIONS", "PROPFIND", "PURGE", "FOO"];
const PATHS = [...new Set(ROUTES.map((r) => concrete(r.path)))];

describe("a method other than GET or HEAD is never a read", () => {
  it.each(ODD)("%s with no Origin is refused on every route", (m) => {
    const let_through = PATHS.filter(
      (p) => checkRequest(req(m, p, {}), ctx).ok,
    );
    expect(let_through).toEqual([]);
  });

  it.each(ODD)(
    "%s shaped as another site's preflight is refused on every route",
    (m) => {
      const let_through = PATHS.filter(
        (p) =>
          checkRequest(
            req(m, p, {
              origin: "https://elsewhere.example",
              "sec-fetch-site": "cross-site",
              "access-control-request-method": "GET",
              "access-control-request-headers": "x-a",
            }),
            ctx,
          ).ok,
      );
      expect(let_through).toEqual([]);
    },
  );

  it("GET and HEAD of a read still pass with no credential on this machine", () => {
    for (const m of ["GET", "HEAD"])
      expect(checkRequest(req(m, "/api/health", {}), ctx)).toMatchObject({
        ok: true,
      });
  });
});
