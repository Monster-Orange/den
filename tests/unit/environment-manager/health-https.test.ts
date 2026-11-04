import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  __setExtraCaForTests,
  pingHttp,
} from "../../../src/shared/environment-manager/health.js";

// A real TLS server with a self-signed cert for a *.localhost name. The check
// must connect to 127.0.0.1 but verify the certificate against the NAME: the
// old code rewrote the URL host to the IP, so every https check failed.
const NAME = "svc.health-test.localhost";
let dir: string;
let server: https.Server;
let port: number;
let cert: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-https-"));
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
      `/CN=${NAME}`,
      "-addext",
      `subjectAltName=DNS:${NAME}`,
    ],
    { stdio: "ignore" },
  );
  cert = fs.readFileSync(path.join(dir, "cert.pem"), "utf-8");
  server = https.createServer(
    { key: fs.readFileSync(path.join(dir, "key.pem")), cert },
    (_req, res) => res.writeHead(200).end("ok"),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  __setExtraCaForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("https health checks", () => {
  it("verifies the certificate against the hostname, connecting to the resolved IP", async () => {
    __setExtraCaForTests([cert]);
    await expect(pingHttp(`https://${NAME}:${port}/healthz`)).resolves.toEqual({
      ok: true,
      status: 200,
    });
  });

  it("still rejects a certificate it does not trust", async () => {
    __setExtraCaForTests([]);
    const r = await pingHttp(`https://${NAME}:${port}/healthz`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/certificate|self.signed/i);
  });
});
