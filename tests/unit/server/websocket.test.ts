/**
 * Den's WebSocket server side (websocket.ts, AG-4a-term's io): the
 * handshake, framing, and what it refuses, on a bare http server with the
 * tests' own client (helpers/ws-client.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  acceptKey,
  acceptWebSocket,
  handshakeRefusal,
  refuseUpgrade,
  type WsConnection,
} from "../../../src/ui/server/websocket.js";
import { clientFrame, wsConnect, type TestWs } from "./helpers/ws-client.js";

let server: http.Server;
let port = 0;
const conns: WsConnection[] = [];
const got: Array<{ text?: string; bytes?: number; binary: boolean }> = [];

beforeAll(async () => {
  server = http.createServer((_q, r) => r.end());
  server.on("upgrade", (req, socket, head) => {
    const bad = handshakeRefusal(req);
    if (bad) return refuseUpgrade(socket, 400, { error: bad }, "Bad Request");
    const ws = acceptWebSocket(req, socket, head, {
      protocol: "den.io",
      maxMessageBytes: 64 * 1024,
      pingMs: 0,
    });
    conns.push(ws);
    ws.on("message", (d: Buffer, binary: boolean) => {
      got.push(
        binary
          ? { bytes: d.length, binary }
          : { text: d.toString("utf-8"), binary },
      );
      // Echo, so the client sees our framing of every size.
      ws.send(binary ? d : d.toString("utf-8"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const c of conns) c.terminate();
  await new Promise<void>((r) => server.close(() => r()));
});

async function open(headers: Record<string, string> = {}): Promise<TestWs> {
  const r = await wsConnect(port, "/x", headers);
  if (!r.ok) throw new Error(`refused ${r.status}`);
  return r.ws;
}

describe("the handshake", () => {
  it("answers RFC 6455's example key with its accept value", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  it("names the subprotocol only when the client offered it", async () => {
    const a = await open({ "sec-websocket-protocol": "x, den.io" });
    expect(a.headers["sec-websocket-protocol"]).toBe("den.io");
    a.close();
    const b = await open();
    expect(b.headers["sec-websocket-protocol"]).toBeUndefined();
    b.close();
    await Promise.all([a.closed, b.closed]);
  });

  it("refuses another version or a malformed key (400)", async () => {
    for (const h of [
      { "sec-websocket-version": "8" },
      { "sec-websocket-key": "short" },
    ]) {
      const r = await wsConnect(port, "/x", h);
      expect(r.ok ? 101 : r.status).toBe(400);
    }
  });
});

describe("frames", () => {
  it("echoes text, and binary of every length class (7-bit, 16-bit, 64-bit)", async () => {
    const ws = await open();
    ws.sendText("héllo");
    for (const n of [5, 300, 70_000 - 10_000])
      ws.sendBinary(Buffer.alloc(n, 7));
    await ws.until(() => ws.messages.length === 4);
    expect(ws.messages[0]).toEqual({
      binary: false,
      data: Buffer.from("héllo"),
    });
    expect(ws.messages.slice(1).map((m) => m.data.length)).toEqual([
      5, 300, 60_000,
    ]);
    ws.close();
    expect(await ws.closed).toBe(1000);
  });

  it("answers a ping with a pong carrying its payload", async () => {
    const ws = await open();
    ws.raw(clientFrame(0x9, Buffer.from("are you there")));
    ws.sendText("after");
    await ws.until(() => ws.messages.length === 1 && ws.pongs.length === 1);
    expect(ws.pongs[0].toString()).toBe("are you there");
    expect(ws.messages[0].data.toString()).toBe("after");
    ws.close();
    await ws.closed;
  });

  it("closes 1009 on a message over the limit, fragmented or not", async () => {
    const a = await open();
    a.sendBinary(Buffer.alloc(64 * 1024 + 1));
    expect(await a.closed).toBe(1009);
    const b = await open();
    b.raw(clientFrame(0x2, Buffer.alloc(40 * 1024), false));
    b.raw(clientFrame(0x0, Buffer.alloc(40 * 1024), true));
    expect(await b.closed).toBe(1009);
  });

  it("closes 1002 on a protocol error: unmasked, a reserved bit, a long or fragmented control frame, a stray continuation, an unknown opcode", async () => {
    const bad = [
      Buffer.from([0x81, 0x01, 0x61]), // unmasked
      (() => {
        const f = clientFrame(0x1, Buffer.from("a"));
        f[0] |= 0x40;
        return f;
      })(),
      clientFrame(0x9, Buffer.alloc(126)),
      clientFrame(0x9, Buffer.from("x"), false),
      clientFrame(0x0, Buffer.from("x")),
      clientFrame(0x3, Buffer.from("x")),
    ];
    for (const f of bad) {
      const ws = await open();
      ws.raw(f);
      expect(await ws.closed).toBe(1002);
    }
  });
});
