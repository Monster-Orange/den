import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { createDenApi } from "../../../src/ui/mcp/api.js";
import {
  identifyServer,
  webReadyWaits,
} from "../../../src/ui/cli/server-identity.js";
import { readWebAuthConfig } from "../../../src/shared/web/web-session.js";
import { denWebBase } from "../../../src/shared/web/web-dial.js";

const OWN = { root: "/srv/acme", product: "acme" };
const headers = () => ({ "x-den-actor": "agent" });
const closers: (() => Promise<void>)[] = [];
let root = "";
const savedRoot = process.env.DEN_ROOT;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1664-")));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  process.env.DEN_ROOT = root;
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  if (savedRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function listen(s: net.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(async () => {
    if (s instanceof http.Server) s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  });
  return (s.address() as AddressInfo).port;
}

/** Our server; server-info's answers are late by `lateMs(n)` for the n-th. */
async function ours(lateMs: (n: number) => number = () => 0) {
  let n = 0;
  const served: string[] = [];
  const port = await listen(
    http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      res.setHeader("content-type", "application/json");
      if (p !== "/api/server-info") {
        served.push(p);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const wait = lateMs(n++);
      const t = setTimeout(
        () => res.end(JSON.stringify({ pid: process.pid, ...OWN })),
        wait,
      );
      res.on("close", () => clearTimeout(t));
    }),
  );
  return { port, served };
}

describe("a refusal says what happened and how long it waited", () => {
  it("no answer within the wait: names the wait and its setting, never a restart", async () => {
    const s = await ours(() => 10_000);
    const api = createDenApi({
      baseUrl: `http://127.0.0.1:${s.port}`,
      cli: "acme",
      headers,
      identity: { own: OWN, timeoutMs: () => 200 },
    });
    const e = await api.get("/api/health").catch((x: Error) => x);
    expect(String(e)).toMatch(/no answer to \/api\/server-info within 0\.2 s/);
    expect(String(e)).toContain("web.tools_probe_seconds");
    expect(String(e)).toContain("The next call checks again.");
    expect(String(e)).not.toMatch(/restart/i);
    expect(s.served).toEqual([]);
  });

  it("a dropped connection: names the error and when it came", async () => {
    const port = await listen(
      net.createServer((sock) => sock.resetAndDestroy()),
    );
    const id = await identifyServer(port, OWN, 2_000);
    expect(id).toMatchObject({
      kind: "unresponsive",
      why: "error",
      code: "ECONNRESET",
    });
    const api = createDenApi({
      baseUrl: `http://127.0.0.1:${port}`,
      cli: "acme",
      headers,
      identity: { own: OWN, timeoutMs: () => 2_000 },
    });
    const e = await api.get("/api/health").catch((x: Error) => x);
    expect(String(e)).toMatch(
      /\/api\/server-info failed with ECONNRESET after \d+ ms/,
    );
    expect(String(e)).not.toMatch(/in time|restart/i);
  });

  it("an empty answer (a server still starting): says so", async () => {
    const port = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200);
        res.end();
      }),
    );
    expect(await identifyServer(port, OWN, 2_000)).toMatchObject({
      kind: "unresponsive",
      why: "empty",
    });
  });
});

describe("a slow server is still ours, and one refusal is not the last word", () => {
  it("an answer late but inside the wait goes through", async () => {
    const s = await ours(() => 300);
    const api = createDenApi({
      baseUrl: `http://127.0.0.1:${s.port}`,
      cli: "acme",
      headers,
      identity: { own: OWN, timeoutMs: () => 5_000 },
    });
    await api.get("/api/health");
    expect(s.served).toEqual(["/api/health"]);
  });

  it("a check that timed out once, then answers: the next call works", async () => {
    const s = await ours((n) => (n === 0 ? 10_000 : 0));
    const api = createDenApi({
      baseUrl: `http://127.0.0.1:${s.port}`,
      cli: "acme",
      headers,
      identity: { own: OWN, timeoutMs: () => 200 },
    });
    await expect(api.get("/api/health")).rejects.toThrow(/within 0\.2 s/);
    await api.get("/api/health");
    expect(s.served).toEqual(["/api/health"]);
  });

  it("the wait is read at each check: a changed setting applies with no restart", async () => {
    const s = await ours(() => 400);
    let wait = 100;
    const api = createDenApi({
      baseUrl: `http://127.0.0.1:${s.port}`,
      cli: "acme",
      headers,
      identity: { own: OWN, timeoutMs: () => wait },
    });
    await expect(api.get("/api/health")).rejects.toThrow(/within 0\.1 s/);
    wait = 5_000;
    await api.get("/api/health");
    expect(s.served).toEqual(["/api/health"]);
  });
});

describe("web.tools_probe_seconds", () => {
  const userYml = (body: string) =>
    fs.writeFileSync(path.join(root, "config", "local", "user.yml"), body);

  it("defaults to 30 s, a permissive wait for a busy server", () => {
    expect(readWebAuthConfig(root).toolsProbeSeconds).toBe(30);
    expect(webReadyWaits().toolsProbeMs).toBe(30_000);
  });

  it("user.yml sets it", () => {
    userYml("web:\n  tools_probe_seconds: 90\n");
    expect(webReadyWaits().toolsProbeMs).toBe(90_000);
  });

  it.each([0, "soon", 100_000])("%p is refused, naming the key", (v) => {
    userYml(`web:\n  tools_probe_seconds: ${JSON.stringify(v)}\n`);
    expect(() => readWebAuthConfig(root)).toThrow("web.tools_probe_seconds");
  });
});

describe("where the tools dial", () => {
  it.each([undefined, "", "0.0.0.0", "::"])(
    "bind %p: the bound loopback address, never localhost",
    (bind) => {
      expect(denWebBase(7778, bind)).toBe("http://127.0.0.1:7778");
    },
  );
});
