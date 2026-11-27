/**
 * Issue 403: who reads a kept screenshot, through the real request guard.
 *
 * GET /api/report/shots/<id> is a readonly route, so on loopback the guard
 * lets an anonymous request through. The reader check (shotReaderOf) must
 * not take that request for the person: a project agent can leave its
 * token off, and report ids are printed in public issues. It needs a
 * proof of the person, the same as approvals (approverAllowed, "read"):
 * a signed-in browser with its CSRF token and approval key, or the
 * person's command-line token. This install's own agent reads with its
 * token. Anything else: 401 with no credential, 403 for a project agent.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import { shotReaderOf } from "../../../src/ui/server/report-routes.js";
import {
  checkRequest,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";
import { approveKeyHash } from "../../../src/shared/web/web-session.js";

const PORT = 4103;
const PATH = "/api/report/shots/0123456789abcdef";
const AK = "k".repeat(43);
const SESSION = {
  key: "sess-key-1",
  csrf: "session-csrf-token-bbbbbbbbbbbbbbbbbbbb",
  approveKeyHash: approveKeyHash(AK),
};

function agent(workspace: string) {
  return {
    kind: "agent" as const,
    actor: `agent:${workspace}-a` as const,
    workspace,
    grants: [],
    session: { name: workspace },
  };
}

/** Issue 403 after 810: the fixture person, as a test install's live checks sign in. */
const FIXTURE = { ...SESSION, key: "sess-fixture", via: "fixture" as const };

function ctx(): GuardContext {
  return {
    port: PORT,
    loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
    edgeHosts: () => [],
    verifyBearer: (t) =>
      t === "den_pt_person"
        ? "person:someone"
        : t === "den_at_server"
          ? agent("den-server")
          : t === "den_at_project"
            ? agent("north")
            : null,
    csrfToken: "server-start-csrf-token-aaaaaaaaaaaaaaaaaaaaaa",
    session: (req) =>
      String(req.headers.cookie ?? "").includes(`den_session_${PORT}=good`)
        ? SESSION
        : String(req.headers.cookie ?? "").includes(`den_session_${PORT}=fx`)
          ? FIXTURE
          : null,
  };
}

function read(headers: Record<string, string>) {
  const req = {
    method: "GET",
    url: PATH,
    headers: { host: `127.0.0.1:${PORT}`, ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
  const guard = checkRequest(req, ctx());
  return { guard, reader: shotReaderOf(req, guard) };
}

describe("issue 403: reading a kept screenshot, through the real guard", () => {
  it("an anonymous loopback request passes the guard but is refused (401)", () => {
    const { guard, reader } = read({});
    expect(guard.ok).toBe(true);
    expect(reader).toEqual({ ok: false, status: 401 });
  });

  it("an agent that only claims a name in headers is refused (401)", () => {
    const { reader } = read({ "x-den-actor": "agent:north-a" });
    expect(reader).toMatchObject({ ok: false, status: 401 });
  });

  it("a cookie with no CSRF token or approval key is refused (401)", () => {
    const { reader } = read({ cookie: `den_session_${PORT}=good` });
    expect(reader).toMatchObject({ ok: false, status: 401 });
  });

  it("a project agent with its token is refused (403) and named", () => {
    const { reader } = read({ authorization: "Bearer den_at_project" });
    expect(reader).toEqual({ ok: false, status: 403, who: "agent:north-a" });
  });

  it("the person's command-line token reads it", () => {
    expect(read({ authorization: "Bearer den_pt_person" }).reader).toEqual({
      ok: true,
    });
  });

  it("the person's signed-in browser (CSRF + approval key) reads it", () => {
    const { reader } = read({
      cookie: `den_session_${PORT}=good`,
      "x-den-csrf": SESSION.csrf,
      "x-den-approve-key": AK,
    });
    expect(reader).toEqual({ ok: true });
  });

  it("this install's own agent reads it with its token", () => {
    expect(read({ authorization: "Bearer den_at_server" }).reader).toEqual({
      ok: true,
    });
  });

  // The fixture person runs a test install's live checks. It may never
  // decide what waits for a person (issue 810), but reading a kept
  // screenshot decides nothing: there it is the person who runs the install.
  it("the fixture person's signed-in browser (CSRF) reads it", () => {
    const { reader } = read({
      cookie: `den_session_${PORT}=fx`,
      "x-den-csrf": FIXTURE.csrf,
    });
    // Issue 946: marked, so the route shows it only what a fixture filed.
    expect(reader).toEqual({ ok: true, fixture: true });
  });

  it("the fixture person's cookie with no CSRF token is refused (401)", () => {
    expect(read({ cookie: `den_session_${PORT}=fx` }).reader).toEqual({
      ok: false,
      status: 401,
    });
  });

  // Issue 946: the fixture cookie with anything less than its own CSRF token.
  it("the fixture person's cookie with a wrong CSRF token is refused (401)", () => {
    expect(
      read({ cookie: `den_session_${PORT}=fx`, "x-den-csrf": "not-its-token" })
        .reader,
    ).toEqual({ ok: false, status: 401 });
  });

  it("the fixture person's cookie with a bearer is never the fixture person", () => {
    const { reader } = read({
      cookie: `den_session_${PORT}=fx`,
      "x-den-csrf": FIXTURE.csrf,
      authorization: "Bearer den_at_gate403notatoken",
    });
    expect(reader).toEqual({ ok: false, status: 401 });
  });

  it("the fixture person's cookie with an agent's claim header reads only as the fixture person", () => {
    const { reader } = read({
      cookie: `den_session_${PORT}=fx`,
      "x-den-csrf": FIXTURE.csrf,
      "x-den-actor": "agent:north-a",
    });
    expect(reader).toEqual({ ok: true, fixture: true });
  });
});
