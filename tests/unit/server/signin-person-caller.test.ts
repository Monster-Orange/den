/**
 * Sign-in: the server's own check of the CLI's calls that register a
 * sign-in link or let a browser in. The caller is placed on loopback and
 * its whole line of parents must hold no running session's root; a caller
 * it can't place, a line it can't read, or records it can't read refuse.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import type { Socket } from "net";
import {
  callerLine,
  forwardedRequest,
  personCallerRefusal,
  watchPeer,
} from "../../../src/ui/server/token-binding.js";

describe("personCallerRefusal", () => {
  const ok = { loopback: true, line: [500, 400, 1], roots: [300] };
  it("a caller outside every session: allowed", () => {
    expect(personCallerRefusal(ok)).toBeNull();
  });
  it("a caller inside a running session's tree: refused", () => {
    expect(personCallerRefusal({ ...ok, roots: [400] })).toMatch(
      /Terminals page/,
    );
  });
  it("not on loopback: refused", () => {
    expect(personCallerRefusal({ ...ok, loopback: false })).toMatch(
      /over localhost/,
    );
  });
  it("a caller it couldn't place, or whose line it couldn't read: refused", () => {
    expect(personCallerRefusal({ ...ok, line: null })).toMatch(
      /can't let a browser in from here/,
    );
  });
  it("records it couldn't read: refused", () => {
    expect(personCallerRefusal({ ...ok, roots: null })).toMatch(
      /can't let a browser in from here/,
    );
  });
});

describe("callerLine", () => {
  function req(port: number): http.IncomingMessage {
    const sock = {
      remoteAddress: "127.0.0.1",
      remotePort: port,
      localPort: 4100,
      once: () => undefined,
    } as unknown as Socket;
    return { socket: sock } as unknown as http.IncomingMessage;
  }
  it("the placed caller's line, read whole", async () => {
    const r = req(50001);
    watchPeer(r.socket, { peer: () => 500 });
    expect(
      callerLine(r, { line: (p) => (p === 500 ? [500, 400, 1] : null) }),
    ).toEqual([500, 400, 1]);
  });
  it("a caller not placed: null", () => {
    const r = req(50002);
    watchPeer(r.socket, { peer: () => null });
    expect(callerLine(r, { line: () => [1] })).toBeNull();
  });
  it("a line that can't be read: null", () => {
    const r = req(50003);
    watchPeer(r.socket, { peer: () => 500 });
    expect(callerLine(r, { line: () => null })).toBeNull();
  });
});

describe("Sign-in: each server refusal says what to do instead", () => {
  const ok = { loopback: true, line: [500, 400, 1], roots: [300] };
  it("not on loopback (an install on its LAN address only): --no-wait, or Settings › Access", () => {
    const t = personCallerRefusal({ ...ok, loopback: false });
    expect(t).toMatch(/--no-wait/);
    expect(t).toMatch(/Settings › Access/);
  });
  it("inside a running session: your own terminal, or Settings › Access", () => {
    const t = personCallerRefusal({ ...ok, roots: [400] });
    expect(t).toMatch(/your own terminal/);
    expect(t).toMatch(/Settings › Access/);
  });
  it("couldn't place the caller: your own terminal, or Settings › Access", () => {
    const t = personCallerRefusal({ ...ok, line: null });
    expect(t).toMatch(/your own terminal/);
    expect(t).toMatch(/Settings › Access/);
  });
  it("a request that came through the edge: refused, with what to do instead", () => {
    const t = personCallerRefusal({ ...ok, forwarded: true });
    expect(t).toMatch(/over localhost/);
    expect(t).toMatch(/Settings › Access/);
  });
});

describe("forwardedRequest", () => {
  const ctx = {
    port: 4100,
    loopbackNames: ["localhost", "127.0.0.1"],
    edgeHosts: () => ["den.acme.example.com"],
    lanHosts: () => [],
  };
  const r = (headers: Record<string, string>) =>
    ({ headers }) as unknown as http.IncomingMessage;
  it("localhost with no forwarding headers: not forwarded", () => {
    expect(forwardedRequest(r({ host: "localhost:4100" }), ctx)).toBe(false);
  });
  it.each([
    [{ host: "den.acme.example.com" }],
    [{ host: "localhost:4100", "x-forwarded-for": "10.0.0.2" }],
    [{ host: "localhost:4100", forwarded: "for=10.0.0.2" }],
    [{ host: "localhost:4100", "x-forwarded-host": "den.acme.example.com" }],
    [{}],
  ])("%j: forwarded (or can't tell)", (h) => {
    expect(forwardedRequest(r(h), ctx)).toBe(true);
  });
});
