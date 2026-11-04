/**
 * The MCP server's web API client: it can only reach the allowed routes,
 * sends the audit headers on every call, reads SSE streams to a bound, and
 * reports a stopped web server with the command that starts it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  DenHttpError,
  DenWebDown,
  assertAllowedRequest,
  createDenApi,
} from "../../../src/ui/mcp/api.js";
import { Refusal } from "../../../src/ui/mcp/guards.js";

const seen: http.IncomingHttpHeaders[] = [];
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.headers);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/service/taillog") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (let i = 1; i <= 5; i++)
        res.write(
          `data: ${JSON.stringify({ type: "line", text: `line ${i}` })}\n\n`,
        );
      // Never ends on its own (like a follow): the client must stop reading.
      return;
    }
    if (url.pathname === "/api/run") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "cmd", text: "$ run" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done", exitCode: 3 })}\n\n`);
      res.end();
      return;
    }
    if (url.pathname === "/api/stacks") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ path: url.pathname, q: url.searchParams.get("env") }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});

const headers = () => ({
  "x-den-actor": "agent",
  "x-den-mcp-client": "acme-client",
});

describe("assertAllowedRequest", () => {
  it("allows the read routes and the three action routes", () => {
    for (const p of ["/api/health", "/api/stacks", "/api/edge", "/api/run"])
      expect(() => assertAllowedRequest("GET", p, {})).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", "/api/workspace/sync", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("GET", "/api/service/exec", {
        cmd: "up",
        env: "local",
      }),
    ).not.toThrow();
  });

  it("never reaches the routes that are not exposed", () => {
    for (const p of [
      "/api/sudo-password",
      "/api/sudo-password/load-from-vault",
      "/api/aws/login",
      "/api/terminal/open",
      "/api/editor/open",
      "/api/workspace/exec",
      "/api/settings",
      "/api/workspaces/create",
      "/api/workspaces/rename",
      "/api/workspaces/services/mode",
      "/api/server-log",
      "/api/acme/config",
      "/api/release/deploy",
    ])
      expect(() => assertAllowedRequest("GET", p, {})).toThrow(Refusal);
    // A read route is GET only.
    expect(() => assertAllowedRequest("POST", "/api/workspaces", {})).toThrow(
      Refusal,
    );
  });

  it("service/exec only with a lifecycle command, env=local", () => {
    expect(() =>
      assertAllowedRequest("GET", "/api/service/exec", {
        cmd: "setup",
        env: "local",
      }),
    ).toThrow(Refusal);
    expect(() =>
      assertAllowedRequest("GET", "/api/service/exec", {
        cmd: "up",
        env: "dev",
      }),
    ).toThrow(Refusal);
  });
});

describe("createDenApi", () => {
  it("GETs JSON with the audit headers", async () => {
    const api = createDenApi({ baseUrl: base, cli: "acme", headers });
    expect(await api.get("/api/health", { env: "local" })).toEqual({
      path: "/api/health",
      q: "local",
    });
    expect(seen.at(-1)).toMatchObject({
      "x-den-actor": "agent",
      "x-den-mcp-client": "acme-client",
    });
  });

  it("reads a stream to its done event", async () => {
    const api = createDenApi({ baseUrl: base, cli: "acme", headers });
    const r = await api.stream(
      "/api/run",
      { pillar: "smoke" },
      {
        maxLines: 100,
        timeoutMs: 5000,
      },
    );
    expect(r.ended).toBe("done");
    expect(r.exitCode).toBe(3);
    expect(r.lines).toEqual(["$ run"]);
  });

  it("stops reading a follow stream at the line bound", async () => {
    const api = createDenApi({ baseUrl: base, cli: "acme", headers });
    const r = await api.stream(
      "/api/service/taillog",
      { repo: "shop", service: "api" },
      { maxLines: 3, timeoutMs: 5000 },
    );
    expect(r.ended).toBe("limit");
    expect(r.lines).toEqual(["line 1", "line 2", "line 3"]);
  });

  it("stops a quiet follow stream once it goes idle", async () => {
    const api = createDenApi({ baseUrl: base, cli: "acme", headers });
    const r = await api.stream(
      "/api/service/taillog",
      { repo: "shop", service: "api" },
      { maxLines: 100, timeoutMs: 5000, idleMs: 200 },
    );
    expect(r.ended).toBe("idle");
    expect(r.lines).toHaveLength(5);
  });

  it("a stopped web server is a DenWebDown naming the start command", async () => {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, "localhost", r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    const api = createDenApi({
      baseUrl: `http://localhost:${port}`,
      cli: "acme",
      headers,
    });
    const err = await api.get("/api/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DenWebDown);
    expect((err as Error).message).toMatch(/`acme web up`/);
  });

  it("an HTTP error is a DenHttpError with its status", async () => {
    const api = createDenApi({ baseUrl: base, cli: "acme", headers });
    const err = await api.get("/api/stacks").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DenHttpError);
    expect(err).toMatchObject({
      status: 404,
      method: "GET",
      path: "/api/stacks",
      body: "Not found",
      message: "GET /api/stacks → 404: Not found",
    });
  });

  it("can read /api/server-info (the version check)", () => {
    expect(() =>
      assertAllowedRequest("GET", "/api/server-info", {}),
    ).not.toThrow();
  });

  it("refuses a disallowed route before any request is made", async () => {
    const before = seen.length;
    const api = createDenApi({ baseUrl: base, cli: "acme", headers });
    await expect(api.get("/api/sudo-password")).rejects.toBeInstanceOf(Refusal);
    expect(seen.length).toBe(before);
  });
});
