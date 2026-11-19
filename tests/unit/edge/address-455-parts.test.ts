/**
 * Issue 455: the parts behind "Den never prints an address it hasn't
 * proven": the identity challenge, who holds a port, the words (en, es,
 * ja, even), the routes for another proxy, doctor's lines, the server's
 * routes (identity, the check, Check again, Take over).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  DEN_IDENTITY_PATH,
  identityAnswer,
  identityBody,
  identityKey,
  probeIdentity,
  probeTargets,
} from "../../../src/shared/den-identity.js";
import {
  ADDRESS_WORDS,
  addressWord,
} from "../../../src/shared/edge/address-words.js";
import {
  addressCheckSettings,
  checkAddress,
  doctorAddressLines,
  noticeLine,
  serverName,
  type AddressState,
} from "../../../src/shared/edge/address-check.js";
import {
  containerOnPort,
  imageShortName,
  processOnPort,
} from "../../../src/shared/edge/port-owner.js";
import {
  proxyKindOf,
  proxyRoute,
  proxyRoutes,
} from "../../../src/shared/edge/proxy-route.js";
import {
  handleAddressRoutes,
  resetAddressCache,
  type AddressRouteDeps,
} from "../../../src/ui/server/address-routes.js";

const KEY = identityKey(Buffer.alloc(32, 1));

describe("the identity challenge", () => {
  it("answers only a challenge, and differently per key and per challenge", () => {
    const c = "ab".repeat(16);
    expect(identityAnswer(KEY, "not hex")).toBeNull();
    expect(identityAnswer(KEY, "")).toBeNull();
    expect(identityAnswer(KEY, c)).toMatch(/^[0-9a-f]{64}$/);
    expect(identityAnswer(KEY, c)).not.toBe(
      identityAnswer(identityKey(Buffer.alloc(32, 2)), c),
    );
    expect(identityAnswer(KEY, c)).not.toBe(
      identityAnswer(KEY, "cd".repeat(16)),
    );
    expect(identityBody(KEY, c)).toEqual({
      den: "identity",
      answer: identityAnswer(KEY, c),
    });
  });
  it("its key is its own, not web.secret (the route is no oracle for sessions)", () => {
    const secret = Buffer.alloc(32, 1);
    expect(identityKey(secret).equals(secret)).toBe(false);
  });
  it("the route table's path is the probe's", () => {
    expect(DEN_IDENTITY_PATH).toBe("/api/den-identity");
  });
  it("a loopback name is probed where a browser goes: both loopbacks", async () => {
    expect(await probeTargets("den.acme.localhost")).toEqual([
      "127.0.0.1",
      "::1",
    ]);
    expect(await probeTargets("localhost")).toEqual(["127.0.0.1", "::1"]);
    expect(await probeTargets("[::1]")).toEqual(["::1"]);
    expect(
      await probeTargets("den.example.com", async () => [
        "192.0.2.1",
        "192.0.2.1",
      ]),
    ).toEqual(["192.0.2.1"]);
  });
});

describe("who holds a port", () => {
  it("a container publishing it: its image's short name and its own name", () => {
    const run = (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("publish=8080")
        ? { code: 0, out: "web-proxy-1\tnginx:1.27.3-alpine\t<no value>\n" }
        : { code: 1, out: "" };
    expect(containerOnPort(8080, run)).toEqual({
      owner: "nginx",
      kind: "container",
      name: "web-proxy-1",
      denEdge: false,
    });
  });
  it("an old Den edge carries the edge's label", () => {
    const run = () => ({
      code: 0,
      out: "acme-edge\ttraefik:v3.7.17\t/home/x/edge\n",
    });
    expect(containerOnPort(80, run)?.denEdge).toBe(true);
  });
  it("a process: its command and pid (lsof)", () => {
    const run = (cmd: string) =>
      cmd === "lsof"
        ? { code: 0, out: "p4242\ncnginx\nf6\n" }
        : { code: 1, out: "" };
    expect(processOnPort(80, run)).toEqual({
      owner: "nginx",
      kind: "process",
      name: "4242",
      denEdge: false,
    });
  });
  it("names from images and Server headers", () => {
    expect(
      imageShortName("registry.example/library/nginx:1.27@sha256:00"),
    ).toBe("nginx");
    expect(imageShortName("caddy")).toBe("caddy");
    expect(serverName("nginx/1.27.3 (Ubuntu)")).toBe("nginx");
    expect(serverName("")).toBeNull();
  });
});

describe("the words, in every language the UI ships", () => {
  const ph = (s: string) =>
    [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it("es and ja have every en line, with the same placeholders", () => {
    const en = ADDRESS_WORDS.en;
    for (const lang of ["es", "ja"] as const) {
      const tr = ADDRESS_WORDS[lang];
      expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as (keyof typeof en)[])
        expect([lang, k, ph(tr[k])]).toEqual([lang, k, ph(en[k])]);
    }
  });
  it("mock v3's notice, word for word (its samples filled in)", () => {
    expect(
      addressWord("en", "held", {
        port: 80,
        owner: "nginx",
        kind: addressWord("en", "kind.container"),
        name: "web-proxy-1",
        title: "Den",
        address: "http://localhost:7777",
      }),
    ).toBe(
      "Port 80 is held by nginx (Docker container web-proxy-1), so Den's own proxy did not start. Den is at http://localhost:7777 until port 80 is free.",
    );
    expect(
      addressWord("en", "unknown", {
        port: 80,
        title: "Den",
        address: "http://localhost:7777",
      }),
    ).toBe(
      "Port 80 is in use by something Den cannot name. Den is at http://localhost:7777 until it is free.",
    );
  });
});

describe("the routes for another proxy", () => {
  const t = {
    host: "den.acme.localhost",
    listen: 80,
    upstreamHost: "host.docker.internal",
    upstreamPort: 7777,
    name: "den",
  };
  it("nginx: mock v3's block (with HTTP/1.1, which its Upgrade lines need)", () => {
    expect(proxyRoute("nginx", t)).toBe(
      [
        "server {",
        "  listen 80;",
        "  server_name den.acme.localhost;",
        "  location / {",
        "    proxy_pass http://host.docker.internal:7777;",
        "    proxy_http_version 1.1;",
        "    proxy_set_header Host $host;",
        "    proxy_set_header Upgrade $http_upgrade;",
        '    proxy_set_header Connection "upgrade";',
        "  }",
        "}",
      ].join("\n"),
    );
  });
  it("Caddy and Traefik: the same route", () => {
    const r = proxyRoutes(t);
    expect(r.caddy).toBe(
      "http://den.acme.localhost {\n  reverse_proxy host.docker.internal:7777\n}",
    );
    expect(r.traefik).toContain('rule: "Host(`den.acme.localhost`)"');
    expect(r.traefik).toContain('- url: "http://host.docker.internal:7777"');
    expect(proxyRoute("caddy", { ...t, listen: 8080 })).toMatch(
      /^http:\/\/den\.acme\.localhost:8080 \{/,
    );
  });
  it("the kind in front, from what holds the port", () => {
    expect(proxyKindOf("nginx")).toBe("nginx");
    expect(proxyKindOf("caddy")).toBe("caddy");
    expect(proxyKindOf("traefik")).toBe("traefik");
    expect(proxyKindOf(null)).toBe("nginx");
  });
});

/** A stand-in probe: `den` for the listed origins, a 404 from nginx for the rest. */
function fakeProbe(den: string[], other: string[] = []) {
  return async (url: string) => {
    const origin = new URL(url).origin;
    if (den.includes(origin))
      return {
        ok: true,
        url: origin,
        hits: [{ kind: "den" as const, at: "127.0.0.1" }],
        other: null,
      };
    if (other.includes(origin)) {
      const o = {
        kind: "other" as const,
        at: "127.0.0.1",
        status: 404,
        server: "nginx/1.27.3",
        otherDen: false,
      };
      return { ok: false, url: origin, hits: [o], other: o };
    }
    return {
      ok: false,
      url: origin,
      hits: [{ kind: "refused" as const, at: "127.0.0.1" }],
      other: null,
    };
  };
}

