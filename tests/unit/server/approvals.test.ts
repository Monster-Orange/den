/**
 * 0.4.12: the approval queue and who may approve (Ward, 2026-11-07: "yes,
 * approving an agent's changes needs a signed-in browser session, even on
 * localhost").
 *
 * approverAllowed is the one check. Only a signed-in browser session
 * passes: the session cookie, no bearer of any kind, a mutation with that
 * session's own CSRF token (checkRequest checked it). An anonymous
 * loopback request does NOT pass, nor one with the server-start CSRF
 * token, nor a person's or an agent's bearer.
 *
 * The queue: a write an agent asks for is held with its exact args. Allow
 * runs it exactly once (on the server, from the stored args). Deny or
 * expiry runs nothing. Deciding twice is refused.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  ApprovalQueue,
  approverAllowed,
} from "../../../src/ui/server/approvals.js";
import {
  checkRequest,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const PORT = 4100;
const SERVER_CSRF = "server-start-csrf-token-aaaaaaaaaaaaaaaaaaaaaa";
const SESSION = {
  key: "sess-key-1",
  csrf: "session-csrf-token-bbbbbbbbbbbbbbbbbbbb",
};

function ctx(): GuardContext {
  return {
    port: PORT,
    loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
    edgeHosts: () => [],
    verifyBearer: (t) =>
      t === "den_pt_person"
        ? "person:someone"
        : t === "den_at_agent"
          ? {
              kind: "agent",
              actor: "agent:server",
              workspace: "default",
              grants: [],
              session: { name: "server" },
            }
          : null,
    csrfToken: SERVER_CSRF,
    session: (req) =>
      String(req.headers.cookie ?? "").includes(`den_session_${PORT}=good`)
        ? SESSION
        : null,
  };
}

function req(headers: Record<string, string>): http.IncomingMessage {
  return {
    method: "POST",
    url: "/api/approvals/a1/decide",
    headers: { host: `localhost:${PORT}`, ...headers },
  } as unknown as http.IncomingMessage;
}

function allowed(headers: Record<string, string>) {
  const r = req(headers);
  const g = checkRequest(r, ctx(), "acme", "Acme");
  return { guard: g.ok, approver: g.ok ? approverAllowed(r, g) : null };
}

const ORIGIN = { origin: `http://localhost:${PORT}` };

describe("approverAllowed: only a signed-in browser session", () => {
  it("the session cookie with its own CSRF token: allowed, as that session", () => {
    expect(
      allowed({
        ...ORIGIN,
        cookie: `den_session_${PORT}=good`,
        "x-den-csrf": SESSION.csrf,
      }),
    ).toEqual({ guard: true, approver: { ok: true, session: SESSION.key } });
  });

  it("an agent's curl with its actor token: refused", () => {
    expect(
      allowed({ ...ORIGIN, authorization: "Bearer den_at_agent" }).approver,
    ).toMatchObject({ ok: false });
  });

  it("an agent's curl with no credential and the server-start CSRF token (the loopback page's): refused", () => {
    const r = allowed({ ...ORIGIN, "x-den-csrf": SERVER_CSRF });
    expect(r.guard).toBe(true); // loopback lets it through the guard...
    expect(r.approver).toMatchObject({ ok: false, code: "signin_to_approve" }); // ...but it can't approve
  });

  it("an agent's curl with no credential and no Origin: refused before it gets here", () => {
    expect(allowed({}).guard).toBe(false);
  });

  it("a person's bearer (the CLI's token) is not a browser session: refused", () => {
    expect(
      allowed({ ...ORIGIN, authorization: "Bearer den_pt_person" }).approver,
    ).toMatchObject({ ok: false });
  });

  it("a bearer alongside a good session cookie: still refused (the bearer is who it is)", () => {
    expect(
      allowed({
        ...ORIGIN,
        cookie: `den_session_${PORT}=good`,
        authorization: "Bearer den_at_agent",
      }).approver,
    ).toMatchObject({ ok: false });
  });

  it("the session cookie with the server-start CSRF token instead of its own: refused by the guard", () => {
    expect(
      allowed({
        ...ORIGIN,
        cookie: `den_session_${PORT}=good`,
        "x-den-csrf": SERVER_CSRF,
      }).guard,
    ).toBe(false);
  });
});

describe("the queue", () => {
  const T0 = Date.parse("2026-11-07T12:00:00Z");

  function queue() {
    let now = T0;
    const runs: unknown[] = [];
    const q = new ApprovalQueue({
      now: () => now,
      ttlMs: 10 * 60_000,
      run: async (action, args) => {
        runs.push([action, args]);
        return { ok: true, said: `ran ${action}` };
      },
    });
    return { q, runs, tick: (ms: number) => (now += ms) };
  }

  it("Allow runs the stored args exactly once, and keeps the result", async () => {
    const { q, runs } = queue();
    const a = q.request({
      actor: "agent:server",
      action: "workspace_create",
      args: { name: "web" },
      summary: "Create workspace web",
    });
    expect(a.state).toBe("pending");
    expect(runs).toEqual([]);
    const d = await q.decide(a.id, "allow", "sess-key-1");
    expect(d).toMatchObject({ ok: true });
    expect(runs).toEqual([["workspace_create", { name: "web" }]]);
    expect(q.get(a.id)).toMatchObject({
      state: "done",
      decidedBy: "sess-key-1",
      result: { ok: true, said: "ran workspace_create" },
    });
    // A second decision is refused and runs nothing.
    expect(await q.decide(a.id, "allow", "sess-key-1")).toMatchObject({
      ok: false,
      code: "already_decided",
    });
    expect(runs).toHaveLength(1);
  });

  it("the args are a copy: changing the caller's object after the request changes nothing", async () => {
    const { q, runs } = queue();
    const args = { name: "web" };
    const a = q.request({
      actor: "agent:server",
      action: "workspace_create",
      args,
      summary: "Create workspace web",
    });
    args.name = "evil";
    await q.decide(a.id, "allow", "s");
    expect(runs).toEqual([["workspace_create", { name: "web" }]]);
  });

  it("Deny runs nothing", async () => {
    const { q, runs } = queue();
    const a = q.request({
      actor: "agent:server",
      action: "repo_add",
      args: { path: "/work/notes" },
      summary: "Add repo notes",
    });
    expect(await q.decide(a.id, "deny", "s")).toMatchObject({ ok: true });
    expect(q.get(a.id)?.state).toBe("denied");
    expect(runs).toEqual([]);
  });

  it("expiry runs nothing, and a late Allow is refused", async () => {
    const { q, runs, tick } = queue();
    const a = q.request({
      actor: "agent:server",
      action: "service_try",
      args: { service: "shop" },
      summary: "Start shop",
    });
    tick(10 * 60_000 + 1);
    expect(q.get(a.id)?.state).toBe("expired");
    expect(await q.decide(a.id, "allow", "s")).toMatchObject({
      ok: false,
      code: "expired",
    });
    expect(runs).toEqual([]);
  });

  it("two Allows at once still run it once", async () => {
    const { q, runs } = queue();
    const a = q.request({
      actor: "agent:server",
      action: "workspace_create",
      args: { name: "web" },
      summary: "Create workspace web",
    });
    const both = await Promise.all([
      q.decide(a.id, "allow", "s"),
      q.decide(a.id, "allow", "s"),
    ]);
    expect(both.filter((d) => d.ok)).toHaveLength(1);
    expect(runs).toHaveLength(1);
  });

  it("an unknown id is refused", async () => {
    const { q } = queue();
    expect(await q.decide("nope", "allow", "s")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("pending lists only what waits, newest last", () => {
    const { q } = queue();
    const a = q.request({
      actor: "agent:server",
      action: "repo_add",
      args: {},
      summary: "A",
    });
    q.request({
      actor: "agent:server",
      action: "repo_add",
      args: {},
      summary: "B",
    });
    void q.decide(a.id, "deny", "s");
    expect(q.pending().map((x) => x.summary)).toEqual(["B"]);
  });
});
