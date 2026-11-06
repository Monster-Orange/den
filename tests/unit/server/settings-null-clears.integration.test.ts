/**
 * POST /api/settings: null clears a pref (0.3.0-dev.32, a consumer's nit).
 *
 * A key set to null ({"graph":{"workspaces":null}}) is removed from
 * config/local/user.yml instead of failing with 400, and a block left
 * empty goes too. So setting a pref and clearing it again leaves user.yml
 * byte-identical. A whole block set to null removes the block.
 *
 * A real server on a throwaway distribution; no browser.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let userYml = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function ping(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "localhost",
        port,
        path: "/api/server-info",
        timeout: 5_000,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
async function post(body: unknown): Promise<{ status: number; text: string }> {
  const r = await fetch(`http://localhost:${port}/api/settings`, {
    method: "POST",
    headers: {
      ...denAuth(path.join(tmp, "home", ".den")),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}
const bytes = () => fs.readFileSync(userYml);

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-null-")));
  const root = path.join(tmp, "dist");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  userYml = path.join(root, "config", "local", "user.yml");
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  server = spawnServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await ping()) === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server did not start:\n${serverOut}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  // A user.yml Den wrote: an editor and one graph pref.
  expect((await post({ editor: "vim" })).status).toBe(200);
  expect((await post({ graph: { direction: "right" } })).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("POST /api/settings: null clears a pref (0.3.0-dev.32)", () => {
  it("graph.workspaces set, then null: user.yml is byte-identical", async () => {
    const before = bytes();
    expect((await post({ graph: { workspaces: "collapsed" } })).status).toBe(
      200,
    );
    expect(bytes().toString()).toContain("workspaces: collapsed");
    const r = await post({ graph: { workspaces: null } });
    expect(`${r.status} ${r.text.slice(0, 80)}`).toMatch(/^200 /);
    expect(bytes().equals(before)).toBe(true);
  });

  it("a block left empty goes: graph cleared key by key leaves no graph:", async () => {
    const before = bytes();
    expect((await post({ graph: { direction: null } })).status).toBe(200);
    expect(bytes().toString()).not.toMatch(/^graph:/m);
    // And back: the same bytes as before.
    expect((await post({ graph: { direction: "right" } })).status).toBe(200);
    expect(bytes().equals(before)).toBe(true);
  });

  it("shell and appearance keys clear the same way", async () => {
    const before = bytes();
    expect(
      (await post({ shell: { collapsed: true, pins: ["shop"] } })).status,
    ).toBe(200);
    expect((await post({ appearance: { mode: "light" } })).status).toBe(200);
    expect(bytes().equals(before)).toBe(false);
    expect(
      (await post({ shell: { collapsed: null, pins: null } })).status,
    ).toBe(200);
    expect((await post({ appearance: { mode: null } })).status).toBe(200);
    expect(bytes().equals(before)).toBe(true);
  });

  it("a whole block set to null is removed", async () => {
    expect((await post({ graph: null })).status).toBe(200);
    expect(bytes().toString()).not.toMatch(/^graph:/m);
    expect(bytes().toString()).toMatch(/^editor: vim$/m);
  });

  it("an unknown key is still refused, null or not", async () => {
    const before = bytes();
    const r = await post({ graph: { zoom: null } });
    expect(r.status).toBe(400);
    // R26b: the message in the JSON error body.
    expect(JSON.parse(r.text).error).toContain('unknown graph setting "zoom"');
    expect(bytes().equals(before)).toBe(true);
  });
});
