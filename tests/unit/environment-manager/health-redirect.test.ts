/**
 * MCP-2.4: a redirect is a redirect, not down. A production app answering
 * `302 → /login` was reported down by `status`, and the web health row had
 * the same bug: both use the shared pingHttp. Since 0.4.4 a 3xx is ok null
 * (never green: the old AWS-ALB 301 guard holds) with its status and its
 * target, the query dropped. `<cli> status` reads it as "unknown" with a
 * `redirect 302 → /login` detail, so a caller waiting for health proceeds.
 *
 * Real servers on this machine (http and https), no mocked fetch.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  __setExtraCaForTests,
  checkServiceHealth,
  healthState,
  pingHttp,
  redirectTarget,
} from "../../../src/shared/environment-manager/health.js";

let dir: string;
let plain: http.Server;
let secure: https.Server;
let port = 0;
let sport = 0;

const answer = (req: http.IncomingMessage, res: http.ServerResponse) => {
  // One request per connection: nothing lingers for the next test.
  const close = { Connection: "close" };
  if (req.url?.startsWith("/admin"))
    res
      .writeHead(302, { ...close, Location: "/login?next=%2Fadmin&t=SECRET" })
      .end();
  else if (req.url === "/sso")
    res
      .writeHead(301, {
        ...close,
        Location: "https://sso.acme.example/start?state=SECRET#frag",
      })
      .end();
  else res.writeHead(200, close).end("ok");
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-redirect-"));
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
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const cert = fs.readFileSync(path.join(dir, "cert.pem"), "utf-8");
  __setExtraCaForTests([cert]);
  plain = http.createServer(answer);
  secure = https.createServer(
    { key: fs.readFileSync(path.join(dir, "key.pem")), cert },
    answer,
  );
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => secure.listen(0, "127.0.0.1", r));
  port = (plain.address() as AddressInfo).port;
  sport = (secure.address() as AddressInfo).port;
});

afterAll(async () => {
  __setExtraCaForTests(null);
  plain.closeAllConnections();
  secure.closeAllConnections();
  await new Promise<void>((r) => plain.close(() => r()));
  await new Promise<void>((r) => secure.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("pingHttp: a redirect is a redirect", () => {
  it("http 302 → /login: ok null, its status, its target without the query", async () => {
    const r = await pingHttp(`http://localhost:${port}/admin`);
    expect(r).toEqual({ ok: null, status: 302, redirect: "/login" });
  });

  it("https 302 too (the web health row's https checks)", async () => {
    const r = await pingHttp(`https://localhost:${sport}/admin`);
    expect(r).toEqual({ ok: null, status: 302, redirect: "/login" });
  });

  it("another origin keeps its origin, never its query or fragment", async () => {
    const r = await pingHttp(`http://localhost:${port}/sso`);
    expect(r).toEqual({
      ok: null,
      status: 301,
      redirect: "https://sso.acme.example/start",
    });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("a remote target.url probe (default 2xx) reports a redirect, not down", async () => {
    const r = await pingHttp(`http://localhost:${port}/admin`, 2000, "2xx");
    expect(r).toEqual({ ok: null, status: 302, redirect: "/login" });
  });

  it("unless the manifest says a 302 is up (target.expect)", async () => {
    const r = await pingHttp(`http://localhost:${port}/admin`, 2000, [302]);
    expect(r).toEqual({ ok: true, status: 302 });
  });

  it("a 200 is still up", async () => {
    expect((await pingHttp(`http://localhost:${port}/`)).ok).toBe(true);
  });
});

describe("<cli> status: a redirect reads as unknown, with its target", () => {
  it("healthState: a redirect is not pending (nothing is waiting to answer)", () => {
    expect(healthState({ ok: null, status: 302, redirect: "/login" })).toBe(
      "unknown",
    );
    expect(healthState({ ok: null, pending: true })).toBe("pending");
  });

  it("a remote service whose target.url answers 302", async () => {
    const repoPath = fs.mkdtempSync(path.join(dir, "repo-"));
    fs.writeFileSync(
      path.join(repoPath, ".den.yml"),
      [
        "name: site",
        "services:",
        "  web:",
        "    runs: { local: remote }",
        `    target: { env: prod, url: http://localhost:${port}/admin }`,
      ].join("\n"),
    );
    const r = await checkServiceHealth({
      address: "site/web",
      repoName: "site",
      subsystem: "web",
      repoPath,
      mode: "managed",
      branch: "main",
    });
    expect(r.health).toBe("unknown");
    expect(r.healthDetail).toBe("redirect 302 → /login");
  });
});

describe("redirectTarget", () => {
  it("names a missing or unreadable Location", () => {
    expect(redirectTarget(undefined, "http://a/")).toBe("(no Location header)");
    expect(redirectTarget("http://[bad", "http://a/")).toBe(
      "(unreadable Location header)",
    );
  });
});
