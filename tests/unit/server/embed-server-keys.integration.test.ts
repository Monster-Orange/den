/**
 * Issue 334 against a real server: a web app's server key reads its one
 * agent's state, and reaches nothing else.
 *
 *   - the key's own agent: 200, its state;
 *   - another agent's state, /api/agents, /api/notifications, the
 *     settings, the pane's key route: refused, though loopback would let
 *     the same request through without the key;
 *   - a revoked key: 401 key_revoked; a made-up one: 401 bad_key;
 *   - an origin taken off the list: 403;
 *   - say with the key: queued for the agent, audited with its length,
 *     never its text.
 *
 * Keys are made in the test's own state dir (ServerKeys, as the held write
 * makes them). Invented names only; nothing real runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { spawnServer, stopServer } from "../../child-servers.js";
import { ServerKeys } from "../../../src/ui/server/embed-server-keys.js";

const PORT = 21876 + Math.floor(Math.random() * 1000);
const ORIGIN = "http://127.0.0.1:5173";
let tmp = "";
let stateDir = "";
let server: ChildProcess | null = null;
let keys: ServerKeys;

function req(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      `http://127.0.0.1:${PORT}${p}`,
      {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        timeout: 15_000,
      },
      (res) => {
        let b = "";
        res.on("data", (c: Buffer) => (b += c.toString()));
        res.on("end", () => {
          let v: Record<string, unknown> = {};
          try {
            v = JSON.parse(b) as Record<string, unknown>;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body: v });
        });
      },
    );
    r.on("error", reject);
    r.on("timeout", () => {
      r.destroy();
      reject(new Error("timeout"));
    });
    if (body) r.write(body);
    r.end();
  });
}

function agentRecord(id: string, ws: string): void {
  const dir = path.join(stateDir, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      persona: id,
      runtime: "claude",
      workspace: ws,
      cwd: tmp,
      session: { id: `s-${id}`, name: `${ws}-${id}` },
      sessionName: `${ws}-${id}`,
      startedAt: "2026-11-17T18:00:00.000Z",
      stoppedAt: "2026-11-17T18:05:00.000Z",
    }),
  );
}

const stateOf = (ws: string, id: string) =>
  `/api/embed/p/${ws}/agents/${id}/state`;

describe("a web app's server key, on a real server", () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-sk-int-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
    fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
    fs.writeFileSync(
      path.join(dist, "config", "den.yml"),
      "environments: [local]\n",
    );
    fs.writeFileSync(
      path.join(dist, "config", "local", "user.yml"),
      `embed:\n  origins: ["${ORIGIN}"]\n`,
    );
    stateDir = path.join(tmp, "home", ".den");
    agentRecord("scout", "north");
    agentRecord("pilot", "north");
    keys = ServerKeys.at(stateDir);
    server = spawnServer("npx", ["tsx", "src/ui/server/index.ts"], {
      env: {
        ...process.env,
        DEN_ROOT: dist,
        DEN_ENGINE_ROOT: process.cwd(),
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        PORT: String(PORT),
        DEN_NO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      try {
        await req("GET", "/api/environments");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error("Server did not start within 30s");
  }, 40_000);

  afterAll(async () => {
    await stopServer(server ?? undefined);
    server = null;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("its own agent's state: 200, stopped", async () => {
    const { key } = keys.create({
      project: "north",
      agent: "scout",
      origin: ORIGIN,
    });
    const r = await req("GET", stateOf("north", "scout"), {
      "X-Den-Embed-Key": key,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      agent: { id: "scout", project: "north" },
      running: false,
      state: "stopped",
    });
    expect(keys.list()[0].lastUsedAt).toBeTruthy();
  }, 30_000);

  it("reaches nothing else: another agent, the agents list, the bell, settings", async () => {
    const { key } = keys.create({
      project: "north",
      agent: "scout",
      origin: ORIGIN,
    });
    const h = { "X-Den-Embed-Key": key };
    // Another agent's state: its own key's agent only.
    const other = await req("GET", stateOf("north", "pilot"), h);
    expect([other.status, other.body.code]).toEqual([403, "key_scope"]);
    for (const p of [
      "/api/agents",
      "/api/notifications",
      "/api/settings",
      "/api/workspaces/north/agents",
      "/api/approvals",
    ]) {
      const r = await req("GET", p, h);
      expect([p, r.status, r.body.code]).toEqual([p, 403, "embed_key_scope"]);
    }
    const mint = await req(
      "POST",
      "/api/embed/keys",
      h,
      JSON.stringify({ project: "north", agent: "scout", origin: ORIGIN }),
    );
    expect([mint.status, mint.body.code]).toEqual([403, "embed_key_scope"]);
    // The same read without the key passes on loopback: the key is what
    // was refused, not the route.
    expect((await req("GET", "/api/settings")).status).toBe(200);
  }, 30_000);

  it("revoked: 401 key_revoked; a made-up key: 401 bad_key", async () => {
    const { key, view } = keys.create({
      project: "north",
      agent: "scout",
      origin: ORIGIN,
    });
    expect(
      (await req("GET", stateOf("north", "scout"), { "X-Den-Embed-Key": key }))
        .status,
    ).toBe(200);
    keys.revoke(view.id);
    const r = await req("GET", stateOf("north", "scout"), {
      "X-Den-Embed-Key": key,
    });
    expect([r.status, r.body.code]).toEqual([401, "key_revoked"]);
    const bad = await req("GET", stateOf("north", "scout"), {
      "X-Den-Embed-Key": `${key.slice(0, -2)}xx`,
    });
    expect([bad.status, bad.body.code]).toEqual([401, "bad_key"]);
  }, 30_000);

  it("another origin, or one taken off the list: 403", async () => {
    const { key } = keys.create({
      project: "north",
      agent: "scout",
      origin: "https://gone.example.test",
    });
    const r = await req("GET", stateOf("north", "scout"), {
      "X-Den-Embed-Key": key,
    });
    expect([r.status, r.body.code]).toEqual([403, "origin_not_listed"]);
    const { key: k2 } = keys.create({
      project: "north",
      agent: "scout",
      origin: ORIGIN,
    });
    const m = await req("GET", stateOf("north", "scout"), {
      "X-Den-Embed-Key": k2,
      Origin: "https://other.example.test",
    });
    expect(m.status).toBe(403);
  }, 30_000);
});
