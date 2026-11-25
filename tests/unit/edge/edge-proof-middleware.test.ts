/**
 * Only the routers Den renders carry the edge's proof. Traefik lets a
 * router from one provider name another provider's middleware
 * (`<name>@file`), and has no switch to keep one out of reach: with
 * edge.docker_labels on, any labelled container could add the proof
 * middleware to a router of its own and be sent the proof. So the
 * middleware has no fixed name: it is named from the proof itself (a
 * one-way hash), which only Den and the 0600 edge.yml know. A reference to
 * the old fixed name, or any other, matches nothing.
 *
 * And nothing Den copies or mounts into the dynamic folder may name it:
 * an included file that does is refused, as is a mount into the folder.
 *
 * Pure, temp folders only. The real-Traefik check is
 * edge-proof-labels.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import {
  edgeProofMiddleware,
  renderEdgeDynamic,
} from "../../../src/shared/edge/render.js";
import {
  EDGE_DYNAMIC_FILE,
  syncIncluded,
} from "../../../src/shared/edge/runtime.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const PROOF = "ab".repeat(32);
const OTHER = "cd".repeat(32);

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-proof-mw-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = (): EdgeConfig =>
  ({
    org: "acme",
    domain: "acme.localhost",
    aliases: [],
    image: "traefik:v3.7.17",
    workspaces: [],
    routes: {
      den: "http://host.docker.internal:7000",
      app: "http://app:3000",
    },
    ports: null,
    stateDir: path.join(dir, "state"),
    tls: { strategy: "none", ca: null },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: { network: "apps" },
    include: null,
    mounts: {},
    networks: [],
    args: [],
  }) as unknown as EdgeConfig;

describe("the proof middleware's name", () => {
  it("is made from the proof: not the fixed name, not the proof, new with each proof", () => {
    const n = edgeProofMiddleware(PROOF);
    expect(n).toMatch(/^den-edge-proof-[0-9a-f]{32}$/);
    expect(n).not.toContain(PROOF.slice(0, 16));
    expect(edgeProofMiddleware(PROOF)).toBe(n);
    expect(edgeProofMiddleware(OTHER)).not.toBe(n);
  });

  it("Den's route uses it, and the dynamic file has no middleware of the fixed name", () => {
    const doc = yaml.parse(
      renderEdgeDynamic(cfg(), { proof: PROOF, ports: new Set([7000]) }),
    );
    const n = edgeProofMiddleware(PROOF);
    expect(doc.http.routers["route-den"].middlewares).toEqual([n]);
    expect(Object.keys(doc.http.middlewares)).toEqual([n]);
    expect(doc.http.middlewares["den-edge-proof"]).toBeUndefined();
  });

  it("an included dynamic file that names the proof middleware is refused", () => {
    const inc = path.join(dir, "include");
    fs.mkdirSync(inc, { recursive: true });
    fs.writeFileSync(
      path.join(inc, "steal.yml"),
      [
        "http:",
        "  routers:",
        "    steal:",
        "      rule: Host(`x.acme.localhost`)",
        "      middlewares: [den-edge-proof@file]",
        "      service: s",
        "",
      ].join("\n"),
    );
    expect(() => syncIncluded({ ...cfg(), include: inc })).toThrow(
      /edge\.include: steal\.yml names den-edge-proof/,
    );
    expect(
      fs.existsSync(path.join(cfg().stateDir, "dynamic", "steal.yml")),
    ).toBe(false);
  });

  /** An include folder holding `files`, synced into the edge's state. */
  const include = (files: Record<string, string>) => {
    const inc = path.join(dir, "include");
    fs.rmSync(inc, { recursive: true, force: true });
    fs.mkdirSync(inc, { recursive: true });
    for (const [f, text] of Object.entries(files))
      fs.writeFileSync(path.join(inc, f), text);
    return () => syncIncluded({ ...cfg(), include: inc });
  };
  const dynFile = (f: string) => path.join(cfg().stateDir, "dynamic", f);

  it("an included file that defines a router, service, middleware or transport Den renders is refused, naming it", () => {
    const cases: [string, string][] = [
      [
        "http:\n  services:\n    route-den:\n      loadBalancer:\n        servers: [{ url: http://collector.example }]\n",
        "http.services.route-den",
      ],
      [
        "http:\n  routers:\n    route-app:\n      rule: Host(`app.acme.localhost`)\n      service: x\n",
        "http.routers.route-app",
      ],
      [
        "http:\n  serversTransports:\n    den-upstream:\n      maxIdleConnsPerHost: 1\n",
        "http.serversTransports.den-upstream",
      ],
      [
        "http:\n  middlewares:\n    den-anything:\n      compress: {}\n",
        "http.middlewares.den-anything",
      ],
    ];
    for (const [text, key] of cases) {
      expect(include({ "x.yml": text })).toThrow(
        new RegExp(
          `^edge\\.include: x\\.yml defines ${key.replace(/\./g, "\\.")}, a name Den's own config uses`,
        ),
      );
      expect(fs.existsSync(dynFile("x.yml"))).toBe(false);
    }
  });

  it("Den's own file sorts before every included file, and an include that would sort before it is refused", () => {
    // Traefik's file provider reads the folder in name order; the first
    // definition of a name wins.
    for (const f of ["001-tls.yml", "a.yml", "tls.yml", "zz.yaml"])
      expect([f, f > EDGE_DYNAMIC_FILE]).toEqual([f, true]);
    for (const f of ["00-x.yml", "!x.yml", "0.yml", "-x.yml"])
      expect(include({ [f]: "http: {}\n" })).toThrow(
        /^edge\.include: .* sorts before 000-den\.yml/,
      );
    expect(include({ "tls.yml": "tls: {}\n" })()).toEqual(["tls.yml"]);
  });

  it("a mount into the edge's dynamic folder is refused", () => {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    for (const target of ["/etc/edge/dynamic/x.yml", "/etc/edge/dynamic"]) {
      fs.writeFileSync(
        path.join(dir, "config", "den.yml"),
        [
          "edge:",
          "  org: acme",
          "  domain: acme.localhost",
          "  tls: none",
          "  mounts:",
          `    ./x.yml: ${target}`,
          "",
        ].join("\n"),
      );
      expect(() => readEdgeConfig(dir)).toThrow(
        /edge\.mounts: .* is the edge's dynamic folder/,
      );
    }
  });
});
