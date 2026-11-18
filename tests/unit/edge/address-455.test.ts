/**
 * Issue 455, red first: Den never prints an address it hasn't proven
 * reaches THIS Den. The configured edge http port stands in for :80 (no
 * test binds :80). Each case below failed on the code before the fix:
 *
 *  1. A server that isn't Den holds the edge port and answers 404. `web
 *     login` printed the sign-in link on web.url anyway (that 404).
 *  2. The holder listens on IPv6 only, or on one of this machine's other
 *     addresses, as Docker publishes ports. The edge's port check only
 *     connected to 127.0.0.1, so it said "free".
 *  3. Den's edge container is listed as running, but the port's answer
 *     isn't Den. `edge up` skipped the check entirely and went on.
 *
 * No Docker: a stand-in `docker` on PATH answers the few calls `edge up`
 * makes, and the Den is a stub that answers the identity challenge with
 * this state dir's key.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { cmdWebLogin } from "../../../src/ui/cli/web-command.js";
import { edgeUp, portInUse } from "../../../src/shared/edge/runtime.js";
import { ensureWebSecret } from "../../../src/shared/web-secret.js";
import {
  DEN_IDENTITY_PATH,
  identityBody,
  identityKey,
} from "../../../src/shared/den-identity.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

let tmp = "";
const servers: net.Server[] = [];
const savedPath = process.env.PATH;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-455-")));
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

function listen(
  s: net.Server,
  host: string,
  opts: { ipv6Only?: boolean; port?: number } = {},
): Promise<number> {
  servers.push(s);
  return new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen({ host, port: opts.port ?? 0, ipv6Only: opts.ipv6Only }, () =>
      resolve((s.address() as AddressInfo).port),
    );
  });
}

/** A Den: answers the identity challenge with `key`. */
function denStub(key: Buffer): Promise<number> {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === DEN_IDENTITY_PATH) {
      const b = identityBody(key, u.searchParams.get("c"));
      res.writeHead(b ? 200 : 400, { "content-type": "application/json" });
      return res.end(JSON.stringify(b ?? { error: "no challenge" }));
    }
    res.writeHead(200).end("den");
  });
  return listen(s, "127.0.0.1");
}

/** Another project's proxy: 404 to everything, as nginx says it. */
function foreign404(
  host: string,
  opts: { ipv6Only?: boolean; port?: number } = {},
): Promise<number> {
  const s = http.createServer((_req, res) => {
    res.writeHead(404, { server: "nginx/1.27.3", "content-type": "text/html" });
    res.end("<h1>404 Not Found</h1>");
  });
  return listen(s, host, opts);
}

const hasIpv6 = (() => {
  const all = Object.values(os.networkInterfaces()).flat();
  return all.some((a) => a?.family === "IPv6" && a.address === "::1");
})();

/** One of this machine's addresses that isn't loopback, or null. */
const lanV4 = (() => {
  for (const a of Object.values(os.networkInterfaces()).flat())
    if (a && a.family === "IPv4" && !a.internal) return a.address;
  return null;
})();

