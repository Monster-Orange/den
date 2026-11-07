/**
 * `web up`'s readiness probe asks the address the server is bound to
 * (DEN_BIND_HOST), not always 127.0.0.1: a server bound to one specific
 * address (a LAN IP with web.allow_plain_http_remote, or ::1) doesn't
 * answer on 127.0.0.1, and `web up` said "did not become ready" and exited
 * non-zero while it served. 0.0.0.0 and :: still answer on loopback. The
 * Host header names the probed address, which the Host allowlist accepts.
 *
 * A stub server stands in for Den (server-info and the shell's marker); it
 * listens on ::1 and, when this machine has one, a LAN IPv4 address.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";

jest.mock("../../../src/shared/edge/config.js", () => ({
  readWebPort: () => 41237,
}));
import {
  isDenWebRunning,
  webProbeTarget,
  webUpUrl,
} from "../../../src/ui/cli/web-command.js";
import { addDenUiMarker } from "../../../src/shared/ui-marker.js";

describe("webProbeTarget: where the probe connects, and its Host", () => {
  it.each([
    [undefined, "127.0.0.1", "127.0.0.1:4000"],
    ["", "127.0.0.1", "127.0.0.1:4000"],
    ["127.0.0.1", "127.0.0.1", "127.0.0.1:4000"],
    ["0.0.0.0", "127.0.0.1", "127.0.0.1:4000"],
    ["::", "127.0.0.1", "127.0.0.1:4000"],
    ["[::]", "127.0.0.1", "127.0.0.1:4000"],
    ["192.168.1.122", "192.168.1.122", "192.168.1.122:4000"],
    ["::1", "::1", "[::1]:4000"],
    ["2001:db8::5", "2001:db8::5", "[2001:db8::5]:4000"],
    ["[2001:DB8::5]", "2001:db8::5", "[2001:db8::5]:4000"],
  ])("DEN_BIND_HOST=%p: %s, Host %s", (bind, host, hostHeader) => {
    expect(webProbeTarget(bind, 4000)).toEqual({ host, hostHeader });
  });
});

describe("isDenWebRunning against a server bound to one address", () => {
  const saved = process.env.DEN_BIND_HOST;
  let server: http.Server | null = null;
  afterEach(async () => {
    if (saved === undefined) delete process.env.DEN_BIND_HOST;
    else process.env.DEN_BIND_HOST = saved;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  /** A stub Den on `addr`: the Host headers it saw, or null if it can't bind. */
  async function stub(addr: string): Promise<{
    port: number;
    hosts: string[];
  } | null> {
    const hosts: string[] = [];
    const s = http.createServer((req, res) => {
      hosts.push(String(req.headers.host));
      res.setHeader("connection", "close");
      if (req.url === "/api/server-info") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ pid: process.pid }));
      } else if (req.url === "/index.html") {
        res.setHeader("content-type", "text/html");
        res.end(addDenUiMarker("<html><head></head><body></body></html>"));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    const ok = await new Promise<boolean>((resolve) => {
      s.once("error", () => resolve(false));
      s.listen(0, addr, () => resolve(true));
    });
    if (!ok) return null;
    server = s;
    return { port: (s.address() as AddressInfo).port, hosts };
  }

  const lanV4 = Object.values(os.networkInterfaces())
    .flatMap((l) => l ?? [])
    .find((a) => a.family === "IPv4" && !a.internal)?.address;

  it.each([["::1", "[::1]"], ...(lanV4 ? [[lanV4, lanV4]] : [])])(
    "DEN_BIND_HOST=%s: ready, asked with Host %s:<port>",
    async (addr, name) => {
      const s = await stub(addr);
      if (!s) return; // no such address here (an IPv6-less runner)
      process.env.DEN_BIND_HOST = addr;
      expect(await isDenWebRunning(s.port)).toBe(true);
      expect(s.hosts.length).toBeGreaterThan(0);
      expect([...new Set(s.hosts)]).toEqual([`${name}:${s.port}`]);
    },
  );
});

describe("webUpUrl: the address `web up` names", () => {
  const hosts = "127.0.0.1 den\n";
  it.each([
    [undefined, "http://den:4000"],
    ["0.0.0.0", "http://den:4000"],
    ["::", "http://den:4000"],
    ["127.0.0.1", "http://den:4000"],
    ["::1", "http://den:4000"],
    ["192.168.1.122", "http://192.168.1.122:4000"],
    ["2001:db8::5", "http://[2001:db8::5]:4000"],
  ])("DEN_BIND_HOST=%p: %s", (bind, url) => {
    expect(webUpUrl(4000, bind, hosts)).toBe(url);
  });
});
