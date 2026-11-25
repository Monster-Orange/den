/**
 * On a real Traefik (the pinned default image), with Docker labels read:
 * a router from a container's labels can't attach the edge's proof.
 * Traefik lets a router from one provider name another provider's
 * middleware, so the labels name Den's proof middleware the way a
 * container would try (`den-edge-proof@file`, directly and through a
 * chain). Only Den's own route may carry the proof; the labelled routers
 * never do.
 *
 * One container: the edge itself carries the labels (its Docker provider
 * reads them over the socket, read-only), and its routers' service is a
 * recorder on this machine that keeps what each request carried. Needs
 * Docker; DEN_SKIP_DOCKER_TESTS=1 (or no Docker) skips it. The container
 * is removed after; every port is a free one.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { DEFAULT_TRAEFIK_IMAGE } from "../../../src/shared/edge/config.js";
import {
  edgeCommand,
  renderEdgeDynamic,
} from "../../../src/shared/edge/render.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";
import { dockerOk, dockerShareTmp, freePort } from "./helpers/docker-edge.js";

const PROOF = crypto.randomBytes(32).toString("hex");
const tag = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const NAME = `den-test-edge-labels-${tag}`;

let ok = false;
let tmp = "";
let edgePort = 0;
let recorder: http.Server | null = null;
/** What each request reaching the recorder carried: its Host and proof. */
const seen: { host: string; proof: string | undefined }[] = [];

function get(host: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: edgePort,
        path: "/",
        method: "GET",
        agent: false,
        headers: { host },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", () => resolve(0));
    req.end();
  });
}

beforeAll(async () => {
  ok = dockerOk();
  if (!ok) return;
  // Docker's share (issue 1356: named to the write guard for this file).
  tmp = fs.realpathSync(dockerShareTmp("edge-labels-"));
  const recPort = await freePort();
  recorder = http.createServer((req, res) => {
    const p = req.headers["x-den-edge-proof"];
    seen.push({
      host: String(req.headers.host ?? ""),
      proof: typeof p === "string" ? p : undefined,
    });
    res.end("ok");
  });
  // Linux: the edge reaches this machine on the bridge, not loopback.
  await new Promise<void>((r) =>
    recorder!.listen(
      recPort,
      process.platform === "linux" ? "0.0.0.0" : "127.0.0.1",
      r,
    ),
  );
  const upstream = `http://host.docker.internal:${recPort}`;
  const cfg = {
    org: "acme",
    domain: "acme.localhost",
    aliases: [],
    image: DEFAULT_TRAEFIK_IMAGE,
    workspaces: [],
    routes: { den: upstream },
    ports: null,
    stateDir: tmp,
    tls: { strategy: "none" },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
  } as unknown as EdgeConfig;
  const dyn = path.join(tmp, "dynamic");
  fs.mkdirSync(dyn, { recursive: true });
  fs.writeFileSync(
    path.join(dyn, "edge.yml"),
    renderEdgeDynamic(cfg, { proof: PROOF, ports: new Set([recPort]) }),
  );
  // The labelled routers' service (a file one: the labels need no port).
  fs.writeFileSync(
    path.join(dyn, "rec.yml"),
    [
      "http:",
      "  services:",
      "    rec:",
      "      loadBalancer:",
      `        servers: [{ url: "${upstream}" }]`,
      "",
    ].join("\n"),
  );
  edgePort = await freePort();
  const router = (name: string, host: string, mw?: string) => [
    "--label",
    `traefik.http.routers.${name}.rule=Host(\`${host}\`)`,
    "--label",
    `traefik.http.routers.${name}.entrypoints=web`,
    "--label",
    `traefik.http.routers.${name}.service=rec@file`,
    ...(mw
      ? ["--label", `traefik.http.routers.${name}.middlewares=${mw}`]
      : []),
  ];
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
      `${dyn}:/etc/edge/dynamic:ro`,
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock:ro",
      "--label",
      "traefik.enable=true",
      // A control: a labelled router with no middleware (the provider is up).
      ...router("plain", "plain.test"),
      ...router("direct", "direct.test", "den-edge-proof@file"),
      "--label",
      "traefik.http.middlewares.grab.chain.middlewares=den-edge-proof@file",
      ...router("chained", "chained.test", "grab@docker"),
      DEFAULT_TRAEFIK_IMAGE,
      ...edgeCommand(cfg),
      // What edge.docker_labels turns on, here over the socket itself.
      "--providers.docker=true",
      "--providers.docker.exposedbydefault=false",
    ],
    { stdio: "ignore", timeout: 240_000 },
  );
  // Up when both providers route: Den's route and the labelled control.
  const until = Date.now() + 90_000;
  while (
    (await get("den.acme.localhost")) !== 200 ||
    (await get("plain.test")) !== 200
  ) {
    if (Date.now() > until) throw new Error("the edge never routed");
    await new Promise((r) => setTimeout(r, 500));
  }
}, 300_000);

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
  if (recorder) await new Promise((r) => recorder!.close(() => r(null)));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}, 90_000);

describe(`a labelled router can't take the proof (${DEFAULT_TRAEFIK_IMAGE})`, () => {
  it("Den's own route carries it", async () => {
    if (!ok) return;
    seen.length = 0;
    expect(await get("den.acme.localhost")).toBe(200);
    expect(seen).toEqual([{ host: "den.acme.localhost", proof: PROOF }]);
  }, 30_000);

  it("a router from labels naming den-edge-proof@file, directly or in a chain, never does", async () => {
    if (!ok) return;
    seen.length = 0;
    for (const host of ["direct.test", "chained.test", "plain.test"])
      await get(host);
    expect(seen.filter((s) => s.proof !== undefined)).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(PROOF);
  }, 30_000);
});
