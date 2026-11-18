/**
 * Issue 455, clause 8: a route snippet that hasn't been run doesn't ship.
 * Each of Den's routes for another proxy (proxy-route.ts: nginx, Caddy,
 * Traefik) runs here in that proxy's official image, at an exact version,
 * in front of a Den stub that answers the identity challenge. The identity
 * probe through each must answer as Den; a name the route doesn't cover
 * must not.
 *
 * Needs Docker; DEN_SKIP_DOCKER_TESTS=1 (or no Docker) skips it. Its
 * containers are its own (den455-<proxy>-<run>), on free ports, and are
 * removed after. With DEN455_PROOF_DIR set, each proxy's config and the
 * probe's output are written there (the lane's evidence).
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
  identityBody,
  identityKey,
  probeIdentity,
  type ProbeResult,
} from "../../../src/shared/den-identity.js";
import {
  proxyRoute,
  type ProxyKind,
} from "../../../src/shared/edge/proxy-route.js";
import { DEFAULT_TRAEFIK_IMAGE } from "../../../src/shared/edge/config.js";
import { dockerOk, freePort } from "./helpers/docker-edge.js";

/** Each proxy's official image, at an exact version. */
const IMAGES: Record<ProxyKind, string> = {
  nginx: "nginx:1.27.5-alpine",
  caddy: "caddy:2.8.4-alpine",
  traefik: DEFAULT_TRAEFIK_IMAGE,
};
const HOST = "den.acme.localhost";
const tag = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const KEY = identityKey(crypto.randomBytes(32));
const PROOF = process.env.DEN455_PROOF_DIR?.trim() || "";

let ok = false;
let tmp = "";
let denPort = 0;
let den: http.Server | null = null;
const containers: string[] = [];

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf-8", timeout: 180_000 });
}

/** The container's config for `kind`: where it goes, and the command. */
function setup(kind: ProxyKind, dir: string, snippet: string) {
  if (kind === "nginx") {
    fs.writeFileSync(path.join(dir, "den.conf"), snippet + "\n");
    return {
      file: "den.conf",
      mount: [`${path.join(dir, "den.conf")}:/etc/nginx/conf.d/den.conf:ro`],
      cmd: [] as string[],
    };
  }
  if (kind === "caddy") {
    fs.writeFileSync(path.join(dir, "Caddyfile"), snippet + "\n");
    return {
      file: "Caddyfile",
      mount: [`${path.join(dir, "Caddyfile")}:/etc/caddy/Caddyfile:ro`],
      cmd: [] as string[],
    };
  }
  fs.writeFileSync(path.join(dir, "den.yml"), snippet + "\n");
  return {
    file: "den.yml",
    mount: [`${dir}:/etc/traefik/dynamic:ro`],
    cmd: [
      "--entrypoints.web.address=:80",
      "--providers.file.directory=/etc/traefik/dynamic",
    ],
  };
}

async function until(
  fn: () => Promise<ProbeResult>,
  ms: number,
): Promise<ProbeResult> {
  const end = Date.now() + ms;
  let last = await fn();
  while (!last.ok && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 500));
    last = await fn();
  }
  return last;
}

beforeAll(async () => {
  ok = dockerOk();
  if (!ok) return;
  // Under the home dir: Docker Desktop and OrbStack share it with the VM.
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.homedir(), ".den-test-455-")),
  );
  // The Den stub. Linux containers reach the host on its bridge, so there
  // it listens on every address; elsewhere loopback (the VM forwards).
  den = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/den-identity") {
      const b = identityBody(KEY, u.searchParams.get("c"));
      res.writeHead(b ? 200 : 400, { "content-type": "application/json" });
      return res.end(JSON.stringify(b ?? {}));
    }
    res.writeHead(200).end("den stub");
  });
  await new Promise<void>((r) =>
    den!.listen(0, process.platform === "linux" ? "0.0.0.0" : "127.0.0.1", r),
  );
  denPort = (den.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  for (const c of containers)
    try {
      execFileSync("docker", ["rm", "-f", c], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  await new Promise((r) => (den ? den.close(() => r(null)) : r(null)));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}, 60_000);

describe.each(Object.keys(IMAGES) as ProxyKind[])(
  "the %s route, in its official image",
  (kind) => {
    it("answers as Den through the proxy; another name does not", async () => {
      if (!ok) return;
      const listen = 80;
      const snippet = proxyRoute(kind, {
        host: HOST,
        listen,
        upstreamHost: "host.docker.internal",
        upstreamPort: denPort,
        name: "den",
      });
      const dir = path.join(tmp, kind);
      fs.mkdirSync(dir, { recursive: true });
      const s = setup(kind, dir, snippet);
      const hostPort = await freePort();
      const name = `den455-${kind}-${tag}`;
      containers.push(name);
      docker([
        "run",
        "-d",
        "--name",
        name,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-p",
        `127.0.0.1:${hostPort}:${listen}`,
        ...s.mount.flatMap((m) => ["-v", m]),
        IMAGES[kind],
        ...s.cmd,
      ]);
      const opts = { key: KEY, timeoutMs: 3000, retries: 0 };
      const through = await until(
        () => probeIdentity(`http://${HOST}:${hostPort}`, opts),
        60_000,
      );
      const other = await probeIdentity(
        `http://other.acme.localhost:${hostPort}`,
        opts,
      );
      if (PROOF) {
        const out = path.join(PROOF, kind);
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, s.file), snippet + "\n");
        fs.writeFileSync(
          path.join(out, "probe.json"),
          JSON.stringify(
            {
              image: IMAGES[kind],
              container: name,
              hostPort,
              denStubPort: denPort,
              at: new Date().toISOString(),
              through: { url: through.url, ok: through.ok, hits: through.hits },
              otherName: { url: other.url, ok: other.ok, hits: other.hits },
            },
            null,
            2,
          ) + "\n",
        );
      }
      try {
        expect([kind, through.ok]).toEqual([kind, true]);
        expect([kind, other.ok]).toEqual([kind, false]);
      } finally {
        if (!through.ok)
          // eslint-disable-next-line no-console -- why a proxy failed, in CI's log
          console.log(docker(["logs", "--tail", "40", name]));
      }
    }, 240_000);
  },
);
