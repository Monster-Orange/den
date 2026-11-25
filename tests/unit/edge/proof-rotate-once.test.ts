/**
 * Issue 728: once agents can't read the edge's state folder, Den rotates
 * the edge's proof once (a marker in that folder, so installs sharing one
 * edge rotate it once), rewriting dynamic/edge.yml so Traefik reloads it by
 * itself; sessions are kept. Stacks' generated secrets are never
 * regenerated (that would lock a stack out of its data): doctor lists them
 * for each owning project's agent.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ensureEdgeProof,
  readEdgeProof,
} from "../../../src/shared/edge/proof.js";
import {
  edgeProofRotation,
  rotateEdgeProofAtStart,
  rotateEdgeProofOnce,
  stacksWithGeneratedSecrets,
} from "../../../src/shared/edge/runtime.js";

let dir = "";
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-rot-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const cfg = () =>
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
  }) as never;
const edgeYml = () => path.join(dir, "dynamic", "edge.yml");
const now = new Date("2026-11-23T08:00:00Z");

describe("issue 728: the edge's proof is rotated once", () => {
  it("an edge with a proof: a new one, edge.yml rewritten with it (0600), marked; never again", () => {
    const old = ensureEdgeProof(dir);
    fs.mkdirSync(path.dirname(edgeYml()), { recursive: true });
    fs.writeFileSync(edgeYml(), `# carries ${old}\n`, { mode: 0o600 });
    expect(edgeProofRotation(cfg())).toEqual({ rotatedAt: null });

    expect(rotateEdgeProofOnce(cfg(), new Set([7000]), now)).toBe("rotated");
    const next = readEdgeProof(dir)!;
    expect(next).not.toBe(old);
    const yml = fs.readFileSync(edgeYml(), "utf8");
    expect(yml).toContain(next);
    expect(yml).not.toContain(old);
    expect(fs.statSync(edgeYml()).mode & 0o777).toBe(0o600);
    expect(edgeProofRotation(cfg())).toEqual({ rotatedAt: now.toISOString() });

    expect(rotateEdgeProofOnce(cfg(), new Set([7000]), now)).toBe("done");
    expect(readEdgeProof(dir)).toBe(next);
  });

  it("a proof with no edge.yml (the edge not set up here now): the proof alone, marked", () => {
    const old = ensureEdgeProof(dir);
    expect(rotateEdgeProofOnce(cfg(), new Set([7000]), now)).toBe("rotated");
    expect(readEdgeProof(dir)).not.toBe(old);
    expect(fs.existsSync(edgeYml())).toBe(false);
  });

  it("no proof ever made: nothing to rotate, and nothing written (no proof, no marker)", () => {
    expect(rotateEdgeProofOnce(cfg(), new Set([7000]), now)).toBe("no-edge");
    expect(readEdgeProof(dir)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(edgeProofRotation(cfg())).toEqual({ rotatedAt: null });
  });
});

describe("issue 728: no edge folder at all", () => {
  it("nothing written: no folder made, no marker", () => {
    const gone = path.join(dir, "not-set-up");
    const c = { ...(cfg() as object), stateDir: gone } as never;
    expect(rotateEdgeProofOnce(c, new Set([7000]), now)).toBe("no-edge");
    expect(fs.existsSync(gone)).toBe(false);
  });
});

describe("issue 728: stacks whose generated secrets agents could read", () => {
  it("lists each stack folder with a generated.env, by project, and never reads the values", () => {
    for (const p of ["db-north", "cache-south"]) {
      fs.mkdirSync(path.join(dir, "stacks", p), { recursive: true });
      fs.writeFileSync(path.join(dir, "stacks", p, "generated.env"), "K=v\n", {
        mode: 0o600,
      });
    }
    fs.mkdirSync(path.join(dir, "stacks", "web-north"), { recursive: true });
    expect(stacksWithGeneratedSecrets(cfg())).toEqual([
      "cache-south",
      "db-north",
    ]);
  });

  it("no stacks folder: none", () => {
    expect(stacksWithGeneratedSecrets(cfg())).toEqual([]);
  });
});

describe("issue 728: the rotation at Den's start", () => {
  it("no edge config here: quiet, nothing rotated", () => {
    const warns: string[] = [];
    const out = rotateEdgeProofAtStart({
      readConfig: () => {
        throw new Error("no edge config");
      },
      ports: new Set([7000]),
      onRotated: () => warns.push("rotated?"),
      warn: (m) => warns.push(m),
    });
    expect(out).toBe("no-config");
    expect(warns).toEqual([]);
  });

  it("a config, and the rotation fails: a warning with the reason, never quiet", () => {
    const warns: string[] = [];
    const out = rotateEdgeProofAtStart({
      readConfig: cfg,
      ports: new Set([7000]),
      rotate: () => {
        throw new Error("EACCES: permission denied");
      },
      onRotated: () => warns.push("rotated?"),
      warn: (m) => warns.push(m),
    });
    expect(out).toBe("failed");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/edge's proof.*not rotated.*EACCES/);
  });

  it("rotated: told once", () => {
    ensureEdgeProof(dir);
    let told = 0;
    const out = rotateEdgeProofAtStart({
      readConfig: cfg,
      ports: new Set([7000]),
      now,
      onRotated: () => told++,
      warn: () => told--,
    });
    expect([out, told]).toEqual(["rotated", 1]);
  });
});
