/**
 * #257: Den's web server closed an idle kept-alive connection after 5 s
 * (Node's default), the same as the page's poll. A client reusing it just
 * then got a reset (seen in CI: `route.fetch: read ECONNRESET`). With
 * applyKeepAlive at web.keep_alive_seconds (default 120), a connection
 * idle past 5 s is still open and is reused. Also: the setting's checks.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import * as ka from "../../../src/ui/server/keep-alive.js";
import {
  readWebKeepAliveSeconds,
  WEB_KEEP_ALIVE_SECONDS_DEFAULT,
} from "../../../src/shared/den-config.js";

let server: http.Server | null = null;
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
afterEach(async () => {
  agent.destroy();
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = null;
});

/** The local port of the socket that carried a GET (same port: reused). */
const get = (port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.get(
      { port, host: "127.0.0.1", agent, path: "/" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(req.socket?.localPort ?? -1));
      },
    );
    req.on("error", reject);
  });

describe("#257: idle connections outlive the page's 5 s poll", () => {
  it("a connection idle for 6 s is still open and is reused", async () => {
    server = http.createServer((_q, r) => r.end("ok"));
    (
      ka as { applyKeepAlive?: (s: http.Server, n: number) => void }
    ).applyKeepAlive?.(server, WEB_KEEP_ALIVE_SECONDS_DEFAULT);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const first = await get(port);
    await new Promise((r) => setTimeout(r, 6_000));
    expect(await get(port)).toBe(first);
  }, 20_000);

  it("web.keep_alive_seconds: 120 by default; seconds 1 to 3600; a bad one names the key", () => {
    expect(readWebKeepAliveSeconds({})).toBe(120);
    expect(readWebKeepAliveSeconds({ web: { keep_alive_seconds: 30 } })).toBe(
      30,
    );
    for (const bad of [0, 4000, "60"])
      expect(() =>
        readWebKeepAliveSeconds({
          web: { keep_alive_seconds: bad as number },
        }),
      ).toThrow(/web\.keep_alive_seconds/);
  });
});
