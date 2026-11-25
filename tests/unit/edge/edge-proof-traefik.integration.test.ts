/**
 * H1 (0.4.48) on the real path: a real Traefik, in a throwaway container,
 * in front of a real Den web server, with an edge set up before 0.4.48
 * (its dynamic/edge.yml has no proof). Den adds the proof at its start;
 * the edge picks the file up by watching it, and from then on:
 *
 *   - a request from this machine through the edge hostname needs no
 *     sign-in (the edge carries the proof, so Den believes where it says
 *     the request came from; with web.edge_unattested: local, as a Docker
 *     gateway's address has needed since SEC-2a);
 *   - the same request straight to Den's port, with X-Forwarded-For set by
 *     hand and no proof (what a peer on the Docker network could send),
 *     signs in: 401 signin_required;
 *   - a proof the client sends through the edge is replaced by the edge's.
 *
 * Each Traefik image an install may run (the pinned default and v2.11).
 * Needs Docker; DEN_SKIP_DOCKER_TESTS=1 (or no Docker) skips it. Never
 * touches any other edge: its containers have their own names and are
 * removed, and every port is a free one.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as http from "http";
import * as path from "path";
import type { ChildProcess } from "child_process";
import { DEFAULT_TRAEFIK_IMAGE } from "../../../src/shared/edge/config.js";
import {
  EDGE_ORG_LABEL,
  EDGE_ROOT_LABEL,
  edgeCommand,
  edgeNames,
} from "../../../src/shared/edge/render.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import { dockerOk, dockerShareTmp, freePort } from "./helpers/docker-edge.js";

const ENGINE = path.join(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const IMAGES = [DEFAULT_TRAEFIK_IMAGE, "traefik:v2.11"];
const tag = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
/** This run's own org: Den finds its edge by the name the org gives it. */
const ORG = `acme-${tag}`;
const EDGE_NAME = edgeNames(ORG).container;

let ok = false;
let tmp = "";
/** The fake install and its home: not shared with Docker, so os.tmpdir(). */
let local = "";
let denPort = 0;
let server: ChildProcess | null = null;
const containers: string[] = [];

interface Reply {
  status: number;
  body: string;
}
function get(
  port: number,
  p: string,
  headers: Record<string, string>,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "GET",
        agent: false,
        headers,
      },
      (res) => {
        let t = "";
        res.on("data", (d: Buffer) => (t += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const edgeState = () => path.join(tmp, "edge-state");
const edgeYml = () => path.join(edgeState(), "dynamic", "edge.yml");
/** Where Den writes its dynamic file (an edge.yml is moved there). */
const denYml = () => path.join(edgeState(), "dynamic", "000-den.yml");
const denText = () => {
  try {
    return fs.readFileSync(denYml(), "utf8");
  } catch {
    return "";
  }
};
/** Den's route's hostname (the product's name on the edge's domain). */
const denHost = () => "den.acme.localhost";

function cfg(): EdgeConfig {
  return {
    org: ORG,
    domain: "acme.localhost",
    aliases: [],
    image: DEFAULT_TRAEFIK_IMAGE,
    workspaces: [],
    routes: {},
    ports: null,
    stateDir: edgeState(),
    tls: { strategy: "none" },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
  } as unknown as EdgeConfig;
}

beforeAll(async () => {
  ok = dockerOk();
  if (!ok) return;
  // Only the edge's dynamic folder is mounted: it alone needs Docker's share.
  tmp = fs.realpathSync(dockerShareTmp("edge-proof-"));
  local = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-proof-")),
  );
  denPort = await freePort();
  const root = path.join(local, "dist");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "web:",
      `  port: ${denPort}`,
      "edge:",
      `  org: ${ORG}`,
      "  domain: acme.localhost",
      "  tls: none",
      "",
    ].join("\n"),
  );
  // Docker Desktop and OrbStack hand the edge their gateway's address for
  // this machine (and Linux its bridge's): a client Den can't place, which
  // signs in unless the person says local (SEC-2a, before H1).
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    "web:\n  edge_unattested: local\n",
  );
  // An edge set up before 0.4.48: an edge.yml, no proof yet.
  fs.mkdirSync(path.dirname(edgeYml()), { recursive: true });
  fs.writeFileSync(edgeYml(), "# set up before 0.4.48\n");
  const home = path.join(local, "home");
  const started = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: edgeState(),
        DEN_HOME: path.join(home, ".den"),
        HOME: home,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: String(denPort),
      },
    },
    // The port the edge's route names (web.port), not one of its own.
    { timeoutMs: 40_000, pickPort: () => Promise.resolve(denPort) },
  );
  server = started.server;
  // Den adds the proof to the edge's file once it listens, on its route.
  const until = Date.now() + 20_000;
  while (!denText().includes("X-Den-Edge-Proof"))
    if (Date.now() > until) throw new Error("Den never wrote the proof");
    else await new Promise((r) => setTimeout(r, 200));
}, 90_000);

afterAll(async () => {
  for (const c of [...new Set(containers)])
    try {
      execFileSync("docker", ["rm", "-f", c], {
        stdio: "ignore",
        timeout: 60_000,
      });
    } catch {
      /* already gone */
    }
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (local) fs.rmSync(local, { recursive: true, force: true });
}, 120_000);

/**
 * A throwaway edge on `image`, reading Den's dynamic folder. Named and
 * labelled as edge up does (Den finds its edge by all three), so one at a
 * time: stopEdge removes it.
 */
