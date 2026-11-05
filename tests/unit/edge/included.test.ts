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
      },
      {
        name: "vpn-api",
        file: "vpn-routes.yml",
        rule: "Host(`api.acme.vpn.example`)",
        service: "vpn-api@file",
        entryPoints: [],
        hosts: ["api.acme.vpn.example"],
        tls: false,
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
      /https:\/\/web\.acme\.vpn\.example, https:\/\/app\.acme\.vpn\.example\s+→ vpn-web {2}\(vpn-routes\.yml\)/,
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
