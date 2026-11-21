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
      /An agent can't do this/,
    );
  });
  it("not on loopback: refused", () => {
    expect(personCallerRefusal({ ...ok, loopback: false })).toMatch(
      /couldn't check/,
    );
  });
  it("a caller it couldn't place, or whose line it couldn't read: refused", () => {
    expect(personCallerRefusal({ ...ok, line: null })).toMatch(
      /couldn't check/,
    );
  });
  it("records it couldn't read: refused", () => {
    expect(personCallerRefusal({ ...ok, roots: null })).toMatch(
      /couldn't check/,
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
