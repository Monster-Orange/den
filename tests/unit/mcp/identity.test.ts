/**
 * The MCP server reads only from THIS distribution's web server. Something
 * else on the configured port (another distribution's Den, an older Den run
 * from another root) gets no request, and every tool says whose server it
 * is. A positive check is trusted for 30s, and re-made after a connection
 * error.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import * as net from "net";
import { createDenApi } from "../../../src/ui/mcp/api.js";
import { callTool, READ_TOOL_NAMES } from "../../../src/ui/mcp/tools.js";
import type { ServerIdentity } from "../../../src/ui/cli/server-identity.js";

const OWN = { root: "/srv/acme", product: "acme" };
const OTHER_ROOT = "/srv/acme-other";
const cfg = {
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
};
const headers = () => ({ "x-den-actor": "agent" });

/** A stand-in web server: what it answers, and the data routes it served. */
function stub(info: object) {
  const served: string[] = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (p === "/api/server-info")
      return res.end(JSON.stringify({ pid: process.pid, ...info }));
    served.push(p);
    res.end(JSON.stringify([{ repo: "shop", service: "api", ok: true }]));
  });
  return { server, served };
}

let foreign: ReturnType<typeof stub>;
let ours: ReturnType<typeof stub>;
let foreignBase = "";
let oursBase = "";

async function listen(s: http.Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  return `http://localhost:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  foreign = stub({ version: "0.2.6", root: OTHER_ROOT, product: "acme-ops" });
  foreignBase = await listen(foreign.server);
  ours = stub({ version: "0.2.6", root: OWN.root, product: OWN.product });
  oursBase = await listen(ours.server);
});

afterAll(async () => {
  for (const s of [foreign.server, ours.server]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe("MCP tools against the server on the port", () => {
  it("a foreign server: every read tool refuses, naming it, and serves no data", async () => {
    const api = createDenApi({
      baseUrl: foreignBase,
      cli: "acme",
      headers,
      identity: { own: OWN },
    });
    const port = new URL(foreignBase).port;
    for (const name of ["status", "services", "workspaces"]) {
      expect(READ_TOOL_NAMES).toContain(name);
      const r = await callTool(name, {}, { api, cfg, cli: "acme" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(
        `port ${port} is in use by acme-ops at ${OTHER_ROOT}; not this distribution's server`,
      );
      expect(r.text).not.toContain("shop");
    }
    expect(foreign.served).toEqual([]);
  });

  it("our server: served", async () => {
    const api = createDenApi({
      baseUrl: oursBase,
      cli: "acme",
      headers,
      identity: { own: OWN },
    });
    const r = await callTool("status", {}, { api, cfg, cli: "acme" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("shop");
    expect(ours.served).toContain("/api/health");
  });
});

describe("the identity check's cache", () => {
  function counted(answers: ServerIdentity[]) {
    let t = 0;
    const asked: number[] = [];
    const identify = async (port: number): Promise<ServerIdentity> => {
      asked.push(port);
      return answers[Math.min(asked.length - 1, answers.length - 1)];
    };
    return {
      asked,
      clock: { advance: (ms: number) => (t += ms) },
      check: { own: OWN, identify, now: () => t },
    };
  }

  it("trusts a positive answer for 30s, then checks again", async () => {
    const c = counted([{ kind: "ours" }]);
    const api = createDenApi({
      baseUrl: oursBase,
      cli: "acme",
      headers,
      identity: c.check,
    });
    await api.get("/api/health");
    await api.get("/api/services");
    c.clock.advance(29_000);
    await api.get("/api/health");
    expect(c.asked).toHaveLength(1);
    c.clock.advance(2_000);
    await api.get("/api/health");
    expect(c.asked).toHaveLength(2);
  });

  it("concurrent calls share one check", async () => {
    const c = counted([{ kind: "ours" }]);
    const api = createDenApi({
      baseUrl: oursBase,
      cli: "acme",
      headers,
      identity: c.check,
    });
    await Promise.all([
      api.get("/api/health"),
      api.get("/api/services"),
      api.get("/api/workspaces"),
    ]);
    expect(c.asked).toHaveLength(1);
  });

  it("re-checks after a connection error, and then sees the new server is foreign", async () => {
    // A port that was ours, then nobody's, then another distribution's.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "localhost", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const c = counted([
      { kind: "ours" },
      { kind: "foreign", who: `acme-ops at ${OTHER_ROOT}` },
    ]);
    const api = createDenApi({
      baseUrl: `http://localhost:${port}`,
      cli: "acme",
      headers,
      identity: c.check,
    });
    // Vouched for, but the server is gone: a connection error.
    await expect(api.get("/api/health")).rejects.toThrow(/not running/);
    expect(c.asked).toHaveLength(1);
    // Within the 30s, yet checked again: the connection error dropped it.
    await expect(api.get("/api/health")).rejects.toThrow(
      `port ${port} is in use by acme-ops at ${OTHER_ROOT}; not this distribution's server`,
    );
    expect(c.asked).toHaveLength(2);
  });

  it("nothing listening is 'not running'; no answer in time is not served", async () => {
    for (const [id, msg] of [
      [{ kind: "none" }, /web server is not running/],
      [{ kind: "unresponsive" }, /did not answer \/api\/server-info in time/],
    ] as [ServerIdentity, RegExp][]) {
      const c = counted([id]);
      const api = createDenApi({
        baseUrl: oursBase,
        cli: "acme",
        headers,
        identity: c.check,
      });
      const before = ours.served.length;
      await expect(api.get("/api/health")).rejects.toThrow(msg);
      expect(ours.served.length).toBe(before);
    }
  });
});
