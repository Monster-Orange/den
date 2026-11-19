/**
 * den#156: a terminal host that doesn't answer a list can't hold the
 * Agents list for good. The client's list fails after its timeout (a late
 * answer is dropped), and GET /api/sessions answers in time with
 * `hostError`, never a request that waits as long as the host does.
 *
 * The host here is a fake on a socket in a temp dir: it answers hello and
 * never answers list.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  connectHost,
  HostError,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { PROTOCOL_VERSION } from "../../../src/shared/sessions/protocol.js";
import { handleSessionList } from "../../../src/ui/server/session-routes.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hlt-"));
const socket = path.join(dir, "host.sock");
/** Every list the fake host was asked for, and how to answer them late. */
const lists: { id: number; conn: net.Socket }[] = [];
let fake: net.Server;

beforeAll(async () => {
  fake = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)) as { id: number; op: string };
        buf = buf.slice(i + 1);
        if (msg.op === "hello")
          conn.write(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              id: msg.id,
              ok: true,
              pid: 1,
              startedAt: new Date().toISOString(),
            }) + "\n",
          );
        // "list": no answer (a host that is stuck).
        else if (msg.op === "list") lists.push({ id: msg.id, conn });
      }
    });
  });
  await new Promise<void>((r) => fake.listen(socket, r));
});

afterAll(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a terminal host that doesn't answer a list (den#156)", () => {
  it("the client's list fails after its timeout, and a late answer is dropped", async () => {
    const c = await connectHost(socket);
    try {
      const t0 = Date.now();
      const err = await c.list({ timeoutMs: 200 }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HostError);
      expect((err as HostError).code).toBe("timeout");
      expect((err as HostError).message).toMatch(/did not answer within/);
      expect(Date.now() - t0).toBeLessThan(2000);
      // The answer comes after all: nothing throws, nothing resolves twice.
      const late = lists.at(-1)!;
      late.conn.write(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          id: late.id,
          ok: true,
          sessions: [],
        }) + "\n",
      );
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      c.close();
    }
  });

  it("GET /api/sessions answers in time, saying the host didn't answer", async () => {
    let client: HostClient | null = null;
    const server = http.createServer((req, res) => {
      void handleSessionList(req, res, "/api/sessions", true, {
        stateDir: () => dir,
        dist: () => "acme",
        connectExisting: async () => (client = await connectHost(socket)),
        activeWorkspaces: () => [],
        hubNow: async () => null,
        repoNames: () => null,
        listWaits: () => ({
          host_timeout_seconds: 0.3,
          refresh_timeout_seconds: 15,
        }),
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const t0 = Date.now();
      const body = await new Promise<Record<string, unknown>>((ok, bad) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: "/api/sessions", timeout: 5000 },
          (res) => {
            let s = "";
            res.on("data", (d) => (s += d));
            res.on("end", () => ok(JSON.parse(s) as Record<string, unknown>));
          },
        );
        req.on("timeout", () => {
          req.destroy();
          bad(new Error("GET /api/sessions waited for the host"));
        });
        req.on("error", bad);
      });
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(body.hostError).toMatch(/did not answer within 0\.3 s/);
      // Issue 500: there, and not answering: Terminal offers Restart.
      expect(body.hostStuck).toBe(true);
      expect(body.sessions).toEqual([]);
      expect(body.refreshTimeoutSeconds).toBe(15);
    } finally {
      (client as HostClient | null)?.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
