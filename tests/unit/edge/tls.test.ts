/**
 * edge.tls (TLS-1a): the built-in strategies none, mkcert and files are
 * registered strategies of kind "tls"; the config selects one; detect()
 * comes before any mkcert use; `none` serves http only; trust and untrust
 * exist only under mkcert. mkcert is never the real one: tests put a fake
 * that records its calls on PATH, or none at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import {
  renderEdgeCompose,
  renderEdgeDynamic,
  routeUrl,
} from "../../../src/shared/edge/render.js";
import { ensureCerts } from "../../../src/shared/edge/runtime.js";
import {
  __resetTlsWarningForTests,
  edgeTlsWarnings,
  edgeTrust,
  edgeUntrust,
  IMPLICIT_TLS_WARNING,
  tlsStrategy,
  tlsStrategyIds,
  warnImplicitTlsOnce,
} from "../../../src/shared/edge/tls.js";
import { getStrategy } from "../../../src/shared/strategies/registry.js";
import { renderStackRoutes } from "../../../src/shared/stacks/render.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const TEAM = "edge:\n  org: acme\n  domain: acme.localhost\n";

let tmp: string;
let savedPath: string | undefined;
let savedEdgeDir: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edge-tls-")));
  savedPath = process.env.PATH;
  savedEdgeDir = process.env.DEN_EDGE_DIR;
  process.env.DEN_EDGE_DIR = path.join(tmp, "state");
  // No mkcert anywhere on PATH unless a test adds the fake.
  process.env.PATH = ["/usr/bin", "/bin"].join(path.delimiter);
  __resetTlsWarningForTests();
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedEdgeDir === undefined) delete process.env.DEN_EDGE_DIR;
  else process.env.DEN_EDGE_DIR = savedEdgeDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function cfgFor(team: string, user?: string): EdgeConfig {
  const root = path.join(tmp, `root-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "den.yml"), team);
  if (user)
    fs.writeFileSync(path.join(root, "config", "local", "user.yml"), user);
  return readEdgeConfig(root);
}

/** A fake mkcert on PATH that records calls; returns the call log. */
function fakeMkcert(): string {
  const bin = path.join(tmp, "fake-bin");
  const log = path.join(tmp, "mkcert-calls");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "mkcert"),
    `#!/bin/sh\necho "mkcert $*" >> "${log}"\nexit 0\n`,
    { mode: 0o755 },
  );
  process.env.PATH = [bin, process.env.PATH].join(path.delimiter);
  return log;
}

describe("the registry", () => {
  it("registers none, mkcert and files as kind tls", () => {
    expect(tlsStrategyIds()).toEqual(["none", "mkcert", "files"]);
    for (const id of tlsStrategyIds()) {
      const s = getStrategy("tls", id);
      expect(s?.kind).toBe("tls");
      expect(typeof s?.detect).toBe("function");
    }
  });

  it("mkcert detect() is a PATH check: 'mkcert is not installed'", () => {
    expect(tlsStrategy("mkcert")!.detect()).toEqual({
      available: false,
      reason: "mkcert is not installed",
    });
    const log = fakeMkcert();
    expect(tlsStrategy("mkcert")!.detect()).toEqual({ available: true });
    expect(fs.existsSync(log)).toBe(false); // detect never runs it
  });

  it("none and files need nothing", () => {
    expect(tlsStrategy("none")!.detect().available).toBe(true);
    expect(tlsStrategy("files")!.detect().available).toBe(true);
  });

  it("only mkcert can trust and untrust", () => {
    expect(tlsStrategy("mkcert")!.capabilities.trust).toBeDefined();
    expect(tlsStrategy("mkcert")!.capabilities.untrust).toBeDefined();
    for (const id of ["none", "files"]) {
      expect(tlsStrategy(id)!.capabilities.trust).toBeUndefined();
      expect(tlsStrategy(id)!.capabilities.untrust).toBeUndefined();
    }
  });
});

