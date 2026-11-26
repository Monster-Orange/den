import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { checkAddress } from "../../../src/shared/edge/address-check.js";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import { assertEdgePorts } from "../../../src/shared/edge/runtime.js";
import {
  identityBody,
  probeIdentity,
} from "../../../src/shared/den-identity.js";
import { pingHttp } from "../../../src/shared/environment-manager/health.js";
import { denWebBase } from "../../../src/shared/web-dial.js";
import { localhostOrigin } from "../../../src/shared/web-session.js";

const KEY = Buffer.alloc(32, 7);
const servers: http.Server[] = [];
let port = 0;
let alone = 0;
const v6 = Object.values(os.networkInterfaces())
  .flat()
  .some((a) => a?.address === "::1");
const it6 = v6 ? it : it.skip;

const listen = (s: http.Server, host: string, p: number) =>
  new Promise<boolean>((ok) => {
    s.once("error", () => ok(false));
    s.listen(p, host, () => ok(true));
  });

const den = () =>
  http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/api/den-identity") {
      res.writeHead(503).end("den here");
      return;
    }
    const b = identityBody(KEY, u.searchParams.get("c"));
    res.writeHead(b ? 200 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify(b ?? {}));
  });

beforeAll(async () => {
  const shared = den();
  const own = den();
  servers.push(shared, own);
  await listen(shared, "127.0.0.1", 0);
  await listen(own, "127.0.0.1", 0);
  port = (shared.address() as AddressInfo).port;
  alone = (own.address() as AddressInfo).port;
  const stranger = http.createServer((_req, res) =>
    res.writeHead(200, { server: "stranger" }).end("{}"),
  );
  servers.push(stranger);
  if (v6) await listen(stranger, "::1", port);
});

afterAll(async () => {
  for (const s of servers)
    await new Promise((r) => (s.listening ? s.close(() => r(null)) : r(null)));
});

const settings = { timeoutMs: 2_000, retries: 0, cacheMs: 0 };

describe("issue 1667: Den's checks dial where its server binds, never localhost", () => {
  it6(
    "the address check proves Den's own port with a stranger on ::1 at the same port, and gives the bound address, not localhost",
    async () => {
      const s = await checkAddress({
        webPort: port,
        wanted: null,
        key: KEY,
        settings,
        probe: probeIdentity,
      });
      expect([s.directOk, s.direct, s.address]).toEqual([
        true,
        denWebBase(port, undefined),
        denWebBase(port, undefined),
      ]);
    },
  );

  it("the address check gives localhost when localhost answers as this Den", async () => {
    const s = await checkAddress({
      webPort: alone,
      wanted: null,
      key: KEY,
      settings,
      probe: probeIdentity,
    });
    expect([s.directOk, s.direct, s.address]).toEqual([
      true,
      localhostOrigin(alone),
      localhostOrigin(alone),
    ]);
  });

  it6(
    "the edge's port check proves Den's own port with a stranger on ::1 at the same port",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1667-"));
      fs.mkdirSync(path.join(dir, "config", "local"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "config", "den.yml"),
        "brand:\n  name: Acme\nedge:\n  org: acme\n  domain: local.example.com\n",
      );
      const cfg = {
        ...readEdgeConfig(dir),
        ports: { http: 18080, https: 18443 },
        routes: { den: `http://host.docker.internal:${port}` },
      };
      const lines: string[] = [];
      const asked: string[] = [];
      await assertEdgePorts(cfg, {
        key: KEY,
        webPort: port,
        state: () => "running",
        owner: () => null,
        log: (l) => void lines.push(l),
        probe: async (url, o) => {
          asked.push(url);
          if (asked.length > 1) return { ok: true, url, hits: [], other: null };
          return probeIdentity(url, o);
        },
      });
      fs.rmSync(dir, { recursive: true, force: true });
      expect(lines).toEqual([]);
      expect(asked).toHaveLength(2);
    },
  );

  it6(
    "the health fallback for a bare service name reaches 127.0.0.1, not a stranger on ::1",
    async () => {
      const r = await pingHttp(
        `http://den-1667-nowhere:${port}/healthz`,
        2_000,
      );
      expect(r.ok).toBe(false);
      expect(r.status).toBe(503);
    },
  );
});
