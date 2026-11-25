/**
 * The edge runs no Traefik API or dashboard. Traefik's API shows its whole
 * dynamic config (routers, services, every middleware with its values), and
 * the headers middleware on Den's own route carries the edge's proof. So:
 *
 *   - no router on any entrypoint serves api@internal (the dashboard
 *     router is gone), with or without TLS, with or without the proof;
 *   - the edge's static command never turns the API on, and any `--api…`
 *     flag in edge.args (one dash or two) is refused (edge-args-allow);
 *   - the proof is only in the dynamic file (0600, mounted read-only),
 *     never in the compose file or the container's command.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import {
  edgeCommand,
  edgeCommandDrift,
  renderEdgeCompose,
  renderEdgeDynamic,
} from "../../../src/shared/edge/render.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const PROOF = "ab".repeat(32);

const edge: EdgeConfig = {
  org: "acme",
  domain: "acme.localhost",
  aliases: ["acme.internal"],
  image: "traefik:v3.7.17",
  workspaces: ["main"],
  routes: {
    den: "http://host.docker.internal:7000",
    api: "http://api:8080",
  },
  ports: { http: 80, https: 443 },
  stateDir: "/tmp/x",
  tls: { strategy: "mkcert", ca: null },
  tlsFrom: "explicit",
  httpsRedirect: true,
  dockerLabels: null,
  include: null,
  mounts: {},
  networks: [],
  args: [],
};

const variants: [string, EdgeConfig][] = [
  ["https", edge],
  ["http only", { ...edge, tls: { strategy: "none" } }],
  ["no redirect", { ...edge, httpsRedirect: false }],
  [
    "docker labels",
    { ...edge, dockerLabels: { network: "apps" } } as unknown as EdgeConfig,
  ],
];

const API_FLAG = /^--api(\.|=|$)/i;

describe("no Traefik API or dashboard on the edge", () => {
  it.each(variants)(
    "%s: no router serves api@internal, on any entrypoint",
    (_, cfg) => {
      for (const den of [undefined, { proof: PROOF, ports: new Set([7000]) }]) {
        const doc = yaml.parse(renderEdgeDynamic(cfg, den));
        const routers = Object.entries(
          (doc.http.routers ?? {}) as Record<string, { service: string }>,
        );
        expect(routers.length).toBeGreaterThan(0);
        expect(routers.filter(([, r]) => r.service === "api@internal")).toEqual(
          [],
        );
        expect(doc.http.routers.dashboard).toBeUndefined();
      }
    },
  );

  it.each(variants)("%s: the static command turns no API on", (_, cfg) => {
    expect(edgeCommand(cfg).filter((a) => API_FLAG.test(a))).toEqual([]);
  });

  it("an --api flag in edge.args, with one dash or two, is refused, naming it", () => {
    for (const a of [
      "--api.insecure=true",
      "-api.insecure=true",
      "--api.dashboard=true",
      "--api",
      "-api",
      "--API.debug=true",
      "--api=true",
    ])
      expect(() =>
        edgeCommand({ ...edge, args: [a, "--log.level=INFO"] }),
      ).toThrow(/^edge\.args: ".*" sets api.*edge\.args can't set/i);
    expect(edgeCommand({ ...edge, args: ["--log.level=INFO"] })).toContain(
      "--log.level=INFO",
    );
  });

  it("a static config file of the user's (--configFile, -configfile, any case, = or space) is refused the same way", () => {
    for (const args of [
      ["--configFile=/etc/edge/traefik.yml"],
      ["--CONFIGFILE=/x.toml"],
      ["-configFile=/etc/edge/static.yml"],
      ["--configfile", "/etc/edge/other.yml"],
      ["-configfile", "/etc/edge/static.yml"],
    ])
      expect(() => edgeCommand({ ...edge, args })).toThrow(
        /^edge\.args: ".*" sets configfile/i,
      );
  });

  it("an environment entry in edge.args (TRAEFIK_API…) is refused, and the edge sets no environment of its own", () => {
    for (const a of [
      "TRAEFIK_API_INSECURE=true",
      "traefik_api=true",
      "--TRAEFIK_API_DASHBOARD=true",
      "TRAEFIK_LOG_LEVEL=INFO",
    ])
      expect(() => edgeCommand({ ...edge, args: [a] })).toThrow(
        /^edge\.args: .*edge\.args can't set/,
      );
    for (const [, cfg] of variants) {
      const doc = yaml.parse(renderEdgeCompose(cfg));
      expect(doc.services.edge.environment).toBeUndefined();
      expect(doc.services.edge.env_file).toBeUndefined();
    }
  });

  it("edge.mounts onto a place Traefik reads a static config file from: refused, with a plain line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-mounts-"));
    try {
      fs.mkdirSync(path.join(root, "config"), { recursive: true });
      const at = (target: string) => {
        fs.writeFileSync(
          path.join(root, "config", "den.yml"),
          [
            "edge:",
            "  org: acme",
            "  domain: acme.localhost",
            "  tls: none",
            "  mounts:",
            `    ./traefik.yml: ${target}`,
            "",
          ].join("\n"),
        );
        return () => readEdgeConfig(root);
      };
      for (const t of [
        "/etc/traefik/traefik.yml",
        "/etc/traefik/traefik.toml",
        "/etc/traefik",
        "/etc/traefik/",
        "/traefik.yaml",
        "/root/.config/traefik.yml",
        "/root/.config",
      ])
        expect(at(t)).toThrow(
          /edge\.mounts: .* is where Traefik reads its static config; Den sets the edge's static config itself/,
        );
      expect(at("/etc/edge/extra.yml")().mounts).toEqual({
        [path.join(root, "traefik.yml")]: "/etc/edge/extra.yml",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a running edge with the API on is recreated once, and why", () => {
    const old = [...edgeCommand(edge), "--api.dashboard=true"];
    expect(edgeCommandDrift(old, edgeCommand(edge))).toEqual(["API off"]);
  });
});

describe("the proof is only in the dynamic file", () => {
  it.each(variants)(
    "%s: not in the compose file or the edge's command",
    (_, cfg) => {
      const dynamic = renderEdgeDynamic(cfg, {
        proof: PROOF,
        ports: new Set([7000]),
      });
      expect(dynamic).toContain(PROOF);
      expect(renderEdgeCompose(cfg)).not.toContain(PROOF);
      expect(edgeCommand(cfg).join(" ")).not.toContain(PROOF);
      // ...and nothing in that command can serve the file's contents.
      expect(edgeCommand(cfg).filter((a) => API_FLAG.test(a))).toEqual([]);
    },
  );
});
