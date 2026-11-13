/**
 * #67: the edge answered 502 on a POST after idle. It reused an upstream
 * connection the upstream had just closed, and a POST isn't retried.
 *
 * A real Traefik (the pinned image, in its own throwaway container) in
 * front of an upstream that does what a keep-alive timeout does at the
 * worst moment: a request on a connection idle for 1.5 s or more is read
 * and the connection closed, unanswered. Before the fix the edge reuses
 * the connection after 3 s idle and the POST gets 502; with the edge's
 * own idle limit (edge.upstream_idle_seconds, 1 s) it opens a fresh one.
 *
 * Needs Docker; DEN_SKIP_DOCKER_TESTS=1 (or no Docker) skips it. Never
 * touches any other edge: its container has its own name and is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { DEFAULT_TRAEFIK_IMAGE } from "../../../src/shared/edge/config.js";
import {
  edgeCommand,
  renderEdgeDynamic,
} from "../../../src/shared/edge/render.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const IDLE_CLOSE_MS = 1500;
const NAME = `den-test-edge-idle-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

function dockerOk(): boolean {
  if (process.env.DEN_SKIP_DOCKER_TESTS === "1") return false;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

let ok = false;
let upstream: net.Server | null = null;
let dir = "";
let edgePort = 0;
/** What the upstream did: answered, or dropped a request after idle. */
const seen: string[] = [];

/** One request on `buf`: its length when whole (headers and body), else 0. */
function wholeRequest(buf: Buffer): number {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return 0;
  const head = buf.subarray(0, end).toString("latin1");
  const len = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
  return buf.length >= end + 4 + len ? end + 4 + len : 0;
}

function startUpstream(): Promise<number> {
  upstream = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let lastAnswer = 0;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (let n = wholeRequest(buf); n; n = wholeRequest(buf)) {
        buf = buf.subarray(n);
        if (lastAnswer && Date.now() - lastAnswer >= IDLE_CLOSE_MS) {
          // Its keep-alive ran out just as this request came: closed.
          seen.push("dropped");
          sock.destroy();
          return;
        }
        seen.push("answered");
        sock.write(
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok",
        );
        lastAnswer = Date.now();
      }
    });
    sock.on("error", () => undefined);
  });
  return new Promise((r) =>
    upstream!.listen(0, "0.0.0.0", () =>
      r((upstream!.address() as AddressInfo).port),
    ),
  );
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** A POST to the route; fetch can't set Host, so plain http (no agent reuse). */
const post = (): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ ping: 1 });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: edgePort,
        path: "/mcp",
        method: "POST",
        agent: false,
        headers: {
          host: "app.idle.localhost",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let t = "";
        res.on("data", (d: Buffer) => (t += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });

beforeAll(async () => {
  ok = dockerOk();
  if (!ok) return;
  const up = await startUpstream();
  edgePort = await freePort();
  // Under the home dir: Docker Desktop and OrbStack share it with the VM.
  dir = fs.mkdtempSync(path.join(os.homedir(), ".den-test-edge-idle-"));
  const cfg: EdgeConfig = {
    org: "idle",
    domain: "idle.localhost",
    aliases: [],
    image: DEFAULT_TRAEFIK_IMAGE,
    workspaces: [],
    routes: { app: `http://host.docker.internal:${up}` },
    ports: null,
    stateDir: dir,
    tls: { strategy: "none" },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
  };
  fs.writeFileSync(path.join(dir, "edge.yml"), renderEdgeDynamic(cfg));
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      NAME,
      "-p",
      `127.0.0.1:${edgePort}:80`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${dir}:/etc/edge/dynamic:ro`,
      DEFAULT_TRAEFIK_IMAGE,
      ...edgeCommand(cfg),
    ],
    { stdio: "ignore", timeout: 180_000 },
  );
  // Up when the route answers.
  const until = Date.now() + 60_000;
  for (;;) {
    const r = await post().catch(() => null);
    if (r?.status === 200) break;
    if (Date.now() > until) throw new Error("the test edge never routed");
    await new Promise((r) => setTimeout(r, 300));
  }
}, 240_000);

afterAll(async () => {
  if (ok)
    try {
      execFileSync("docker", ["rm", "-f", NAME], {
        stdio: "ignore",
        timeout: 60_000,
      });
    } catch {
      /* already gone */
    }
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("#67: a POST through the edge after idle", () => {
  it("is not a 502: the edge drops an idle upstream connection before the upstream does", async () => {
    if (!ok) return;
    seen.length = 0;
    expect((await post()).status).toBe(200);
    // Longer than the upstream keeps it, longer than the edge's 1 s.
    await new Promise((r) => setTimeout(r, 3000));
    const r = await post();
    expect([r.status, seen]).toEqual([200, ["answered", "answered"]]);
  }, 60_000);
});
