/**
 * With no edge opt-ins set, the edge renders exactly what it rendered before
 * the opt-ins existed: its own certificate and redirect, no Docker labels,
 * no mounts or extra networks or args. The golden file is the pre-opt-in
 * engine's own output for the same config; regenerate it only on purpose.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  certNames,
  renderEdgeCompose,
  renderEdgeDynamic,
} from "../../../src/shared/edge/render.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";
import {
  withoutOwnerLabels,
  withoutUpstreamTransport,
} from "./helpers/owner-labels.js";

const golden = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../fixtures/edge/no-opt-ins.golden.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

// The opt-ins at their defaults (what readEdgeConfig gives when none is set).
const defaults = {
  tls: { strategy: "mkcert", ca: null },
  tlsFrom: "explicit",
  httpsRedirect: true,
  dockerLabels: null,
  include: null,
  mounts: {},
  networks: [],
  args: [],
};
const cfg = {
  org: "acme",
  domain: "acme.localhost",
  aliases: ["acme.internal"],
  image: "traefik:v3.7",
  workspaces: ["main", "pr-12"],
  subzones: ["shop"],
  routes: {
    den: "http://host.docker.internal:7791",
    api: "http://api:8080",
  },
  ports: null,
  stateDir: "/tmp/acme/edge",
  ...defaults,
} as unknown as EdgeConfig;
const pub = { ...cfg, ports: { http: 80, https: 443 } } as EdgeConfig;

describe("edge with no opt-ins", () => {
  it("renders byte-identical to the pre-opt-in engine", () => {
    expect(certNames(cfg)).toEqual(golden.certNames);
    expect(withoutUpstreamTransport(renderEdgeDynamic(cfg))).toBe(
      golden.dynamic,
    );
    expect(withoutOwnerLabels(renderEdgeCompose(cfg))).toBe(golden.compose);
    expect(withoutUpstreamTransport(renderEdgeDynamic(pub))).toBe(
      golden.dynamicPublished,
    );
    expect(withoutOwnerLabels(renderEdgeCompose(pub))).toBe(
      golden.composePublished,
    );
  });
});

// Dotted routes (`app.shop`) add their zone's wildcard; rendered by den
// 50d9b0a's own code for this config.
const dotted = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../fixtures/edge/dotted-routes.golden.json"),
    "utf-8",
  ),
) as Record<string, unknown> & { config: object };

describe("edge with no opt-ins and dotted routes", () => {
  it("renders byte-identical to den 50d9b0a", () => {
    const c = { ...dotted.config, ...defaults } as unknown as EdgeConfig;
    const p = { ...c, ports: { http: 80, https: 443 } } as EdgeConfig;
    expect(certNames(c)).toEqual(dotted.certNames);
    expect(withoutUpstreamTransport(renderEdgeDynamic(c))).toBe(dotted.dynamic);
    expect(withoutOwnerLabels(renderEdgeCompose(c))).toBe(dotted.compose);
    expect(withoutUpstreamTransport(renderEdgeDynamic(p))).toBe(
      dotted.dynamicPublished,
    );
    expect(withoutOwnerLabels(renderEdgeCompose(p))).toBe(
      dotted.composePublished,
    );
  });
});
