/**
 * Integration: spawn `bin/den mcp` (Den's own profile, in a throwaway root
 * whose org config enables two actions) against a stub web server, and
 * speak raw JSON-RPC over its stdio: initialize, tools/list, one read tool,
 * one refused action. Every stdout line must be a protocol message.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
const requests: { path: string; headers: http.IncomingHttpHeaders }[] = [];
let stub: http.Server;
let port = 0;
let root = "";
let child: ChildProcess;
const stdoutLines: string[] = [];
const waiting = new Map<number, (msg: Record<string, unknown>) => void>();

function send(msg: Record<string, unknown>): void {
  child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push({ path: url.pathname, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        url.pathname === "/api/health"
          ? [{ repo: "shop", service: "api", ok: true }]
          : {},
      ),
    );
  });
  await new Promise<void>((r) => stub.listen(0, "localhost", r));
  port = (stub.address() as AddressInfo).port;

  root = fs.mkdtempSync(path.join(os.tmpdir(), "den-mcp-"));
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nmcp:\n  actions: [service_up, run_tests]\n",
  );

  child = spawn(
    path.join(ENGINE, "bin", "den"),
    ["mcp", "--port", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_HOME: path.join(root, "home"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const done = waiting.get(msg.id as number);
        if (done) {
          waiting.delete(msg.id as number);
          done(msg);
        }
      } catch {
        /* asserted below: every line must parse */
      }
    }
  });
}, 30_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((r) => stub.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("bin/den mcp over stdio", () => {
  it("initializes, lists tools, calls a read tool and refuses an action", async () => {
    const init = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acme-test-client", version: "9.8.7" },
    });
    expect(init.result).toMatchObject({
      serverInfo: { name: "den" },
      capabilities: { tools: {} },
    });
    send({ method: "notifications/initialized" });

    const list = await request(2, "tools/list");
    const names = (
      (list.result as { tools: { name: string }[] }).tools ?? []
    ).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "status",
        "stacks",
        "edge_status",
        "service_up",
        "run_tests",
      ]),
    );
    expect(names).not.toContain("service_down");
    expect(names).not.toContain("workspace_sync");

    const status = await request(3, "tools/call", {
      name: "status",
      arguments: {},
    });
    const sr = status.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(sr.isError).toBeFalsy();
    expect(JSON.parse(sr.content[0].text)).toEqual([
      { repo: "shop", service: "api", ok: true },
    ]);
    const health = requests.find((r) => r.path === "/api/health");
    expect(health?.headers).toMatchObject({
      "x-den-actor": "agent",
      "x-den-mcp-client": "acme-test-client",
      "x-den-mcp-client-version": "9.8.7",
    });
    // The MCP server's own pid (tsx runs it in a child of bin/den's process).
    expect(health?.headers["x-den-mcp-pid"]).toMatch(/^\d+$/);
    expect(health?.headers["x-den-mcp-session"]).toMatch(/^[0-9a-f-]{36}$/);

    const before = requests.length;
    const refused = await request(4, "tools/call", {
      name: "run_tests",
      arguments: { pillar: "smoke", env: "production" },
    });
    const rr = refused.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(rr.isError).toBe(true);
    expect(rr.content[0].text).toMatch(/^Refused: .*production/);
    // Nothing reached an action route; only the refusal was reported (F2).
    expect(requests.slice(before).map((r) => r.path)).toEqual([
      "/api/activity",
    ]);

    // stdout carried the protocol and nothing else.
    for (const line of stdoutLines)
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  }, 30_000);
});

describe("bin/den mcp --call / --list (one shot)", () => {
  // Async: the stub web server runs in this process, so a sync spawn would
  // block it from answering.
  const run = (
    ...args: string[]
  ): Promise<{ status: number | null; stdout: string }> =>
    new Promise((resolve) => {
      const p = spawn(
        path.join(ENGINE, "bin", "den"),
        ["mcp", "--port", String(port), ...args],
        {
          cwd: root,
          env: {
            ...process.env,
            DEN_ROOT: root,
            DEN_HOME: path.join(root, "home"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      p.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
      p.on("close", (status) => resolve({ status, stdout }));
    });

  it("--list prints the enabled tool names", async () => {
    const r = await run("--list");
    expect(r.status).toBe(0);
    const names = r.stdout.trim().split("\n");
    expect(names).toEqual(
      expect.arrayContaining(["status", "service_up", "run_tests"]),
    );
    expect(names).not.toContain("service_down");
  }, 30_000);

  it("--call runs one read tool over HTTP and prints its result", async () => {
    const before = requests.length;
    const r = await run("--call", "status", "{}");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      { repo: "shop", service: "api", ok: true },
    ]);
    const health = requests.slice(before).find((q) => q.path === "/api/health");
    expect(health?.headers["x-den-actor"]).toBe("agent");
  }, 30_000);

  it("--call exits 1 on a refused action", async () => {
    const r = await run(
      "--call",
      "run_tests",
      JSON.stringify({ pillar: "smoke", env: "production" }),
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^Refused: .*production/);
  }, 30_000);
});
