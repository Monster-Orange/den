/**
 * Issue 1299 review: every request that can sign in waits for the sessions
 * lock, and a refused sign-in never spends what allowed it.
 *
 *  1. A new device's poll of an approved code whose sign-in is refused
 *     (the sessions file busy or unreadable) keeps the approval: the next
 *     poll signs in. The same for the GitHub sign-in poll.
 *  2. mayWriteSessions covers every path that can sign in: any request
 *     but GET/HEAD, /auth, and the pairing routes (the poll is a GET).
 *  3. Every place a session is started is known here, so a new one has
 *     to be checked against that rule.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import type * as http from "http";
import * as path from "path";
import { handleGithubRoutes } from "../../../src/ui/server/github-routes.js";
import { handlePairRoutes } from "../../../src/ui/server/pair-routes.js";
import { PairRequests } from "../../../src/ui/server/pair-requests.js";
import { mayWriteSessions } from "../../../src/ui/server/session-writes.js";
import { SessionStoreUnreadable } from "../../../src/shared/web/web-session.js";

function harness(signIn: () => { cookie: string; approveKey: string }) {
  const pairs = new PairRequests();
  const sent: { body: unknown; status?: number }[] = [];
  const deps = {
    pairs,
    sendJson: (_r: http.ServerResponse, body: unknown, status?: number) =>
      void sent.push({ body, status }),
    readBody: async () => "",
    signIn,
    client: () => undefined,
    approver: () => null,
    audit: () => {},
  };
  const res = { setHeader: () => {} } as unknown as http.ServerResponse;
  const poll = (id: string) =>
    handlePairRoutes(
      { method: "GET", headers: {} } as unknown as http.IncomingMessage,
      res,
      `/api/signin/code/${id}`,
      deps,
    );
  return { pairs, sent, poll };
}

describe("issue 1299: a refused sign-in keeps the approval", () => {
  it("(1) the poll's sign-in is refused, then the next poll signs in", async () => {
    let busy = true;
    const h = harness(() => {
      if (busy) throw new SessionStoreUnreadable("EBUSY");
      return { cookie: "c=1", approveKey: "k" };
    });
    const r = h.pairs.create({});
    expect(h.pairs.approve(r.code).ok).toBe(true);
    await expect(h.poll(r.id)).rejects.toThrow(SessionStoreUnreadable);
    expect(h.pairs.get(r.id)?.state).toBe("approved");
    busy = false;
    await h.poll(r.id);
    expect(h.sent.at(-1)?.body).toMatchObject({ ok: true, state: "ok" });
    // Spent now: one approval, one session.
    expect(h.pairs.get(r.id)).toBeNull();
  });
});

describe("issue 1299: a refused GitHub sign-in keeps the flow", () => {
  it("(1b) the poll's sign-in is refused, then the next poll signs in", async () => {
    const id = "abcdefghijklmnop0123";
    let spent = false;
    const flows = {
      get: () =>
        spent ? null : { id, purpose: "signin", state: "ok", login: "octo" },
      identity: () => (spent ? null : { id: 1, login: "octo", name: "Octo" }),
      claim: () => {
        if (spent) return null;
        spent = true;
        return { id: 1, login: "octo", name: "Octo" };
      },
    };
    let busy = true;
    const sent: unknown[] = [];
    const deps = {
      flows,
      sendJson: (_r: unknown, body: unknown) => void sent.push(body),
      signIn: () => {
        if (busy) throw new SessionStoreUnreadable("EBUSY");
        return { cookie: "c=1", approveKey: "k" };
      },
    } as unknown as Parameters<typeof handleGithubRoutes>[3];
    const res = { setHeader: () => {} } as unknown as http.ServerResponse;
    const poll = () =>
      handleGithubRoutes(
        { method: "GET", headers: {} } as unknown as http.IncomingMessage,
        res,
        `/api/github/signin/${id}`,
        deps,
      );
    await expect(poll()).rejects.toThrow(SessionStoreUnreadable);
    expect(spent).toBe(false);
    busy = false;
    await poll();
    expect(sent.at(-1)).toMatchObject({ ok: true, state: "ok" });
    expect(spent).toBe(true);
  });
});

describe("issue 1299: mayWriteSessions", () => {
  it("(2) covers every path that can sign in", () => {
    expect(mayWriteSessions("POST", "/api/anything")).toBe(true);
    expect(mayWriteSessions("DELETE", "/api/anything")).toBe(true);
    expect(mayWriteSessions("GET", "/auth")).toBe(true);
    expect(
      mayWriteSessions("GET", "/api/signin/code/abcdefghijklmnop0123"),
    ).toBe(true);
    expect(
      mayWriteSessions("GET", "/api/github/signin/abcdefghijklmnop0123"),
    ).toBe(true);
    expect(mayWriteSessions("GET", "/api/health")).toBe(false);
    expect(mayWriteSessions("HEAD", "/")).toBe(false);
  });

  it("(3) every session start is a known one, under that rule", () => {
    const dir = path.join(process.cwd(), "src/ui/server");
    const calls = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        [
          ...fs
            .readFileSync(path.join(dir, f), "utf-8")
            .matchAll(/\bstartSession\(/g),
        ].map(() => f),
      );
    // The definition, the link and claim sign-ins at /auth (handleAuth,
    // confirmFirstRunLink, handleFixtureAuth, handleAgentViewAuth,
    // handleClaim), and the pairing poll's signIn: a new one fails this
    // count until its route is checked against mayWriteSessions.
    expect(calls.length).toBe(7);
    expect(new Set(calls)).toEqual(new Set(["index.ts"]));
    const src = fs.readFileSync(path.join(dir, "index.ts"), "utf-8");
    expect(src).toMatch(
      /if \(mayWriteSessions\(req\.method, pathname\)\)\s*await webSessions\.whenFree\(/,
    );
  });
});
