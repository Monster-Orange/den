/**
 * H1 (0.4.48): the edge's proof. A secret only Den and its edge know, in
 * the state folder (0600, 32 random bytes). The edge adds it to every
 * request it forwards to Den's own web route; Den believes the edge's
 * forwarded client only with it. Rotating makes a new one at once: the
 * old one stops working.
 *
 * A temp state folder. No real secret is printed.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  edgeProofFile,
  ensureEdgeProof,
  proofMatches,
  readEdgeProof,
  rotateEdgeProof,
} from "../../../src/shared/edge/proof.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-proof-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the edge's proof", () => {
  it("none until made; made once, 0600, 32 random bytes as hex; kept after", () => {
    expect(readEdgeProof(dir)).toBeNull();
    const p = ensureEdgeProof(dir);
    expect(p).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(edgeProofFile(dir)).mode & 0o777).toBe(0o600);
    expect(ensureEdgeProof(dir)).toBe(p);
    expect(readEdgeProof(dir)).toBe(p);
  });

  it("rotating makes a new one, and the old one no longer matches", () => {
    const old = ensureEdgeProof(dir);
    const next = rotateEdgeProof(dir);
    expect(next).not.toBe(old);
    expect(proofMatches(old, next)).toBe(false);
    expect(proofMatches(next, next)).toBe(true);
  });

  it("matches only the exact proof: missing, empty, short or a near miss never", () => {
    const p = ensureEdgeProof(dir);
    for (const bad of [undefined, "", p.slice(0, 63), `${p}0`, p.toUpperCase()])
      expect(proofMatches(bad, p)).toBe(false);
    expect(proofMatches(p, null)).toBe(false);
  });

  it("a file that isn't a proof (edited, cut short) is none, never trusted", () => {
    fs.mkdirSync(path.dirname(edgeProofFile(dir)), { recursive: true });
    fs.writeFileSync(edgeProofFile(dir), "short\n", { mode: 0o600 });
    expect(readEdgeProof(dir)).toBeNull();
  });
});

describe("the edge picks up the proof (H1)", () => {
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

  it("at Den's start: an edge.yml without the proof is rewritten with it (0600); one with it is left alone", async () => {
    const { syncEdgeProof } =
      await import("../../../src/shared/edge/runtime.js");
    fs.mkdirSync(path.dirname(edgeYml()), { recursive: true });
    fs.writeFileSync(edgeYml(), "# old\n");
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("written");
    const p = readEdgeProof(dir)!;
    const den = path.join(dir, "dynamic", "000-den.yml");
    expect(fs.readFileSync(den, "utf8")).toContain(p);
    expect(fs.statSync(den).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(edgeYml())).toBe(false);
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("current");
  });

  it("no edge here (no edge.yml): nothing written, no proof made", async () => {
    const { syncEdgeProof } =
      await import("../../../src/shared/edge/runtime.js");
    expect(syncEdgeProof(cfg(), new Set([7000]))).toBe("no-edge");
    expect(readEdgeProof(dir)).toBeNull();
    expect(fs.existsSync(edgeYml())).toBe(false);
  });
});

describe("Den checks the proof on each request (H1)", () => {
  const req = (proof?: string) => ({
    headers: {
      host: "den.acme.example",
      ...(proof === undefined ? {} : { "x-den-edge-proof": proof }),
    } as Record<string, string | string[] | undefined>,
  });

  it("the right proof proves; it is taken off the request, and a second look gives the same answer", async () => {
    const { edgeProofChecker } =
      await import("../../../src/shared/edge/proof.js");
    const p = ensureEdgeProof(dir);
    const proved = edgeProofChecker(() => dir);
    const r = req(p);
    expect(proved(r)).toBe(true);
    expect(r.headers).not.toHaveProperty("x-den-edge-proof");
    expect(proved(r)).toBe(true);
  });

  it("a wrong, missing or repeated header never proves", async () => {
    const { edgeProofChecker } =
      await import("../../../src/shared/edge/proof.js");
    const p = ensureEdgeProof(dir);
    const proved = edgeProofChecker(() => dir);
    expect(proved(req("00".repeat(32)))).toBe(false);
    expect(proved(req())).toBe(false);
    const two = req();
    two.headers["x-den-edge-proof"] = [p, p];
    expect(proved(two)).toBe(false);
  });

  it("after a rotation the old proof fails on the very next request", async () => {
    const { edgeProofChecker } =
      await import("../../../src/shared/edge/proof.js");
    const old = ensureEdgeProof(dir);
    const proved = edgeProofChecker(() => dir);
    expect(proved(req(old))).toBe(true);
    const next = rotateEdgeProof(dir);
    expect(proved(req(old))).toBe(false);
    expect(proved(req(next))).toBe(true);
  });

  it("issue 1592: a proof rewritten in one tick, same inode and size, is read again", async () => {
    const { edgeProofChecker } =
      await import("../../../src/shared/edge/proof.js");
    const file = edgeProofFile(dir);
    const old = ensureEdgeProof(dir);
    // A whole-ms stamp, now: utimes keeps no sub-ms part.
    const tick = new Date();
    fs.utimesSync(file, tick, tick);
    const proved = edgeProofChecker(() => dir);
    expect(proved(req(old))).toBe(true);
    // A new proof in the same file, at the same size, in the same tick of
    // a coarse file clock (or a rename onto a reused inode).
    const next = "cd".repeat(32);
    fs.writeFileSync(file, `${next}\n`, { mode: 0o600 });
    fs.utimesSync(file, tick, tick);
    expect(proved(req(old))).toBe(false);
    expect(proved(req(next))).toBe(true);
  });

  it("issue 1592: the generation file rewritten in one tick, same inode and size, to an older generation: read again, and the proof no longer proves", async () => {
    const { edgeProofChecker, edgeProofGenerationFile, EDGE_PROOF_GENERATION } =
      await import("../../../src/shared/edge/proof.js");
    const p = ensureEdgeProof(dir);
    const gen = edgeProofGenerationFile(dir);
    const tick = new Date();
    fs.utimesSync(gen, tick, tick);
    const proved = edgeProofChecker(() => dir);
    expect(proved(req(p))).toBe(true);
    const older = `${EDGE_PROOF_GENERATION - 1}\n`;
    expect(older.length).toBe(fs.readFileSync(gen, "utf8").length);
    fs.writeFileSync(gen, older, { mode: 0o600 });
    fs.utimesSync(gen, tick, tick);
    expect(proved(req(p))).toBe(false);
  });

  it("the trust hold is looked at on every request, never from the cache: held, the same checker's next request fails; released, it proves", async () => {
    const { edgeProofChecker, holdEdgeTrust, releaseEdgeTrust } =
      await import("../../../src/shared/edge/proof.js");
    const p = ensureEdgeProof(dir);
    const later = Date.now() + 10_000;
    const clock = jest.spyOn(Date, "now").mockReturnValue(later);
    try {
      const proved = edgeProofChecker(() => dir);
      expect(proved(req(p))).toBe(true);
      expect(proved(req(p))).toBe(true);
      holdEdgeTrust(dir, "a reason");
      expect(proved(req(p))).toBe(false);
      releaseEdgeTrust(dir);
      expect(proved(req(p))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("no proof file (no edge, or not synced yet): nothing proves (fails closed)", async () => {
    const { edgeProofChecker } =
      await import("../../../src/shared/edge/proof.js");
    expect(edgeProofChecker(() => dir)(req("ab".repeat(32)))).toBe(false);
    expect(edgeProofChecker(() => null)(req("ab".repeat(32)))).toBe(false);
  });
});
