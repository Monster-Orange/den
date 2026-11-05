/**
 * `<cli> mcp clients` ends with a line about the web server the MCP server
 * reads from. A server that accepts the connection but is too busy to answer
 * within the probe's 1.5s is "not answering", never "not running"; and when
 * the org config runs the web UI as a service (`web.service`), the advice is
 * `<cli> service status`, not `<cli> web up`.
 *
 * Real bin/den in throwaway distributions, against a stub that never answers
 * and a port nobody listens on.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let hung: http.Server;
let hungPort = 0;
let closedPort = 0;
let foreign: http.Server;
let foreignPort = 0;
const OTHER_ROOT = "/srv/acme-other";

function makeRoot(name: string, orgConfig: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(path.join(root, "config", "den.yml"), orgConfig);
  // The MCP server's command: only its path is used here.
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "den"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  return root;
}

/** `bin/den mcp clients --port <port>` in `root`; its stdout, colour off. */
function clients(root: string, port: number): Promise<string> {
  return mcp(root, ["clients", "--port", String(port)]).then((r) => r.out);
}

/** `bin/den mcp <args>` in `root`: its output (colour off) and exit code. */
function mcp(
  root: string,
  args: string[],
): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(ENGINE, "bin", "den"), ["mcp", ...args], {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_HOME: path.join(root, "home"),
        // No agents installed here: nothing to probe but the web server.
        HOME: path.join(root, "home"),
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ out, code }));
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-mcp-web-"));
  // Accepts the request and never answers: a server busy past the timeout.
  hung = http.createServer(() => {
    /* never respond */
  });
  await new Promise<void>((r) => hung.listen(0, "localhost", r));
  hungPort = (hung.address() as AddressInfo).port;
  // Another distribution's server: it names a root that is not ours.
  foreign = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        pid: 1,
        version: "0.2.3",
        root: OTHER_ROOT,
        product: "acme-ops",
      }),
    );
  });
  await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
  foreignPort = (foreign.address() as AddressInfo).port;
  // A port that was free a moment ago: nothing listens on it.
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "localhost", r));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
});

afterAll(async () => {
  await new Promise<void>((r) => foreign.close(() => r()));
  hung.closeAllConnections();
  await new Promise<void>((r) => hung.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SERVICE_CONFIG =
  "environments: [local]\nweb:\n  service:\n    label: local.acme.web\n";
const PLAIN_CONFIG = "environments: [local]\n";

describe("mcp clients: the web server line", () => {
  it("a server too busy to answer is 'not answering within 1.5s', not 'not running'", async () => {
    const out = await clients(makeRoot("busy", PLAIN_CONFIG), hungPort);
    expect(out).toMatch(/not answering within 1\.5s/);
    expect(out).not.toMatch(/not running/);
    expect(out).toMatch(/`den web restart`/);
  }, 20_000);

  it("as a service, a busy server points at `den service status`", async () => {
    const out = await clients(makeRoot("busy-svc", SERVICE_CONFIG), hungPort);
    expect(out).toMatch(/not answering within 1\.5s/);
    expect(out).toMatch(/`den service status`/);
    expect(out).not.toMatch(/web (up|restart)/);
  }, 20_000);

  it("as a service, a stopped server points at `den service status`, not `web up`", async () => {
    const out = await clients(makeRoot("down-svc", SERVICE_CONFIG), closedPort);
    expect(out).toMatch(/web server not running at/);
    expect(out).toMatch(/`den service status`/);
    expect(out).not.toMatch(/web up/);
  }, 20_000);

  it("without a service, a stopped server still says `den web up`", async () => {
    const out = await clients(makeRoot("down", PLAIN_CONFIG), closedPort);
    expect(out).toMatch(/web server not running at .*`den web up`/);
  }, 20_000);

  it("another distribution's server is named, never 'up'", async () => {
    const out = await clients(makeRoot("foreign", PLAIN_CONFIG), foreignPort);
    expect(out).toContain(
      `port ${foreignPort} is in use by acme-ops at ${OTHER_ROOT}`,
    );
    expect(out).not.toMatch(/web server up/);
  }, 20_000);

  it("connect refuses to point an agent at another distribution's server", async () => {
    const { out, code } = await mcp(makeRoot("foreign-connect", PLAIN_CONFIG), [
      "connect",
      "claude-code",
      "--dry-run",
      "--port",
      String(foreignPort),
    ]);
    expect(out).toContain(
      `port ${foreignPort} is in use by acme-ops at ${OTHER_ROOT}`,
    );
    expect(out).toMatch(/pick another port/);
    expect(code).toBe(1);
  }, 20_000);
});
