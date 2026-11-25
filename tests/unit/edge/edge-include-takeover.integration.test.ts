/**
 * On a real Traefik (the pinned default image): an included dynamic file
 * can't take Den's route over. Traefik's file provider reads the dynamic
 * folder in name order and keeps the first definition of a name, and Den's
 * router and service names can be worked out from the config
 * (`route-<name>`). So:
 *
 *   - an include that defines one of Den's names (here `services.route-den`,
 *     pointing at a collector), or that would sort before Den's own file,
 *     is refused by syncIncluded and never copied;
 *   - one whose names Den can't read (a Go template, which Traefik renders)
 *     is copied, but Den's own file sorts first, so Den's definition wins.
 *
 * Either way the collector never sees the proof, and Den's route still
 * carries it to Den. One container, removed after. Needs Docker;
 * DEN_SKIP_DOCKER_TESTS=1 (or no Docker) skips it. Every port is a free one.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { DEFAULT_TRAEFIK_IMAGE } from "../../../src/shared/edge/config.js";
import { readEdgeProof } from "../../../src/shared/edge/proof.js";
import { edgeCommand } from "../../../src/shared/edge/render.js";
import {
  syncEdgeProof,
  syncIncluded,
} from "../../../src/shared/edge/runtime.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";
import { dockerOk, dockerShareTmp, freePort } from "./helpers/docker-edge.js";

const tag = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const NAME = `den-test-edge-include-${tag}`;

let ok = false;
let tmp = "";
let edgePort = 0;
let proof = "";
const servers: http.Server[] = [];
/** What reached each upstream: Den's and the collector's. */
const seen: Record<"den" | "collector", (string | undefined)[]> = {
  den: [],
  collector: [],
};
const refusals: string[] = [];

async function recorder(who: "den" | "collector"): Promise<number> {
  const port = await freePort();
  const s = http.createServer((req, res) => {
    const p = req.headers["x-den-edge-proof"];
    seen[who].push(typeof p === "string" ? p : undefined);
    res.end(who);
  });
  servers.push(s);
  // Linux: the edge reaches this machine on the bridge, not loopback.
  await new Promise<void>((r) =>
    s.listen(port, process.platform === "linux" ? "0.0.0.0" : "127.0.0.1", r),
  );
  return port;
}

function get(host: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: edgePort,
        path: "/",
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
  tmp = fs.realpathSync(dockerShareTmp("edge-include-"));
  const denPort = await recorder("den");
  const collector = `http://host.docker.internal:${await recorder("collector")}`;
  const cfg = {
    org: "acme",
    domain: "acme.localhost",
    aliases: [],
    image: DEFAULT_TRAEFIK_IMAGE,
    workspaces: [],
    routes: { den: `http://host.docker.internal:${denPort}` },
    ports: null,
    stateDir: path.join(tmp, "state"),
    tls: { strategy: "none" },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
  } as unknown as EdgeConfig;
  const dyn = path.join(cfg.stateDir, "dynamic");
  // An edge set up here before: its generated file, with no proof yet.
  fs.mkdirSync(dyn, { recursive: true });
  fs.writeFileSync(path.join(dyn, "edge.yml"), "# set up before\n");
  const takeover = (name: string) =>
    [
      "http:",
      "  services:",
      `    ${name}:`,
      "      loadBalancer:",
      `        servers: [{ url: "${collector}" }]`,
      "",
    ].join("\n");
  const sync = (files: Record<string, string>) => {
    const inc = path.join(tmp, `include-${Object.keys(files).join("-")}`);
    fs.mkdirSync(inc, { recursive: true });
    for (const [f, text] of Object.entries(files))
      fs.writeFileSync(path.join(inc, f), text);
    try {
      syncIncluded({ ...cfg, include: inc });
    } catch (e) {
      refusals.push((e as Error).message);
    }
  };
  // A Go template Den can't read names from: it sorts after Den's file.
  sync({ "a.yml": takeover('{{ print "route-den" }}') });
  // Plain, and named to sort first: refused.
  sync({ "00-x.yml": takeover("route-den") });
  // Den's start writes its own file with the proof.
  syncEdgeProof(cfg, new Set([denPort]));
  proof = readEdgeProof(cfg.stateDir) ?? "";
  edgePort = await freePort();
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
      DEFAULT_TRAEFIK_IMAGE,
      ...edgeCommand(cfg),
    ],
    { stdio: "ignore", timeout: 240_000 },
  );
  const until = Date.now() + 90_000;
  while ((await get("den.acme.localhost")) !== 200) {
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
  for (const s of servers) await new Promise((r) => s.close(() => r(null)));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}, 90_000);

describe(`an include can't take Den's route over (${DEFAULT_TRAEFIK_IMAGE})`, () => {
  it("the include defining Den's service and sorting first is refused, naming the key", () => {
    if (!ok) return;
    expect(refusals).toEqual([
      expect.stringMatching(/^edge\.include: 00-x\.yml /),
    ]);
  });

  it("requests to Den's hostname reach Den with the proof; the collector gets nothing", async () => {
    if (!ok) return;
    seen.den.length = 0;
    seen.collector.length = 0;
    for (let i = 0; i < 3; i++) await get("den.acme.localhost");
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.collector).toEqual([]);
    expect(seen.den).toEqual([proof, proof, proof]);
  }, 30_000);
});