// eslint-disable-next-line no-restricted-syntax -- the browser's origin Den prints
const DIRECT = "http://localhost:7777";
const WANTED = "http://den.acme.localhost";

describe("the port Den states and every route's port are one (Den Design)", () => {
  // One source: the port Den's server listens on. The address Den gives
  // (direct) and the upstream of the nginx, Caddy and Traefik routes all
  // come from it, so a card or notice can never name one port while its
  // snippet sends to another.
  for (const webPort of [7777, 8088, 55429]) {
    it(`port ${webPort}`, async () => {
      const direct = `http://localhost:${webPort}`;
      const s = await checkAddress({
        webPort,
        wanted: WANTED,
        key: KEY,
        settings: { timeoutMs: 1000, retries: 0, cacheMs: 0 },
        probe: fakeProbe([direct], [WANTED]),
        owner: () => ({
          owner: "nginx",
          kind: "container",
          name: "web-proxy-1",
          denEdge: false,
        }),
      });
      expect([s.direct, s.address]).toEqual([direct, direct]);
      const stated = Number(new URL(s.address!).port);
      const ports = Object.entries(s.routes ?? {}).map(([k, r]) => [
        k,
        [...r.matchAll(/host\.docker\.internal:(\d+)/g)].map((m) =>
          Number(m[1]),
        ),
      ]);
      expect(ports).toEqual([
        ["nginx", [stated]],
        ["caddy", [stated]],
        ["traefik", [stated]],
      ]);
    });
  }
});

