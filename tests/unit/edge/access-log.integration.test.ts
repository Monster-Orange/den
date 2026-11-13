/**
 * #63: through a real Traefik (the pinned image, in its own throwaway
 * container), a one-time token in a path or query never reaches the
 * access log Den keeps. Traefik writes its raw lines to the 0600 file Den
 * made; one sweep masks them into edge-access.log and empties the file;
 * Traefik keeps appending to it after. The request id in Den's line is
 * the trace id the upstream got in `traceparent`.
 *
 * Needs Docker; DEN_SKIP_DOCKER_TESTS=1 (or no Docker) skips it. Never
 * touches any other edge: its container has its own name and is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  readAccessLogConfig,
  requestIdOf,
} from "../../../src/shared/edge/access-log.js";
import {
  accessPaths,
  prepareAccessRaw,
  sweepAccessLog,
} from "../../../src/shared/edge/access-sweep.js";
import { DEFAULT_TRAEFIK_IMAGE } from "../../../src/shared/edge/config.js";
import {
  EDGE_ACCESS_DIR,
  edgeCommand,
  renderEdgeDynamic,
} from "../../../src/shared/edge/render.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";
import { dockerOk, freePort } from "./helpers/docker-edge.js";

const NAME = `den-test-edge-access-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const SECRET = `tok-${crypto.randomBytes(8).toString("hex")}`;
const on = readAccessLogConfig(true);

let ok = false;
let upstream: http.Server | null = null;
let dir = "";
let edgePort = 0;
/** The traceparent each upstream request carried. */
const traceparents: string[] = [];

const get = (p: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: edgePort,
        path: p,
        agent: false,
        headers: { host: "app.access.localhost" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });

/** The raw file's text, without the NUL hole a Docker VM share leaves. */
const rawText = () =>
  fs.readFileSync(accessPaths(dir).raw, "utf-8").replace(/\0+/g, "");
const rawLines = () => rawText().split("\n").filter(Boolean).length;

async function until(what: string, f: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  ok = dockerOk();
  if (!ok) return;
  upstream = http.createServer((req, res) => {
    if (req.url !== "/ready")
      traceparents.push(String(req.headers.traceparent));
    res.end("ok");
  });
  await new Promise<void>((r) => upstream!.listen(0, "0.0.0.0", r));
  const up = (upstream.address() as AddressInfo).port;
  edgePort = await freePort();
  // Under the home dir: Docker Desktop and OrbStack share it with the VM.
  dir = fs.mkdtempSync(path.join(os.homedir(), ".den-test-edge-access-"));
  const cfg: EdgeConfig = {
    org: "access",
    domain: "access.localhost",
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
    accessLog: on,
  };
  fs.mkdirSync(path.join(dir, "dynamic"));
  fs.writeFileSync(
    path.join(dir, "dynamic", "edge.yml"),
    renderEdgeDynamic(cfg),
  );
  prepareAccessRaw(dir);
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
      `${path.join(dir, "dynamic")}:/etc/edge/dynamic:ro`,
      "-v",
      `${accessPaths(dir).dir}:${EDGE_ACCESS_DIR}`,
      DEFAULT_TRAEFIK_IMAGE,
      ...edgeCommand(cfg),
    ],
    { stdio: "ignore", timeout: 180_000 },
  );
  const end = Date.now() + 60_000;
  while ((await get("/ready").catch(() => 0)) !== 200) {
    if (Date.now() > end) throw new Error("the test edge never routed");
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

describe("#63: the edge's access log through a real Traefik", () => {
  it("keeps no one-time token, and the request id is the upstream's trace id", async () => {
    if (!ok) return;
    // The readiness probes' lines (Traefik logs after it answers): swept.
    await until("the probe that routed is logged", () =>
      rawText().includes('"DownstreamStatus":200'),
    );
    sweepAccessLog(dir, on);
    traceparents.length = 0;
    expect(await get(`/cb?code=${SECRET}&state=x`)).toBe(200);
    expect(await get(`/auth/link/${SECRET}`)).toBe(200);
    await until("Traefik wrote both lines", () => rawLines() >= 2);
    // The raw lines do have it: what Den is there to take out.
    expect(rawText()).toContain(SECRET);
    expect(fs.statSync(accessPaths(dir).raw).mode & 0o777).toBe(0o600);

    expect(sweepAccessLog(dir, on).kept).toBeGreaterThanOrEqual(2);
    const kept = fs.readFileSync(accessPaths(dir).log, "utf-8");
    expect(kept).not.toContain(SECRET);
    const lines = kept
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, string>)
      .filter((l) => l.RequestPath !== "/ready"); // a late probe line
    expect(lines.map((l) => l.RequestPath)).toEqual([
      "/cb?code=[redacted]&state=x",
      "/auth/link/[redacted]",
    ]);
    expect(lines.map((l) => l.request_id)).toEqual(
      traceparents.map((t) => requestIdOf(t)),
    );
    expect(lines[0].request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.statSync(accessPaths(dir).raw).size).toBe(0);

    // Emptied under it, Traefik keeps appending from the start.
    expect(await get("/after")).toBe(200);
    await until("Traefik wrote after the sweep", () => rawLines() >= 1);
    expect(sweepAccessLog(dir, on).kept).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(accessPaths(dir).log, "utf-8")).toContain(
      '"RequestPath":"/after"',
    );
  }, 90_000);
});
