/**
 * SEC-2a's limits on an agent's token, as the request checks apply them (a
 * pure function of the request), on loopback where nothing else asks:
 *  - signing in and the owner are a person's: every route under
 *    /api/web/*, /api/github/* and /api/signin/*, and /auth, is refused
 *    (403 agent_forbidden), whatever the method;
 *  - the admin password stays read-only to it: its status is a read; set,
 *    forget and load-from-vault are refused.
 * The real server's wiring is sec1c-actor-tokens.integration.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  isEdgePeer,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const PORT = 41239;
const AGENT = "Bearer den_at_agent";

const ctx = (): GuardContext => ({
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [],
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
  localNet: () => ({ own: ["127.0.0.1", "::1"], bridges: [] }),
});
/** Straight to the server's port on this machine, with the agent's token. */
const req = (method: string, url: string): http.IncomingMessage =>
  ({
    method,
    url,
    headers: { host: `localhost:${PORT}`, authorization: AGENT },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;

describe("an agent's token and signing in (SEC-2a)", () => {
  const refused = [
    ["GET", "/api/web/owner"],
    ["POST", "/api/web/owner/link"],
    ["GET", "/api/web/owner/link/abcdefghijklmnopqrstuvwxyz012345"],
    ["POST", "/api/web/owner/unlink"],
    ["GET", "/api/web/pair"],
    ["POST", "/api/web/pair"],
    ["GET", "/api/web/waiting"],
    ["POST", "/api/web/approve"],
    ["POST", "/api/web/deny"],
    ["POST", "/api/github/signin"],
    ["GET", "/api/github/signin/abcdefghijklmnopqrstuvwxyz012345"],
    ["POST", "/api/signin/code"],
    ["GET", "/api/signin/code/abcdefghijklmnopqrstuvwxyz012345"],
    ["GET", "/auth?c=x"],
  ] as const;

  it("reaches none of /api/web/*, /api/github/*, /api/signin/* or /auth", () => {
    for (const [m, p] of refused)
      expect([m, p, checkRequest(req(m, p), ctx())]).toMatchObject([
        m,
        p,
        { ok: false, status: 403, code: "agent_forbidden" },
      ]);
  });
});

describe("an agent's token and the admin password (R8)", () => {
  it("may read its status", () => {
    expect(
      checkRequest(req("GET", "/api/sudo-password/status"), ctx()),
    ).toMatchObject({ ok: true });
  });

  it("can't set, forget or load it", () => {
    for (const p of [
      "/api/sudo-password",
      "/api/sudo-password/forget",
      "/api/sudo-password/load-from-vault",
    ])
      expect([p, checkRequest(req("POST", p), ctx())]).toMatchObject([
        p,
        { ok: false, status: 403, code: "agent_forbidden" },
      ]);
  });
});
