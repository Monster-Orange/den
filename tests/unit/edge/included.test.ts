/**
 * The routers in the edge's included dynamic files (PL-SPEC §10, a consumer
 * review): Traefik serves them, so `edge routes`, /api/edge and the
 * Edge page list them, each marked by its source file. Read-only: the
 * files are parsed, never written; Docker is never asked.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  includedRouters,
  ruleHosts,
  stackRouters,
  routerUrls,
} from "../../../src/shared/edge/included.js";
import { edgeStatus } from "../../../src/shared/edge/status.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

let tmp = "";
let dyn = "";

const VPN_ROUTES = `http:
  routers:
    vpn-web:
      rule: "Host(\`web.acme.vpn.example\`) || Host(\`app.acme.vpn.example\`)"
      service: vpn-web
      entryPoints: [websecure]
      tls: {}
    vpn-api:
      rule: Host(\`api.acme.vpn.example\`)
      service: vpn-api@file
  services:
    vpn-web:
      loadBalancer:
        servers: [{ url: "http://host.docker.internal:3000" }]
`;

const base = (over: Partial<EdgeConfig> = {}): EdgeConfig => ({
  org: "acme",
  domain: "acme.localhost",
  aliases: [],
  image: "traefik:v3",
  workspaces: [],
  routes: { web: "http://localhost:3000" },
  ports: { http: 80, https: 443 },
  stateDir: path.join(tmp, "state"),
  tls: { strategy: "none" },
  tlsFrom: "explicit",
  httpsRedirect: true,
  dockerLabels: null,
  include: dyn,
  mounts: {},
  networks: [],
  args: [],
  ...over,
});

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-incl-")));
  dyn = path.join(tmp, "dist", "edge", "dynamic");
  fs.mkdirSync(dyn, { recursive: true });
  fs.writeFileSync(path.join(dyn, "vpn-routes.yml"), VPN_ROUTES);
  // Middlewares only: no routers, nothing listed.
  fs.writeFileSync(
    path.join(dyn, "middlewares.yaml"),
    "http:\n  middlewares:\n    gz: { compress: {} }\n",
  );
  // Not copied in by `edge up`, so not listed: Den's own file and a
  // stack's route file.
  fs.writeFileSync(
    path.join(dyn, "edge.yml"),
    "http:\n  routers:\n    own: { rule: Host(`x`), service: x }\n",
  );
  fs.writeFileSync(
    path.join(dyn, "stack-shop.yml"),
    "http:\n  routers:\n    shop: { rule: Host(`y`), service: y }\n",
  );
  fs.writeFileSync(path.join(dyn, "broken.yml"), "http: [unclosed\n");
  fs.writeFileSync(path.join(dyn, "notes.txt"), "not yaml");
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ruleHosts", () => {
  it("every Host(...) argument, in order, once", () => {
    expect(
      ruleHosts(
        "Host(`a.x`) || (Host(`b.x`, \"c.x\") && PathPrefix(`/p`)) || Host('a.x')",
      ),
    ).toEqual(["a.x", "b.x", "c.x"]);
    expect(ruleHosts("PathPrefix(`/`)")).toEqual([]);
  });
});

describe("includedRouters", () => {
  it("lists http.routers from each included YAML file, marked by file", () => {
    const out = includedRouters(base());
    expect(out.routers).toEqual([
      {
        name: "vpn-web",
        file: "vpn-routes.yml",
        rule: "Host(`web.acme.vpn.example`) || Host(`app.acme.vpn.example`)",
        service: "vpn-web",
        entryPoints: ["websecure"],
        hosts: ["web.acme.vpn.example", "app.acme.vpn.example"],
        tls: true,
        secure: true,
        upstream: "http://host.docker.internal:3000",
      },
      {
        name: "vpn-api",
        file: "vpn-routes.yml",
        rule: "Host(`api.acme.vpn.example`)",
        service: "vpn-api@file",
        entryPoints: [],
        hosts: ["api.acme.vpn.example"],
        tls: false,
        secure: false,
        upstream: "vpn-api@file",
      },
    ]);
  });

  it("a file that doesn't parse is reported by name, not fatal", () => {
    const out = includedRouters(base());
    expect(out.errors.map((e) => e.file)).toEqual(["broken.yml"]);
    expect(out.errors[0].error).not.toMatch(/unclosed/);
  });

  it("no include: nothing", () => {
    expect(includedRouters(base({ include: null }))).toEqual({
      routers: [],
      errors: [],
    });
  });

  it("reads only: the files are as they were", () => {
    const before = fs.readFileSync(path.join(dyn, "vpn-routes.yml"));
    includedRouters(base());
    expect(fs.readFileSync(path.join(dyn, "vpn-routes.yml"))).toEqual(before);
    expect(fs.existsSync(path.join(tmp, "state"))).toBe(false);
  });
});

describe("edgeStatus", () => {
  const deps = {
    containerState: () => "running",
    caTrusted: () => null,
    issuedNames: () => null,
  };
  it("carries the included routers beside Den's own routes", () => {
    const st = edgeStatus(base(), deps);
    expect(st.routes.map((r) => r.name)).toEqual(["web"]);
    expect(st.included.map((r) => `${r.file}:${r.name}`)).toEqual([
      "vpn-routes.yml:vpn-web",
      "vpn-routes.yml:vpn-api",
    ]);
    expect(st.includedErrors.map((e) => e.file)).toEqual(["broken.yml"]);
  });

  it("tls: where the strategy came from, and the CA directory", () => {
    expect(edgeStatus(base(), deps).tls).toEqual({
      strategy: "none",
      implicit: false,
      from: "explicit",
      ca: null,
    });
    expect(
      edgeStatus(
        base({ tls: { strategy: "mkcert", ca: null }, tlsFrom: "implicit" }),
        deps,
      ).tls,
    ).toEqual({
      strategy: "mkcert",
      implicit: true,
      from: "implicit",
      ca: path.join(tmp, "state", "ca"),
    });
    expect(
      edgeStatus(
        base({ tls: { strategy: "files", ca: "/x/ca" }, tlsFrom: "legacy" }),
        deps,
      ).tls,
    ).toEqual({
      strategy: "files",
      implicit: false,
      from: "legacy",
      ca: "/x/ca",
    });
  });
});

describe("the stacks' routers (a consumer's finding, 0.3.0-dev.32)", () => {
  // `stack up` writes stack-<project>.yml into the edge's dynamic dir.
  const stackState = () => {
    const stateDir = path.join(tmp, "stack-state");
    const d = path.join(stateDir, "dynamic");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "stack-shop-main.yml"),
      "http:\n  routers:\n    stack-shop-web:\n      rule: Host(`web.shop.acme.localhost`)\n      service: stack-shop-web\n      tls: {}\n" +
        "  services:\n    stack-shop-web:\n      loadBalancer:\n        servers: [{ url: http://shop-main-web-1:3000 }]\n",
    );
    fs.writeFileSync(path.join(d, "stack-bad.yml"), "http: [unclosed\n");
    // Den's own and a copied-in included file: not a stack's.
    fs.writeFileSync(
      path.join(d, "edge.yml"),
      "http:\n  routers:\n    own: { rule: Host(`x`), service: x }\n",
    );
    fs.writeFileSync(path.join(d, "vpn-routes.yml"), VPN_ROUTES);
    return stateDir;
  };

  it("lists http.routers from each stack-*.yml in the dynamic dir, marked by file", () => {
    const out = stackRouters(base({ stateDir: stackState() }));
    expect(out.routers).toEqual([
      {
        name: "stack-shop-web",
        file: "stack-shop-main.yml",
        rule: "Host(`web.shop.acme.localhost`)",
        service: "stack-shop-web",
        entryPoints: [],
        hosts: ["web.shop.acme.localhost"],
        tls: true,
        secure: true,
        upstream: "http://shop-main-web-1:3000",
      },
    ]);
    expect(out.errors.map((e) => e.file)).toEqual(["stack-bad.yml"]);
  });

  // A consumer's dogfood finding (0.3.0-dev.33): the stack rows showed
  // no scheme and the Traefik service's name, where Den's own rows show
  // https://… and the upstream URL.
  it("a router on websecure is secure without a tls block; the upstream is its service's loadBalancer URL", () => {
    const stateDir = path.join(tmp, "stack-state-lb");
    const d = path.join(stateDir, "dynamic");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "stack-shop-main.yml"),
      [
        "http:",
        "  routers:",
        "    stack-shop-web:",
        "      entryPoints: [websecure]",
        "      rule: Host(`web.shop.acme.localhost`)",
        "      service: stack-shop-web",
        "    stack-shop-admin:",
        "      entryPoints: [web]",
        "      rule: Host(`admin.shop.acme.localhost`)",
        "      service: shop-admin@docker",
        "  services:",
        "    stack-shop-web:",
        "      loadBalancer:",
        "        servers:",
        "          - url: http://shop-main-web-1:3000",
        "",
      ].join("\n"),
    );
    const out = stackRouters(base({ stateDir }));
    expect(
      out.routers.map((r) => [r.name, r.secure, routerUrls(r), r.upstream]),
    ).toEqual([
      [
        "stack-shop-web",
        true,
        ["https://web.shop.acme.localhost"],
        "http://shop-main-web-1:3000",
      ],
      [
        "stack-shop-admin",
        false,
        ["http://admin.shop.acme.localhost"],
        "shop-admin@docker",
      ],
    ]);
  });

  it("no dynamic dir yet: none", () => {
    expect(
      stackRouters(base({ stateDir: path.join(tmp, "no-such-state") })),
    ).toEqual({ routers: [], errors: [] });
  });

  it("edgeStatus carries them apart from the included ones", () => {
    const st = edgeStatus(base({ stateDir: stackState() }), {
      containerState: () => "running",
      caTrusted: () => null,
      issuedNames: () => null,
    });
    expect(st.stacks.map((r) => `${r.file}:${r.name}`)).toEqual([
      "stack-shop-main.yml:stack-shop-web",
    ]);
    expect(st.stackErrors.map((e) => e.file)).toEqual(["stack-bad.yml"]);
    expect(st.included.map((r) => r.name)).not.toContain("stack-shop-web");
  });

  it("`edge routes` prints them after the included ones, marked stack", async () => {
    const root = path.join(tmp, "dist-stack");
    fs.cpSync(path.join(process.cwd(), "examples", "distribution"), root, {
      recursive: true,
    });
    const saved = { ...process.env };
    process.env.DEN_ROOT = root;
    process.env.DEN_EDGE_DIR = stackState();
    process.env.HOME = path.join(tmp, "home");
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const { cmdEdge } = await import("../../../src/ui/cli/edge-command.js");
      await cmdEdge(["routes"]);
    } finally {
      console.log = log;
      process.env = saved;
    }
    const text = lines.join("\n");
    expect(text).toMatch(
      /https:\/\/web\.shop\.acme\.localhost\s+→ http:\/\/shop-main-web-1:3000 {2}\(stack: stack-shop-main\.yml\)/,
    );
    expect(text).toMatch(/stack-bad\.yml: not read/);
  });
});

describe("`edge routes`", () => {
  it("prints Den's routes, then each included router with its source file", async () => {
    const root = path.join(tmp, "dist");
    fs.cpSync(path.join(process.cwd(), "examples", "distribution"), root, {
      recursive: true,
    });
    const conf = path.join(root, "config", "acme.yml");
    fs.writeFileSync(
      conf,
      fs
        .readFileSync(conf, "utf-8")
        .replace("  tls: none\n", "  tls: none\n  include: edge/dynamic\n"),
    );
    const saved = { ...process.env };
    process.env.DEN_ROOT = root;
    process.env.DEN_EDGE_DIR = path.join(tmp, "edge-state");
    process.env.HOME = path.join(tmp, "home");
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const { cmdEdge } = await import("../../../src/ui/cli/edge-command.js");
      await cmdEdge(["routes"]);
    } finally {
      console.log = log;
      process.env = saved;
    }
    const text = lines.join("\n");
    expect(text).toMatch(/http:\/\/acme\.acme\.localhost\s+→ http:/);
    expect(text).toMatch(
      /https:\/\/web\.acme\.vpn\.example, https:\/\/app\.acme\.vpn\.example\s+→ http:\/\/host\.docker\.internal:3000 {2}\(vpn-routes\.yml\)/,
    );
    expect(text).toMatch(
      /http:\/\/api\.acme\.vpn\.example\s+→ vpn-api@file {2}\(vpn-routes\.yml\)/,
    );
    expect(text).toMatch(/broken\.yml: not read/);
    expect(text).not.toMatch(/\bown\b|\bshop\b/);
    // Nothing was written: no state dir.
    expect(fs.existsSync(path.join(tmp, "edge-state"))).toBe(false);
  });
});
