/**
 * den#143: `web up`'s readiness probe on a busy machine. Each probe request
 * gave up after a fixed 1.5 s, so a server that answered in 2 s (a loaded
 * machine, a cold start) was "not running": `web up` said "did not become
 * ready", and the web-ready-invalid-config suite failed in full runs.
 * Now the probe waits `web.ready_probe_seconds` (default 10), and `web up`
 * waits `web.start_wait_seconds` (default 120) for the server: both
 * Settings › Server rows and `config` keys.
 *
 * A stub Den that answers late stands in for the loaded server.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { isDenWebRunning } from "../../../src/ui/cli/web-command.js";
import { addDenUiMarker } from "../../../src/shared/ui-marker.js";
import { readWebAuthConfig } from "../../../src/shared/web/web-session.js";

/** How late the stub answers: past the old 1.5 s, under the default. */
const LATE_MS = 2_000;

let server: http.Server | null = null;
let root = "";
const savedRoot = process.env.DEN_ROOT;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-ready-")));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  process.env.DEN_ROOT = root;
});

afterEach(async () => {
  if (savedRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedRoot;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** A stub Den that answers each request `ms` late; its port. */
async function lateDen(ms: number): Promise<number> {
  const s = http.createServer((req, res) => {
    setTimeout(() => {
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
    }, ms);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  server = s;
  return (s.address() as AddressInfo).port;
}

const userYml = (text: string) =>
  fs.writeFileSync(path.join(root, "config", "local", "user.yml"), text);

describe("den#143: the readiness probe on a busy machine", () => {
  it("a server that answers in 2 s is running (the default wait)", async () => {
    const port = await lateDen(LATE_MS);
    expect(await isDenWebRunning(port)).toBe(true);
  }, 20_000);

  it("web.ready_probe_seconds is the probe's wait: 1 s gives up on it", async () => {
    userYml("web:\n  ready_probe_seconds: 1\n");
    const port = await lateDen(LATE_MS);
    expect(await isDenWebRunning(port)).toBe(false);
  }, 20_000);
});

describe("den#143: the readiness waits are settings", () => {
  it("defaults: the probe 10 s, the start 120 s", () => {
    const c = readWebAuthConfig(root);
    expect([c.readyProbeSeconds, c.startWaitSeconds]).toEqual([10, 120]);
  });

  it("user.yml sets them", () => {
    userYml("web:\n  ready_probe_seconds: 30\n  start_wait_seconds: 300\n");
    const c = readWebAuthConfig(root);
    expect([c.readyProbeSeconds, c.startWaitSeconds]).toEqual([30, 300]);
  });

  it.each([
    ["ready_probe_seconds", 0],
    ["ready_probe_seconds", "soon"],
    ["start_wait_seconds", -1],
    ["start_wait_seconds", 100_000],
  ])("web.%s: %p is refused, naming the key", (key, v) => {
    userYml(`web:\n  ${key}: ${JSON.stringify(v)}\n`);
    expect(() => readWebAuthConfig(root)).toThrow(`web.${key}`);
  });
});
