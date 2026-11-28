import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  edgeProofChecker,
  edgeProofFile,
  EDGE_PROOF_HEADER,
  ensureEdgeProof,
  readEdgeProof,
  rotateEdgeProof,
} from "../../../src/shared/edge/proof.js";
import { edgeProofMiddleware } from "../../../src/shared/edge/render.js";
import {
  EDGE_DYNAMIC_FILE,
  syncEdgeProof,
} from "../../../src/shared/edge/runtime.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-proof-up-"));
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
    routes: { den: "http://host.docker.internal:7000" },
    ports: null,
    stateDir: dir,
    tls: { strategy: "none", ca: null },
    tlsFrom: "explicit",
    httpsRedirect: false,
    dockerLabels: null,
    include: null,
    mounts: {},
    networks: [],
    args: [],
  }) as unknown as EdgeConfig;
const edgeYml = () => path.join(dir, "dynamic", "edge.yml");
const denYml = () => path.join(dir, "dynamic", EDGE_DYNAMIC_FILE);
const OLD = "cd".repeat(32);

function oldInstall(): void {
  fs.mkdirSync(path.dirname(edgeYml()), { recursive: true });
  fs.writeFileSync(edgeProofFile(dir), OLD + "\n", { mode: 0o600 });
  fs.writeFileSync(
    edgeYml(),
    [
      "http:",
      "  routers:",
      "    dashboard:",
      "      rule: Host(`edge.acme.localhost`)",
      "      service: api@internal",
      "  middlewares:",
      "    den-edge-proof:",
      "      headers:",
      "        customRequestHeaders:",
      `          X-Den-Edge-Proof: ${OLD}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

const asks = (proof: string) => ({
  headers: { [EDGE_PROOF_HEADER]: proof } as Record<string, string>,
});

describe("the edge's proof on upgrade", () => {
  it("an install with an older proof gets a new one at the first start, in the same file, and edge.yml carries it", () => {
    oldInstall();
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("rotated");
    const next = readEdgeProof(dir);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect(next).not.toBe(OLD);
    const yml = fs.readFileSync(denYml(), "utf8");
    expect(yml).toContain(next!);
    expect(yml).not.toContain(OLD);
    expect(yml).not.toContain("api@internal");
    expect(fs.statSync(denYml()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(edgeYml())).toBe(false);
    expect(fs.statSync(edgeProofFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("the server never accepts the older proof, before the rotation or after; only the new one", () => {
    oldInstall();
    const check = edgeProofChecker(() => dir);
    expect(check(asks(OLD))).toBe(false);
    syncEdgeProof(cfg(), new Set([7000]));
    const next = readEdgeProof(dir)!;
    expect(check(asks(OLD))).toBe(false);
    expect(check(asks(next))).toBe(true);
  });

  it("only once: the next start leaves the new proof alone", () => {
    oldInstall();
    syncEdgeProof(cfg(), new Set([7000]));
    const next = readEdgeProof(dir);
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("current");
    expect(readEdgeProof(dir)).toBe(next);
  });

  it("edge up on an older proof makes a new one too (whichever runs first)", () => {
    oldInstall();
    const next = ensureEdgeProof(dir);
    expect(next).not.toBe(OLD);
    expect(ensureEdgeProof(dir)).toBe(next);
  });

  it("a proof made by this version (new, or rotated by hand) is kept", () => {
    const made = ensureEdgeProof(dir);
    expect(ensureEdgeProof(dir)).toBe(made);
    const rotated = rotateEdgeProof(dir);
    expect(ensureEdgeProof(dir)).toBe(rotated);
    fs.mkdirSync(path.dirname(edgeYml()), { recursive: true });
    fs.writeFileSync(edgeYml(), "# old\n");
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("written");
    expect(readEdgeProof(dir)).toBe(rotated);
  });

  it("a proof of this generation in an edge.yml with the fixed middleware name (an earlier build's) is rendered again: the made-from-the-proof name, in Den's own file", () => {
    const p = ensureEdgeProof(dir);
    fs.mkdirSync(path.dirname(edgeYml()), { recursive: true });
    fs.writeFileSync(
      edgeYml(),
      [
        "http:",
        "  routers:",
        "    route-den:",
        "      rule: Host(`den.acme.localhost`)",
        "      middlewares: [den-edge-proof]",
        "      service: route-den",
        "  middlewares:",
        "    den-edge-proof:",
        "      headers:",
        "        customRequestHeaders:",
        `          X-Den-Edge-Proof: ${p}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("written");
    const now = path.join(dir, "dynamic", EDGE_DYNAMIC_FILE);
    const yml = fs.readFileSync(now, "utf8");
    expect(yml).toContain(edgeProofMiddleware(p));
    expect(yml).not.toMatch(/^\s*den-edge-proof:/m);
    expect(fs.existsSync(edgeYml())).toBe(false);
    expect(fs.statSync(now).mode & 0o777).toBe(0o600);
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("current");
  });

  it("no edge here: nothing is made or rotated", () => {
    fs.writeFileSync(edgeProofFile(dir), OLD + "\n", { mode: 0o600 });
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("no-edge");
    expect(readEdgeProof(dir)).toBe(OLD);
  });
});
