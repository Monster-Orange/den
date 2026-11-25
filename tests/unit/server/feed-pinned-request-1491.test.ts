/**
 * Issue 1491: a public-only feed's request goes to exactly the address
 * Den resolved and checked for that connect, never to a second lookup's
 * answer (DNS rebinding). pinnedFetch opens the socket to the checked
 * address and keeps the feed's name for TLS (servername) and the Host
 * header. A redirect is never followed, so the bearer never reaches a
 * second address.
 *
 * Real local servers on 127.0.0.1, reached by a name that doesn't resolve
 * (feed.example.test): an answer proves the socket used the pinned
 * address. The TLS case makes a throwaway certificate for that name with
 * openssl. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pinnedFetch } from "../../../src/ui/server/feed-pinned-request";

const NAME = "feed.example.test";
const servers: (http.Server | https.Server)[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

interface Seen {
  host?: string;
  auth?: string;
  servername?: string | false;
  path?: string;
}

async function listen(s: http.Server | https.Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

function handler(seen: Seen[], answer: (res: http.ServerResponse) => void) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    seen.push({
      host: req.headers.host,
      auth: req.headers.authorization,
      servername: (req.socket as { servername?: string | false }).servername,
      path: req.url,
    });
    answer(res);
  };
}

const ok = (res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end("id: e1\ndata: {}\n\n");
};

describe("issue 1491: pinnedFetch connects to the checked address", () => {
  it("over http: the socket goes to the pinned address, and Host is the feed's name", async () => {
    const seen: Seen[] = [];
    const port = await listen(http.createServer(handler(seen, ok)));
    const res = await pinnedFetch(`http://${NAME}:${port}/events`, {
      headers: { Accept: "text/event-stream" },
      address: "127.0.0.1",
      family: 4,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toContain("id: e1");
    expect(seen).toEqual([
      {
        host: `${NAME}:${port}`,
        auth: undefined,
        servername: undefined,
        path: "/events",
      },
    ]);
  });

  it("over https: TLS checks the certificate against the feed's name (servername), not the address", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1491-tls-"));
    dirs.push(d);
    const key = path.join(d, "key.pem");
    const cert = path.join(d, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        `/CN=${NAME}`,
        "-addext",
        `subjectAltName=DNS:${NAME}`,
      ],
      { stdio: "ignore" },
    );
    const ca = fs.readFileSync(cert);
    const seen: Seen[] = [];
    const port = await listen(
      https.createServer(
        { key: fs.readFileSync(key), cert: ca },
        handler(seen, ok),
      ),
    );
    const res = await pinnedFetch(`https://${NAME}:${port}/events`, {
      headers: { Authorization: "Bearer one-value" },
      address: "127.0.0.1",
      family: 4,
      ca,
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(seen).toEqual([
      {
        host: `${NAME}:${port}`,
        auth: "Bearer one-value",
        servername: NAME,
        path: "/events",
      },
    ]);
    // A certificate for another name is refused: the address alone never passes.
    await expect(
      pinnedFetch(`https://other.example.test:${port}/events`, {
        headers: {},
        address: "127.0.0.1",
        family: 4,
        ca,
      }),
    ).rejects.toThrow();
  });

  it("a redirect is refused, and the bearer never goes to the second address", async () => {
    const second: Seen[] = [];
    const port2 = await listen(http.createServer(handler(second, ok)));
    const first: Seen[] = [];
    const port1 = await listen(
      http.createServer(
        handler(first, (res) => {
          res.writeHead(302, { location: `http://127.0.0.1:${port2}/events` });
          res.end();
        }),
      ),
    );
    await expect(
      pinnedFetch(`http://${NAME}:${port1}/events`, {
        headers: { Authorization: "Bearer one-value" },
        address: "127.0.0.1",
        family: 4,
      }),
    ).rejects.toMatchObject({ redirect: true });
    expect(first.map((x) => x.auth)).toEqual(["Bearer one-value"]);
    expect(second).toEqual([]);
  });

  it("an aborted signal rejects with the signal's reason (a timeout stays a TimeoutError)", async () => {
    const seen: Seen[] = [];
    const port = await listen(
      http.createServer(handler(seen, () => undefined)),
    );
    await expect(
      pinnedFetch(`http://${NAME}:${port}/events`, {
        headers: {},
        address: "127.0.0.1",
        family: 4,
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