async function startEdge(image: string): Promise<number> {
  const name = EDGE_NAME;
  const port = await freePort();
  containers.push(name);
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:80`,
      "--add-host",
      "host.docker.internal:host-gateway",
      // How Den finds the edge container's own address (isEdgePeer).
      "--label",
      `${EDGE_ROOT_LABEL}=${fs.realpathSync(edgeState())}`,
      "--label",
      `${EDGE_ORG_LABEL}=${ORG}`,
      "-v",
      `${path.dirname(edgeYml())}:/etc/edge/dynamic:ro`,
      image,
      ...edgeCommand(cfg()),
    ],
    { stdio: "ignore", timeout: 240_000 },
  );
  // Up when Den's route answers through it.
  const until = Date.now() + 60_000;
  for (;;) {
    const r = await get(port, "/api/health", { host: denHost() }).catch(
      () => null,
    );
    // 421: Den hasn't read this new edge's address yet (Linux); a miss
    // makes it read again.
    if (r && ![404, 421, 502].includes(r.status)) return port;
    if (Date.now() > until) {
      const rules = denText()
        .split("\n")
        .filter((l) => /rule:|url:|entryPoints/.test(l))
        .join("\n");
      let log = "";
      try {
        log = execFileSync("docker", ["logs", "--tail", "15", name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        log = String((e as { stderr?: string }).stderr ?? e);
      }
      throw new Error(
        `the ${image} edge never routed (last: ${r?.status ?? "no answer"})\n${rules}\n${log}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function stopEdge(): void {
  try {
    execFileSync("docker", ["rm", "-f", EDGE_NAME], {
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    /* already gone */
  }
}

describe.each(IMAGES)("H1 on a real edge (%s)", (image) => {
  let edgePort = 0;
  beforeAll(async () => {
    if (ok) edgePort = await startEdge(image);
  }, 300_000);
  afterAll(() => {
    if (ok) stopEdge();
  }, 90_000);

  it("this machine through the edge hostname: no sign-in", async () => {
    if (!ok) return;
    const r = await get(edgePort, "/api/settings", { host: denHost() });
    expect([r.status, /signin_required/.test(r.body)]).toEqual([200, false]);
  }, 30_000);

  it("the edge serves no Traefik API or dashboard: not on its hostname, not inside the container", async () => {
    if (!ok) return;
    for (const p of ["/api/rawdata", "/api/http/middlewares", "/dashboard/"])
      expect([
        p,
        (await get(edgePort, p, { host: "edge.acme.localhost" })).status,
      ]).toEqual([p, 404]);
    const name = EDGE_NAME;
    let inside = "";
    try {
      inside = execFileSync(
        "docker",
        ["exec", name, "wget", "-qO-", "http://127.0.0.1:8080/api/rawdata"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      /* 404 or nothing listening: wget fails */
    }
    expect(inside).not.toContain("X-Den-Edge-Proof");
  }, 30_000);

  it("a client's own proof through the edge is replaced by the edge's", async () => {
    if (!ok) return;
    const r = await get(edgePort, "/api/settings", {
      host: denHost(),
      "x-den-edge-proof": "0".repeat(64),
    });
    expect(r.status).toBe(200);
  }, 30_000);
});

/**
 * 0.4.48: another container on this machine's Docker network, straight to
 * Den (on Linux, Den's listener on the bridge's gateway; on macOS, Docker
 * delivers host.docker.internal to loopback), with X-Forwarded-For set by
 * hand and no proof. `000`: nothing answered (Linux before 0.4.48).
 */
function fromContainer(host: string, proof?: string): string {
  const name = `den-test-bridge-peer-${tag}`;
  containers.push(name);
  return execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      "curlimages/curl:8.10.1",
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "20",
      "-H",
      `Host: ${host}`,
      "-H",
      "X-Forwarded-For: 127.0.0.1",
      ...(proof ? ["-H", `X-Den-Edge-Proof: ${proof}`] : []),
      `http://host.docker.internal:${denPort}/api/settings`,
    ],
    { encoding: "utf8", timeout: 240_000 },
  ).trim();
}

describe("Den on the Docker bridge (0.4.48)", () => {
  it("a container sending the edge's hostname and X-Forwarded-For: 127.0.0.1 by hand, no proof: 401 (Linux: 421, not the edge)", async () => {
    if (!ok) return;
    // Linux: its own address, not the edge container's: not the edge at
    // all. macOS: Docker delivers it to loopback, and without the proof it
    // signs in.
    expect(fromContainer(denHost())).toBe(
      process.platform === "linux" ? "421" : "401",
    );
  }, 300_000);

  it("on Linux, a container with the right proof and X-Forwarded-For: 127.0.0.1 is still not the edge: 421", async () => {
    if (!ok || process.platform !== "linux") return;
    const proof = fs
      .readFileSync(path.join(edgeState(), "den-edge-proof"), "utf8")
      .trim();
    expect(fromContainer(denHost(), proof)).toBe("421");
  }, 300_000);

  it("on Linux, a container sending Host 127.0.0.1 by hand: still beyond loopback, 401", async () => {
    // macOS: Docker hands host.docker.internal to loopback; no bridge peer.
    if (!ok || process.platform !== "linux") return;
    expect(fromContainer(`127.0.0.1:${denPort}`)).toBe("401");
  }, 300_000);
});

describe("H1 without the edge", () => {
  it("straight to Den's port with X-Forwarded-For by hand and no proof: 401 signin_required, whatever edge_unattested says", async () => {
    if (!ok) return;
    const r = await get(denPort, "/api/settings", {
      host: denHost(),
      "x-forwarded-for": "127.0.0.1",
    });
    expect([r.status, /signin_required/.test(r.body)]).toEqual([401, true]);
  }, 30_000);
});