describe("the check", () => {
  const settings = { timeoutMs: 1000, retries: 0, cacheMs: 0 };
  it("the wanted address answers as Den: it is the address", async () => {
    const s = await checkAddress({
      webPort: 7777,
      wanted: WANTED,
      key: KEY,
      settings,
      probe: fakeProbe([DIRECT, WANTED]),
    });
    expect([
      s.address,
      s.wantedAnswer,
      noticeLine(s, { lang: "en", title: "Den", cli: "den" }),
    ]).toEqual([WANTED, "den", null]);
  });
  it("another server answers it: Den's own port, the owner, the routes", async () => {
    const s = await checkAddress({
      webPort: 7777,
      wanted: WANTED,
      key: KEY,
      settings,
      probe: fakeProbe([DIRECT], [WANTED]),
      owner: () => ({
        owner: "nginx",
        kind: "container",
        name: "web-proxy-1",
        denEdge: false,
      }),
    });
    expect([
      s.address,
      s.wantedAnswer,
      s.port,
      s.answeredAs,
      s.routeKind,
    ]).toEqual([DIRECT, "other", 80, "nginx", "nginx"]);
    expect(s.routes?.nginx).toContain(
      "proxy_pass http://host.docker.internal:7777;",
    );
    const d = doctorAddressLines(s, { lang: "en", title: "Den", cli: "den" });
    expect(d.status).toBe("warn");
    expect(d.lines).toEqual([
      "Edge: not running. Port 80 is held by nginx (container web-proxy-1).",
      "Den answers at http://localhost:7777. That address was checked just now: it is this Den.",
      "Options: free port 80, or add Den to that proxy (route below).",
      "Route for nginx / Caddy / Traefik:  den edge route --for nginx",
    ]);
  });
  it("Den's server not answering: nothing is proven, nothing claimed", async () => {
    const s = await checkAddress({
      webPort: 7777,
      wanted: "https://den.example.com",
      key: KEY,
      settings,
      probe: fakeProbe([]),
    });
    expect([s.address, s.directOk, s.wantedAnswer]).toEqual([
      null,
      false,
      "unknown",
    ]);
    expect(
      doctorAddressLines(s, { lang: "en", title: "Den", cli: "den" }).lines[0],
    ).toMatch(/not running here, so no address was checked/);
  });
  it("no identity key yet: nothing probed", async () => {
    let asked = 0;
    const s = await checkAddress({
      webPort: 7777,
      wanted: WANTED,
      key: null,
      settings,
      probe: async (u) => {
        asked++;
        return fakeProbe([u])(u);
      },
    });
    expect([asked, s.address]).toEqual([0, null]);
  });
  it("its limits are Settings, with permissive defaults", () => {
    expect(addressCheckSettings(() => ({}))).toEqual({
      timeoutMs: 5000,
      retries: 2,
      cacheMs: 60_000,
      // How many definite failures move a proven address back (the sign-in's).
      dropAfter: 2,
      unknownKeepMs: 300_000,
    });
    expect(
      addressCheckSettings(() => ({
        web: {
          address_check_timeout_seconds: 30,
          address_check_retries: 0,
          address_check_cache_seconds: 0,
        },
      })),
    ).toEqual({
      timeoutMs: 30_000,
      retries: 0,
      cacheMs: 0,
      dropAfter: 2,
      unknownKeepMs: 300_000,
    });
  });
});

describe("probeIdentity against real listeners", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
    );
  });
  const serve = (h: http.RequestListener): Promise<number> =>
    new Promise((resolve) => {
      const s = http.createServer(h);
      servers.push(s);
      s.listen(0, "127.0.0.1", () =>
        resolve((s.address() as AddressInfo).port),
      );
    });
  it("a 404 is not Den; its Server header is kept", async () => {
    const p = await serve((_q, r) => {
      r.writeHead(404, { server: "nginx/1.27.3" }).end();
    });
    const r = await probeIdentity(`http://127.0.0.1:${p}`, {
      key: KEY,
      timeoutMs: 2000,
      retries: 0,
    });
    expect([r.ok, r.other?.status, r.other?.server]).toEqual([
      false,
      404,
      "nginx/1.27.3",
    ]);
  });
  it("a server that echoes a made-up answer is not Den", async () => {
    const p = await serve((_q, r) => {
      r.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ den: "identity", answer: "0".repeat(64) }),
      );
    });
    const r = await probeIdentity(`http://127.0.0.1:${p}`, {
      key: KEY,
      timeoutMs: 2000,
      retries: 0,
    });
    expect([r.ok, r.other?.otherDen]).toEqual([false, true]);
  });
  it("the right answer is Den", async () => {
    const p = await serve((q, r) => {
      const c = new URL(q.url ?? "/", "http://x").searchParams.get("c");
      r.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(identityBody(KEY, c)),
      );
    });
    const r = await probeIdentity(`http://127.0.0.1:${p}`, {
      key: KEY,
      timeoutMs: 2000,
      retries: 0,
    });
    expect(r.ok).toBe(true);
  });
});

