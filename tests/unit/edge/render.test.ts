import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import {
  certNames,
  renderEdgeCompose,
  renderEdgeDynamic,
  routeUrl,
} from "../../../src/shared/edge/render.js";
import {
  readEdgeConfig,
  readWebPort,
} from "../../../src/shared/edge/config.js";
import { brandHtmlTitle } from "../../../src/shared/brand.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const edge: EdgeConfig = {
  org: "acme",
  domain: "acme.localhost",
  aliases: [],
  image: "traefik:v3.7.17",
  workspaces: ["main", "pr-12"],
  routes: {},
  ports: { http: 80, https: 443 },
  stateDir: "/tmp/x",
  caroot: null,
  issueCert: true,
  httpsRedirect: true,
  dockerLabels: null,
  include: null,
  mounts: {},
  networks: [],
  args: [],
};

describe("certificate names", () => {
  it("issues apex, wildcard and per-workspace wildcard names", () => {
    expect(certNames(edge)).toEqual([
      "acme.localhost",
      "*.acme.localhost",
      "*.main.acme.localhost",
      "*.pr-12.acme.localhost",
    ]);
  });
  it("adds a wildcard for a dotted route's zone (app.shop → *.shop)", () => {
    const cfg = {
      ...edge,
      subzones: ["webapp"],
      routes: {
        "app.shop": "http://host.docker.internal:5173",
        "api.shop": "http://host.docker.internal:3001",
        "app.webapp": "http://x", // already a subzone: no duplicate
        "webapp.main": "http://x", // a workspace zone: no duplicate
        den: "http://x", // undotted: covered by *.<domain>
      },
    };
    expect(certNames(cfg)).toEqual([
      "acme.localhost",
      "*.acme.localhost",
      "*.main.acme.localhost",
      "*.pr-12.acme.localhost",
      "*.webapp.acme.localhost",
      "*.shop.acme.localhost",
    ]);
  });
  it("covers every alias domain", () => {
    const both = { ...edge, aliases: ["acme.internal"], workspaces: [] };
    expect(certNames(both)).toEqual([
      "acme.localhost",
      "*.acme.localhost",
      "acme.internal",
      "*.acme.internal",
    ]);
  });
});

describe("renderEdgeDynamic", () => {
  it("routes <name>.<domain> (and aliases) to its upstream over TLS", () => {
    const cfg = {
      ...edge,
      aliases: ["acme.internal"],
      routes: { "webapp.main": "http://host.docker.internal:3000" },
    };
    const doc = yaml.parse(renderEdgeDynamic(cfg));
    const r = doc.http.routers["route-webapp-main"];
    expect(r.rule).toBe(
      "Host(`webapp.main.acme.localhost`) || Host(`webapp.main.acme.internal`)",
    );
    expect(r.tls).toEqual({});
    expect(
      doc.http.services["route-webapp-main"].loadBalancer.servers[0].url,
    ).toBe("http://host.docker.internal:3000");
    expect(doc.http.routers.dashboard.rule).toContain("edge.acme.internal");
  });
  it("keeps a non-443 published port in the HTTPS redirect", () => {
    const redirect = (ports: EdgeConfig["ports"]) =>
      yaml.parse(renderEdgeDynamic({ ...edge, ports })).http.middlewares[
        "to-https"
      ].redirectScheme;
    expect(redirect({ http: 8080, https: 8443 }).port).toBe("8443");
    expect(redirect({ http: 80, https: 443 }).port).toBeUndefined();
    expect(redirect(null).port).toBeUndefined();
  });
  it("rejects reserved and malformed route names", () => {
    expect(() =>
      renderEdgeDynamic({ ...edge, routes: { edge: "http://x" } }),
    ).toThrow(/reserved/);
    expect(() =>
      renderEdgeDynamic({ ...edge, routes: { "Bad Name": "http://x" } }),
    ).toThrow(/lowercase/);
  });
  it("leaves plain HTTP alone when https_redirect is off", () => {
    const doc = yaml.parse(
      renderEdgeDynamic({ ...edge, httpsRedirect: false }),
    );
    expect(doc.http.routers["to-https"]).toBeUndefined();
    expect(doc.http.middlewares).toBeUndefined();
  });
  it("has no TLS store of its own when it issues no certificate", () => {
    const doc = yaml.parse(renderEdgeDynamic({ ...edge, issueCert: false }));
    expect(doc.tls).toBeUndefined();
    expect(doc.http.routers.dashboard.tls).toEqual({});
  });
});

