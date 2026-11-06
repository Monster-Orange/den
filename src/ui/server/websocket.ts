/**
 * A small WebSocket server side (RFC 6455), for the one route that needs
 * one: a session's terminal io (`/api/sessions/<id>/io`, AG-4a-term). Den
 * has no `ws` dependency and needs very little of one: a handshake on the
 * http server's `upgrade` event, then masked client frames in and unmasked
 * frames out. Nothing here knows about sessions or credentials: the
 * request checks (request-guard.ts) ran before acceptWebSocket is called.
 *
 * What it takes, and what it refuses:
 *  - version 13 only; a key that is 16 bytes of base64;
 *  - text, binary, continuation (a fragmented message is reassembled),
 *    ping (answered with pong), pong, close (answered, then the socket
 *    ends);
 *  - a client frame that isn't masked: close 1002; a control frame over
 *    125 bytes or fragmented: 1002; a reserved bit or opcode: 1002;
 *  - a message over `maxMessageBytes` (default 1 MiB): 1009;
 *  - a peer that stops reading (more than `maxBacklogBytes` queued): the
 *    socket is destroyed, as the session host drops a slow client.
 * A ping goes out every `pingMs` (default 30 s); a peer that hasn't answered
 * the last one by the next is gone, and the socket is destroyed.
 */
import { createHash } from "crypto";
import { EventEmitter } from "events";
import type * as http from "http";
import type { Duplex } from "stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const KEY_RE = /^[A-Za-z0-9+/]{22}==$/;

export const WS_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocol: 1002,
  tooBig: 1009,
  internal: 1011,
} as const;

/** The Sec-WebSocket-Accept value for a client's key. */
export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

