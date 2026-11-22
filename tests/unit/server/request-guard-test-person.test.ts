/**
 * Issue 636: the request checks for the test-person path. The header
 * (x-den-test-person) counts only with the person's own token, on a test
 * bed, from this machine; with anything else the request is refused (403)
 * before any route runs. The real server's wiring is
 * test-person.integration.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  principalOf,
  setPrincipal,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const PORT = 41236;
const local = `localhost:${PORT}`;
const ctx = (testBed: boolean): GuardContext => ({
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [],
  verifyBearer: (t) =>
    t === "den_pt_good"
      ? "person:someone"
      : t === "den_at_good"
        ? {
            kind: "agent",
            actor: "agent:stub",
            workspace: "north",
            grants: [],
            session: { name: "stub" },
          }
        : null,
  session: (r) =>
    /den_session_\d+=good/.test(String(r.headers.cookie ?? ""))
      ? { key: "k".repeat(64), csrf: "the-csrf" }
      : null,
  testBed: () => testBed,
});
const req = (
  method: string,
  url: string,
  headers: Record<string, string>,
): http.IncomingMessage =>
  ({
    method,
    url,
    headers: { host: local, ...headers },
  }) as unknown as http.IncomingMessage;
const TP = { "x-den-test-person": "1" };

describe("the test-person header", () => {
  it("on an install that isn't a test bed: 403 not_test_bed, with the person's token too", () => {
    for (const [m, p] of [
      ["POST", "/api/web/test-person"],
      ["POST", "/api/workspaces/north/agents/stub/stop"],
      ["GET", "/api/settings"],
    ] as const) {
      const r = checkRequest(
        req(m, p, { authorization: "Bearer den_pt_good", ...TP }),
        ctx(false),
      );
      expect([p, r]).toMatchObject([
        p,
        { ok: false, status: 403, code: "not_test_bed" },
      ]);
      if (!r.ok) expect(r.error).toMatch(/isn't a test bed.*Nothing ran/);
    }
  });

  it("with an agent's token, a browser session or no credential: 403 test_person_refused, even on a test bed", () => {
    for (const h of [
      { authorization: "Bearer den_at_good" },
      {
        cookie: `den_session_${PORT}=good`,
        "x-den-csrf": "the-csrf",
        origin: `http://${local}`,
      },
      {},
    ]) {
      const r = checkRequest(
        req("POST", "/api/web/test-person", { ...h, ...TP }),
        ctx(true),
      );
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        code: "test_person_refused",
      });
    }
  });

  it("from beyond this machine: refused, even on a test bed", () => {
    const g = ctx(true);
    g.peerIsLoopback = () => false;
    g.lanHosts = () => ["box.lan"];
    const r = checkRequest(
      {
        method: "POST",
        url: "/api/web/test-person",
        headers: {
          host: `box.lan:${PORT}`,
          authorization: "Bearer den_pt_good",
          ...TP,
        },
        socket: { remoteAddress: "192.0.2.7" },
      } as unknown as http.IncomingMessage,
      g,
    );
    expect(r.ok).toBe(false);
  });

  it("on a test bed with the person's token: the person, on the test-person path", () => {
    const q = req("POST", "/api/workspaces/north/agents/stub/stop", {
      authorization: "Bearer den_pt_good",
      ...TP,
    });
    const r = checkRequest(q, ctx(true));
    expect(r).toMatchObject({
      ok: true,
      principal: { kind: "person", actor: "person:someone", testPerson: true },
    });
    if (r.ok) setPrincipal(q, r.principal);
    expect(principalOf(q)).toBe("person:someone");
  });

  it("without the header nothing changes: the person's token is the person's", () => {
    const r = checkRequest(
      req("GET", "/api/settings", { authorization: "Bearer den_pt_good" }),
      ctx(false),
    );
    expect(r).toMatchObject({
      ok: true,
      principal: { kind: "person", actor: "person:someone" },
    });
    if (r.ok) expect(r.principal).not.toHaveProperty("testPerson");
  });
});
