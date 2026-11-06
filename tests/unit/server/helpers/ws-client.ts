/**
 * A minimal WebSocket client for tests (RFC 6455, client side): the
 * handshake over http.request's `upgrade`, masked frames out, frames in.
 * A test sets every header itself (Host, Origin, Authorization, the
 * subprotocols), which a browser's WebSocket never lets a page do, so the
 * request checks can be shown refusing each one. Never prints a header.
 */
import { randomBytes } from "crypto";
import * as http from "http";
import type { Duplex } from "stream";

export interface WsMessage {
  binary: boolean;
  data: Buffer;
}

export interface TestWs {
  /** The 101's headers. */
  headers: http.IncomingHttpHeaders;
  messages: WsMessage[];
  /** The payloads of the pongs received. */
  pongs: Buffer[];
  /** Every binary frame so far, as text. */
  output(): string;
  /** The text frames so far, parsed. */
  controls(): Record<string, unknown>[];
  sendBinary(data: Buffer | string): void;
  sendText(text: string): void;
  /** Send raw bytes (a malformed frame). */
  raw(bytes: Buffer): void;
  close(code?: number): void;
  /** Drop the socket with no closing handshake. */
  destroy(): void;
  /** Resolves with the close code once the socket ends. */
  closed: Promise<number>;
  /** Wait until `pred` holds over what arrived (or time out). */
  until(pred: () => boolean, ms?: number): Promise<void>;
}

export type UpgradeResult =
  | { ok: true; ws: TestWs }
  | { ok: false; status: number; body: Record<string, unknown> };

/** A masked frame, as a client sends it. */
export function clientFrame(
  opcode: number,
  payload: Buffer,
  fin = true,
): Buffer {
  const mask = randomBytes(4);
  const n = payload.length;
  const len =
    n < 126
      ? Buffer.from([0x80 | n])
      : n < 65536
        ? Buffer.from([0x80 | 126, n >> 8, n & 0xff])
        : (() => {
            const b = Buffer.alloc(9);
            b[0] = 0x80 | 127;
            b.writeBigUInt64BE(BigInt(n), 1);
            return b;
          })();
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0) | opcode]),
    len,
    mask,
    body,
  ]);
}

function wrap(
  socket: Duplex,
  head: Buffer,
  headers: http.IncomingHttpHeaders,
): TestWs {
  const messages: WsMessage[] = [];
  const pongs: Buffer[] = [];
  let buf = head;
  let parts: Buffer[] = [];
  let partBinary = false;
  let closeCode = 1006;
  let resolveClosed!: (c: number) => void;
  const closed = new Promise<number>((r) => (resolveClosed = r));
  const waiters = new Set<() => void>();
  const poke = () => {
    for (const w of [...waiters]) w();
  };
  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (op === 0x8) {
        closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        try {
          socket.write(clientFrame(0x8, payload.subarray(0, 2)));
        } catch {
          /* gone */
        }
        socket.end();
      } else if (op === 0x9) socket.write(clientFrame(0xa, payload));
      else if (op === 0xa) pongs.push(payload);
      else if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) partBinary = op === 0x2;
        parts.push(payload);
        if (fin) {
          messages.push({ binary: partBinary, data: Buffer.concat(parts) });
          parts = [];
        }
      }
    }
  };
  socket.on("data", (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    parse();
    poke();
  });
  socket.on("error", () => undefined);
  socket.on("close", () => {
    resolveClosed(closeCode);
    poke();
  });
  if (buf.length) parse();
  return {
    headers,
    messages,
    pongs,
    output: () =>
      Buffer.concat(
        messages.filter((m) => m.binary).map((m) => m.data),
      ).toString("utf-8"),
    controls: () =>
      messages
        .filter((m) => !m.binary)
        .map(
          (m) =>
            JSON.parse(m.data.toString("utf-8")) as Record<string, unknown>,
        ),
    sendBinary: (d) =>
      void socket.write(
        clientFrame(0x2, Buffer.isBuffer(d) ? d : Buffer.from(d)),
      ),
    sendText: (t) => void socket.write(clientFrame(0x1, Buffer.from(t))),
    raw: (b) => void socket.write(b),
    close: (code = 1000) => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code, 0);
      socket.write(clientFrame(0x8, b));
    },
    destroy: () => void socket.destroy(),
    closed,
    until(pred, ms = 5000) {
      return new Promise<void>((resolve, reject) => {
        if (pred()) return resolve();
        const t = setTimeout(() => {
          waiters.delete(check);
          reject(new Error("timed out waiting on the socket"));
        }, ms);
        const check = () => {
          if (!pred()) return;
          clearTimeout(t);
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
      });
    },
  };
}

/** Open a WebSocket to `path` on localhost:`port` with exactly `headers`. */
export function wsConnect(
  port: number,
  p: string,
  headers: Record<string, string> = {},
): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "localhost",
      port,
      path: p,
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("response", (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString()));
      res.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
        resolve({ ok: false, status: res.statusCode ?? 0, body });
      });
    });
    req.on("upgrade", (res, socket, head) =>
      resolve({ ok: true, ws: wrap(socket, head, res.headers) }),
    );
    req.on("error", reject);
    req.end();
  });
}