describe("case 1: a non-Den server answers 404 on the address's port", () => {
  it("web login prints Den's own proven address, never the 404's, and says why", async () => {
    const key = identityKey(ensureWebSecret(tmp));
    const denPort = await denStub(key);
    const held = await foreign404(hasIpv6 ? "::" : "0.0.0.0");
    let out = "";
    let err = "";
    const code = await cmdWebLogin(["--port", String(denPort)], {
      out: (s) => (out += s),
      err: (s) => (err += s),
      stateDir: tmp,
      webUrl: () => ({
        url: `http://den.acme.localhost:${held}`,
        confirmed: true,
      }),
      addressDeps: {
        owner: () => ({
          owner: "nginx",
          kind: "container",
          name: "web-proxy-1",
          denEdge: false,
        }),
      },
    });
    expect(code).toBe(0);
    const link = out.trim();
    // The link is on the address that was just proven to be this Den.
    // eslint-disable-next-line no-restricted-syntax -- the browser's origin the CLI prints
    expect(link.startsWith(`http://localhost:${denPort}/auth?c=`)).toBe(true);
    expect(link).not.toContain("den.acme.localhost");
    // The one sentence, naming what holds the port.
    expect(err).toContain(
      `Port ${held} is held by nginx (Docker container web-proxy-1)`,
    );
    // eslint-disable-next-line no-restricted-syntax -- the words quote the browser's origin
    expect(err).toContain(
      `is at http://localhost:${denPort} until port ${held} is free.`,
    );
  });

  it("with no owner in sight, names what answered from its Server header", async () => {
    const key = identityKey(ensureWebSecret(tmp));
    const denPort = await denStub(key);
    const held = await foreign404(hasIpv6 ? "::" : "0.0.0.0");
    let out = "";
    let err = "";
    await cmdWebLogin(["--port", String(denPort)], {
      out: (s) => (out += s),
      err: (s) => (err += s),
      stateDir: tmp,
      webUrl: () => ({
        url: `http://den.acme.localhost:${held}`,
        confirmed: true,
      }),
      addressDeps: { owner: () => null },
    });
    expect(out).not.toContain("den.acme.localhost");
    expect(err).toContain(`Port ${held} is held by nginx, so`);
  });

  it("when the address answers as this Den, it is the one printed (and nothing more is said)", async () => {
    const key = identityKey(ensureWebSecret(tmp));
    const denPort = await denStub(key);
    let out = "";
    let err = "";
    await cmdWebLogin(["--port", String(denPort)], {
      out: (s) => (out += s),
      err: (s) => (err += s),
      stateDir: tmp,
      // Den's own port, by a .localhost name: it answers as this Den.
      webUrl: () => ({
        url: `http://den.acme.localhost:${denPort}`,
        confirmed: true,
      }),
    });
    expect(out.startsWith(`http://den.acme.localhost:${denPort}/auth?c=`)).toBe(
      true,
    );
    expect(err).not.toMatch(/is held by/);
  });

  it("another Den on the port (a wrong answer) is not this Den", async () => {
    const mine = identityKey(ensureWebSecret(tmp));
    const theirs = identityKey(Buffer.alloc(32, 7));
    const denPort = await denStub(mine);
    const other = await denStub(theirs);
    let out = "";
    await cmdWebLogin(["--port", String(denPort)], {
      out: (s) => (out += s),
      err: () => {},
      stateDir: tmp,
      webUrl: () => ({
        url: `http://den.acme.localhost:${other}`,
        confirmed: true,
      }),
      addressDeps: { owner: () => null },
    });
    expect(out).not.toContain(`den.acme.localhost:${other}`);
  });
});

describe("case 2: the holder listens where 127.0.0.1 doesn't reach", () => {
  const v6 = hasIpv6 ? it : it.skip;
  v6("an IPv6-loopback-only listener ([::1]) holds the port", async () => {
    const p = await foreign404("::1");
    expect(await portInUse(p)).toBe(true);
  });
  v6(
    "an IPv6-wildcard-only listener ([::], v6 only) holds the port",
    async () => {
      const p = await foreign404("::", { ipv6Only: true });
      expect(await portInUse(p)).toBe(true);
    },
  );
  (lanV4 ? it : it.skip)(
    "a listener on one of this machine's other addresses holds the port",
    async () => {
      const p = await foreign404(lanV4!);
      expect(await portInUse(p)).toBe(true);
    },
  );
  it("a free port is free", async () => {
    const s = net.createServer();
    const p = await listen(s, "127.0.0.1");
    await new Promise((r) => s.close(() => r(null)));
    servers.splice(servers.indexOf(s), 1);
    expect(await portInUse(p)).toBe(false);
  });
});

describe("case 3: the edge container is running, but the port's answer isn't Den", () => {
  /** A stand-in docker: the edge `acme-edge` runs and is owned here. */
  function fakeDocker(stateDir: string): void {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "docker"),
      [
        "#!/bin/sh",
        'case "$1 $2" in',
        // existingEdge: owned by this state dir.
        `  "inspect --type") case "$*" in *-f*) echo "${stateDir}|"; exit 0;; esac; exit 1;;`,
        // containerState
        '  "inspect -f") echo running; exit 0;;',
        '  "image inspect") exit 1;;',
        '  "ps "*|"ps --filter") exit 0;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${savedPath}`;
  }

  it("edge up stops and says what answered instead of going on", async () => {
    const key = identityKey(ensureWebSecret(tmp));
    const denPort = await denStub(key);
    const held = await foreign404(hasIpv6 ? "::" : "0.0.0.0");
    const stateDir = path.join(tmp, "edge");
    fs.mkdirSync(stateDir, { recursive: true });
    fakeDocker(stateDir);
    const cfg = {
      org: "acme",
      domain: "acme.localhost",
      aliases: [],
      image: "traefik:v3.7.17",
      workspaces: [],
      routes: { den: `http://host.docker.internal:${denPort}` },
      ports: { http: held, https: held + 1 },
      stateDir,
      defaultStateDir: true,
      tls: { strategy: "none" },
      tlsFrom: "explicit",
      httpsRedirect: false,
      dockerLabels: null,
      include: null,
      mounts: {},
      networks: [],
      args: [],
    } as unknown as EdgeConfig;
    await expect(
      edgeUp(cfg, {
        log: () => {},
        check: { key, webPort: denPort, owner: () => null },
      }),
    ).rejects.toThrow(
      new RegExp(`Port ${held} answers, but it isn't .*: nginx`),
    );
  });
});
