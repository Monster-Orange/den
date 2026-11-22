/**
 * Issue 625 follow-up: a box set with only a Playwright address is checked
 * by a WebSocket upgrade, not a bare TCP connect. A relay or port forward
 * in front of a dead server still accepts TCP; only "101 Switching
 * Protocols" counts as open. The check closes at once, within the box
 * check timeout. Stub servers on 127.0.0.1 stand in for the box.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import { createHash } from "crypto";
import * as net from "net";
import { sftpProbe } from "../../../src/shared/gates/boxes.js";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
});

/** A stub box: `answer` gets the request text and writes what it likes. */
async function stub(
  answer: (req: string, sock: net.Socket) => void,
): Promise<{ port: number; requests: string[]; closed: () => boolean }> {
  const requests: string[] = [];
  let closed = false;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf-8");
      if (!buf.includes("\r\n\r\n")) return;
      requests.push(buf);
      answer(buf, sock);
    });
    sock.on("close", () => (closed = true));
    sock.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    requests,
    closed: () => closed,
  };
}

const probe = sftpProbe(spawn);
const box = (port: number, p = "/pw") => ({
  name: "box1",
  browser_slots: 1,
  playwright: `ws://127.0.0.1:${port}${p}`,
});

describe("a Playwright-only box is checked by a WebSocket upgrade", () => {
  it("a server that accepts TCP but never upgrades is unreachable, within the timeout", async () => {
    const s = await stub(() => {
      /* a relay with nothing behind it: silence */
    });
    const t0 = Date.now();
    const r = await probe(box(s.port), 400);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.state).toBe("unreachable");
    expect(r.reason).toMatch(/no websocket upgrade/i);
  });

  it("an HTTP answer other than 101 is unreachable, saying what came back", async () => {
    const s = await stub((_req, sock) =>
      sock.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"),
    );
    const r = await probe(box(s.port), 2000);
    expect(r.state).toBe("unreachable");
    expect(r.reason).toMatch(/502/);
  });

  it("101 Switching Protocols is open; the request is a websocket upgrade to its path, closed at once", async () => {
    const s = await stub((req, sock) => {
      const key = /sec-websocket-key:\s*(\S+)/i.exec(req)?.[1] ?? "";
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    const r = await probe(box(s.port, "/pw?x=1"), 2000);
    expect(r.state).toBe("open");
    const req = s.requests[0]!;
    expect(req).toMatch(/^GET \/pw\?x=1 HTTP\/1\.1\r\n/);
    expect(req).toMatch(/\r\nupgrade: websocket\r\n/i);
    expect(req).toMatch(/\r\nconnection: upgrade\r\n/i);
    expect(req).toMatch(/\r\nsec-websocket-version: 13\r\n/i);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.closed()).toBe(true);
  });

  it("a refused connection is unreachable", async () => {
    const s = await stub(() => {});
    const port = s.port;
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    const r = await probe(box(port), 1000);
    expect(r.state).toBe("unreachable");
  });
});