describe("renderEdgeCompose", () => {
  it("publishes host ports when standalone", () => {
    const doc = yaml.parse(renderEdgeCompose(edge));
    expect(doc.services.edge.ports).toEqual(["80:80", "443:443"]);
    expect(doc.services.edge.networks).toEqual(["acme-edge"]);
    expect(JSON.stringify(doc)).not.toContain("docker.sock");
  });
  it("publishes nothing when fronted by another proxy", () => {
    const doc = yaml.parse(renderEdgeCompose({ ...edge, ports: null }));
    expect(doc.services.edge.ports).toBeUndefined();
  });

  describe("docker_labels", () => {
    const labelled = {
      ...edge,
      dockerLabels: { network: "apps-network" },
    };
    const doc = yaml.parse(renderEdgeCompose(labelled));
    const cmd: string[] = doc.services.edge.command;
    const proxy = doc.services["docker-proxy"];

    it("reads labels through a read-only socket proxy, never the socket", () => {
      expect(doc.services.edge.volumes.join(" ")).not.toContain("docker.sock");
      expect(proxy.volumes).toEqual([
        "/var/run/docker.sock:/var/run/docker.sock:ro",
      ]);
      expect(proxy.environment).toMatchObject({ CONTAINERS: "1", POST: "0" });
      expect(cmd).toContain(
        "--providers.docker.endpoint=tcp://acme-edge-docker:2375",
      );
    });
    it("exposes nothing by default and routes on the apps network", () => {
      expect(cmd).toContain("--providers.docker.exposedbydefault=false");
      expect(cmd).toContain("--providers.docker.network=apps-network");
      expect(doc.services.edge.networks).toEqual([
        "acme-edge",
        "acme-edge-docker",
        "apps-network",
      ]);
      expect(doc.networks["apps-network"]).toEqual({ external: true });
    });
    it("keeps the socket proxy off every network but its own", () => {
      expect(proxy.networks).toEqual(["acme-edge-docker"]);
      expect(doc.networks["acme-edge-docker"]).toEqual({ internal: true });
    });
    it("is off unless asked for", () => {
      const plain = yaml.parse(renderEdgeCompose(edge));
      expect(plain.services["docker-proxy"]).toBeUndefined();
      expect(plain.services.edge.command.join(" ")).not.toContain(
        "providers.docker",
      );
    });
  });

  it("adds mounts, networks and extra args, and drops ./certs when it issues none", () => {
    const doc = yaml.parse(
      renderEdgeCompose({
        ...edge,
        issueCert: false,
        mounts: { "/host/certs": "/etc/traefik/dynamic/certs" },
        networks: ["more-net"],
        args: ["--accesslog=true"],
      }),
    );
    const svc = doc.services.edge;
    expect(svc.volumes).toEqual([
      "./dynamic:/etc/edge/dynamic:ro",
      "/host/certs:/etc/traefik/dynamic/certs:ro",
    ]);
    expect(svc.networks).toEqual(["acme-edge", "more-net"]);
    expect(svc.command).toContain("--accesslog=true");
    expect(doc.networks["more-net"]).toEqual({ external: true });
  });
});

describe("routeUrl", () => {
  it("omits :443 and keeps other ports", () => {
    expect(routeUrl("ui", edge)).toBe("https://ui.acme.localhost");
    expect(routeUrl("ui", { ...edge, ports: null })).toBe(
      "https://ui.acme.localhost",
    );
    expect(
      routeUrl("ui", { ...edge, ports: { http: 8080, https: 8443 } }),
    ).toBe("https://ui.acme.localhost:8443");
  });
});