describe("edge.tls config", () => {
  it("reads none, a bare id, and the object forms", () => {
    expect(cfgFor(TEAM + "  tls: none\n").tls).toEqual({ strategy: "none" });
    expect(cfgFor(TEAM + "  tls: { strategy: none }\n").tls).toEqual({
      strategy: "none",
    });
    expect(cfgFor(TEAM + "  tls: mkcert\n").tls).toEqual({
      strategy: "mkcert",
      ca: null,
    });
    const c = cfgFor(TEAM + "  tls: { strategy: mkcert, ca: ca }\n");
    expect(c.tls).toEqual({
      strategy: "mkcert",
      ca: expect.stringMatching(/\/ca$/),
    });
    expect(c.tlsFrom).toBe("explicit");
    const f = cfgFor(
      TEAM +
        "  tls: { strategy: files, include: edge/dynamic, mounts: { /h: /c } }\n",
    );
    expect(f.tls).toEqual({ strategy: "files", ca: null });
    expect(f.include).toMatch(/\/edge\/dynamic$/);
    expect(f.mounts).toEqual({ "/h": "/c" });
  });

  it("user.yml's tls replaces the team's", () => {
    expect(
      cfgFor(TEAM + "  tls: none\n", "edge:\n  tls: mkcert\n").tls,
    ).toEqual({ strategy: "mkcert", ca: null });
  });

  it("an unknown strategy is an error naming the built-ins", () => {
    expect(() => cfgFor(TEAM + "  tls: { strategy: acme }\n")).toThrow(
      'edge.tls.strategy "acme" is not a known TLS strategy; the built-ins are none, mkcert, files',
    );
    expect(() => cfgFor(TEAM + "  tls: secret\n")).toThrow(
      /the built-ins are none, mkcert, files/,
    );
    expect(() => cfgFor(TEAM + "  tls: [mkcert]\n")).toThrow(
      /edge.tls must be a strategy id/,
    );
  });

  it("refuses keys a strategy does not take", () => {
    expect(() => cfgFor(TEAM + "  tls: { strategy: none, ca: x }\n")).toThrow(
      "edge.tls.ca does not apply to strategy none (it takes strategy)",
    );
    expect(() =>
      cfgFor(TEAM + "  tls: { strategy: mkcert, include: x }\n"),
    ).toThrow(/edge.tls.include does not apply to strategy mkcert/);
    expect(() =>
      cfgFor(TEAM + "  tls: { strategy: files, mounts: [x] }\n"),
    ).toThrow(/edge.tls.mounts must map/);
    expect(() =>
      cfgFor(TEAM + "  tls: { strategy: files, mounts: { /h: rel } }\n"),
    ).toThrow(/absolute container path/);
    expect(() =>
      cfgFor(TEAM + '  tls: { strategy: mkcert, ca: "" }\n'),
    ).toThrow(/edge.tls.ca must be/);
  });

  it("refuses edge.tls beside the legacy keys, and two includes", () => {
    expect(() =>
      cfgFor(TEAM + "  caroot: ca\n  tls: { strategy: mkcert }\n"),
    ).toThrow(/edge.tls replaces edge.caroot; remove it/);
    expect(() =>
      cfgFor(TEAM + "  tls: none\n", "edge:\n  issue_cert: false\n"),
    ).toThrow(/edge.tls replaces edge.issue_cert/);
    expect(() =>
      cfgFor(TEAM + "  include: a\n  tls: { strategy: files, include: b }\n"),
    ).toThrow(/edge.include and edge.tls.include are both set/);
  });

  it("maps the legacy shapes, and warns only for the implicit default", () => {
    const implicit = cfgFor(TEAM);
    expect(implicit.tls).toEqual({ strategy: "mkcert", ca: null });
    expect(implicit.tlsFrom).toBe("implicit");
    expect(edgeTlsWarnings(implicit)).toEqual([
      "edge.tls is not set; defaulting to mkcert with a local CA. Set edge.tls explicitly.",
    ]);
    const caroot = cfgFor(TEAM + "  caroot: shared\n");
    expect(caroot.tls).toEqual({
      strategy: "mkcert",
      ca: expect.stringMatching(/\/shared$/),
    });
    expect(caroot.tlsFrom).toBe("legacy");
    expect(edgeTlsWarnings(caroot)[0]).toMatch(
      /deprecated; they still work\. Say the same with edge\.tls: \{ strategy: mkcert, ca: .*\/shared \}/,
    );
    const files = cfgFor(TEAM + "  issue_cert: false\n");
    expect(files.tls).toEqual({ strategy: "files", ca: null });
    expect(edgeTlsWarnings(cfgFor(TEAM + "  tls: none\n"))).toEqual([]);
  });

  it("gives the implicit-default warning once per run", () => {
    const lines: string[] = [];
    const cfg = cfgFor(TEAM);
    warnImplicitTlsOnce(cfg, (l) => lines.push(l));
    warnImplicitTlsOnce(cfg, (l) => lines.push(l));
    warnImplicitTlsOnce(cfgFor(TEAM + "  tls: none\n"), (l) => lines.push(l));
    expect(lines).toEqual([IMPLICIT_TLS_WARNING]);
  });
});