/** The subprotocols a client offered (Sec-WebSocket-Protocol), in order. */
export function offeredProtocols(req: http.IncomingMessage): string[] {
  const raw = req.headers["sec-websocket-protocol"];
  const v = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Why an upgrade request is not a WebSocket handshake Den takes, or null. */
export function handshakeRefusal(req: http.IncomingMessage): string | null {
  if ((req.method ?? "GET").toUpperCase() !== "GET")
    return "a WebSocket handshake is a GET";
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket") return "only a WebSocket upgrade is served";
  if (String(req.headers["sec-websocket-version"] ?? "") !== "13")
    return "WebSocket version 13 only";
  const key = String(req.headers["sec-websocket-key"] ?? "");
  if (!KEY_RE.test(key) || Buffer.from(key, "base64").length !== 16)
    return "a WebSocket key is 16 bytes, base64";
  return null;
}

export interface WebSocketOptions {
  /** The subprotocol to answer with (it must be one the client offered). */
  protocol?: string;
  maxMessageBytes?: number;
  maxBacklogBytes?: number;
  /** 0: never ping. */
  pingMs?: number;
}

/**
 * One accepted connection. Events: `message` (data: Buffer, binary:
 * boolean), `close` (code: number, reason: string), once, whoever closed.
 */
export class WsConnection extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partBytes = 0;
  private partBinary = false;
  private closing = false;
  private closed = false;
  private awaitingPong = false;
  private readonly pinger: NodeJS.Timeout | null;
  private readonly maxMessage: number;
  private readonly maxBacklog: number;

  constructor(
    private readonly socket: Duplex,
    head: Buffer,
    o: WebSocketOptions = {},
  ) {
    super();
    this.maxMessage = o.maxMessageBytes ?? 1024 * 1024;
    this.maxBacklog = o.maxBacklogBytes ?? 8 * 1024 * 1024;
    socket.on("data", (c: Buffer) => this.onData(c));
    socket.on("error", () => undefined);
    socket.on("close", () => this.finish(1006, ""));
    const ping = o.pingMs ?? 30_000;
    this.pinger =
      ping > 0
        ? setInterval(() => {
            if (this.awaitingPong) {
              this.socket.destroy();
              return;
            }
            this.awaitingPong = true;
            this.frame(0x9, Buffer.alloc(0));
          }, ping)
        : null;
    this.pinger?.unref();
    if (head.length) this.onData(head);
  }

  /** Whether frames can still be sent. */
  get open(): boolean {
    return !this.closing && !this.closed;
  }

  send(data: Buffer | string): void {
    if (!this.open) return;
    if (typeof data === "string") this.frame(0x1, Buffer.from(data, "utf-8"));
    else this.frame(0x2, data);
  }

  /** Start the closing handshake; the socket ends once the peer answers. */
  close(code: number = WS_CLOSE.normal, reason = ""): void {
    if (this.closing || this.closed) return;
    this.closing = true;
    const r = Buffer.from(reason.slice(0, 120), "utf-8");
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.frame(0x8, body);
    // A peer that never answers the close is let go of anyway.
    const t = setTimeout(() => this.socket.destroy(), 2000);
    t.unref();
    this.finish(code, reason);
  }

  /** Drop the connection without a closing handshake. */
  terminate(): void {
    this.socket.destroy();
    this.finish(1006, "");
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.emit("close", code, reason);
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const n = payload.length;
    const head =
      n < 126
        ? Buffer.from([0x80 | opcode, n])
        : n < 65536
          ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
          : (() => {
              const h = Buffer.alloc(10);
              h[0] = 0x80 | opcode;
              h[1] = 127;
              h.writeBigUInt64BE(BigInt(n), 2);
              return h;
            })();
    this.socket.write(Buffer.concat([head, payload]));
    if (this.socket.writableLength > this.maxBacklog) this.socket.destroy();
  }

  private fail(code: number, reason: string): void {
    this.close(code, reason);
    this.buf = Buffer.alloc(0);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.closed && !this.closing) return;
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) return this.fail(WS_CLOSE.protocol, "reserved bits set");
      if (!(b1 & 0x80))
        return this.fail(WS_CLOSE.protocol, "client frames must be masked");
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage))
          return this.fail(WS_CLOSE.tooBig, "message too big");
        len = Number(big);
        off = 10;
      }
      const control = opcode >= 0x8;
      if (control && (len > 125 || !fin))
        return this.fail(WS_CLOSE.protocol, "bad control frame");
      if (len > this.maxMessage)
        return this.fail(WS_CLOSE.tooBig, "message too big");
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (!this.handle(fin, opcode, payload)) return;
    }
  }

  /** One frame; false once the connection is done with. */
  private handle(fin: boolean, opcode: number, payload: Buffer): boolean {
    switch (opcode) {
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.closing) {
          this.closing = true;
          this.frame(0x8, payload.subarray(0, 2));
        }
        this.socket.end();
        this.finish(code, payload.subarray(2).toString("utf-8"));
        return false;
      }
      case 0x9:
        if (this.open) this.frame(0xa, payload);
        return true;
      case 0xa:
        this.awaitingPong = false;
        return true;
      case 0x1:
      case 0x2:
        if (this.parts.length) {
          this.fail(WS_CLOSE.protocol, "a new message inside a fragmented one");
          return false;
        }
        this.partBinary = opcode === 0x2;
        return this.part(fin, payload);
      case 0x0:
        if (!this.parts.length) {
          this.fail(
            WS_CLOSE.protocol,
            "a continuation with nothing to continue",
          );
          return false;
        }
        return this.part(fin, payload);
      default:
        this.fail(WS_CLOSE.protocol, "unknown opcode");
        return false;
    }
  }

  private part(fin: boolean, payload: Buffer): boolean {
    this.partBytes += payload.length;
    if (this.partBytes > this.maxMessage) {
      this.fail(WS_CLOSE.tooBig, "message too big");
      return false;
    }
    this.parts.push(payload);
    if (!fin) return true;
    const msg =
      this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
    this.parts = [];
    this.partBytes = 0;
    if (this.open) this.emit("message", msg, this.partBinary);
    return true;
  }
}

/**
 * Answer the handshake (101) and return the connection. The caller checked
 * handshakeRefusal and the request checks first.
 */
export function acceptWebSocket(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  o: WebSocketOptions = {},
): WsConnection {
  const key = String(req.headers["sec-websocket-key"]);
  const protocol =
    o.protocol && offeredProtocols(req).includes(o.protocol)
      ? o.protocol
      : null;
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : "") +
      "\r\n",
  );
  (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
  return new WsConnection(socket, head, o);
}

/** An http answer on an upgrade's raw socket (a refusal), then the end. */
export function refuseUpgrade(
  socket: Duplex,
  status: number,
  body: Record<string, unknown>,
  statusText: string,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Content-Type: application/json\r\nConnection: close\r\n" +
      Object.entries(extraHeaders)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("") +
      `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
  );
}
