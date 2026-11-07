/**
 * A state dir too long for a unix socket (sun_path: 104 bytes on macOS,
 * 108 on Linux): the session host's socket goes in a short per-user dir,
 * /tmp/den-<uid>/<hash>.sock (0700 dir, 0600 socket), derived the same way
 * by the host and every client (paths.ts). Without it the host refused to
 * start and a client's connect failed with EINVAL, which the Workspaces
 * page's agents route answered with a 500.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  connectHost,
  HostError,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../src/shared/sessions/host.js";
import {
  MAX_SOCKET_PATH,
  sessionPaths,
} from "../../../src/shared/sessions/paths.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { scriptedFactory } from "./helpers/fake-pty.js";

const tmps: string[] = [];
const hosts: SessionHost[] = [];
const clients: HostClient[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of hosts.splice(0)) await h.close();
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A state dir whose `sessions.sock` is well over the limit. */
function longStateDir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "den-long-"));
  tmps.push(base);
  const dir = path.join(base, "a-deliberately-long-home".repeat(3), ".acme");
  fs.mkdirSync(dir, { recursive: true });
  expect(Buffer.byteLength(path.join(dir, "sessions.sock"))).toBeGreaterThan(
    MAX_SOCKET_PATH,
  );
  return dir;
}

describe("the session socket with a long state dir", () => {
  it("fits the limit, outside the state dir, the same for every caller", () => {
    const dir = longStateDir();
    const sock = sessionPaths(dir).socket;
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(MAX_SOCKET_PATH);
    expect(sock.startsWith(dir)).toBe(false);
    expect(sessionPaths(dir).socket).toBe(sock);
    expect(sessionPaths(`${dir}/`).socket).toBe(sock);
    // A short state dir keeps its socket inside.
    const short = fs.mkdtempSync(path.join(os.tmpdir(), "den-s-"));
    tmps.push(short);
    expect(sessionPaths(short).socket).toBe(path.join(short, "sessions.sock"));
  });

  it("the host listens there (0700 dir, 0600 socket) and a client reaches it", async () => {
    const dir = longStateDir();
    const { factory } = scriptedFactory();
    const h = new SessionHost({
      stateDir: dir,
      pty: () => ({ available: true, factory }),
      flushMs: 0,
      log: () => undefined,
    });
    hosts.push(h);
    expect(await h.listen()).toBe("listening");
    const sock = sessionPaths(dir).socket;
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
    const c = await connectHost(sock);
    clients.push(c);
    expect(await c.list()).toEqual([]);
  });

  it("GET /api/workspaces/<ws>/agents answers, not a 500 (no host running)", async () => {
    const dir = longStateDir();
    const server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      handleAgentRoutes(req, res, p, {
        agents: {
          dist: "acme",
          cli: "acme",
          stateDir: () => dir,
          workspaceExists: (ws) => ws === "north",
          workspaceDir: () => dir,
          out: () => undefined,
          err: () => undefined,
        },
        unlocked: () => true,
      }).catch((e: Error) => {
        res.writeHead(500);
        res.end(e.message);
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "localhost", r));
    const port = (server.address() as AddressInfo).port;
    const got = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.get(
          {
            host: "localhost",
            port,
            path: "/api/workspaces/north/agents",
            agent: false,
          },
          (res) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
      },
    );
    expect([got.status, got.body]).toEqual([
      200,
      expect.stringContaining('"agents"'),
    ]);
  });

  it("a socket the OS refuses is a clear HostError, never a bare errno", async () => {
    // A path over the limit is what the OS refuses (EINVAL or ENAMETOOLONG).
    const bad = path.join(os.tmpdir(), "x".repeat(MAX_SOCKET_PATH + 20));
    const e = await connectHost(bad).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(HostError);
    expect((e as HostError).code).toBe("unavailable");
    expect((e as Error).message).toMatch(
      /^could not reach the session host on /,
    );
  });
});