describe("tls: none", () => {
  const cfg = (): EdgeConfig => ({
    ...cfgFor(TEAM + "  tls: none\n  routes: { api: http://api:1 }\n"),
    subzones: [],
  });

  it("routes on the http entrypoint with no TLS, redirect or cert", () => {
    const doc = yaml.parse(renderEdgeDynamic(cfg()));
    expect(doc.tls).toBeUndefined();
    expect(doc.http.middlewares).toBeUndefined();
    expect(doc.http.routers["to-https"]).toBeUndefined();
    for (const r of Object.values(doc.http.routers) as {
      entryPoints: string[];
      tls?: unknown;
    }[]) {
      expect(r.entryPoints).toEqual(["web"]);
      expect(r.tls).toBeUndefined();
    }
    expect(renderEdgeDynamic(cfg())).not.toMatch(/&a1|websecure/);
  });

  it("has no https entrypoint, port or cert volume", () => {
    const svc = yaml.parse(renderEdgeCompose(cfg())).services.edge;
    expect(svc.command).toContain("--entrypoints.web.address=:80");
    expect(svc.command.join(" ")).not.toContain("websecure");
    expect(svc.ports).toEqual(["80:80"]);
    expect(svc.volumes).toEqual(["./dynamic:/etc/edge/dynamic:ro"]);
  });

  it("gives http URLs", () => {
    expect(routeUrl("api", cfg())).toBe("http://api.acme.localhost");
    expect(
      routeUrl("api", { ...cfg(), ports: { http: 8080, https: 8443 } }),
    ).toBe("http://api.acme.localhost:8080");
  });

  it("routes stacks on the http entrypoint too", () => {
    const doc = yaml.parse(
      renderStackRoutes(
        cfg(),
        {
          name: "shop",
          repo: "shop",
          files: [],
          routes: { app: "web:80" },
          generate: [],
          uses: [],
          env: {},
          profiles: [],
        },
        { name: "shop-main", services: {}, networks: {} } as never,
      ),
    );
    const r = doc.http.routers["stack-shop-app"];
    expect(r.entryPoints).toEqual(["web"]);
    expect(r.tls).toBeUndefined();
  });

  it("does no cert work and never calls mkcert", () => {
    const log = fakeMkcert();
    expect(ensureCerts(cfg())).toEqual({ issued: false, names: [] });
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(path.join(tmp, "state", "certs"))).toBe(false);
  });
});

describe("mkcert, checked before use", () => {
  it("ensure() with mkcert off PATH says 'mkcert is not installed'", () => {
    expect(() => ensureCerts(cfgFor(TEAM + "  tls: mkcert\n"))).toThrow(
      /^mkcert is not installed\. Install it/,
    );
  });

  it("ensure() issues through the (fake) mkcert", () => {
    const log = fakeMkcert();
    const r = ensureCerts(cfgFor(TEAM + "  tls: mkcert\n"));
    expect(r.issued).toBe(true);
    expect(fs.readFileSync(log, "utf-8")).toMatch(
      /^mkcert -cert-file .*\/state\/certs\/edge\.pem -key-file .*edge-key\.pem acme\.localhost/,
    );
  });
});

describe("edge trust / untrust", () => {
  it("refuse outside mkcert, with no mkcert call", () => {
    const log = fakeMkcert();
    for (const tls of ["none", "{ strategy: files }"]) {
      const cfg = cfgFor(TEAM + `  tls: ${tls}\n`);
      expect(() => edgeTrust(cfg)).toThrow(
        /^edge trust needs edge.tls.strategy: mkcert/,
      );
      expect(() => edgeUntrust(cfg)).toThrow(
        /^edge untrust needs edge.tls.strategy: mkcert/,
      );
    }
    expect(fs.existsSync(log)).toBe(false);
  });

  it("files with an existing ca: trust installs that CA (as caroot did); untrust refuses it", () => {
    const log = fakeMkcert();
    const ca = path.join(tmp, "shared-ca");
    fs.mkdirSync(ca);
    fs.writeFileSync(path.join(ca, "rootCA.pem"), "");
    fs.writeFileSync(path.join(ca, "rootCA-key.pem"), "");
    const cfg = cfgFor(
      TEAM + `  tls: { strategy: files, include: edge/dynamic, ca: ${ca} }\n`,
    );
    expect(edgeTrust(cfg)).toBe(0);
    expect(fs.readFileSync(log, "utf-8")).toBe("mkcert -install\n");
    expect(() => edgeUntrust(cfg)).toThrow(/shared CA .* never uninstalls it/);
    expect(fs.readFileSync(log, "utf-8")).toBe("mkcert -install\n");
  });

  it("refuse to untrust a shared CA", () => {
    const log = fakeMkcert();
    expect(() =>
      edgeUntrust(cfgFor(TEAM + "  tls: { strategy: mkcert, ca: ca }\n")),
    ).toThrow(/shared CA .* never uninstalls it/);
    expect(fs.existsSync(log)).toBe(false);
  });

  it("say 'mkcert is not installed' under mkcert with no mkcert", () => {
    expect(() => edgeTrust(cfgFor(TEAM + "  tls: mkcert\n"))).toThrow(
      /^mkcert is not installed/,
    );
    expect(() => edgeUntrust(cfgFor(TEAM + "  tls: mkcert\n"))).toThrow(
      /^mkcert is not installed/,
    );
  });
});