describe("the server's routes", () => {
  afterEach(() => resetAddressCache());
  type Sent = { status: number; body: Record<string, unknown> };
  function call(
    method: string,
    url: string,
    deps: Partial<AddressRouteDeps> = {},
  ): Promise<{
    handled: boolean;
    sent: Sent | null;
    raw: { status: number; body: string };
  }> {
    return new Promise((resolve) => {
      let sent: Sent | null = null;
      const raw = { status: 0, body: "" };
      const req = {
        method,
        url,
        headers: {},
      } as unknown as http.IncomingMessage;
      const res = {
        writeHead: (s: number) => {
          raw.status = s;
          return res;
        },
        end: (b?: string) => {
          raw.body = b ?? "";
        },
      } as unknown as http.ServerResponse;
      const d: AddressRouteDeps = {
        key: () => KEY,
        check: async () => STATE,
        edge: async () => ({
          container: "acme-edge",
          state: "absent",
          publish: true,
          ports: null,
        }),
        cacheMs: () => 0,
        setPublishOff: () => {},
        takeOver: async () => {},
        isAgent: () => false,
        sendJson: (_r, body, status) => {
          sent = {
            status: status ?? 200,
            body: body as Record<string, unknown>,
          };
        },
        ...deps,
      };
      void handleAddressRoutes(
        req,
        res,
        new URL(url, "http://x").pathname,
        d,
      ).then((handled) => resolve({ handled, sent, raw }));
    });
  }
  const STATE: AddressState = {
    checkedAt: "2026-11-18T05:48:00.000Z",
    wanted: WANTED,
    wantedAnswer: "other",
    direct: DIRECT,
    directOk: true,
    address: DIRECT,
    port: 80,
    owner: {
      owner: "nginx",
      kind: "container",
      name: "web-proxy-1",
      denEdge: false,
    },
    answeredAs: "nginx",
    routes: null,
    routeKind: "nginx",
  };

  it("the identity route answers a challenge, and only one", async () => {
    const c = "ef".repeat(16);
    const ok = await call("GET", `/api/den-identity?c=${c}`);
    expect([ok.handled, ok.raw.status, JSON.parse(ok.raw.body)]).toEqual([
      true,
      200,
      identityBody(KEY, c),
    ]);
    const bad = await call("GET", "/api/den-identity?c=nope");
    expect(bad.raw.status).toBe(400);
  });
  it("GET /api/edge/address: the check and the edge now", async () => {
    const r = await call("GET", "/api/edge/address");
    expect(r.sent?.body).toMatchObject({
      ok: true,
      address: DIRECT,
      edge: { state: "absent" },
    });
  });
  it("Check again: an agent is refused", async () => {
    const r = await call("POST", "/api/edge/address/check", {
      isAgent: () => true,
    });
    expect(r.sent?.status).toBe(403);
  });
  it("Check again: reached through another proxy, edge.publish: false is set for the person", async () => {
    let set = 0;
    const r = await call("POST", "/api/edge/address/check", {
      check: async () => ({ ...STATE, wantedAnswer: "den", address: WANTED }),
      setPublishOff: () => void set++,
    });
    expect([set, r.sent?.body.publishSet, r.sent?.body.address]).toEqual([
      1,
      true,
      WANTED,
    ]);
  });
  it("Check again: still the other server, nothing is set", async () => {
    let set = 0;
    const r = await call("POST", "/api/edge/address/check", {
      setPublishOff: () => void set++,
    });
    expect([set, r.sent?.body.wantedAnswer]).toEqual([0, "other"]);
  });
  it("Take over: refused unless an old Den edge holds the port", async () => {
    let took = "";
    const no = await call("POST", "/api/edge/address/take-over", {
      takeOver: async (c) => void (took = c),
    });
    expect([no.sent?.status, took]).toEqual([409, ""]);
    const yes = await call("POST", "/api/edge/address/take-over", {
      check: async () => ({
        ...STATE,
        owner: {
          owner: "traefik",
          kind: "container",
          name: "old-edge",
          denEdge: true,
        },
      }),
      takeOver: async (c) => void (took = c),
    });
    expect([yes.sent?.status, took]).toEqual([200, "old-edge"]);
  });
});
