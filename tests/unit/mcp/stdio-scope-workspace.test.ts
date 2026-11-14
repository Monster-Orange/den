/**
 * A scoped stdio MCP server (`mcp --workspace north --actor agent:<id>`,
 * no grants) lists its workspace tools without a `workspace` parameter
 * (MCP-2.2), yet a call that names another workspace anyway is refused,
 * never answered about north. 0.4.28-dev.0's gate found the SDK dropped
 * the unlisted key, so `agent_helpers {workspace: "west"}` answered for
 * the agent's own workspace. Raw JSON-RPC over stdio against a stub web
 * server; invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const paths: string[] = [];
let stub: http.Server;
let root = "";
let child: ChildProcess;
const waiting = new Map<number, (msg: Record<string, unknown>) => void>();

const send = (msg: Record<string, unknown>) =>
  child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const request = (id: number, method: string, params = {}) =>
  new Promise<Record<string, unknown>>((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    paths.push(url.pathname);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        url.pathname === "/api/server-info"
          ? { pid: process.pid, version: "0.2.6", root, product: "den" }
          : url.pathname === "/api/workspaces"
            ? {
                active: ["north", "south"],
                focus: "north",
                workspaces: { north: {}, south: {} },
              }
            : url.pathname === "/api/health"
              ? []
              : { helpers: [] },
      ),
    );
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const port = (stub.address() as AddressInfo).port;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "den-mcp-scope-"));
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  child = spawnServer(
    path.join(ENGINE, "bin", "den"),
    [
      "mcp",
      "--port",
      String(port),
      "--workspace",
      "north",
      "--actor",
      "agent:scout",
    ],
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
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        waiting.get(msg.id as number)?.(msg);
        waiting.delete(msg.id as number);
      } catch {
        /* not a message */
      }
    }
  });
  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "acme-test-client", version: "1.0.0" },
  });
  send({ method: "notifications/initialized" });
}, 30_000);

afterAll(async () => {
  await stopServer(child);
  await new Promise<void>((r) => stub.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

type Call = { content: { text: string }[]; isError?: boolean };
const call = async (id: number, name: string, args: unknown) =>
  (await request(id, "tools/call", { name, arguments: args })).result as Call;

describe("a scoped stdio server, another workspace named anyway", () => {
  it("lists no workspace parameter on its pinned tools", async () => {
    const list = await request(2, "tools/list");
    const tools = (
      list.result as {
        tools: { name: string; inputSchema: { properties?: object } }[];
      }
    ).tools;
    for (const n of ["status", "agent_helpers"]) {
      const t = tools.find((x) => x.name === n)!;
      expect([n, "workspace" in (t.inputSchema.properties ?? {})]).toEqual([
        n,
        false,
      ]);
    }
  }, 30_000);

  it("refuses it, for agent_helpers and status alike; its own still answers", async () => {
    for (const [i, name, args] of [
      [3, "agent_helpers", { agent: "scout", workspace: "west" }],
      [4, "status", { workspace: "south" }],
    ] as const) {
      const before = paths.length;
      const r = await call(i, name, args);
      expect([name, r.isError]).toEqual([name, true]);
      expect(r.content[0].text).toMatch(
        /^Refused: .*scoped to project "north"/,
      );
      expect(
        paths
          .slice(before)
          .filter((p) => p.includes("/helpers") || p === "/api/health"),
      ).toEqual([]);
    }
    const own = await call(5, "agent_helpers", { agent: "scout" });
    expect(own.isError).toBeFalsy();
    expect(paths.at(-1)).toBe("/api/workspaces/north/agents/scout/helpers");
  }, 30_000);
});
