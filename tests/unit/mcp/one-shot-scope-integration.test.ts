/**
 * Integration: `bin/den mcp --workspace <ws> --actor agent:<id> --call …`,
 * the real entry (bin/den → mcp-main → runMcp), against a stub web server.
 * A scoped one-shot goes through the scoped path the stdio server uses:
 * it says its scope on stderr, a call naming another workspace is refused
 * before anything of it is read, a bare `services` is the scope's own (with
 * its scope block), and `graph` is the workspace's map. With a grant from
 * the org config, an ungranted workspace still gets Den's refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
const requests: { path: string; workspace: string | null }[] = [];
let stub: http.Server;
let port = 0;
let root = "";

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "den-mcp-shot-"));
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nagents:\n  scout:\n    grants: [east]\n",
  );
  stub = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ws = url.searchParams.get("workspace");
    requests.push({ path: url.pathname, workspace: ws });
    const body =
      url.pathname === "/api/server-info"
        ? { pid: process.pid, version: "0.4.4", root, product: "den" }
        : url.pathname === "/api/workspaces"
          ? {
              active: ["north", "south"],
              focus: "north",
              workspaces: {
                north: { services: { shop: {} } },
                south: { services: { bank: {} } },
                east: { services: {} },
              },
            }
          : url.pathname === "/api/services"
            ? [
                {
                  repo: ws === "south" ? "bank" : "shop",
                  service: "api",
                  repoPath: `/private/${ws ?? "all"}-path`,
                  commands: ["up"],
                },
              ]
            : url.pathname === "/api/graph"
              ? { nodes: ["shop", "bank"], edges: [] }
              : [];
    res.writeHead(200, {
      "Content-Type": "application/json",
      Connection: "close",
    });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => stub.listen(0, "localhost", r));
  port = (stub.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

function den(
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(root, "home"),
    };
    delete env.DEN_ACTOR_TOKEN;
    const child = spawn(
      path.join(ENGINE, "bin", "den"),
      ["mcp", "--port", String(port), ...args],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const SCOPED = ["--workspace", "north", "--actor", "agent:scout"];

describe("bin/den mcp --call, scoped", () => {
  it("naming another workspace is refused before anything of it is read", async () => {
    requests.length = 0;
    const r = await den([
      ...SCOPED,
      "--call",
      "services",
      '{"workspace":"south"}',
    ]);
    expect(r.err).toContain("mcp --call: scoped to north as agent:scout");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /^Refused: services: .*"south" is another project.*agents\.scout\.grants/,
    );
    expect(r.out).not.toContain("bank");
    expect(r.out).not.toContain("/private/");
    expect(requests.filter((q) => q.path === "/api/services")).toEqual([]);
  }, 30_000);

  it("a bare services is the scope's own, with its scope block; graph is the workspace's map", async () => {
    requests.length = 0;
    const svc = await den([...SCOPED, "--call", "services"]);
    expect(svc.code).toBe(0);
    const body = JSON.parse(svc.out) as {
      scope: { workspace: string };
      services: { repo: string }[];
    };
    expect(body.scope.workspace).toBe("north");
    expect(body.services.map((s) => s.repo)).toEqual(["shop"]);
    expect(requests.filter((q) => q.path === "/api/services")).toEqual([
      { path: "/api/services", workspace: "north" },
    ]);
    const g = await den([...SCOPED, "--call", "graph"]);
    expect(g.code).toBe(0);
    expect(JSON.parse(g.out)).toMatchObject({
      map: "workspace",
      nodes: ["shop"],
    });
  }, 60_000);

  it("with a grant, an ungranted workspace is refused by Den (naming the grant), not by the schema", async () => {
    requests.length = 0;
    const r = await den([
      ...SCOPED,
      "--grant",
      "east",
      "--call",
      "services",
      '{"workspace":"south"}',
    ]);
    expect(r.err).toContain(
      "mcp --call: scoped to north as agent:scout · grants: east",
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/adds "south" to agents\.scout\.grants/);
    expect(requests.filter((q) => q.path === "/api/services")).toEqual([]);
  }, 30_000);
});