describe("readEdgeConfig", () => {
  function root(team: string, user?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-cfg-"));
    fs.mkdirSync(path.join(dir, "config", "local"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "den.yml"), team);
    if (user)
      fs.writeFileSync(path.join(dir, "config", "local", "user.yml"), user);
    return dir;
  }
  const team = "edge:\n  org: acme\n  domain: acme.localhost\n";

  it("is standalone on 80/443 by default and routes the web UI", () => {
    const cfg = readEdgeConfig(root(team));
    expect(cfg.ports).toEqual({ http: 80, https: 443 });
    expect(cfg.routes.den).toBe("http://host.docker.internal:7777");
    expect(cfg.dockerLabels).toBeNull();
    expect(cfg.caroot).toBeNull();
    expect(cfg.issueCert).toBe(true);
    expect(cfg.httpsRedirect).toBe(true);
  });
  it("names the web UI route after the brand", () => {
    const cfg = readEdgeConfig(root("brand:\n  name: Acme\n" + team));
    expect(cfg.routes.acme).toBe("http://host.docker.internal:7777");
    expect(cfg.routes.den).toBeUndefined();
  });
  it("lets an engineer stop publishing and move the web UI port", () => {
    const r = root(team, "edge:\n  publish: false\nweb:\n  port: 7791\n");
    const cfg = readEdgeConfig(r);
    expect(cfg.ports).toBeNull();
    expect(cfg.routes.den).toBe("http://host.docker.internal:7791");
    expect(readWebPort(r)).toBe(7791);
  });
  it("refuses a config without org/domain or with a bad port", () => {
    expect(() => readEdgeConfig(root("{}\n"))).toThrow(/no `edge:` block/);
    expect(() => readEdgeConfig(root(team + "  https_port: 99999\n"))).toThrow(
      /port number/,
    );
  });
  it("reads the opt-in options, resolving paths against the repo root", () => {
    const r = root(
      team +
        [
          "  caroot: ~/ca",
          "  issue_cert: false",
          "  https_redirect: false",
          "  docker_labels: { network: apps-network }",
          "  include: edge/dynamic",
          "  mounts: { ~/certs: /etc/traefik/dynamic/certs }",
          "  networks: [more-net]",
          "  args: [--accesslog=true]",
          "",
        ].join("\n"),
    );
    const cfg = readEdgeConfig(r);
    expect(cfg.caroot).toBe(path.join(os.homedir(), "ca"));
    expect(cfg.issueCert).toBe(false);
    expect(cfg.httpsRedirect).toBe(false);
    expect(cfg.dockerLabels).toEqual({ network: "apps-network" });
    expect(cfg.include).toBe(path.join(r, "edge", "dynamic"));
    expect(cfg.mounts).toEqual({
      [path.join(os.homedir(), "certs")]: "/etc/traefik/dynamic/certs",
    });
    expect(cfg.networks).toEqual(["more-net"]);
    expect(cfg.args).toEqual(["--accesslog=true"]);
  });
  it("refuses docker_labels without a network and mounts to relative paths", () => {
    expect(() =>
      readEdgeConfig(root(team + "  docker_labels: true\n")),
    ).toThrow(/docker_labels.network/);
    expect(() =>
      readEdgeConfig(root(team + "  mounts: { /a: relative }\n")),
    ).toThrow(/absolute/);
  });
});

describe("brandHtmlTitle", () => {
  it("rewrites the product name in <title> only", () => {
    const html = "<title>Den · Logs</title><p>Den</p>";
    expect(brandHtmlTitle(html, { name: "Acme Bench", tagline: "" })).toBe(
      "<title>Acme Bench · Logs</title><p>Den</p>",
    );
    expect(brandHtmlTitle(html, { name: "Den", tagline: "" })).toBe(html);
  });
});
