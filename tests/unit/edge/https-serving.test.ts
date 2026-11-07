/**
 * MCP-2.5: `edge_status.certIssued` read `false` while HTTPS worked: under
 * `tls: files` the distribution supplies the cert, so Den never minted one.
 * It is renamed `certIssuedByDen` (the old name kept for one release, with
 * a deprecation note), and `https` says the TLS strategy, who supplies the
 * cert and whether HTTPS is actually serving (a TLS handshake on the
 * edge's https port). /api/edge serves the probed status.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as tls from "tls";
import type { AddressInfo } from "net";
import {
  CERT_ISSUED_DEPRECATION,
  edgeStatus,
  tlsHandshake,
  withHttpsServing,
  type EdgeStatusDeps,
} from "../../../src/shared/edge/status.js";
import { handleReadonlyRoutes } from "../../../src/ui/server/readonly-routes.js";
import { defaultReadonlyRouteDeps } from "../../../src/ui/server/readonly-routes.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const edge: EdgeConfig = {
  org: "acme",
  domain: "acme.localhost",
  aliases: [],
  image: "traefik:v3",
  workspaces: [],
  routes: { web: "http://localhost:3000" },
  ports: { http: 80, https: 443 },
  stateDir: "/nonexistent/edge-state",
  tls: { strategy: "files", ca: null },
  tlsFrom: "explicit",
  httpsRedirect: true,
  dockerLabels: null,
  include: null,
  mounts: {},
  networks: [],
  args: [],
};

const running: EdgeStatusDeps = {
  containerState: () => "running",
  caTrusted: () => null,
  issuedNames: () => null,
  included: () => ({ routers: [], errors: [] }),
  stacks: () => ({ routers: [], errors: [] }),
};

describe("certIssued is explained (tls: files)", () => {
  it("certIssuedByDen false, the cert the distribution's, and the old name deprecated", () => {
    const st = edgeStatus(edge, running);
    expect(st.certIssuedByDen).toBe(false);
    expect(st.certIssued).toBe(false);
    expect(st.https).toEqual({
      strategy: "files",
      certs: "distribution",
      serving: null,
      detail: "not probed",
    });
    expect(st.deprecated).toEqual({ certIssued: CERT_ISSUED_DEPRECATION });
    expect(CERT_ISSUED_DEPRECATION).toMatch(/renamed certIssuedByDen/);
  });

  it("serving comes from a handshake on the published https port", async () => {
    const seen: unknown[] = [];
    const st = await withHttpsServing(
      edgeStatus(edge, running),
      edge,
      async (o) => {
        seen.push(o);
        return { ok: true };
      },
    );
    expect(seen).toEqual([
      {
        host: "127.0.0.1",
        port: 443,
        servername: "web.acme.localhost",
        timeoutMs: 1500,
      },
    ]);
    expect(st.https.serving).toBe(true);
    expect(st.https.detail).toBe(
      "TLS handshake answered on 127.0.0.1:443 (web.acme.localhost)",
    );
  });

  it("not serving: the handshake failed, or the container is down", async () => {
    const failed = await withHttpsServing(
      edgeStatus(edge, running),
      edge,
      async () => ({ ok: false, error: "ECONNREFUSED" }),
    );
    expect(failed.https).toMatchObject({
      serving: false,
      detail: "no TLS on 127.0.0.1:443 (web.acme.localhost): ECONNREFUSED",
    });
    let asked = false;
    const down = await withHttpsServing(
      edgeStatus(edge, { ...running, containerState: () => "exited" }),
      edge,
      async () => ((asked = true), { ok: true }),
    );
    expect(asked).toBe(false);
    expect(down.https).toMatchObject({
      serving: false,
      detail: "the edge container is exited",
    });
  });

  it("a proxy in front owns the ports: not probed, serving null", async () => {
    const st = await withHttpsServing(
      edgeStatus({ ...edge, ports: null }, running),
      { ...edge, ports: null },
      async () => ({ ok: true }),
    );
    expect(st.https.serving).toBeNull();
    expect(st.https.detail).toMatch(/proxy in front/);
  });

  it("tls: none serves no https, and says so without a probe", async () => {
    const cfg: EdgeConfig = { ...edge, tls: { strategy: "none" } };
    const st = await withHttpsServing(edgeStatus(cfg, running), cfg);
    expect(st.https).toEqual({
      strategy: "none",
      certs: "none",
      serving: false,
      detail: "tls: none: the edge serves http only",
    });
  });
});

describe("tlsHandshake (real sockets)", () => {
  let dir: string;
  let tlsServer: tls.Server;
  let tcpServer: net.Server;
  let tlsPort = 0;
  let tcpPort = 0;
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-https-"));
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
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
        "-subj",
        "/CN=web.acme.localhost",
      ],
      { stdio: "ignore" },
    );
    tlsServer = tls.createServer(
      {
        key: fs.readFileSync(path.join(dir, "key.pem")),
        cert: fs.readFileSync(path.join(dir, "cert.pem")),
      },
      (s) => s.end(),
    );
    // Speaks plain text, not TLS: an http-only listener on the https port.
    tcpServer = net.createServer((s) =>
      s.end("HTTP/1.1 400 Bad Request\r\n\r\n"),
    );
    // Every accepted socket is destroyed at the end, whatever state it is in.
    for (const srv of [tlsServer, tcpServer])
      srv.on("connection", (sock: net.Socket) => sockets.add(sock));
    await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => tcpServer.listen(0, "127.0.0.1", r));
    tlsPort = (tlsServer.address() as AddressInfo).port;
    tcpPort = (tcpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const sock of sockets) sock.destroy();
    await new Promise<void>((r) => tlsServer.close(() => r()));
    await new Promise<void>((r) => tcpServer.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const shake = (port: number) =>
    tlsHandshake({
      host: "127.0.0.1",
      port,
      servername: "web.acme.localhost",
      timeoutMs: 1500,
    });

  it("a TLS listener answers (a self-signed cert still serves)", async () => {
    expect(await shake(tlsPort)).toEqual({ ok: true });
  });

  it("a plain-text listener is not HTTPS", async () => {
    expect((await shake(tcpPort)).ok).toBe(false);
  });

  it("nothing listening is not HTTPS", async () => {
    const free = net.createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    const p = (free.address() as AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));
    expect(await shake(p)).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});

describe("/api/edge serves the probed status", () => {
  it("awaits an async edge status (the https probe)", async () => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleReadonlyRoutes(req, res, url.pathname, url, {
        ...defaultReadonlyRouteDeps,
        edge: async () =>
          withHttpsServing(edgeStatus(edge, running), edge, async () => ({
            ok: true,
          })),
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/api/edge",
            agent: false,
            headers: { Connection: "close" },
          },
          (res) => {
            let b = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (b += c));
            res.on("end", () => resolve(b));
          },
        );
        req.on("error", reject);
        req.end();
      });
      const json = JSON.parse(body) as Record<string, unknown>;
      expect(json).toMatchObject({
        configured: true,
        certIssuedByDen: false,
        https: { strategy: "files", certs: "distribution", serving: true },
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
