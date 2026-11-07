/**
 * SEC-2a, seeing the real client through a front proxy (SEC-2 spec):
 *  1. the edge trusts X-Forwarded-* only from its own networks and loopback
 *     (forwardedHeaders.trustedIPs on every entrypoint), never `insecure`:
 *     an `edge.args` entry setting either is dropped, with a notice;
 *  2. `edge.proxy_protocol.trusted_ips` (empty by default) makes the
 *     entrypoints accept the PROXY protocol from those front proxies;
 *  3. `edge up` says when the running edge's command differs (the one
 *     recreate this needs) and why.
 * Pure: no Docker.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import {
  droppedEdgeArgs,
  EDGE_FORWARDED_TRUSTED_IPS,
  edgeCommand,
  edgeCommandDrift,
  renderEdgeCompose,
} from "../../../src/shared/edge/render.js";
import {
  proxyProtocolIps,
  readEdgeConfig,
} from "../../../src/shared/edge/config.js";
import { edgeUpNotices } from "../../../src/shared/edge/runtime.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const edge: EdgeConfig = {
  org: "acme",
  domain: "acme.localhost",
  aliases: [],
  image: "traefik:v3.7.17",
  workspaces: ["main"],
  routes: {},
  ports: null,
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
const command = (cfg: EdgeConfig): string[] =>
  yaml.parse(renderEdgeCompose(cfg)).services.edge.command as string[];
const TRUST = EDGE_FORWARDED_TRUSTED_IPS.join(",");

describe("the edge's forwarded-header trust", () => {
  it("is its own networks and loopback, on every entrypoint; never insecure", () => {
    expect(EDGE_FORWARDED_TRUSTED_IPS).toEqual([
      "127.0.0.1/32",
      "::1/128",
      "172.16.0.0/12",
      "192.168.65.0/24",
    ]);
    const c = command(edge);
    expect(c).toContain(
      `--entrypoints.web.forwardedHeaders.trustedIPs=${TRUST}`,
    );
    expect(c).toContain(
      `--entrypoints.websecure.forwardedHeaders.trustedIPs=${TRUST}`,
    );
    expect(c.filter((a) => /insecure/i.test(a))).toEqual([]);
    expect(c.filter((a) => /proxyProtocol/.test(a))).toEqual([]);
    // tls: none has no websecure entrypoint, so no trust for one.
    const plain = command({ ...edge, tls: { strategy: "none" } });
    expect(plain.filter((a) => /forwardedHeaders/.test(a))).toEqual([
      `--entrypoints.web.forwardedHeaders.trustedIPs=${TRUST}`,
    ]);
  });

  it("an edge.args entry that sets the trust is dropped, and edge up says so", () => {
    const args = [
      "--accesslog=true",
      "--entrypoints.web.forwardedHeaders.insecure=true",
      "--entrypoints.websecure.forwardedHeaders.insecure=true",
      "--entrypoints.websecure.forwardedHeaders.trustedIPs=0.0.0.0/0",
      "--entrypoints.websecure.proxyProtocol.insecure=true",
    ];
    const cfg = { ...edge, args };
    expect(droppedEdgeArgs(cfg)).toEqual(args.slice(1));
    const c = command(cfg);
    expect(c).toContain("--accesslog=true");
    expect(c.filter((a) => /insecure|0\.0\.0\.0/.test(a))).toEqual([]);
    expect(edgeUpNotices(cfg, null)).toEqual([
      `edge.args: ignoring ${args.slice(1).join(", ")}: Den sets the entrypoints' ` +
        "forwarded-header trust itself (its own networks and loopback), and " +
        "PROXY protocol trust from edge.proxy_protocol.trusted_ips. Remove it " +
        "from the config to silence this.",
    ]);
    expect(edgeUpNotices(edge, null)).toEqual([]);
  });
});

describe("the PROXY protocol from a trusted front proxy", () => {
  it("is off by default; edge.proxy_protocol.trusted_ips turns it on for every entrypoint", () => {
    const cfg = {
      ...edge,
      proxyProtocolTrustedIps: ["172.18.0.5", "10.9.0.0/16"],
    };
    const c = command(cfg);
    expect(c).toContain(
      "--entrypoints.web.proxyProtocol.trustedIPs=172.18.0.5,10.9.0.0/16",
    );
    expect(c).toContain(
      "--entrypoints.websecure.proxyProtocol.trustedIPs=172.18.0.5,10.9.0.0/16",
    );
  });

  it("reads edge.proxy_protocol.trusted_ips (user.yml over the team's), and names a bad value", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-pp-"));
    try {
      fs.mkdirSync(path.join(dir, "config", "local"), { recursive: true });
      const team = "edge:\n  org: acme\n  domain: acme.localhost\n";
      fs.writeFileSync(path.join(dir, "config", "den.yml"), team);
      expect(readEdgeConfig(dir).proxyProtocolTrustedIps).toEqual([]);
      fs.writeFileSync(
        path.join(dir, "config", "den.yml"),
        team + "  proxy_protocol:\n    trusted_ips: [172.18.0.5]\n",
      );
      expect(readEdgeConfig(dir).proxyProtocolTrustedIps).toEqual([
        "172.18.0.5",
      ]);
      fs.writeFileSync(
        path.join(dir, "config", "local", "user.yml"),
        "edge:\n  proxy_protocol:\n    trusted_ips: ['fd00::/8']\n",
      );
      expect(readEdgeConfig(dir).proxyProtocolTrustedIps).toEqual(["fd00::/8"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(() => proxyProtocolIps({ trusted_ips: ["gateway"] })).toThrow(
      'edge.proxy_protocol.trusted_ips: "gateway" is not an IP address or CIDR',
    );
    expect(() => proxyProtocolIps({ trusted_ips: ["10.0.0.0/33"] })).toThrow();
    expect(() => proxyProtocolIps({ trusted: [] } as never)).toThrow(
      'edge.proxy_protocol: unknown key "trusted" (known: trusted_ips)',
    );
  });
});

describe("edge up detects the drift (the one recreate 0.4.5 needs)", () => {
  it("a running edge from 0.4.3 (no trust, insecure args): says it recreates it, and why", () => {
    const old = [
      "--entrypoints.web.address=:80",
      "--entrypoints.websecure.address=:443",
      "--providers.file.directory=/etc/edge/dynamic",
      "--providers.file.watch=true",
      "--api.dashboard=true",
      "--ping=true",
      "--log.level=WARN",
      "--entrypoints.websecure.forwardedHeaders.insecure=true",
    ];
    const cfg = {
      ...edge,
      args: ["--entrypoints.websecure.forwardedHeaders.insecure=true"],
    };
    expect(edgeCommandDrift(old, edgeCommand(cfg))).toEqual([
      "forwarded-header trust",
    ]);
    expect(edgeUpNotices(cfg, old)[1]).toBe(
      "acme-edge's settings changed (forwarded-header trust): recreating it once. Routes drop only while it restarts.",
    );
  });

  it("nothing changed, or no edge running: no notice", () => {
    expect(edgeCommandDrift(edgeCommand(edge), edgeCommand(edge))).toEqual([]);
    expect(edgeCommandDrift(null, edgeCommand(edge))).toEqual([]);
    expect(edgeUpNotices(edge, edgeCommand(edge))).toEqual([]);
  });

  it("names the PROXY protocol, or another change, too", () => {
    const pp = edgeCommand({
      ...edge,
      proxyProtocolTrustedIps: ["172.18.0.5"],
    });
    expect(edgeCommandDrift(edgeCommand(edge), pp)).toEqual(["PROXY protocol"]);
    expect(
      edgeCommandDrift(
        edgeCommand(edge),
        edgeCommand({ ...edge, args: ["--accesslog=true"] }),
      ),
    ).toEqual(["its command"]);
  });
});
